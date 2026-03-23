/**
 * Working Memory Brief (WMB) — Layer 3: Attention management.
 *
 * Generates a structured summary injected at the END of the message list
 * before each LLM call, exploiting recency bias to ensure the LLM
 * actually utilizes key context information.
 *
 * Pure code generation. Zero LLM calls. ~1ms latency.
 *
 * Design reference: DESIGN.md §5.7
 */

import type { ExMem } from "../core/exmem.ts";

const MAX_PINNED_DISPLAY = 5;

/**
 * Generate a Working Memory Brief from current context state.
 *
 * Components:
 * 1. Full Narrative from _index.md (no truncation — context space is ample)
 * 2. [pinned] items scanned from ALL context files (max 5 shown)
 * 3. File list from context directory
 * 4. Staleness warning if context hasn't been updated recently
 *
 * Returns null if there's nothing meaningful to inject.
 */
export async function generateWMB(
  exMem: ExMem,
  turnsSinceLastUpdate?: number,
): Promise<string | null> {
  // Read _index.md
  const indexContent = await exMem.getIndexContent();
  if (!indexContent || indexContent.includes("No context recorded yet")) {
    return null;
  }

  // 1. Extract full Narrative
  const narrative = extractNarrative(indexContent);
  if (!narrative) return null;

  // 2. Scan [pinned] items from all context files
  const snapshot = await exMem.context.readSnapshot();
  const pinnedItems = scanPinnedItems(snapshot.files);

  // 3. File list
  const fileNames = [...snapshot.files.keys()].filter((f) => f !== "_index.md");

  // 4. Assemble WMB
  let wmb = "[Working Memory — review before responding]\n";
  wmb += `📝 ${narrative}\n`;

  if (pinnedItems.length > 0) {
    const displayed = pinnedItems.slice(0, MAX_PINNED_DISPLAY);
    for (const item of displayed) {
      wmb += `⚠️ ${item}\n`;
    }
    if (pinnedItems.length > MAX_PINNED_DISPLAY) {
      wmb += `⚠️ ... and ${pinnedItems.length - MAX_PINNED_DISPLAY} more [pinned]\n`;
    }
  }

  if (fileNames.length > 0) {
    wmb += `📁 ${fileNames.join(", ")}`;
  }

  // 5. Staleness warning — remind agent to update context
  if (turnsSinceLastUpdate !== undefined && turnsSinceLastUpdate >= STALE_THRESHOLD) {
    wmb += `\n⏰ Context last updated ${turnsSinceLastUpdate} turns ago — consider using ctx_update`;
  }

  return wmb;
}

/** Turns since last ctx_update before showing staleness warning */
const STALE_THRESHOLD = 10;

/**
 * Generate an empty-context reminder when context files have no content
 * but conversation has been going on.
 *
 * This addresses the "common failure mode" where WMB returns null
 * (because context is empty) but the agent should be reminded to start recording.
 *
 * Returns null if not enough turns have passed.
 */
export function generateEmptyContextReminder(turnsSinceLastUpdate: number): string | null {
  if (turnsSinceLastUpdate < 5) return null;
  return `[Working Memory — no context recorded yet]\n⏰ ${turnsSinceLastUpdate} turns into conversation with no context saved.\nUse ctx_update to record important information (goals, constraints, results).`;
}

/**
 * Determine the consolidation interval based on context state.
 *
 * Cold start (context empty): 5 turns — quickly establish first context files.
 * Stale (context exists but not updated): 20 turns.
 */
export function getConsolidationInterval(contextIsEmpty: boolean): number {
  return contextIsEmpty ? 5 : 20;
}

/**
 * Determine whether WMB should be injected for this LLM call.
 *
 * Inject when:
 *   - Conversation > 20 messages (attention diluting)
 *   - OR context has changed since last injection
 *
 * Don't inject when:
 *   - Conversation < 10 messages AND no context changes
 *
 * Design reference: DESIGN.md §5.7 frequency control
 */
export function shouldInjectWMB(
  messageCount: number,
  contextChanged: boolean,
): boolean {
  if (messageCount < 10 && !contextChanged) return false;
  if (messageCount > 20) return true;
  if (contextChanged) return true;
  return false;
}

// ── Internal helpers ─────────────────────────────────────────

/**
 * Extract the Narrative section from _index.md content.
 * Returns the full Narrative text (no truncation).
 */
function extractNarrative(indexContent: string): string | null {
  // Match "## Narrative" followed by content until the next "## " or end
  const match = indexContent.match(
    /## Narrative\s*\n([\s\S]*?)(?=\n## |\n#[^#]|$)/,
  );
  const text = match?.[1]?.trim();
  return text && text.length > 10 ? text : null;
}

/**
 * Scan all context files for lines containing [pinned].
 * Returns cleaned-up pinned item strings.
 */
function scanPinnedItems(files: Map<string, string>): string[] {
  const items: string[] = [];
  for (const [, content] of files) {
    for (const line of content.split("\n")) {
      if (line.includes("[pinned]")) {
        // Clean up: remove bullet markers, trim
        const cleaned = line.trim().replace(/^[-*•]\s*/, "");
        if (cleaned.length > 3) {
          items.push(cleaned);
        }
      }
    }
  }
  // Deduplicate (same [pinned] might appear in _index.md and topic file)
  return [...new Set(items)];
}
