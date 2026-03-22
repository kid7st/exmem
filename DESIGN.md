# exmem: External Memory for LLM Agents

LLM Agent 的外部认知记忆系统。

## 1. 问题

LLM Agent 通过对话逐步构建一个**心智模型**——对项目的理解、
做出的决策、发现的约束、尝试过的方案。

当 context window 满了，compaction 将心智模型压缩为一段摘要。这个过程有三个缺陷：

1. **每次从头生成**——信息在多轮 compaction 中逐渐衰减
2. **扁平无结构**——无法定向查询某个方面
3. **没有历史**——无法回溯心智模型的演化

原始对话并没有丢（Pi JSONL 保留了），但**对话是过程，Context 是产物**。
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

现有 compaction 下，v1-v3 已被压缩成"测试了多组参数"。Agent 无法回答。

---

## 2. 解法

将心智模型**外化**为一组 Context 文件，用 **Git 版本控制**其演化。

```
对话流 → Agent 处理 → 心智模型变化 → 写入 Context 文件 → git commit
                                                              │
                                          git log / show / diff / grep
                                          随时可回溯任意历史版本
```

Git 的语义恰好匹配 Context 的操作需求：

| 需求 | Git 能力 |
|------|---------|
| 查看某时刻的 Context | `git show <hash>:<file>` |
| 对比 Context 如何变化 | `git diff`（同一文件跨版本，有意义的 diff）|
| 按方面追踪历史 | `git log -- <file>` |
| 搜索历史 | `git grep` / `git log --grep` |

---

## 3. 系统设计

### 3.1 全局架构

```
┌───────────────────────────────────────────────────────────┐
│                        Agent                               │
│                   (Context Window)                          │
│                                                            │
│  已有工具:  read, write, bash, edit                         │
│  新增工具:  ctx_update (唯一)                               │
│  读取记忆:  bash + 标准 git 命令                            │
├───────────────────────────────────────────────────────────┤
│                   Pi Extension                              │
│                                                            │
│  session_start          → 初始化 .exmem/                 │
│  session_before_compact → 记忆固化 (核心)                   │
│  before_agent_start     → system prompt 增强               │
├───────────────────────────────────────────────────────────┤
│                   .exmem/ (Git 仓库)                      │
│                                                            │
│  context/                                                  │
│  ├── _index.md          ← 全局概览 (= compaction summary)  │
│  └── <topic>.md         ← LLM 按需创建的领域文件            │
└───────────────────────────────────────────────────────────┘
```

### 3.2 组件清单

| 组件 | 数量 | 说明 |
|------|------|------|
| 自定义工具 | 1 | `ctx_update`：写入 Context 文件 + git commit |
| Extension hooks | 3 | `session_start`, `session_before_compact`, `before_agent_start` |
| 必需文件 | 1 | `_index.md` |
| 额外存储 | 1 | `.exmem/` git 仓库 |
| LLM 额外调用 | 0 | 替换 Pi 默认的 compaction 摘要生成，非新增 |

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

**不预设固定文件结构。** 只有 `_index.md` 是必需的。
其他文件由 LLM 根据对话内容自行创建，
每个文件覆盖一个独立的话题领域。

### 4.2 `_index.md`

全局概览，同时作为 Pi 的 compaction summary。示例：

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

**Narrative** 是关键：它提供叙事性上下文，
让 Agent 读完后能续上工作。

### 4.3 话题状态管理

Context 文件记录**全部已知信息**，不只是当前焦点。
话题用状态标注区分：

```markdown
## 🟢 Active: 动量策略市场原理研究
- 理解动量因子的理论基础

## ⏸️ Paused: 均线交叉策略回测
- v2 参数最优 (MA 10/30, RSI 70, Sharpe 1.5)
```

焦点切换时标记 ⏸️，不删除内容。

### 4.4 `[pinned]` 标记

用户的关键约束标记为不可删除：

```markdown
- MaxDD ≤ 25% [pinned]
- 必须兼容 Python 3.8+ [pinned]
```

固化时代码验证所有 `[pinned]` 条目在更新后仍然存在。
如果 LLM 删了，代码自动恢复。

### 4.5 大小控制

所有 Context 文件总大小有预算（默认 ~8k tokens）。
超出时，固化 prompt 指示 LLM 精简不活跃内容。
被精简的信息仍保留在 git 历史中，可通过 `git show` 恢复。

---

## 5. 核心机制：两阶段记忆更新

```
阶段 1: 实时编码 (对话过程中)
    Agent 通过 ctx_update 随时记录重要信息
    → 小增量、高保真
    → 信息在产生的瞬间被捕获

阶段 2: 记忆固化 (compaction 时)
    LLM 审视即将压缩的对话 + 当前 Context 文件
    → 查漏补缺
    → 整理状态
    → git commit
```

### 5.1 阶段 1：ctx_update 工具

```typescript
ctx_update(file, content, message?)
```

- `file`: 文件路径（相对于 context/），如 `"strategy-params.md"`
- `content`: 完整的新文件内容
- `message`(可选): 变更描述

内部操作：
1. 对比新旧内容，无变化则跳过（幂等）
2. 写入文件
3. `git add -A && git commit`（commit message 自动包含 `git diff --stat`）

### 5.2 阶段 2：记忆固化流程

```
session_before_compact 触发
    │
    ├─ 1. [代码] 快照：git commit -m "[snapshot]"
    │     (后续验证失败时可回滚到此状态)
    │
    ├─ 2. [代码] 读取当前 context 文件 + 序列化对话
    │     如果对话 > 40k tokens → 分段处理 (见 §5.5)
    │
    ├─ 3. [LLM] 固化调用 (见 §5.3)
    │     模型：使用当前 session 模型，或配置中指定的固化模型
    │     输入: 当前 context 文件 + 对话
    │     输出: 更新后的文件 (结构化格式)
    │     首次固化时附加格式示范 (见 §5.4)
    │
    ├─ 4. [代码] 解析 LLM 输出，写入文件
    │
    ├─ 5. [代码] 后置验证
    │     ✓ _index.md 存在、非空、包含 Narrative
    │     ✓ [pinned] 条目完整
    │     ✓ 总大小在预算内 (允许 20% 溢出)
    │     ✓ 无文件被异常清空
    │     ✓ 解析成功
    │
    ├─ 6a. 验证通过 → git commit -m "[context] ..."
    │
    ├─ 6b. 验证失败 → git checkout HEAD -- context/  (回滚到快照)
    │                  返回 undefined (Pi 走默认 compaction)
    │
    └─ 7. 返回 _index.md 内容作为 compaction summary
```

### 5.3 固化 Prompt

```
你管理一组 Context 文件。基于以下新对话，更新这些文件。

当前文件:
<current-context>
{每个文件的路径和完整内容}
</current-context>

新对话:
<conversation>
{序列化的对话}
</conversation>

规则：
1. 新信息加到对应文件，没有合适文件就新建
   (每个文件覆盖一个独立的话题领域)
   优先保留：目标和成功标准、验证/测试结果、约束条件 [pinned]、
   已尝试但失败的方向及原因
2. 信息变了就更新，被否定了就删掉或标注
3. 不要删除标记为 [pinned] 的条目
   如果新信息与 [pinned] 矛盾，在旁边标注 ⚠️ 冲突，不要覆盖
4. 用户切换话题时标记旧话题 ⏸️ Paused，不要删除内容
5. 总大小控制在 {budget} tokens 以内，超出时精简不活跃内容

输出格式：
<context-update>
<file path="..." action="update|create|unchanged">
(文件完整内容)
</file>
...
(务必包含更新后的 _index.md，其中要有 Narrative 段落)
</context-update>
```

### 5.4 首次固化的格式示范

仅在首次固化时（context/ 目录为空或只有初始模板时）
附加到固化 prompt 末尾。

**使用纯格式示范，不绑定特定领域，避免锚定效应：**

```
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
- action="unchanged" 的文件不需要包含内容
```

后续固化不需要此示范（已有 context 文件作为隐式示例）。

### 5.5 分段处理

当 messagesToSummarize 超过 ~40k tokens 时：

```
LLM call 1: current context + conversation[0:half] → updated context v1
LLM call 2: updated context v1 + conversation[half:end] → updated context v2
```

每次调用的输入更小，提取更精准。

---

## 6. Agent 接口

### 6.1 写入：ctx_update

唯一的自定义工具。Agent 在对话中遇到重要信息时调用：

```
ctx_update(file="constraints.md", content="...", message="add MaxDD constraint")
```

### 6.2 读取：bash + 标准 git 命令

无自定义读取工具。Agent 使用已有的 `read` 和 `bash`：

```bash
# 读取当前 context 文件
read(".exmem/context/strategy-params.md")

# 查看某个文件的版本历史
bash("cd .exmem && git log --oneline -- context/strategy-params.md")

# 读取历史版本
bash("cd .exmem && git show ghi9012:context/strategy-params.md")

# 搜索历史
bash("cd .exmem && git log --all --oneline --grep='Sharpe'")

# 对比两个版本
bash("cd .exmem && git diff ghi9012 abc1234 -- context/strategy-params.md")
```

### 6.3 System Prompt 增强

```markdown
## Context Memory

你有一个外部记忆系统在 `.exmem/` 目录下，用 Git 版本控制。
你的知识和理解被持久化在 context 文件中。

**记录信息** — 遇到以下内容时，用 ctx_update 记录：
- 用户的约束/要求 ("必须", "不要", "限制")
- 量化结果 (数值, 百分比, 指标)
- 参数/配置变更 ("改为", "设置为")
- 决策及理由 ("决定用", "选择")
- 目标变更 ("接下来做", "先放下")
关键约束标记为 [pinned]，如: `MaxDD ≤ 25% [pinned]`

**查询历史** — 需要历史信息时，用 bash 执行 git 命令：
  cd .exmem && git log --oneline -- context/<file>    # 版本历史
  cd .exmem && git show <hash>:context/<file>         # 读取历史版本
  cd .exmem && git diff <hash1> <hash2> -- context/   # 对比变化
  cd .exmem && git log --all --oneline --grep='...'   # 搜索

**切换话题** — 标记旧话题为 ⏸️ Paused，不要删除内容。

当前记忆: {N} 个检查点, {M} 个 context 文件
```

---

## 7. 安全机制

| 机制 | 防护对象 | 实现方式 |
|------|---------|---------|
| 固化前快照 | LLM 输出垃圾时可回滚 | 固化前 `git commit -m "[snapshot]"` |
| 后置验证 (5 项) | 捕获明显的固化失败 | 确定性代码检查 |
| [pinned] 验证 | 关键约束不被删除 | 字符串匹配 + 自动恢复 |
| [pinned] 冲突标注 | 关键约束不被语义覆盖 | 固化 prompt 规则 3 |
| ctx_update 幂等 | 重复写入不产生空 commit | 内容对比后再 commit |
| 分段处理 | 长对话的固化质量 | >40k tokens 时拆分为 2 次调用 |
| 降级到 Pi 默认 | 固化彻底失败时保底 | 验证失败 → 回滚快照 → 返回 undefined |

---

## 8. 初始化

`session_start` hook 中执行：

```
if .exmem/ 不存在:
    git init .exmem/
    mkdir .exmem/context/
    写入 .exmem/context/_index.md (初始模板，见下)
    git add -A && git commit -m "[init] initialize exmem"

读取当前状态:
    checkpointCount = git rev-list --count HEAD
    contextFileCount = ls context/*.md | wc -l
    (用于 system prompt 中的 {N} 和 {M})
```

**初始 _index.md 模板：**

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
─── v1-v4 迭代过程 (多轮对话 + 多次 compaction) ───

Agent 在每次参数变更后调用:
  ctx_update("strategy-params.md", "...v2: MA 10/30, RSI 70...", "v2 params")
  ctx_update("backtest-results.md", "...v2: Sharpe 1.5...", "v2 results")

compaction 时, 固化 hook 确保所有信息被整合到 context 文件中

─── 用户: "v2 的结果最好，回到 v2 参数" ───

Agent:
  bash("cd .exmem && git log --oneline -- context/strategy-params.md")
  → abc1234  v4: MA 20/50
    def5678  v3: MA 10/30 RSI 65
    ghi9012  v2: MA 10/30 RSI 70     ← 目标
    jkl3456  v1: MA 10/20

  bash("cd .exmem && git show ghi9012:context/strategy-params.md")
  → 拿到 v2 完整参数

─── 用户: "帮我分析 MA 周期对 Sharpe 的影响" ───

Agent:
  bash("cd .exmem && git diff ghi9012 abc1234 -- context/strategy-params.md")
  → MA fast 10→20, slow 30→50

  bash("cd .exmem && git diff ghi9012 abc1234 -- context/backtest-results.md")
  → Sharpe 1.5→1.1, MaxDD -15%→-22%

  Agent: "增大 MA 周期 (10/30→20/50) 导致 Sharpe 从 1.5 降到 1.1。
          建议回退到 v2 的 MA 10/30。"
```

### 焦点切换场景

```
─── 用户: "先放下均线策略，研究动量策略的原理" ───

Agent:
  ctx_update("goals.md",
    "# Goals\n## 🟢 Active: 动量策略研究\n...\n## ⏸️ Paused: 均线策略\n...",
    "switch focus to momentum")

  (对话继续, compaction 发生, context 文件被固化更新)

─── 用户: "好，回到均线策略" ───

Agent:
  read(".exmem/context/goals.md")
  → 看到均线策略标记为 ⏸️，有 v2 最优参数的摘要
  → 如需细节: bash("cd .exmem && git log ...")
```

---

## 10. 模块结构

```
exmem/
├── package.json
├── tsconfig.json
├── DESIGN.md                       ← 本文档
├── DECISIONS.md                    ← 设计决策记录
│
├── src/
│   ├── index.ts                    ← 公开导出
│   ├── core/
│   │   ├── types.ts                ← 类型定义
│   │   ├── git-ops.ts              ← Git CLI 封装
│   │   ├── context.ts              ← Context 文件读写 + 验证
│   │   └── exmem.ts              ← ExMem 主类 (init, checkpoint)
│   ├── pi-extension/
│   │   ├── index.ts                ← Extension 入口
│   │   ├── hooks.ts                ← session_start / session_before_compact
│   │   ├── tools.ts                ← ctx_update 工具定义
│   │   └── prompts.ts              ← 固化 prompt + 格式示范
│   └── tests/
│
└── archive/                        ← 设计演化过程
```

---

## 11. 实施阶段

### Phase 1: 核心系统 ✅

- [x] GitOps — git CLI 封装 (17 methods: init, add, commit, show, log, diff, grep, ...)
- [x] Context — 文件读写 (11 methods) + _index.md 模板 + [pinned] 验证+恢复 + 大小检查
- [x] ExMem — 主类 (init, updateFile, checkpoint with snapshot/rollback)
- [x] ctx_update 工具 — 幂等检查 + 写入 + 自动 commit message (含 diff stat)
- [x] session_start hook — 初始化 .exmem/
- [x] session_before_compact hook — 完整固化流程 (快照/固化/验证/回滚/降级)
- [x] before_agent_start hook — system prompt 增强
- [x] prompts.ts — 固化 prompt (5 rules, English) + 首次格式示范 (domain-neutral)
- [x] 分段处理 — >40k tokens 时拆分为 2 次 LLM 调用
- [x] 测试 — 15 tests (init, idempotency, checkpoint, validation, rollback, [pinned], XML parsing)
- [x] 国际化 — 英文 README + 中文翻译, 英文源码/prompts, MIT License, CONTRIBUTING.md

### Phase 2: 自动回忆 ✅

- [x] ExMem 扩展 — log (filtered to [context] commits), searchCommitMessages, searchContent, search (combined with scoring)
- [x] auto-recall.ts — extractKeywords (English + Chinese + quoted strings + numbers) + autoRecall (pure code, no LLM)
- [x] before_agent_start hook — inject recalled context as hidden custom message (exmem-recall)
- [x] 注入控制 — maxInjectTokens (2000), scoreThreshold (1.0), overlap detection, top-2 hits max
- [x] 精确率优先 — 6 guard conditions (short prompt, no history, no keywords, low score, high overlap, budget)
- [x] 测试 — 16 new tests (extractKeywords: 6, log: 2, search: 4, autoRecall: 4)

### Phase 3: 扩展

- [ ] Pi `/tree` 的 git 分支联动
- [ ] `/mem-status` 命令
- [ ] 配置系统 (大小预算, 固化模型选择, 分段阈值)
- [ ] 文档和示例
