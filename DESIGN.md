# exmem: Structured Working Memory for LLM Agents

LLM Agent 的结构化工作记忆系统。

## 1. 问题

LLM Agent 通过对话逐步构建一个**心智模型**——对项目的理解、
做出的决策、发现的约束、尝试过的方案。这个心智模型面临两个威胁：

### 1.1 信息丢失（compaction）

当 context window 满了，compaction 将心智模型压缩为一段摘要：
1. **每次从头生成**——信息在多轮 compaction 中衰减
2. **扁平无结构**——无法定向查询
3. **没有历史**——无法回溯演化

### 1.2 注意力稀释（长 context）

随着 context window 扩展到 1M tokens，compaction 触发变少，
但新问题出现：信息在 context 中但 LLM 无法有效利用。

**Lost in the Middle (Liu et al., 2023)**：LLM 对 context 中间位置的
信息利用率比开头/结尾低 30 个百分点。
**Memory-Probe (ICLR 2026)**：瓶颈不是**检索**而是**利用**——
即使信息在 context 中，LLM 仍然经常不使用它。

原始对话数据并没有丢（Pi JSONL 保留了），
但**对话是过程，Context 是产物**。
从对话恢复 Context 等于让 LLM 重新读一遍所有对话——不可行。

### 场景

量化策略开发中，经过 4 轮参数迭代和回测：

```
v1: MA 10/20, RSI 70  → Sharpe 1.2
v2: MA 10/30, RSI 70  → Sharpe 1.5  ← 最优
v3: MA 10/30, RSI 65  → Sharpe 1.3
v4: MA 20/50, RSI 70  → Sharpe 1.1
```

用户说："v2 的结果最好，回到 v2 参数，帮我分析 MA 周期和 Sharpe 的关系。"

- 在 compaction 场景下：v1-v3 被压缩成"测试了多组参数"
- 在长 context 场景下：v1 的对话在 500K tokens 之前，LLM 注意力到不了

两种情况下 Agent 都无法回答。

---

## 2. 解法

将心智模型**外化**为 Git 版本控制的 Context 文件，
通过三层机制确保信息被**组织、检索、利用**：

```
┌─────────────────────────────────────────────┐
│ Layer 3: ATTENTION (注意力)                   │
│ 确保 LLM 在生成时实际利用信息                   │
│ → Working Memory Brief 注入到 context 末尾     │
├─────────────────────────────────────────────┤
│ Layer 2: RETRIEVAL (检索)                     │
│ 从历史中找到相关信息并提供给 LLM                 │
│ → auto-recall 搜索 + 注入                     │
├─────────────────────────────────────────────┤
│ Layer 1: ORGANIZATION (组织)                  │
│ 结构化存储，可查找、可版本控制                    │
│ → Context 文件 + git 版本控制                  │
└─────────────────────────────────────────────┘
```

Git 的语义匹配 Context 的操作需求：

| 需求 | Git 能力 |
|------|---------|
| 查看某时刻的 Context | `git show <hash>:<file>` |
| 对比 Context 如何变化 | `git diff`（同一文件跨版本）|
| 按方面追踪历史 | `git log -- <file>` |
| 搜索历史 | `git grep` / `git log --grep` |

---

## 3. 系统设计

### 3.1 全局架构

```
┌─────────────────────────────────────────────────────────────┐
│                          Agent                               │
│                     (Context Window)                          │
│                                                              │
│  ┌─ BEGINNING (high attention) ─────────────────────────┐    │
│  │ System prompt + exmem instructions                    │    │
│  └───────────────────────────────────────────────────────┘    │
│  ┌─ MIDDLE (attention fades) ───────────────────────────┐    │
│  │ Conversation history...                               │    │
│  └───────────────────────────────────────────────────────┘    │
│  ┌─ END (high attention) ───────────────────────────────┐    │
│  │ Working Memory Brief (WMB)                            │    │
│  │ 📝 Narrative  ⚠️ [pinned] constraints  📁 Files      │    │
│  └───────────────────────────────────────────────────────┘    │
│                                                              │
│  Tools: read, write, bash, edit, ctx_update                  │
├─────────────────────────────────────────────────────────────┤
│                     Pi Extension (4 hooks)                    │
│                                                              │
│  session_start          → 初始化 .exmem/                     │
│  before_agent_start     → system prompt + auto-recall        │
│  context                → WMB 注入 (Layer 3)                 │
│  agent_end              → 主动 consolidation (1M 安全网)       │
│  session_before_compact → 记忆固化                            │
├─────────────────────────────────────────────────────────────┤
│                     .exmem/ (Git 仓库)                        │
│                                                              │
│  context/                                                    │
│  ├── _index.md     ← 概览 (compaction summary + WMB source) │
│  └── <topic>.md    ← LLM 按需创建的领域文件                   │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 组件清单

| 组件 | 数量 | 说明 |
|------|------|------|
| 自定义工具 | 1 | `ctx_update`：写入 Context 文件 + git commit |
| Extension hooks | 5 | `session_start`, `before_agent_start`, `context`, `agent_end`, `session_before_compact` |
| 必需文件 | 1 | `_index.md` |
| 额外存储 | 1 | `.exmem/` git 仓库 |
| LLM 额外调用 | 0 | 固化替换 Pi 默认摘要生成；WMB 纯代码生成 |

---

## 4. 数据模型

### 4.1 仓库结构

```
.exmem/
├── .git/
└── context/
    ├── _index.md              ← 唯一必需文件
    └── <topic>.md             ← LLM 按需创建的领域文件
```

不预设固定文件结构。其他文件由 LLM 根据对话内容自行创建。

### 4.2 `_index.md`

服务两个目的：

1. **Compaction summary**——compaction 后 Agent 看到的上下文概览
2. **WMB 数据源**——代码从中提取 Narrative 生成 Working Memory Brief

示例：

```markdown
# Project Context
Updated: 2025-03-21T10:30 | Commit: abc1234

## Narrative
正在从均线策略转向研究动量策略。均线策略经过 4 轮参数优化，
v2 (MA 10/30, RSI 70) 表现最优 (Sharpe 1.5)。
用户希望先理解动量因子理论基础再做对比。

## Files
- goals.md — 2 active, 1 paused
- strategy-params.md — 均线策略 4 versions, v2 best
- backtest-results.md — latest: v4 Sharpe 1.1
- constraints.md — MaxDD ≤ 25%
```

Narrative 的第一句应当明确当前目标/焦点，第二句概括当前进展。

### 4.3 话题状态管理

Context 文件记录**全部已知信息**，不只是当前焦点。
焦点切换时标记 ⏸️ Paused，不删除内容：

```markdown
## 🟢 Active: 动量策略市场原理研究
## ⏸️ Paused: 均线交叉策略回测
- v2 参数最优 (MA 10/30, RSI 70, Sharpe 1.5)
```

### 4.4 `[pinned]` 标记

服务两个目的：

1. **固化保护**——代码验证所有 [pinned] 条目在 consolidation 后仍然存在
2. **注意力锚定**——[pinned] 条目在每次 WMB 中展示，确保 Agent 持续看到关键约束

```markdown
- MaxDD ≤ 25% [pinned]
```

### 4.5 大小控制

所有 Context 文件总大小有预算（默认 ~8k tokens）。
超出时，固化 prompt 指示 LLM 精简不活跃内容。
被精简的信息仍保留在 git 历史中。

---

## 5. 核心机制

### 5.1 两阶段记忆更新

```
阶段 1: 实时编码 (对话过程中)
    Agent 通过 ctx_update 随时记录重要信息

阶段 2: 记忆固化 (compaction 时)
    LLM 审视即将压缩的对话 + 当前 Context 文件
    → 查漏补缺 → 整理状态 → git commit
```

### 5.2 ctx_update 工具

```typescript
ctx_update(file, content, message?)
```

内部操作：
1. 对比新旧内容，无变化则跳过（幂等）
2. 写入文件
3. `git add -A && git commit`（commit message 含 `git diff --stat`）

### 5.3 记忆固化流程

```
session_before_compact 触发
    │
    ├─ 1. [代码] 快照：git commit -m "[snapshot]"
    │
    ├─ 2. [代码] 读取 context 文件 + 序列化对话
    │     如果对话 > 40k tokens → 分段处理 (§5.6)
    │
    ├─ 3. [LLM] 固化调用 (§5.4)
    │     首次固化时附加格式示范 (§5.5)
    │
    ├─ 4. [代码] 解析输出 + 写入文件
    │
    ├─ 5. [代码] 后置验证
    │     ✓ _index.md 存在、非空、包含 Narrative
    │     ✓ [pinned] 条目完整（缺失则自动恢复）
    │     ✓ 总大小在预算内 (允许 20% 溢出)
    │     ✓ 无文件被异常清空
    │     ✓ 解析成功
    │
    ├─ 6a. 通过 → git commit
    ├─ 6b. 失败 → git checkout 回滚 → Pi 默认 compaction
    │
    └─ 7. 返回 _index.md 内容作为 compaction summary
```

### 5.4 固化 Prompt

```
You manage a set of Context files. Update them based on the new conversation.

Current files:
<current-context>
{files}
</current-context>

New conversation:
<conversation>
{conversation}
</conversation>

Rules:
1. Add new info to corresponding file, create new file if needed.
   Prioritize: goals/criteria, test results, constraints [pinned],
   failed approaches with reasons.
2. Update changed info. Remove or annotate negated info.
3. Do NOT delete [pinned] items. If conflict, annotate ⚠️ — don't overwrite.
4. On topic switch, mark old topic ⏸️ Paused — don't delete.
5. Keep total under {budget} tokens. Condense inactive content if over.

Output:
<context-update>
<file path="..." action="update|create|unchanged">
(content)
</file>
...
(_index.md must include Narrative: first sentence = current goal/focus,
 second = current status)
</context-update>
```

### 5.5 首次格式示范

仅在首次固化时附加到 prompt 末尾。使用占位内容，避免领域锚定：

```
## Output format demo (placeholder content, format only)

<context-update>
<file path="[topic-name].md" action="create">
# [Topic]
## 🟢 Active: [goal]
- [key info]
- [hard requirement] [pinned]
</file>
<file path="_index.md" action="create">
# Project Context
## Narrative
[current goal/focus. current status/progress.]
## Files
- [file].md: [summary]
</file>
</context-update>
```

### 5.6 分段处理

当对话超过 ~40k tokens 时拆分为 2 次 LLM 调用，
每次输入更小，提取更精准。

### 5.7 Working Memory Brief (WMB)

**解决 Layer 3（注意力）问题。** 在每次 LLM 调用前，
将结构化摘要注入到消息列表末尾，利用 LLM 的 recency bias
确保关键信息被实际利用。

**WMB 由纯代码生成，零 LLM 调用，延迟 ~1ms：**

```typescript
function generateWMB(indexContent, allFiles, fileNames): string {
  // 1. 完整 Narrative (不截取——context 空间充足)
  const narrative = extractNarrative(indexContent);

  // 2. [pinned] 项扫描 (所有文件, 最多展示 5 个)
  const pinned = scanPinnedItems(allFiles);

  // 3. 文件列表
  const files = fileNames.filter(f => f !== "_index.md");

  // 4. 组装
  return `[Working Memory — review before responding]
📝 ${narrative}
${pinned.map(p => `⚠️ ${p}`).join("\n")}
📁 ${files.join(", ")}`;
}
```

**注入条件**（频率控制）：

```
注入 when:
  对话长度 > 20 条消息 (注意力开始稀释)
  OR 自上次注入以来有 ctx_update (context 已变)

不注入 when:
  对话 < 10 条消息 (太短, 无需刷新)
  AND context 无变化
```

**Staleness 提醒**：当 Agent 连续 ≥10 轮未调用 ctx_update 时，
WMB 末尾显示 `⏰ Context last updated N turns ago — consider using ctx_update`。

### 5.8 主动 Consolidation（1M Context 安全网）

在 1M context 下 compaction 可能整个 session 不触发。
`agent_end` hook 每轮递增计数，当 Agent 连续 N 轮（默认 20）
未调用 ctx_update 时，自动触发一次 consolidation——
复用 §5.3-5.4 的 prompt 和 parsing，但不触发 Pi compaction。

```
agent_end 触发
    │
    ├─ turnsSinceLastCtxUpdate++
    │
    ├─ if < N → 跳过
    │
    ├─ if ≥ N:
    │    收集最近 N×3 条 message entry (从 sessionManager)
    │    序列化为对话文本
    │    调用 consolidation prompt + parsing
    │    checkpoint (snapshot → apply → validate → commit/rollback)
    │    成功 → 重置计数器
    │
    └─ 失败 → 静默，下一个 interval 重试
```

这是"同步"而非"压缩"——更新 context 文件但不删除对话消息。
ctx_update 调用成功时也会重置计数器，
因此当 Agent 主动维护 context 时，此机制零开销。

**WMB 示例**：

```
[Working Memory — review before responding]
📝 正在从均线策略转向研究动量策略。均线策略经过 4 轮参数优化，
v2 (MA 10/30, RSI 70) 表现最优 (Sharpe 1.5)。
用户希望先理解动量因子理论基础再做对比。
⚠️ MaxDD ≤ 25% [pinned]
⚠️ 数据范围: 2020-2023 [pinned]
📁 goals.md, strategy-params.md, backtest-results.md, constraints.md
```

**注入位置**：消息列表末尾。
与 auto-recall（消息前部）形成注意力 U 型曲线的两端覆盖：

```
[system prompt]                  ← primacy zone
[auto-recall: 历史 context]      ← primacy zone
[conversation...]                ← dead zone
[WMB: 当前状态]                  ← recency zone
```

---

## 6. Agent 接口

### 6.1 写入：ctx_update

唯一的自定义工具。记录重要信息到 context 文件：

```
ctx_update(file="constraints.md", content="...", message="add MaxDD constraint")
```

### 6.2 读取：bash + 标准 git 命令

无自定义读取工具：

```bash
read(".exmem/context/strategy-params.md")                              # 当前
bash("cd .exmem && git log --oneline -- context/strategy-params.md")   # 历史
bash("cd .exmem && git show ghi9012:context/strategy-params.md")       # 版本
bash("cd .exmem && git log --all --oneline --grep='Sharpe'")           # 搜索
bash("cd .exmem && git diff ghi9012 abc1234 -- context/")              # 对比
```

### 6.3 System Prompt

```markdown
## Context Memory

You have a structured working memory at `.exmem/`, version-controlled with Git.

**Maintain context** — Use ctx_update when you encounter:
- Constraints/requirements ("must", "don't", "limit")
- Quantitative results (numbers, percentages, metrics)
- Parameter changes ("change to", "set to")
- Decisions ("decided to use", "chose")
- Goal changes ("next we'll do", "put X on hold")
Mark critical constraints as [pinned]: `MaxDD ≤ 25% [pinned]`

**Review context** — In long conversations, refresh your understanding:
  read(".exmem/context/_index.md")

**Query history** — Use bash with git commands:
  cd .exmem && git log --oneline -- context/<file>
  cd .exmem && git show <hash>:context/<file>
  cd .exmem && git diff <hash1> <hash2> -- context/
  cd .exmem && git log --all --oneline --grep='...'

**Switch topics** — Mark old topics ⏸️ Paused, don't delete content.

Current memory: {N} checkpoints, {M} context files
```

---

## 7. 安全机制

| 机制 | 防护对象 | 实现 |
|------|---------|------|
| 固化前快照 | LLM 输出垃圾 | 固化前 `git commit -m "[snapshot]"` |
| 后置验证 (5 项) | 明显的固化失败 | 确定性代码检查 |
| [pinned] 验证 + 恢复 | 关键约束被删 | 字符串匹配 + 自动恢复 |
| [pinned] 冲突标注 | 关键约束被语义覆盖 | 固化 prompt 规则 3 |
| ctx_update 幂等 | 空 commit | 内容对比 |
| 分段处理 | 长对话固化质量 | >40k 时拆分 |
| 降级到 Pi 默认 | 固化彻底失败 | 回滚 + 返回 undefined |

---

## 8. 初始化

`session_start` hook：

```
if .exmem/ 不存在:
    git init .exmem/
    mkdir .exmem/context/
    写入 _index.md 模板
    git add -A && git commit -m "[init] initialize exmem"

读取状态 → {N} checkpoints, {M} files → 用于 system prompt
```

初始 _index.md：

```markdown
# Project Context

## Narrative
(No context recorded yet)

## Files
(No files yet)
```

---

## 9. 端到端示例

### 量化策略场景

```
─── v1-v4 迭代 (多轮对话 + compaction) ───

Agent 每次参数变更后调用:
  ctx_update("strategy-params.md", "...", "v2 params")
  ctx_update("backtest-results.md", "...", "v2 results")

compaction 时固化 hook 整合信息到 context 文件

─── 用户: "v2 最好，回到 v2 参数" ───

Agent:
  bash("cd .exmem && git log --oneline -- context/strategy-params.md")
  → ghi9012  v2: MA 10/30 RSI 70     ← 目标

  bash("cd .exmem && git show ghi9012:context/strategy-params.md")
  → v2 完整参数

─── 用户: "分析 MA 周期对 Sharpe 的影响" ───

Agent:
  bash("cd .exmem && git diff ghi9012 abc1234 -- context/strategy-params.md")
  bash("cd .exmem && git diff ghi9012 abc1234 -- context/backtest-results.md")
  → "MA 周期增大导致 Sharpe 下降，建议回退到 v2"
```

### 注意力管理场景

```
─── 对话进行了 50 轮，早期约束被淹没 ───

WMB 在每次 LLM 调用前自动注入:
  [Working Memory — review before responding]
  📝 正在优化均线策略。v2 (MA 10/30) 最优。
  ⚠️ MaxDD ≤ 25% [pinned]
  📁 strategy-params.md, backtest-results.md

Agent 即使在第 50 轮仍然能看到 [pinned] 约束
→ 不会生成违反约束的方案
```

---

## 10. 模块结构

```
exmem/
├── src/
│   ├── index.ts
│   ├── core/
│   │   ├── types.ts              ← 类型定义
│   │   ├── git-ops.ts            ← Git CLI 封装
│   │   ├── context.ts            ← Context 文件读写 + 验证
│   │   └── exmem.ts              ← ExMem 主类
│   ├── pi-extension/
│   │   ├── index.ts              ← Extension 入口 (5 hooks + 1 tool)
│   │   ├── hooks.ts              ← session_start / compact / agent_start
│   │   ├── tools.ts              ← ctx_update 工具
│   │   ├── prompts.ts            ← 固化 prompt + 格式示范
│   │   ├── auto-recall.ts        ← 关键词搜索 + 历史注入 (Layer 2)
│   │   └── wmb.ts                ← Working Memory Brief 生成 (Layer 3)
│   └── tests/
├── DESIGN.md
├── DECISIONS.md
└── archive/
```

---

## 11. 实施阶段

### Phase 1: 组织层 (Layer 1) ✅

- [x] GitOps, Context, ExMem 核心类
- [x] ctx_update 工具（幂等 + 自动 commit）
- [x] session_start / session_before_compact / before_agent_start hooks
- [x] 固化 prompt (5 rules) + 格式示范 + 分段处理
- [x] [pinned] 验证恢复 + 快照回滚 + 后置验证 + 降级
- [x] 15 tests

### Phase 2: 检索层 (Layer 2) ✅

- [x] ExMem.log / searchCommitMessages / searchContent / search
- [x] auto-recall (纯代码, 关键词匹配, 6 道 guard)
- [x] before_agent_start 注入 (hidden custom message)
- [x] 16 tests (31 total)

### Phase 3: 注意力层 (Layer 3) + 1M 安全网 ✅

- [x] wmb.ts — WMB 生成（完整 Narrative + [pinned] 扫描去重 + 文件列表，纯代码 ~1ms）
- [x] context hook — 注入 WMB 到消息末尾（recency bias）
- [x] 频率控制（>20 消息 OR git HEAD 变化时注入）
- [x] WMB staleness 提醒（≥10 轮未更新时显示 ⏰ 提醒）
- [x] auto-recall 阈值调整（3 → 2）
- [x] system prompt 更新（主动维护引导 + "structured working memory" 定位）
- [x] agent_end hook — 主动 periodic consolidation（每 20 轮安全网）
- [x] periodicConsolidation() — 复用 consolidation prompt/parsing/validation
- [x] turn 计数 + ctx_update 重置逻辑
- [x] 测试 — 47 total

### Phase 4: 打磨

- [ ] 配置系统（token 预算、WMB 注入阈值）
- [ ] Pi `/tree` 分支联动
- [ ] 文档和示例
