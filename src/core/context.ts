/**
 * Context file management.
 *
 * Handles reading, writing, validation of context files
 * within the .exmem/context/ directory.
 *
 * Design reference: DESIGN.md §4, §5.2 step 5, §8
 */

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  ContextSnapshot,
  ConsolidationOutput,
  ValidationResult,
  ExMemConfig,
} from "./types.ts";

// Rough estimate: 1 token ≈ 4 chars for English, ~2 chars for CJK
// Use 3 as a balanced estimate for mixed content
const CHARS_PER_TOKEN = 3;

// ---------------------------------------------------------------------------
// Initial template (DESIGN §8)
// ---------------------------------------------------------------------------

const INDEX_TEMPLATE = `# Project Context

## Narrative
(No context recorded yet)

## Files
(No files yet)
`;

// ---------------------------------------------------------------------------
// Context Manager
// ---------------------------------------------------------------------------

export class ContextManager {
  private contextPath: string;

  constructor(
    private repoPath: string,
    private config: ExMemConfig,
  ) {
    this.contextPath = join(repoPath, config.contextDir);
  }

  // ── Initialization (DESIGN §8) ────────────────────────────────

  /** Create context directory and initial _index.md if they don't exist. */
  async initialize(): Promise<boolean> {
    await mkdir(this.contextPath, { recursive: true });

    const indexPath = join(this.contextPath, "_index.md");
    try {
      await readFile(indexPath, "utf8");
      return false; // already exists
    } catch {
      await writeFile(indexPath, INDEX_TEMPLATE, "utf8");
      return true; // newly created
    }
  }

  // ── Read ───────────────────────────────────────────────────────

  /** Read all context files into a snapshot. */
  async readSnapshot(): Promise<ContextSnapshot> {
    const files = new Map<string, string>();
    let totalChars = 0;

    try {
      const entries = await readdir(this.contextPath, { recursive: true });
      for (const entry of entries) {
        if (typeof entry !== "string" || !entry.endsWith(".md")) continue;
        const content = await readFile(join(this.contextPath, entry), "utf8");
        files.set(entry, content);
        totalChars += content.length;
      }
    } catch {
      // Empty context directory
    }

    return {
      files,
      totalTokens: Math.ceil(totalChars / CHARS_PER_TOKEN),
    };
  }

  /** Read a single context file. Returns null if not found. */
  async readFile(relativePath: string): Promise<string | null> {
    try {
      return await readFile(join(this.contextPath, relativePath), "utf8");
    } catch {
      return null;
    }
  }

  /** Get the list of context file paths. */
  async listFiles(): Promise<string[]> {
    try {
      const entries = await readdir(this.contextPath, { recursive: true });
      return entries.filter(
        (e): e is string => typeof e === "string" && e.endsWith(".md"),
      );
    } catch {
      return [];
    }
  }

  // ── Write ──────────────────────────────────────────────────────

  /** Write a single context file. Creates parent dirs if needed. */
  async writeFile(relativePath: string, content: string): Promise<void> {
    // Path safety: prevent traversal outside context/
    if (relativePath.includes("..") || relativePath.startsWith("/") || relativePath.includes("\\")) {
      throw new Error(`Invalid context path: "${relativePath}". Must be relative, no traversal.`);
    }

    const fullPath = join(this.contextPath, relativePath);
    const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
    if (dir !== this.contextPath) {
      await mkdir(dir, { recursive: true });
    }
    await writeFile(fullPath, content, "utf8");
  }

  /** Apply a consolidation output — write all updated/created files. */
  async applyConsolidation(output: ConsolidationOutput): Promise<string[]> {
    const changed: string[] = [];
    for (const [path, update] of output.files) {
      if (update.action === "unchanged" || update.content === undefined) continue;
      // Skip if content is identical to what's already on disk
      const existing = await this.readFile(path);
      if (existing === update.content) continue;
      await this.writeFile(path, update.content);
      changed.push(path);
    }
    return changed;
  }

  // ── Validation (DESIGN §5.2 step 5) ───────────────────────────

  /**
   * Post-consolidation validation checklist.
   * Only checks for obvious failures — not quality judgment.
   *
   * 5 checks:
   * 1. _index.md exists and is non-empty
   * 2. _index.md contains Narrative section
   * 3. Total size within budget (with overflow tolerance)
   * 4. All [pinned] items from previous version are preserved
   * 5. No file was emptied (if it previously had content)
   */
  async validate(
    previousSnapshot: ContextSnapshot,
  ): Promise<ValidationResult> {
    // 1. _index.md exists and non-empty
    const index = await this.readFile("_index.md");
    if (!index || index.trim().length < 50) {
      return { ok: false, reason: "_index.md missing or nearly empty" };
    }

    // 2. _index.md contains Narrative
    if (!index.includes("Narrative")) {
      return { ok: false, reason: "_index.md missing Narrative section" };
    }

    // 3. Total size within budget
    const currentSnapshot = await this.readSnapshot();
    const maxTokens = this.config.tokenBudget * this.config.budgetOverflowRatio;
    if (currentSnapshot.totalTokens > maxTokens) {
      return {
        ok: false,
        reason: `context size (${currentSnapshot.totalTokens} tokens) exceeds budget (${maxTokens} tokens)`,
      };
    }

    // 4. [pinned] items preserved
    const pinnedCheck = await this.checkPinnedPreserved(previousSnapshot);
    if (!pinnedCheck.ok) {
      return pinnedCheck;
    }

    // 5. No file was emptied
    for (const [path, oldContent] of previousSnapshot.files) {
      if (oldContent.length > 100) {
        const newContent = await this.readFile(path);
        if (newContent !== null && newContent.trim().length < 10) {
          return { ok: false, reason: `${path} was emptied (had ${oldContent.length} chars)` };
        }
      }
    }

    return { ok: true };
  }

  // ── [pinned] mechanism (DESIGN §4.4) ──────────────────────────

  /**
   * Extract all [pinned] items from a snapshot.
   * Returns a map of file → Set of pinned lines.
   */
  extractPinnedItems(snapshot: ContextSnapshot): Map<string, Set<string>> {
    const result = new Map<string, Set<string>>();
    for (const [path, content] of snapshot.files) {
      const pinned = new Set<string>();
      for (const line of content.split("\n")) {
        if (line.includes("[pinned]")) {
          // Normalize whitespace for comparison
          pinned.add(line.trim());
        }
      }
      if (pinned.size > 0) {
        result.set(path, pinned);
      }
    }
    return result;
  }

  /**
   * Check that all [pinned] items from a previous snapshot
   * still exist in the current context files.
   * Delegates to findMissingPinnedItems for the actual async check.
   */
  async checkPinnedPreserved(previousSnapshot: ContextSnapshot): Promise<ValidationResult> {
    const missing = await this.findMissingPinnedItems(previousSnapshot);
    if (missing.size > 0) {
      const lost = [...missing.values()].flat();
      return { ok: false, reason: `[pinned] items lost: ${lost.join("; ")}` };
    }
    return { ok: true };
  }

  /**
   * Full pinned check: compare previous pinned items against current files.
   * Returns missing items for auto-recovery.
   */
  async findMissingPinnedItems(
    previousSnapshot: ContextSnapshot,
  ): Promise<Map<string, string[]>> {
    const previousPinned = this.extractPinnedItems(previousSnapshot);
    const missing = new Map<string, string[]>();

    // Read ALL current files once — pinned items may have moved between files
    const currentSnapshot = await this.readSnapshot();
    const allCurrentContent = [...currentSnapshot.files.values()].join("\n");

    for (const [path, pinnedLines] of previousPinned) {
      const missingInFile: string[] = [];
      for (const pinnedLine of pinnedLines) {
        // Extract core content (strip bullets, [pinned] tag, normalize whitespace)
        const coreContent = pinnedLine
          .replace(/^\s*[-*]\s*/, "")
          .replace("[pinned]", "")
          .trim();
        // Check across ALL current files, not just the original file
        if (coreContent.length > 5 && !allCurrentContent.includes(coreContent)) {
          missingInFile.push(pinnedLine);
        }
      }
      if (missingInFile.length > 0) {
        missing.set(path, missingInFile);
      }
    }

    return missing;
  }

  /**
   * Recover missing [pinned] items by appending them to the appropriate files.
   */
  async recoverPinnedItems(missing: Map<string, string[]>): Promise<void> {
    for (const [path, items] of missing) {
      let content = (await this.readFile(path)) ?? "";
      content += "\n\n## Recovered [pinned] items\n";
      for (const item of items) {
        content += `${item}\n`;
      }
      await this.writeFile(path, content);
    }
  }

  // ── Token estimation ───────────────────────────────────────────

  estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN);
  }
}
