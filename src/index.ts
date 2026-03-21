/**
 * git-mem: External cognitive memory system for LLM agents.
 *
 * Public API exports.
 */

export { GitMem, GitMemError } from "./core/git-mem.ts";
export { GitOps } from "./core/git-ops.ts";
export { ContextManager } from "./core/context.ts";
export type {
  GitMemConfig,
  Checkpoint,
  ContextSnapshot,
  ConsolidationInput,
  ConsolidationOutput,
  FileUpdate,
  ValidationResult,
  ExecResult,
} from "./core/types.ts";
export { DEFAULT_CONFIG } from "./core/types.ts";
