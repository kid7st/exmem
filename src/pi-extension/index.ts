/**
 * git-mem Pi extension entry point.
 *
 * Registers:
 * - 1 tool: ctx_update
 * - 3 hooks: session_start, session_before_compact, before_agent_start
 *
 * Design reference: DESIGN.md §3
 */

import { GitMem } from "../core/git-mem.ts";
import { createCtxUpdateTool } from "./tools.ts";
import { onSessionStart, onBeforeAgentStart, onBeforeCompact } from "./hooks.ts";

// ExtensionAPI type — imported dynamically to avoid hard dependency
type ExtensionAPI = any;

export default function gitMemExtension(pi: ExtensionAPI) {
  // Resolve repo path relative to cwd
  // Will be set on session_start when we have access to ctx.cwd
  let gitMem: GitMem | null = null;
  let initFailed = false;

  // ── session_start: Initialize .git-mem/ (DESIGN §8) ─────────

  pi.on("session_start", async (_event: any, ctx: any) => {
    try {
      gitMem = new GitMem({ repoPath: `${ctx.cwd}/.git-mem` });
      await onSessionStart(gitMem);
    } catch (error) {
      initFailed = true;
      const msg = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`git-mem init failed: ${msg}. Memory features disabled.`, "warning");
    }
  });

  // ── before_agent_start: System prompt enhancement (DESIGN §6.3) ──

  pi.on("before_agent_start", async (event: any, _ctx: any) => {
    if (!gitMem || initFailed) return;

    try {
      const result = await onBeforeAgentStart(gitMem, event);
      return { systemPrompt: result.systemPrompt };
    } catch {
      // Non-critical: agent works without memory prompt
    }
  });

  // ── session_before_compact: Memory consolidation (DESIGN §5.2) ──

  pi.on("session_before_compact", async (event: any, ctx: any) => {
    if (!gitMem || initFailed) return; // Fallback: Pi default compaction

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

      const result = await onBeforeCompact(gitMem, {
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
      ctx.ui.notify(`git-mem consolidation failed: ${msg}. Using default compaction.`, "warning");
      return; // undefined = Pi proceeds with default
    }
  });

  // ── Register ctx_update tool (DESIGN §6.1) ─────────────────

  // We need gitMem to be initialized, but registerTool happens at load time.
  // Solution: register with a wrapper that checks gitMem at execution time.
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
      if (!gitMem || initFailed) {
        throw new Error("git-mem not initialized. Context memory is not available.");
      }

      // Normalize: strip leading @ (some models add it)
      const file = params.file.replace(/^@/, "");

      const hash = await gitMem.updateFile(file, params.content, params.message);

      if (hash === null) {
        return {
          content: [{ type: "text" as const, text: `No changes to ${file} (content identical).` }],
          details: { file, changed: false },
        };
      }

      return {
        content: [{ type: "text" as const, text: `Updated context/${file} (commit: ${hash}).` }],
        details: { file, hash, changed: true },
      };
    },
  });
}
