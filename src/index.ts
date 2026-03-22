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
} from "./core/types.ts";
export { DEFAULT_CONFIG } from "./core/types.ts";
