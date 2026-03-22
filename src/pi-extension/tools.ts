/**
 * ctx_update tool definition for Pi.
 *
 * The only custom tool registered by exmem.
 * Provides atomic write + git commit with idempotency.
 *
 * Design reference: DESIGN.md §5.1, §6.1
 */

import type { ExMem } from "../core/exmem.ts";

/**
 * Create the ctx_update tool definition for Pi's registerTool().
 *
 * Usage in Pi extension:
 *   pi.registerTool(createCtxUpdateTool(exMem));
 */
export function createCtxUpdateTool(exMem: ExMem) {
  // Dynamic import of typebox to avoid hard dependency when pi is not available
  // The actual tool definition uses Type.Object etc. from @sinclair/typebox
  // which is available through pi-coding-agent

  return {
    name: "ctx_update",
    label: "Context Update",
    description:
      "Update a context memory file. Writes the file and commits to git automatically. " +
      "Use this to record important information: constraints, decisions, parameters, results, goals.",
    promptSnippet: "Record important information (constraints, results, decisions) to persistent context memory",
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
      try {
        // Normalize: strip leading @ (some models add it)
        const file = params.file.replace(/^@/, "");

        const hash = await exMem.updateFile(file, params.content, params.message);

        if (hash === null) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No changes to ${file} (content identical).`,
              },
            ],
            details: { file, changed: false },
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Updated context/${file} (commit: ${hash}).`,
            },
          ],
          details: { file, hash, changed: true },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`ctx_update failed: ${message}`);
      }
    },
  };
}
