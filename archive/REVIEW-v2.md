# 第二轮审查：重新理解问题

## 上一轮审查的错误

我在 REVIEW.md 中说"数据没有丢失，Pi JSONL 已经存了所有东西"。
这在技术上正确，但**完全搞错了重点**。

JSONL 保存的是**对话过程**（原始事务流）。
用户需要的是**经过对话累积构建出来的 Context**（当前状态）。

这是两个完全不同的东西。

---

## 核心区分：对话 ≠ Context

用一个类比：

| | 对话（JSONL） | Context |
|---|---|---|
| 本质 | 事务日志（transaction log） | 数据库当前状态（current state） |
| 内容 | 所有说过的话、调用的工具、产生的输出 | 从对话中提炼出的累积理解 |
| 结构 | 线性追加，只增不减 | 有结构，会增删改 |
| 体积 | 持续增长 | 相对稳定（旧信息被更新/替换） |
| 例子 | "用户说…" "助手回答…" "工具输出…" | "目标是X" "决定了Y因为Z" "约束是W" |

**对话是过程，Context 是产物。**

就像我们现在这次讨论：
- 对话过程：第一轮设计 → 审查批评了 git 的必要性 → 你反驳说 JSONL ≠ Context → …
- Context 当前状态：**"问题的本质是'需要维护一个累积构建的 Context'，而非'存储对话历史'"**

如果你只有 JSONL（对话过程），要恢复 Context 当前状态，你需要**从头重新处理所有对话**。
这正是 LLM 在没有 compaction 时做的事——读取所有消息，在"脑中"构建一个心智模型。
一旦 compaction 把旧消息移出了 context window，这个心智模型就断裂了。

**这才是 compaction 真正丢失的东西：不是原始数据，而是 LLM 从数据中累积构建的心智模型。**

---

## 问题重新定义

### 原来的问题定义（DESIGN.md）
> 压缩导致对话细节丢失，需要保存和检索原始对话。

### 上一轮审查的问题定义（REVIEW.md）
> 原始数据没丢（在 JSONL 里），只是缺少检索接口。

### 真正的问题
> **LLM 通过对话累积构建的 "Context"（理解/心智模型）没有被显式地维护。**
> 每次 compaction 时，摘要是对当前心智模型的一次快照，但这个快照：
> 1. 是一次性生成的，不是增量维护的
> 2. 下次 compaction 会被完全替换，而不是在其基础上更新
> 3. 是扁平的文本，无法部分读取或定向查询
>
> 而原始 JSONL 虽然完整，但从中恢复出 Context 的成本近似于让 LLM 重新读一遍所有对话——
> 这在实际上不可行。

---

## Git 的角色重新审视

在这个新理解下，git 不是用来存储原始对话的（JSONL 做了这件事），
而是用来**版本控制一份持续维护的 Context 文档**。

| 我上一轮说的 | 修正后 |
|------------|--------|
| "git 存储对话是冗余的" | ✅ 对的，不应该存原始对话 |
| "直接从 JSONL 读就行" | ❌ 错的，从 JSONL 读到的是原始对话，不是 Context |
| "git 的 diff/branch 没有意义" | ❌ 错的，**Context 文档**的 diff/branch 是有意义的 |
| "git 是过度设计" | ❌ 部分错了，git 版本控制 Context 文档恰恰是合理的 |

### git 在新理解下的价值

```
对话流: [用户] → [助手] → [工具] → [用户] → [助手] → ...
                    │
                    ▼ 提炼
           Context 文档 (CONTEXT.md)
                    │
                    ▼ git commit
           版本历史: v1 → v2 → v3 → ...
```

- **`git commit`**：记录 Context 的每次演化
- **`git diff`**：看 Context 如何变化（**有意义了！**因为是同一份文档的演化，不是两段不同对话的 diff）
- **`git log`**：看 Context 的演化轨迹
- **`git show`**：看任意时刻的 Context 全貌
- **`git branch`**：不同探索方向的 Context 分叉

两段不同对话的 diff 是噪音。**同一份 Context 文档跨版本的 diff 是信号。**

---

## 修正后的架构模型

### 核心概念

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  对话流 (Pi JSONL)          Context 文档 (.git-mem/)         │
│                                                             │
│  [usr] 帮我设计内存系统      # 项目 Context                  │
│  [ast] 好的，我来分析...    │                               │
│  [tool] read compaction.md  │  ## 目标                      │
│  [ast] 分析完了，建议...    │  设计 git-based 的内存增强系统  │
│  [usr] 不要用 git 存对话    │                               │
│  [ast] 你说得对...         │  ## 关键洞察                    │
│                            │  - Context ≠ 对话              │
│  ─── compaction ───        │  - 需要版本控制的是 Context     │
│                            │    而非原始对话                 │
│  [compaction summary]      │                               │
│  (← 从 Context 文档生成)   │  ## 当前决策                    │
│                            │  - git 管理 Context 文档演化    │
│  [usr] 继续实现吧          │  - Pi JSONL 保留原始对话        │
│  [ast] ...                 │  - 工具让 Agent 查 Context 历史 │
│                            │                               │
│  ─── compaction ───        │  ## 已探索但放弃的方向           │
│                            │  - git 存原始对话（冗余）       │
│  [compaction summary]      │  - 从 JSONL 直接读（缺少 Context）│
│  (← 从更新后的 Context     │                               │
│     文档生成)              │  (随对话推进持续更新...)         │
│                            │                               │
└─────────────────────────────────────────────────────────────┘
```

两条平行的信息流：
1. **Pi JSONL**（左侧）：记录所有对话过程，Pi 管理
2. **Context 文档**（右侧）：对话的累积产物，git-mem 管理

### Context 文档的生命周期

```
Session 开始
    │
    ▼
Context 文档初始化（空或从上次 session 继承）
    │
    ▼
对话进行中...
    │
    ├── 可选：每 N 轮对话后，增量更新 Context 文档
    │   (turn_end hook → LLM 问 "基于这几轮对话，Context 文档需要怎么更新？")
    │
    ▼
Compaction 触发
    │
    ├── 1. 基于 messagesToSummarize + 当前 Context 文档
    │      → 让 LLM 生成 **更新后的 Context 文档**（不是从头写，是增量更新）
    │
    ├── 2. 将更新后的 Context 文档写入 .git-mem/CONTEXT.md
    │
    ├── 3. git commit（commit message = 本次更新的变更摘要）
    │
    ├── 4. 从 Context 文档生成 compaction summary 返回给 pi
    │      （或者 Context 文档本身就是 summary）
    │
    └── 5. 下次 compaction 时，步骤 1 的输入是：
           - 新的 messagesToSummarize
           - 上一版 Context 文档（作为已有知识的基础）
           → 输出是更新后的 Context 文档
    │
    ▼
Context 文档持续累积、精炼
```

**关键区别于现有 compaction：**

| | 现有 compaction | git-mem Context |
|---|---|---|
| 生成方式 | 每次从头生成摘要 | 在前一版基础上增量更新 |
| 跨 compaction | 前一次摘要只作为"参考"被压缩进新摘要 | 前一版是明确的基础，被增量修改 |
| 历史 | 只有最新一份摘要 | 所有版本都保留在 git 中 |
| 信息累积 | 信息可能在多次 compaction 后逐渐衰减 | 信息被显式保留或显式删除 |
| 可查询性 | 只能读当前摘要 | 可以查任意版本、做 diff、做搜索 |

---

## 修正后的设计要点

### 1. 存什么

**只存 Context 文档**——一份持续演化的结构化 markdown 文件。

不存原始对话（JSONL 有了）。不存 messages.json（冗余）。
不存 summary.md（Context 文档本身就是更好的 summary）。

```
.git-mem/
├── .git/
└── CONTEXT.md        ← 唯一需要版本控制的文件
```

### 2. Context 文档的结构（建议）

```markdown
# Project Context
Last updated: 2025-03-21T10:30:00Z

## Goal
[当前要达成的目标，随对话推进可能修改]

## Current Understanding
[对问题域的当前理解，会随着讨论深入而更新]

## Decisions
[已做的决策及理由，新决策追加，改变的决策标记修改]

## Constraints
[约束条件，用户要求，技术限制]

## Progress
[完成了什么，正在做什么]

## Explored & Rejected
[尝试过但放弃的方向及原因——这是纯 compaction 很容易丢失的信息]

## Open Questions
[待解决的问题]

## Key Facts
[重要的具体事实：错误信息、配置值、API 细节等]
```

每个 section 都可以被增量更新。LLM 被要求的不是"重新生成摘要"，
而是"**基于新的对话，更新这份 Context 文档**"。

### 3. 更新 Context 文档的 Prompt

```
你是一个 Context 维护者。你的任务是基于新的对话内容，更新一份持续维护的 Context 文档。

当前的 Context 文档：
<current_context>
{current CONTEXT.md content}
</current_context>

自上次更新以来的新对话：
<new_conversation>
{serialized messages to summarize}
</new_conversation>

请输出更新后的完整 Context 文档。规则：
1. **增量更新**：在现有内容基础上添加、修改、删除。不要从头重写。
2. **保留仍然相关的信息**：不要因为新对话没提到就删掉旧信息。
3. **更新已改变的信息**：如果新对话改变了之前的决策或理解，更新对应部分。
4. **添加新信息**：新的发现、决策、约束、进展等添加到对应 section。
5. **标记废弃的信息**：如果某个方向被放弃，移到 "Explored & Rejected" 而不是直接删除。
6. **保持结构**：维持 markdown 的 section 结构。
7. **精炼而非堆砌**：如果多条信息可以合并为一个更清晰的表述，合并它。
```

### 4. Compaction 集成方式改进

之前设计的方案 A（完全自定义 compaction）和方案 B（存储 + 透传）都有问题。

**新方案：Context-as-Summary**

```
session_before_compact:
    1. 读取当前 CONTEXT.md（如果存在）
    2. 序列化 messagesToSummarize
    3. 用上述 prompt 让 LLM 生成更新后的 CONTEXT.md
    4. 写入 .git-mem/CONTEXT.md → git commit
    5. 返回给 pi:
       {
         compaction: {
           summary: updatedContextMd,         // Context 文档直接作为 summary
           firstKeptEntryId: ...,
           tokensBefore: ...,
           details: { commitHash: "..." }
         }
       }
```

这样 compaction summary **就是** Context 文档（或其精简版）。
Context 文档同时服务两个目的：
- Pi 的 compaction summary（Agent 在后续对话中看到的压缩上下文）
- git-mem 的持久化 Context（版本控制的累积知识）

### 5. Agent 的记忆工具（精简）

既然核心是 Context 文档的版本历史，工具可以更聚焦：

| 工具 | 作用 | 对应 git 操作 |
|------|------|-------------|
| `mem_log` | 看 Context 的演化历史 | `git log --oneline` |
| `mem_recall` | 看某个版本的完整 Context | `git show <hash>:CONTEXT.md` |
| `mem_diff` | 看两个版本间 Context 的变化 | `git diff <h1> <h2> -- CONTEXT.md` |
| `mem_search` | 在 Context 历史中搜索 | `git log --all -S "<query>"` + `git grep` |

注意这里 **`mem_diff` 变得有意义了**——因为是同一份文档的演化 diff，
不是两段不同对话的 diff。

而 `mem_recall` 的溢出问题也大幅缓解——Context 文档是精炼过的，
通常 2k-10k tokens，不是 80k tokens 的原始对话。

### 6. 回顾 REVIEW.md 的结论

| REVIEW.md 的结论 | 在新理解下是否成立 |
|---|---|
| "数据没丢" | 部分对——原始对话没丢，但 **Context 确实丢了** |
| "git 是冗余存储" | 错了——git 存的是 Context 文档，不是对话，不冗余 |
| "直接从 JSONL 读就行" | 错了——JSONL 里是原始对话，不是 Context |
| "git diff 无意义" | 错了——Context 文档的 diff 有意义 |
| "git branch 重复造轮子" | 仍然成立——MVP 可以不做 |
| "四文件结构冗余" | 成立——改为只存 CONTEXT.md |
| "messages.json 全保真无意义" | 成立——不需要了 |
| "recall 会导致 context 溢出" | **大幅缓解**——Context 文档是精炼的，不是原始对话 |
| "自动回忆应该是核心" | 仍然成立——但 Context 文档本身就是更好的"自动回忆" |

---

## 与 DESIGN.md 的对照：需要改什么

### 保留
- git 作为版本控制后端 ✅（但目的变了：版本控制 Context，不是存储对话）
- Pi extension 架构和 hook 映射 ✅
- 分层记忆索引的思路 ✅（但从"对话层级"变为"Context 版本层级"）
- 记忆工具 ✅（精简为 4 个，语义微调）
- System prompt 增强 ✅

### 修改
- 存储内容：从"四文件对话快照"改为"单文件 Context 文档" 
- Compaction 集成：从"存储 + 生成摘要"改为"更新 Context 文档 = 生成摘要"
- LLM prompt：从"总结这段对话"改为"更新这份 Context 文档"
- `mem_recall`：从"检索原始对话"改为"检索历史版本的 Context"
- `mem_diff`：从"对比两段对话"改为"对比 Context 的两个版本"

### 砍掉
- `conversation.md`（搜索用 Context 历史就够了）
- `messages.json`（冗余，JSONL 有原始数据）
- `summary.md`（Context 文档本身就是 summary）
- `metadata.json` 作为独立文件（嵌入 CONTEXT.md 头部或 commit message）
- Git 分支管理（MVP 不需要，Pi tree 够用）

### 新增
- Context 文档的结构定义
- 增量更新的 LLM prompt 设计
- Context 文档大小管理策略（避免无限增长）

---

## 待解决的新问题

### 1. Context 文档的大小控制

Context 文档会随时间增长。如果不控制，它本身可能超过 context window 的限制
（因为它要作为 compaction summary 发送给 LLM）。

需要一个"Context 文档自身的压缩"策略：
- 设置最大 token 数（比如 8k tokens）
- 当超出时，指示 LLM 在更新时精炼/合并/删减低优先级信息
- "Explored & Rejected" section 可以被周期性精简

### 2. 增量更新的质量

LLM 做增量更新时，可能会：
- 丢失它认为不重要的旧信息
- 重复已有信息
- 未能正确合并新旧信息

需要在 prompt 中设计好的指令来缓解，以及在 Context 文档结构上提供足够的锚点。

### 3. 首次 Compaction 的冷启动

首次 compaction 时没有前一版 Context 文档。
需要从零生成。这等价于现有的 compaction summary 生成，没有额外问题。

### 4. Context 文档 vs Compaction Summary 的关系

如果 Context 文档直接作为 compaction summary，它会出现在 LLM 的 context 中。
这意味着 Context 文档的内容需要适合作为"之前对话的摘要"出现在对话开头。

需要考虑：Context 文档的格式是否适合作为 system/user message 的一部分？
可能需要一个轻量转换层。

### 5. 与原始对话的交叉检索

有时 Agent 确实需要原始对话的细节（比如确切的错误信息）。
Context 文档可能只记录了"遇到了 JWT 验证错误"，但没有完整的 stack trace。

此时需要回到 JSONL。可以：
- 在 Context 文档中标注来源 entry ID（如 `[ref: entry-a1b2c3d4]`）
- 提供一个补充工具从 JSONL 读原始 entry
- 或者在 Context 的 "Key Facts" section 中保留关键的具体数据

这是 Context 文档 + JSONL 检索的组合方案。
