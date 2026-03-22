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

You have an external memory system at \`.exmem/\`, version-controlled with Git.
Your knowledge and understanding are persisted in context files.

**Record information** — Use ctx_update when you encounter:
- User constraints/requirements ("must", "don't", "limit", "require")
- Quantitative results (numbers, percentages, metrics)
- Parameter/config changes ("change to", "set to")
- Decisions and rationale ("decided to use", "chose", "instead of")
- Goal changes ("next we'll do", "put X on hold")
Mark critical constraints as [pinned], e.g.: \`MaxDD ≤ 25% [pinned]\`

**Query history** — Use bash with standard git commands:
  cd .exmem && git log --oneline -- context/<file>    # version history
  cd .exmem && git show <hash>:context/<file>         # read historical version
  cd .exmem && git diff <hash1> <hash2> -- context/   # compare versions
  cd .exmem && git log --all --oneline --grep='...'   # search

**Switching topics** — Mark old topics as ⏸️ Paused, don't delete their content.

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

  // Parse each <file> tag
  const fileRegex = /<file\s+path="([^"]+)"\s+action="(update|create|unchanged)"(?:\s*\/>|>([\s\S]*?)<\/file>)/g;
  let match;

  while ((match = fileRegex.exec(updateContent)) !== null) {
    const [, path, action, content] = match;
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
