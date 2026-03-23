/**
 * exmem: External cognitive memory system for LLM agents.
 *
 * Public API exports.
 */

export { ExMem, ExMemError } from "./core/exmem.ts";
export { GitOps } from "./core/git-ops.ts";
export { ContextManager } from "./core/context.ts";
export type {
  ExMemConfig,
  Checkpoint,
  ContextSnapshot,
  ConsolidationInput,
  ConsolidationOutput,
  FileUpdate,
  ValidationResult,
  ExecResult,
  LogEntry,
  SearchHit,
  AutoRecallConfig,
} from "./core/types.ts";
export { DEFAULT_CONFIG, DEFAULT_RECALL_CONFIG } from "./core/types.ts";
export { autoRecall, extractKeywords } from "./pi-extension/auto-recall.ts";
export { generateWMB, shouldInjectWMB } from "./pi-extension/wmb.ts";
