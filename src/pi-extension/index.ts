/**
 * exmem Pi extension entry point.
 *
 * Registers:
 * - 1 tool: ctx_update
 * - 5 hooks: session_start, before_agent_start, context, agent_end, session_before_compact
 *
 * Design reference: DESIGN.md §3
 */

import { ExMem } from "../core/exmem.ts";
import { onSessionStart, onBeforeAgentStart, onBeforeCompact, periodicConsolidation } from "./hooks.ts";
import { generateWMB, shouldInjectWMB, generateEmptyContextReminder, getConsolidationInterval } from "./wmb.ts";

// ExtensionAPI type — imported dynamically to avoid hard dependency
type ExtensionAPI = any;

export default function exMemExtension(pi: ExtensionAPI) {
  // Resolve repo path relative to cwd
  // Will be set on session_start when we have access to ctx.cwd
  let exMem: ExMem | null = null;
  let initFailed = false;
  let turnsSinceLastCtxUpdate = 0;

  // ── session_start: Initialize .exmem/ (DESIGN §8) ─────────

  pi.on("session_start", async (_event: any, ctx: any) => {
    try {
      exMem = new ExMem({ repoPath: `${ctx.cwd}/.exmem` });
      await onSessionStart(exMem);
    } catch (error) {
      initFailed = true;
      const msg = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`exmem init failed: ${msg}. Memory features disabled.`, "warning");
    }
  });

  // ── before_agent_start: System prompt enhancement (DESIGN §6.3) ──

  pi.on("before_agent_start", async (event: any, _ctx: any) => {
    if (!exMem || initFailed) return;

    try {
      const result = await onBeforeAgentStart(exMem, event);

      // Phase 2: inject recalled context as a hidden message
      if (result.recallContent) {
        return {
          systemPrompt: result.systemPrompt,
          message: {
            customType: "exmem-recall",
            content: result.recallContent,
            display: false, // hidden from TUI, visible to LLM
          },
        };
      }

      return { systemPrompt: result.systemPrompt };
    } catch {
      // Non-critical: agent works without memory prompt
    }
  });

  // ── context: Working Memory Brief injection (DESIGN §5.7) ──────

  let lastWmbContextHash: string | null = null; // Track context changes

  pi.on("context", async (event: any, _ctx: any) => {
    if (!exMem || initFailed) return;

    try {
      const messageCount = event.messages?.length ?? 0;

      // Detect context changes: compare current head with last injected
      let contextChanged = false;
      try {
        const currentHead = await exMem.git.head();
        if (lastWmbContextHash !== null && currentHead !== lastWmbContextHash) {
          contextChanged = true;
        }
        lastWmbContextHash = currentHead;
      } catch {
        // git head may fail if no commits yet
      }

      // Frequency control (DESIGN §5.7)
      if (!shouldInjectWMB(messageCount, contextChanged)) return;

      const wmb = await generateWMB(exMem, turnsSinceLastCtxUpdate);

      // If WMB has content, inject it
      // If context is empty but stale, inject a standalone reminder
      let injection: string | null = wmb;
      if (!wmb) {
        injection = generateEmptyContextReminder(turnsSinceLastCtxUpdate);
      }

      if (!injection) return;

      // Inject at END of message list — recency bias (DESIGN §5.7)
      // Use "system" role so LLM treats this as background context, not user input.
      return {
        messages: [
          ...event.messages,
          {
            role: "system" as const,
            content: [{ type: "text" as const, text: injection }],
            timestamp: Date.now(),
          },
        ],
      };
    } catch {
      // Non-critical: conversation works without WMB
    }
  });

  // ── agent_end: Turn counting + periodic consolidation (Dir 3) ────

  pi.on("agent_end", async (event: any, ctx: any) => {
    if (!exMem || initFailed) return;

    turnsSinceLastCtxUpdate++;

    // Dir 3: periodic consolidation when Agent hasn't updated context
    // Adaptive interval: shorter when context is empty (cold start)
    let contextIsEmpty = false;
    try {
      const indexContent = await exMem.getIndexContent();
      contextIsEmpty = !indexContent || indexContent.includes("No context recorded yet");
    } catch { /* assume not empty */ }

    const interval = getConsolidationInterval(contextIsEmpty);
    if (turnsSinceLastCtxUpdate < interval) return;

    try {
      // Collect recent messages from session for consolidation
      const entries = ctx.sessionManager.getEntries();
      if (!entries || entries.length === 0) return;

      // Import Pi's serialization
      const { convertToLlm, serializeConversation } = await import(
        "@mariozechner/pi-coding-agent"
      );

      // Take the last N message entries
      const recentEntries = entries
        .filter((e: any) => e.type === "message")
        .slice(-PERIODIC_CONSOLIDATION_INTERVAL * 3) // ~3 messages per turn
        .map((e: any) => e.message)
        .filter(Boolean);

      if (recentEntries.length === 0) return;

      const recentConversation = serializeConversation(convertToLlm(recentEntries));

      // Resolve model + API key
      const model = ctx.model;
      if (!model) return;
      const apiKey = await ctx.modelRegistry.getApiKey(model);
      if (!apiKey) return;

      const { complete } = await import("@mariozechner/pi-ai");

      const success = await periodicConsolidation(exMem, {
        recentConversation,
        signal: AbortSignal.timeout(60_000),
        callLLM: async (prompt: string, sig: AbortSignal) => {
          const response = await complete(
            model,
            {
              messages: [
                {
                  role: "user" as const,
                  content: [{ type: "text" as const, text: prompt }],
                  timestamp: Date.now(),
                },
              ],
            },
            { apiKey, maxTokens: 8192, signal: sig },
          );
          return response.content
            .filter((c: any): c is { type: "text"; text: string } => c.type === "text")
            .map((c: any) => c.text)
            .join("\n");
        },
      });

      if (success) {
        turnsSinceLastCtxUpdate = 0; // Reset after successful consolidation
      } else {
        // Reset counter on failure too — wait a full interval before retrying.
        // Without this, counter stays >= interval and retries every turn.
        turnsSinceLastCtxUpdate = 0;
      }
    } catch {
      // Non-critical: periodic consolidation failure doesn't affect conversation
      // Reset to avoid retrying every subsequent turn
      turnsSinceLastCtxUpdate = 0;
    }
  });

  // ── session_before_compact: Memory consolidation (DESIGN §5.2) ──

  pi.on("session_before_compact", async (event: any, ctx: any) => {
    if (!exMem || initFailed) return; // Fallback: Pi default compaction

    try {
      // Import Pi's serialization utility
      const { convertToLlm, serializeConversation } = await import(
        "@mariozechner/pi-coding-agent"
      );

      const { preparation, signal } = event;
      const {
        messagesToSummarize,
        turnPrefixMessages,
        tokensBefore,
        firstKeptEntryId,
      } = preparation;

      // Combine messages to summarize
      const allMessages = [...messagesToSummarize, ...turnPrefixMessages];
      if (allMessages.length === 0) return;

      // Serialize conversation to text
      const conversation = serializeConversation(convertToLlm(allMessages));

      // Resolve model and API key for consolidation LLM call
      const model = ctx.model;
      if (!model) return; // No model → fallback to Pi default

      const apiKey = await ctx.modelRegistry.getApiKey(model);
      if (!apiKey) return;

      // Import complete function for LLM call
      const { complete } = await import("@mariozechner/pi-ai");

      const result = await onBeforeCompact(exMem, {
        conversation,
        tokensBefore,
        firstKeptEntryId,
        signal,
        callLLM: async (prompt: string, sig: AbortSignal) => {
          const response = await complete(
            model,
            {
              messages: [
                {
                  role: "user" as const,
                  content: [{ type: "text" as const, text: prompt }],
                  timestamp: Date.now(),
                },
              ],
            },
            { apiKey, maxTokens: 8192, signal: sig },
          );
          return response.content
            .filter((c: any): c is { type: "text"; text: string } => c.type === "text")
            .map((c: any) => c.text)
            .join("\n");
        },
      });

      if (!result) return; // Fallback: Pi default compaction

      return {
        compaction: {
          summary: result.summary,
          firstKeptEntryId: result.firstKeptEntryId,
          tokensBefore: result.tokensBefore,
          details: result.details,
        },
      };
    } catch (error) {
      // Any error → fallback to Pi default compaction (DESIGN §7)
      const msg = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`exmem consolidation failed: ${msg}. Using default compaction.`, "warning");
      return; // undefined = Pi proceeds with default
    }
  });

  // ── Register ctx_update tool (DESIGN §6.1) ─────────────────

  // We need exMem to be initialized, but registerTool happens at load time.
  // Solution: register with a wrapper that checks exMem at execution time.
  pi.registerTool({
    name: "ctx_update",
    label: "Context Update",
    description:
      "Update a context memory file. Writes the file and commits to git automatically. " +
      "Use this to record important information: constraints, decisions, parameters, results, goals.",
    promptSnippet:
      "Record important information (constraints, results, decisions) to persistent context memory",
    promptGuidelines: [
      "When encountering important information (user constraints, test results, parameter changes, decisions), use ctx_update to record it.",
      "Mark critical constraints with [pinned], e.g.: `MaxDD ≤ 25% [pinned]`",
      "When switching topics, mark old topics as ⏸️ Paused, don't delete their content.",
    ],
    parameters: {
      type: "object" as const,
      properties: {
        file: {
          type: "string" as const,
          description:
            'File path relative to context/, e.g. "strategy-params.md", "constraints.md". Use lowercase with hyphens.',
        },
        content: {
          type: "string" as const,
          description: "Complete new content for the file (replaces entire file)",
        },
        message: {
          type: "string" as const,
          description: "Brief description of what changed (optional)",
        },
      },
      required: ["file", "content"],
    },

    async execute(
      toolCallId: string,
      params: { file: string; content: string; message?: string },
      signal: AbortSignal | undefined,
      onUpdate: ((update: any) => void) | undefined,
      ctx: any,
    ) {
      if (!exMem || initFailed) {
        throw new Error("exmem not initialized. Context memory is not available.");
      }

      // Normalize: strip leading @ (some models add it)
      const file = params.file.replace(/^@/, "");

      // Path validation: prevent traversal outside context/
      if (file.includes("..") || file.startsWith("/") || file.includes("\\")) {
        throw new Error(`Invalid file path: "${file}". Path must be relative and within context/.`);
      }

      const hash = await exMem.updateFile(file, params.content, params.message);

      if (hash === null) {
        return {
          content: [{ type: "text" as const, text: `No changes to ${file} (content identical).` }],
          details: { file, changed: false },
        };
      }

      // Reset staleness counter — Agent is actively maintaining context
      turnsSinceLastCtxUpdate = 0;

      return {
        content: [{ type: "text" as const, text: `Updated context/${file} (commit: ${hash}).` }],
        details: { file, hash, changed: true },
      };
    },
  });
}
