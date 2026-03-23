/**
 * ExMem — main entry point for exmem core library.
 *
 * Orchestrates GitOps and ContextManager to provide:
 * - init: Initialize the .exmem repository
 * - checkpoint: Two-phase consolidation (snapshot → update → validate → commit)
 * - updateFile: Atomic file update + commit (for ctx_update tool)
 *
 * Design reference: DESIGN.md §5, §8
 */

import type {
  ExMemConfig,
  Checkpoint,
  ContextSnapshot,
  ConsolidationOutput,
  ValidationResult,
  LogEntry,
  SearchHit,
} from "./types.ts";
import { DEFAULT_CONFIG } from "./types.ts";
import { GitOps, ExMemError } from "./git-ops.ts";
import { ContextManager } from "./context.ts";

export class ExMem {
  readonly git: GitOps;
  readonly context: ContextManager;
  readonly config: ExMemConfig;

  constructor(config: Partial<ExMemConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.git = new GitOps(this.config.repoPath);
    this.context = new ContextManager(this.config.repoPath, this.config);
  }

  // ── Initialization (DESIGN §8) ────────────────────────────────

  /**
   * Initialize the .exmem repository.
   * Idempotent: safe to call multiple times.
   * Returns true if newly created, false if already existed.
   */
  async init(): Promise<boolean> {
    const isExisting = await this.git.isRepo();

    if (!isExisting) {
      await this.git.init();
    }

    const created = await this.context.initialize();

    if (!isExisting || created) {
      // Configure git for clean commits
      await this.git.exec(["config", "user.email", "exmem@local"]);
      await this.git.exec(["config", "user.name", "exmem"]);

      if (await this.git.hasChanges()) {
        await this.git.addAndCommit("[init] initialize exmem");
      }
      return true;
    }

    return false;
  }

  // ── File update (DESIGN §5.1 — ctx_update tool backend) ──────

  /**
   * Atomically update a context file and commit.
   * Idempotent: skips if content unchanged.
   *
   * Returns the commit hash, or null if no change.
   */
  async updateFile(
    relativePath: string,
    content: string,
    message?: string,
  ): Promise<string | null> {
    // Idempotency check (DESIGN §5.1 step 1)
    const existing = await this.context.readFile(relativePath);
    if (existing === content) {
      return null; // No change
    }

    // Write file (DESIGN §5.1 step 2)
    await this.context.writeFile(relativePath, content);

    // Stage all changes
    await this.git.addAll();

    // Auto-generate commit message with diff stat (DESIGN §5.1 step 3)
    const diffStat = await this.git.diffStat();
    const commitMsg = message
      ? `[context] ${message}\n---\n${diffStat}`
      : `[context] update ${relativePath}\n---\n${diffStat}`;

    return this.git.commit(commitMsg);
  }

  // ── Checkpoint (DESIGN §5.2 — compaction-time consolidation) ──

  /**
   * Full consolidation flow:
   * 1. Snapshot current state (for rollback)
   * 2. Apply consolidation output from LLM
   * 3. Validate
   * 4. Commit or rollback
   *
   * The LLM call itself is NOT done here — the caller (extension hook)
   * handles the LLM interaction and passes the parsed output.
   *
   * @param output - Parsed LLM consolidation output
   * @returns Checkpoint on success, null on validation failure (rolled back)
   */
  async checkpoint(output: ConsolidationOutput): Promise<Checkpoint | null> {
    // Step 1: Snapshot for rollback (DESIGN §5.2 step 1)
    const previousSnapshot = await this.context.readSnapshot();
    await this.git.addAndCommit("[snapshot] pre-consolidation");

    try {
      // Step 2: Apply consolidation output (DESIGN §5.2 step 4)
      const filesChanged = await this.context.applyConsolidation(output);

      if (filesChanged.length === 0) {
        return null; // Nothing changed
      }

      // Step 3: Check and recover [pinned] items
      const missingPinned = await this.context.findMissingPinnedItems(previousSnapshot);
      if (missingPinned.size > 0) {
        await this.context.recoverPinnedItems(missingPinned);
      }

      // Step 4: Validate (DESIGN §5.2 step 5)
      const validation = await this.context.validate(previousSnapshot);

      if (!validation.ok) {
        // Step 5b: Rollback (DESIGN §5.2 step 6b)
        await this.rollback();
        return null;
      }

      // Step 5a: Commit (DESIGN §5.2 step 6a)
      await this.git.addAll();
      const diffStat = await this.git.diffStat();
      const commitMessage = `[context] consolidation\n---\n${diffStat}`;
      const hash = await this.git.commit(commitMessage);

      return {
        hash,
        message: commitMessage,
        timestamp: new Date(),
        filesChanged,
      };
    } catch (error) {
      // Any error during consolidation → rollback
      await this.rollback();
      throw error;
    }
  }

  // ── Query methods ───────────────────────────────────────────

  /** Get the content of _index.md (the compaction summary). */
  async getIndexContent(): Promise<string | null> {
    return this.context.readFile("_index.md");
  }

  /** Get current state: checkpoint count + file count. */
  async getStatus(): Promise<{ checkpoints: number; files: number }> {
    const checkpoints = await this.git.commitCount();
    const files = await this.context.listFiles();
    return { checkpoints, files: files.length };
  }

  // ── Phase 2: log & search (for auto-recall) ───────────────────

  /**
   * Get commit log entries.
   * Filters to [context] commits only (excludes [snapshot], [init]).
   */
  async log(limit = 50): Promise<LogEntry[]> {
    const SEP = "---EXMEM---";
    const raw = await this.git.log([
      `--format=%h${SEP}%s${SEP}%aI`,
      `-${limit}`,
      "--grep=\\[context\\]",
    ]);

    if (!raw.trim()) return [];

    return raw
      .trim()
      .split("\n")
      .map((line) => {
        const [hash, message, timestamp] = line.split(SEP);
        return { hash, message, timestamp };
      })
      .filter((e) => e.hash); // skip malformed lines
  }

  /**
   * Search commit messages for a query string.
   * Returns matching log entries with the matched commit message lines.
   */
  async searchCommitMessages(query: string): Promise<LogEntry[]> {
    const raw = await this.git.log([
      "--all",
      "--oneline",
      `--grep=${query}`,
      "-i", // case-insensitive
      "-20",
    ]);

    if (!raw.trim()) return [];

    return raw
      .trim()
      .split("\n")
      .map((line) => {
        const spaceIdx = line.indexOf(" ");
        return {
          hash: line.substring(0, spaceIdx),
          message: line.substring(spaceIdx + 1),
          timestamp: "",
        };
      })
      .filter((e) => e.hash);
  }

  /**
   * Search context file content across all commits for a query.
   * Uses git grep on the current HEAD (not all commits — for speed).
   */
  async searchContent(query: string): Promise<{ file: string; line: string }[]> {
    try {
      const raw = await this.git.grep(query);
      if (!raw.trim()) return [];

      return raw
        .trim()
        .split("\n")
        .map((line) => {
          // git grep output: <file>:<matched line>
          const colonIdx = line.indexOf(":");
          return {
            file: line.substring(0, colonIdx),
            line: line.substring(colonIdx + 1),
          };
        })
        .filter((r) => r.file.startsWith(this.config.contextDir));
    } catch {
      return []; // git grep returns exit code 1 on no match
    }
  }

  /**
   * Search both commit messages and content. Returns scored results.
   * Score = matchCount × recencyWeight
   */
  async search(keywords: string[]): Promise<SearchHit[]> {
    const allEntries = await this.log(50);
    const hitMap = new Map<string, SearchHit>();

    for (const keyword of keywords) {
      if (!keyword || keyword.length < 2) continue;

      // Search commit messages
      const msgHits = await this.searchCommitMessages(keyword);
      for (const entry of msgHits) {
        const existing = hitMap.get(entry.hash);
        if (existing) {
          existing.score += 1;
          existing.matchedLines.push(`[commit] ${entry.message}`);
        } else {
          // Find recency: position in log (0 = most recent)
          const idx = allEntries.findIndex((e) => e.hash === entry.hash);
          const recency = idx >= 0 ? 1.0 / (1 + idx * 0.2) : 0.3;
          hitMap.set(entry.hash, {
            entry,
            matchedLines: [`[commit] ${entry.message}`],
            score: recency,
          });
        }
      }

      // Search content — batch file→commit lookup to avoid N+1
      const contentHits = await this.searchContent(keyword);
      if (contentHits.length > 0) {
        // Deduplicate files, then batch-lookup last commit per file
        const uniqueFiles = [...new Set(contentHits.map((h) => h.file))];
        const fileCommitMap = new Map<string, string>();
        for (const file of uniqueFiles) {
          const log = await this.git.log(["--oneline", "-1", "--", file]);
          if (log.trim()) fileCommitMap.set(file, log.trim());
        }

        for (const hit of contentHits) {
          const fileLog = fileCommitMap.get(hit.file);
          if (!fileLog) continue;
          const hash = fileLog.split(" ")[0];
          if (!hash) continue;

          const existing = hitMap.get(hash);
          if (existing) {
            existing.score += 0.5;
            existing.matchedLines.push(`[${hit.file}] ${hit.line.trim()}`);
          } else {
            const idx = allEntries.findIndex((e) => e.hash === hash);
            const recency = idx >= 0 ? 1.0 / (1 + idx * 0.2) : 0.3;
            hitMap.set(hash, {
              entry: { hash, message: fileLog.substring(hash.length + 1), timestamp: "" },
              matchedLines: [`[${hit.file}] ${hit.line.trim()}`],
              score: recency * 0.5,
            });
          }
        }
      }
    }

    // Sort by score descending
    return [...hitMap.values()].sort((a, b) => b.score - a.score);
  }

  // ── Internal ───────────────────────────────────────────────────

  /** Rollback context directory to the pre-consolidation snapshot. */
  private async rollback(): Promise<void> {
    try {
      await this.git.checkoutPath("HEAD", this.config.contextDir);
    } catch {
      // If checkout fails, the snapshot commit should still be there
      // Context may be in an inconsistent state, but the git history is safe
    }
  }
}

export { ExMemError } from "./git-ops.ts";
