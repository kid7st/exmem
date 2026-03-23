/**
 * Prompts for exmem consolidation and system prompt enhancement.
 *
 * All prompts are in English. The LLM naturally adapts its output language
 * to match the conversation content (e.g., Chinese conversation → Chinese context files).
 *
 * Design reference: DESIGN.md §5.3, §5.4, §6.3
 */

import type { ContextSnapshot } from "../core/types.ts";

// ---------------------------------------------------------------------------
// System Prompt (DESIGN §6.3)
// ---------------------------------------------------------------------------

export function buildSystemPrompt(checkpoints: number, fileCount: number): string {
  return `## Context Memory

You have a structured working memory at \`.exmem/\`, version-controlled with Git.
Your knowledge and understanding are persisted in context files.

**Maintain context** — After completing each task step or receiving results, use ctx_update to record what you learned and what changed:
- Constraints/requirements ("must", "don't", "limit") — mark as [pinned]
- Quantitative results (numbers, percentages, metrics)
- Parameter/config changes
- Decisions and rationale
- Goal changes ("next we'll do", "put X on hold")

**Review context** — In long conversations, refresh your understanding:
  read(".exmem/context/_index.md")

**Query history** — Use bash with standard git commands:
  cd .exmem && git log --oneline -- context/<file>
  cd .exmem && git show <hash>:context/<file>
  cd .exmem && git diff <hash1> <hash2> -- context/
  cd .exmem && git log --all --oneline --grep='...'

**Switch topics** — Mark old topics ⏸️ Paused, don't delete content.

Current memory: ${checkpoints} checkpoints, ${fileCount} context files`;
}

// ---------------------------------------------------------------------------
// Consolidation Prompt (DESIGN §5.3)
// ---------------------------------------------------------------------------

export function buildConsolidationPrompt(
  currentContext: ContextSnapshot,
  conversation: string,
  tokenBudget: number,
): string {
  // Serialize current context files
  let contextSection = "";
  for (const [path, content] of currentContext.files) {
    contextSection += `### ${path}\n${content}\n\n`;
  }

  return `You manage a set of Context files. Update them based on the following new conversation.

Current files:
<current-context>
${contextSection.trim() || "(empty — first consolidation)"}
</current-context>

New conversation:
<conversation>
${conversation}
</conversation>

Rules:
1. Add new information to the corresponding file. Create a new file if no existing file fits.
   (Each file covers one independent topic area.)
   Prioritize preserving: goals and success criteria, verification/test results,
   constraints [pinned], and approaches that were tried but failed (with reasons).
2. If information changed, update it. If negated, remove or annotate it.
3. Do NOT delete items marked [pinned].
   If new information contradicts a [pinned] item, annotate ⚠️ conflict next to it — do not overwrite.
4. When the user switches topics, mark old topics ⏸️ Paused — do not delete content.
5. Keep total size under ${tokenBudget} tokens. If exceeding, condense inactive content.

Output format:
<context-update>
<file path="..." action="update|create|unchanged">
(complete file content)
</file>
...
(Must include updated _index.md with a Narrative section)
</context-update>`;
}

// ---------------------------------------------------------------------------
// First-time Format Demo (DESIGN §5.4)
// ---------------------------------------------------------------------------

export const FORMAT_DEMO = `
## Output format demonstration (placeholder content — shows format only)

<context-update>
<file path="[name-based-on-content].md" action="create">
# [Topic Name]
## 🟢 Active: [Goal or task description]
- [Key information extracted from conversation]
- [User's hard requirement] [pinned]

### [Optional: progress/results log]
- [Attempt 1]: [Result] → [Assessment]
- [Attempt 2]: [Result] → [Assessment]
</file>
<file path="[another-topic].md" action="create">
# [Another Independent Topic]
- [Related information]
</file>
<file path="_index.md" action="create">
# Project Context

## Narrative
[2-3 sentences: what we're doing, where we are, what's next]

## Files
- [file].md: [one-line summary]
- [file].md: [one-line summary]
</file>
</context-update>

Format notes:
- File names: lowercase with hyphens, descriptive (e.g., api-design.md, test-results.md)
- Each file covers one independent topic — don't put everything in one file
- Use 🟢 Active / ⏸️ Paused to annotate topic status
- Mark user's hard requirements as [pinned]
- _index.md must have Narrative (situational summary) and Files (file list)
- Files with action="unchanged" don't need content`;

// ---------------------------------------------------------------------------
// Parse consolidation output (DESIGN §5.2 step 4)
// ---------------------------------------------------------------------------

import type { ConsolidationOutput, FileUpdate } from "../core/types.ts";

/**
 * Parse the LLM's XML-formatted consolidation output.
 * Returns null if parsing fails (triggers fallback).
 */
export function parseConsolidationOutput(raw: string): ConsolidationOutput | null {
  const files = new Map<string, FileUpdate>();

  // Extract content between <context-update> tags
  const updateMatch = raw.match(/<context-update>([\s\S]*?)<\/context-update>/);
  if (!updateMatch) return null;

  const updateContent = updateMatch[1];

  // Parse each <file> tag — tolerant of LLM output variations:
  //   Attribute order: path-first or action-first
  //   Quoting: double quotes, single quotes
  //   Whitespace: extra spaces between attributes
  const fileTagRegex = /<file\s+([\s\S]*?)(?:\s*\/>|>([\s\S]*?)<\/file>)/g;
  const attrRegex = /(\w+)\s*=\s*["']([^"']+)["']/g;
  let match;

  while ((match = fileTagRegex.exec(updateContent)) !== null) {
    const attrString = match[1];
    const content = match[2];

    // Extract attributes flexibly
    const attrs: Record<string, string> = {};
    let attrMatch;
    while ((attrMatch = attrRegex.exec(attrString)) !== null) {
      attrs[attrMatch[1]] = attrMatch[2];
    }
    attrRegex.lastIndex = 0; // Reset for next iteration

    const path = attrs.path;
    const action = attrs.action;

    if (!path || !action) continue;
    if (!["update", "create", "unchanged"].includes(action)) continue;

    files.set(path, {
      action: action as FileUpdate["action"],
      content: content?.trim(),
    });
  }

  if (files.size === 0) return null;

  // Must include _index.md
  if (!files.has("_index.md")) return null;

  return { files };
}
