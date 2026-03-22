/**
 * Core type definitions for exmem.
 *
 * Design reference: DESIGN.md §3.2, §4, §5
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ExMemConfig {
  /** Path to the .exmem repository (absolute or relative to cwd) */
  repoPath: string;

  /** Context files directory within the repo */
  contextDir: string;

  /** Total token budget for all context files (DESIGN §4.5) */
  tokenBudget: number;

  /** Token budget overflow tolerance (DESIGN §5.2 step 5: allow 20%) */
  budgetOverflowRatio: number;

  /** Conversation token threshold for segmented processing (DESIGN §5.5) */
  segmentThreshold: number;
}

export const DEFAULT_CONFIG: ExMemConfig = {
  repoPath: ".exmem",
  contextDir: "context",
  tokenBudget: 8000,
  budgetOverflowRatio: 1.2,
  segmentThreshold: 40000,
};

// ---------------------------------------------------------------------------
// Checkpoint — result of a consolidation commit
// ---------------------------------------------------------------------------

export interface Checkpoint {
  /** Git commit hash */
  hash: string;

  /** Commit message */
  message: string;

  /** Commit timestamp */
  timestamp: Date;

  /** Files changed in this checkpoint */
  filesChanged: string[];
}

// ---------------------------------------------------------------------------
// Context snapshot — current state of all context files
// ---------------------------------------------------------------------------

export interface ContextSnapshot {
  /** Map of file path (relative to context/) → content */
  files: Map<string, string>;

  /** Total estimated token count across all files */
  totalTokens: number;
}

// ---------------------------------------------------------------------------
// Consolidation — input/output of the compaction-time LLM call
// ---------------------------------------------------------------------------

export interface ConsolidationInput {
  /** Current context files */
  currentContext: ContextSnapshot;

  /** Serialized conversation to consolidate */
  conversation: string;

  /** Token budget */
  tokenBudget: number;

  /** Whether this is the first consolidation (triggers format demo) */
  isFirstConsolidation: boolean;
}

export interface ConsolidationOutput {
  /** Updated files: path → { action, content } */
  files: Map<string, FileUpdate>;
}

export interface FileUpdate {
  action: "update" | "create" | "unchanged";
  /** Content is required for update/create, absent for unchanged */
  content?: string;
}

// ---------------------------------------------------------------------------
// Validation result (DESIGN §5.2 step 5)
// ---------------------------------------------------------------------------

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Git operation results
// ---------------------------------------------------------------------------

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}
