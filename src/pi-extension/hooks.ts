/**
 * Pi extension hook implementations.
 *
 * Design reference: DESIGN.md §5.2, §6.3, §8
 */

import type { ExMem } from "../core/exmem.ts";
import {
  buildConsolidationPrompt,
  buildSystemPrompt,
  parseConsolidationOutput,
  FORMAT_DEMO,
} from "./prompts.ts";

// ---------------------------------------------------------------------------
// session_start (DESIGN §8)
// ---------------------------------------------------------------------------

export async function onSessionStart(exMem: ExMem): Promise<void> {
  await exMem.init();
}

// ---------------------------------------------------------------------------
// before_agent_start (DESIGN §6.3)
// ---------------------------------------------------------------------------

export async function onBeforeAgentStart(
  exMem: ExMem,
  event: { prompt: string; systemPrompt: string },
): Promise<{ systemPrompt: string }> {
  const status = await exMem.getStatus();
  const memorySection = buildSystemPrompt(status.checkpoints, status.files);

  return {
    systemPrompt: event.systemPrompt + "\n\n" + memorySection,
  };
}

// ---------------------------------------------------------------------------
// session_before_compact (DESIGN §5.2)
// ---------------------------------------------------------------------------

/**
 * Complete consolidation flow.
 *
 * This function:
 * 1. Reads current context + conversation
 * 2. Builds the consolidation prompt
 * 3. Calls the LLM (via provided callback)
 * 4. Parses output + validates + commits or rolls back
 * 5. Returns compaction result for Pi
 *
 * The LLM call is abstracted as a callback to keep the hook
 * independent of any specific LLM client.
 */
export async function onBeforeCompact(
  exMem: ExMem,
  opts: {
    /** Serialized conversation (from Pi's serializeConversation) */
    conversation: string;
    /** Token count before compaction */
    tokensBefore: number;
    /** Pi's firstKeptEntryId */
    firstKeptEntryId: string;
    /** AbortSignal from Pi */
    signal: AbortSignal;
    /**
     * LLM call callback.
     * Receives the consolidation prompt, returns raw LLM text output.
     */
    callLLM: (prompt: string, signal: AbortSignal) => Promise<string>;
  },
): Promise<CompactionResult | null> {
  const { conversation, tokensBefore, firstKeptEntryId, signal, callLLM } = opts;

  // Step 1: Read current context (DESIGN §5.2 step 2)
  const currentContext = await exMem.context.readSnapshot();
  const isFirst =
    currentContext.files.size === 0 ||
    (currentContext.files.size === 1 &&
      (currentContext.files.get("_index.md") ?? "").includes("No context recorded yet"));

  // Step 2: Build prompt (DESIGN §5.3)
  let prompt = buildConsolidationPrompt(
    currentContext,
    conversation,
    exMem.config.tokenBudget,
  );

  // Append format demo on first consolidation (DESIGN §5.4)
  if (isFirst) {
    prompt += "\n\n" + FORMAT_DEMO;
  }

  // Step 3: Handle segmentation if conversation is too long (DESIGN §5.5)
  const conversationTokens = exMem.context.estimateTokens(conversation);

  let rawOutput: string;
  if (conversationTokens > exMem.config.segmentThreshold) {
    rawOutput = await processSegmented(exMem, currentContext, conversation, callLLM, signal);
  } else {
    // Single LLM call
    rawOutput = await callLLM(prompt, signal);
  }

  // Step 4: Parse output (DESIGN §5.2 step 4)
  const parsed = parseConsolidationOutput(rawOutput);
  if (!parsed) {
    // Fallback: return null → Pi uses default compaction
    return null;
  }

  // Step 5: Checkpoint (snapshot → apply → validate → commit/rollback)
  const checkpoint = await exMem.checkpoint(parsed);
  if (!checkpoint) {
    // Validation failed → already rolled back
    return null;
  }

  // Step 6: Read the updated _index.md as the compaction summary
  const summary = await exMem.getIndexContent();
  if (!summary) {
    return null;
  }

  return {
    summary,
    firstKeptEntryId,
    tokensBefore,
    details: {
      commitHash: checkpoint.hash,
      filesChanged: checkpoint.filesChanged,
    },
  };
}

/**
 * Segmented processing for long conversations (DESIGN §5.5).
 * Splits conversation in half and processes in two LLM calls.
 */
async function processSegmented(
  exMem: ExMem,
  initialContext: import("../core/types.ts").ContextSnapshot,
  conversation: string,
  callLLM: (prompt: string, signal: AbortSignal) => Promise<string>,
  signal: AbortSignal,
): Promise<string> {
  const lines = conversation.split("\n");
  const midpoint = Math.floor(lines.length / 2);
  const segment1 = lines.slice(0, midpoint).join("\n");
  const segment2 = lines.slice(midpoint).join("\n");

  // Call 1: Process first half
  const prompt1 = buildConsolidationPrompt(
    initialContext,
    segment1,
    exMem.config.tokenBudget,
  );
  const raw1 = await callLLM(prompt1, signal);
  const parsed1 = parseConsolidationOutput(raw1);

  // Apply first half's updates to context (without committing)
  if (parsed1) {
    await exMem.context.applyConsolidation(parsed1);
  }

  // Call 2: Process second half with updated context
  const updatedContext = await exMem.context.readSnapshot();
  const prompt2 = buildConsolidationPrompt(
    updatedContext,
    segment2,
    exMem.config.tokenBudget,
  );

  return callLLM(prompt2, signal);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CompactionResult {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details: {
    commitHash: string;
    filesChanged: string[];
  };
}
