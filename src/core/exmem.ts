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

  // ── Query methods (used by auto-recall in Phase 2) ────────────

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
