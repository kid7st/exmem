/**
 * Prompts for exmem consolidation and system prompt enhancement.
 *
 * Design reference: DESIGN.md §5.3, §5.4, §6.3
 */

import type { ContextSnapshot } from "../core/types.ts";

// ---------------------------------------------------------------------------
// System Prompt (DESIGN §6.3)
// ---------------------------------------------------------------------------

export function buildSystemPrompt(checkpoints: number, fileCount: number): string {
  return `## Context Memory

你有一个外部记忆系统在 \`.exmem/\` 目录下，用 Git 版本控制。
你的知识和理解被持久化在 context 文件中。

**记录信息** — 遇到以下内容时，用 ctx_update 记录：
- 用户的约束/要求 ("必须", "不要", "限制")
- 量化结果 (数值, 百分比, 指标)
- 参数/配置变更 ("改为", "设置为")
- 决策及理由 ("决定用", "选择")
- 目标变更 ("接下来做", "先放下")
关键约束标记为 [pinned]，如: \`MaxDD ≤ 25% [pinned]\`

**查询历史** — 需要历史信息时，用 bash 执行 git 命令：
  cd .exmem && git log --oneline -- context/<file>    # 版本历史
  cd .exmem && git show <hash>:context/<file>         # 读取历史版本
  cd .exmem && git diff <hash1> <hash2> -- context/   # 对比变化
  cd .exmem && git log --all --oneline --grep='...'   # 搜索

**切换话题** — 标记旧话题为 ⏸️ Paused，不要删除内容。

当前记忆: ${checkpoints} 个检查点, ${fileCount} 个 context 文件`;
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

  return `你管理一组 Context 文件。基于以下新对话，更新这些文件。

当前文件:
<current-context>
${contextSection.trim() || "(空 — 首次固化)"}
</current-context>

新对话:
<conversation>
${conversation}
</conversation>

规则：
1. 新信息加到对应文件，没有合适文件就新建
   (每个文件覆盖一个独立的话题领域)
   优先保留：目标和成功标准、验证/测试结果、约束条件 [pinned]、已尝试但失败的方向及原因
2. 信息变了就更新，被否定了就删掉或标注
3. 不要删除标记为 [pinned] 的条目
   如果新信息与 [pinned] 矛盾，在旁边标注 ⚠️ 冲突，不要覆盖
4. 用户切换话题时标记旧话题 ⏸️ Paused，不要删除内容
5. 总大小控制在 ${tokenBudget} tokens 以内，超出时精简不活跃内容

输出格式：
<context-update>
<file path="..." action="update|create|unchanged">
(文件完整内容)
</file>
...
(务必包含更新后的 _index.md，其中要有 Narrative 段落)
</context-update>`;
}

// ---------------------------------------------------------------------------
// First-time Format Demo (DESIGN §5.4)
// ---------------------------------------------------------------------------

export const FORMAT_DEMO = `
## 输出格式示范（以下为占位内容，仅展示格式）

<context-update>
<file path="[根据实际内容命名].md" action="create">
# [话题名称]
## 🟢 Active: [目标或任务描述]
- [从对话中提取的关键信息]
- [用户的硬性要求] [pinned]

### [可选：进展/结果记录]
- [尝试 1]: [结果] → [评价]
- [尝试 2]: [结果] → [评价]
</file>
<file path="[另一个话题].md" action="create">
# [另一个独立话题]
- [相关信息]
</file>
<file path="_index.md" action="create">
# Project Context

## Narrative
[2-3 句话：在做什么、做到哪了、下一步是什么]

## Files
- [file].md: [一行摘要]
- [file].md: [一行摘要]
</file>
</context-update>

格式要点：
- 文件名小写加连字符，描述内容（如 api-design.md, test-results.md）
- 每个文件覆盖一个独立话题，不要把所有信息放进一个文件
- 用 🟢 Active / ⏸️ Paused 标注话题状态
- 用户的硬性要求标记 [pinned]
- _index.md 必须有 Narrative（叙事概括）和 Files（文件清单）
- action="unchanged" 的文件不需要包含内容`;

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
