# DESIGN.md 架构审查

## 审查结论

设计的**核心洞察**（compaction 是有损的，应该给 Agent 提供检索已压缩细节的能力）是正确的。但当前设计存在一个前提假设上的重大偏差，以及若干过度设计的问题。

---

## 一、前提假设偏差：数据并没有"丢失"

### 问题

设计文档 §1.1 的核心叙事是：

> 被压缩掉的 ~78k tokens 的细节 **永久丢失**

**这不准确。** 通过阅读 Pi 的 session 文档和代码可以确认：

1. Pi 的 session JSONL 是 **append-only** 的。compaction 时不会删除旧 entry，而是追加一条 `CompactionEntry`。
2. `buildSessionContext()` 只是从 `firstKeptEntryId` 起构建发送给 LLM 的消息——旧 entry **依然在 JSONL 文件中**。
3. `ctx.sessionManager.getEntries()` 返回**所有** entry（包括已被 compact 掉的）。

所以真正的问题不是"数据丢失"，而是：

> **数据仍然存在于 session JSONL 中，但 LLM 看不到它，也没有工具可以访问它。**

这个区分至关重要，因为它意味着：

- **存储层面**：Pi 已经在帮你存储了，git-mem 再存一份是**冗余**的
- **真正缺失的是**：一个让 Agent 能检索已压缩 entry 的**索引 + 检索接口**

### 影响

git-mem 设计中约 60% 的复杂度（GitOps、Serializer、4文件结构、git commit 流程）
都是在解决一个不存在的问题——"数据存储"。真正需要解决的是"数据检索"。

---

## 二、核心缺陷：recall 导致的 context 循环溢出

### 问题

设计中**最严重的功能性缺陷**：

1. Compaction 触发时，context 已经**满了**（`contextTokens > contextWindow - reserveTokens`）
2. Compaction 压缩掉旧消息，腾出空间
3. Agent 后续用 `mem_recall` 检索某个 checkpoint
4. `mem_recall` 的工具结果（可能是 80k tokens 的完整 conversation.md）进入 context
5. Context 再次满了，**立即触发新一轮 compaction**
6. 新 compaction 把刚 recall 回来的内容又压缩掉

**结果：recall → compaction → recall 的死循环，或者 recall 回来的内容还没被 Agent 处理就被压缩掉了。**

设计文档没有讨论这个问题。

### 根因

`mem_recall(section="conversation")` 没有大小限制。一个 checkpoint 的 conversation.md
可能是几万到几十万字符。直接作为工具结果返回，会立即击穿 context window。

### 必须解决

这不是"优化"，这是功能正确性问题。如果 recall 会导致循环 compaction，
整个系统就不能用。

---

## 三、过度设计分析

### 3.1 Git 作为存储后端——解决方案与问题不匹配

| Git 能力 | 设计中的用途 | 实际价值 |
|---------|------------|---------|
| `git commit` | 存储 context 快照 | **低** — Pi JSONL 已经存储了 |
| `git log` | 浏览 checkpoint 索引 | **中** — 有用，但一个 JSON index 文件就够了 |
| `git show` | 检索具体 checkpoint | **低** — 直接从 JSONL 读取同样的数据 |
| `git grep` | 全文搜索 | **中** — 有用，但搜索 JSONL 也可以 |
| `git diff` | 对比两个 checkpoint | **低** — 两段不同对话的 diff 是噪音，不是信息 |
| `git branch` | 镜像对话分支 | **低** — Pi 已有完整的 tree 管理 |
| delta compression | 增量存储 | **低** — 冗余存储，本来就不需要存 |

Git 的核心优势——协作、分支合并、增量 diff——在这个场景下基本用不到。
实际有用的只有 "按 ID 存取" 和 "文本搜索"，这些简单得多的方案就能做到。

### 3.2 四文件结构冗余

每个 checkpoint 存储 4 个文件：

- `conversation.md` — 截断版对话
- `messages.json` — 全保真消息（**巨大**）
- `summary.md` — 摘要（**已在 commit message 中**）
- `metadata.json` — 元数据（**已在 commit message 尾部中**）

实际上：
- `summary.md` 和 commit message 内容重复
- `metadata.json` 和 commit message 尾部重复
- `messages.json` 和 Pi session JSONL 内容重复
- 只有 `conversation.md` 有独立价值（搜索友好的格式）

### 3.3 分支管理——重复造轮子

Pi 已经有完整的 session tree 管理：
- `id`/`parentId` 形成树结构
- `BranchSummaryEntry` 处理分支摘要
- `SessionManager` 提供 `branch()`、`getTree()`、`getChildren()` 等 API

在 git 中再维护一套平行的分支映射，等于重复造轮子，而且要保持两者同步本身就是复杂度来源。

### 3.4 `mem_diff` 工具——噪音大于信号

对两个 checkpoint 的 conversation.md 做 `git diff`，得到的是两段**完全不同的对话文本**的 diff。
这不像源码 diff 那样有意义。两次 compaction 之间的对话不是同一个文件的两个版本——它们是**完全不同的内容**。

有意义的 diff 是 `summary.md` 之间的差异（进展变化），但这个直接比较两段文本就行，不需要 git diff。

### 3.5 方案 A（完全自定义 compaction）——引入额外 LLM 开销

方案 A 需要在 `session_before_compact` 中自行调用 LLM 生成摘要。
这意味着每次 compaction 多一次 LLM 调用（或者替换 pi 内置的调用）。
对于一个"增强存储"的 extension 来说，这是不成比例的开销。

---

## 四、缺失的关键考量

### 4.1 Agent 不会可靠地主动使用记忆工具

设计假设 Agent 会：
1. 注意到自己需要已压缩的信息
2. 主动调用 `mem_search` 或 `mem_recall`
3. 用正确的关键词搜索
4. 从结果中提取所需信息

实际上 LLM 在这方面并不可靠。它们不具备关于"自己丢失了什么"的元认知。
系统提示中的引导有帮助，但远不够可靠。

**自动回忆（§12.5）应该是核心功能，不是 future extension。**

### 4.2 检索结果的大小控制

文档没有讨论：
- `mem_recall` 返回多大的内容？有没有上限？
- 如果一个 checkpoint 的 conversation.md 是 100KB，全部返回到 context 里吗？
- 工具结果的截断策略是什么？

### 4.3 `messages.json` 全保真存储的实际价值

设计声称"无法预知哪些细节将来会被需要"，所以全量保存。但思考实际场景：

Agent 需要回忆的通常是什么？
- 用户说过的约束条件 → 在 conversation.md 中（用户消息不会被截断）
- 之前的错误信息 → 在 conversation.md 中（工具输出截断到 3000 字符通常够用）
- 决策的上下文 → 在 summary.md 中
- 某个文件之前的内容 → **Agent 可以直接 `read` 那个文件**（或者用 `git log` 在项目 repo 里看）

真正需要全保真工具输出的场景极其少见。而 `messages.json` 可能占每个 checkpoint 的 90% 体积。

### 4.4 compaction 延迟预算

当前 compaction 流程（Pi 内置）：
1. 找切分点 — ~0ms
2. 序列化消息 — ~10ms
3. LLM 调用生成摘要 — ~3-10s
4. 追加 entry — ~1ms

git-mem 方案 A 增加：
5. 写文件到 .git-mem/ — ~50-200ms（取决于消息量）
6. git add + git commit — ~100-500ms
7. 额外 LLM 调用（如果自行生成摘要）— ~3-10s

总延迟可能从 ~5s 增加到 ~10-15s。这是一个明显的 UX 降级。
文档没有讨论延迟预算。

### 4.5 跨 session 的记忆隔离

`.git-mem/` 是项目级的，但 Pi 的 session 是独立的。
如果两个 session 在同一个项目目录下，它们共享同一个 `.git-mem/` 仓库。
这意味着 `mem_search` 可能返回来自另一个 session 的结果——这是 feature 还是 bug？
设计没有讨论。

---

## 五、改进建议

### 5.1 重新定位：不是"存储"，是"索引 + 检索接口"

既然 Pi JSONL 已经存了所有数据，git-mem 应该重新定位为：

> **给 Agent 提供一个检索已压缩上下文的索引和工具集。**

不需要 git，不需要冗余存储。需要的是：
1. 一个 checkpoint 索引（记录每次 compaction 的摘要 + entry ID 范围）
2. 检索工具（从 session JSONL 中读取指定范围的 entry）
3. 搜索工具（遍历 JSONL 中的历史 entry 做文本匹配）

### 5.2 修改后的架构草图

```
┌─────────────────────────────────────────────────┐
│                    Agent                         │
│                                                  │
│  Tools:                                          │
│    mem_log     — 列出历史 compaction 摘要         │
│    mem_recall  — 从指定 compaction 区间           │
│                  检索原始对话（分页/截断）          │
│    mem_search  — 搜索所有历史对话                  │
├─────────────────────────────────────────────────┤
│              Pi Extension                        │
│                                                  │
│  session_before_compact:                         │
│    → 不改变 compaction 行为                       │
│    → 仅在 summary 末尾追加 checkpoint ref         │
│    → 或者直接什么都不做 (return undefined)         │
│                                                  │
│  session_compact:                                │
│    → 记录 compaction entry 到内存索引              │
│                                                  │
│  before_agent_start:                             │
│    → 注入 system prompt 提示                      │
│    → 可选：自动搜索相关历史，注入摘要               │
├─────────────────────────────────────────────────┤
│           数据源：Pi Session JSONL                │
│           (已有数据，无需冗余存储)                  │
│                                                  │
│  ctx.sessionManager.getEntries()                 │
│  ctx.sessionManager.getEntry(id)                 │
│  ctx.sessionManager.getBranch(fromId)            │
└─────────────────────────────────────────────────┘
```

### 5.3 解决 recall 溢出问题

**方案：分页 + 截断 + 摘要优先**

```typescript
// mem_recall 不返回全量内容，而是分页
parameters: Type.Object({
  compactionId: Type.String({ description: "compaction entry ID" }),
  mode: StringEnum([
    "summary",       // 只返回摘要 (默认, ~2k tokens)
    "messages",      // 返回消息列表 (截断每条到 500 chars)
    "detail",        // 返回指定消息的完整内容
  ]),
  messageIndex: Type.Optional(Type.Number({
    description: "mode=detail 时，指定要查看的消息索引"
  })),
  maxChars: Type.Optional(Type.Number({
    description: "最大返回字符数 (默认 10000)"
  })),
})
```

Agent 的检索流程变为：
1. `mem_log` → 看有哪些 compaction checkpoints
2. `mem_recall(id, mode="summary")` → 看某个 checkpoint 的摘要
3. `mem_recall(id, mode="messages")` → 看消息列表概览（每条截断）
4. `mem_recall(id, mode="detail", messageIndex=7)` → 看第 7 条消息的完整内容

每一步返回的数据量都是可控的（默认 ≤10k chars ≈ 3k tokens），不会击穿 context。

### 5.4 保留 Git 的使用场景——但降级为可选后端

Git 不应该是核心架构，而是一个**可选的增强后端**：

- **默认后端**：直接从 Pi session JSONL 读取（零额外存储）
- **Git 后端**（可选）：同时将 checkpoint 写入 git repo，提供 `git grep` 加速搜索和跨 session 搜索

```typescript
interface MemoryBackend {
  index(compactionEntry: CompactionEntry): Promise<void>
  search(query: string): Promise<SearchResult[]>
  getMessages(fromId: string, toId: string): Promise<AgentMessage[]>
}

class SessionBackend implements MemoryBackend { /* 从 JSONL 读 */ }
class GitBackend implements MemoryBackend { /* 从 git repo 读 */ }
```

### 5.5 自动回忆应该是核心功能

最有价值的能力不是让 Agent 手动搜索记忆，而是**系统自动注入相关历史**：

```typescript
pi.on("before_agent_start", async (event, ctx) => {
  // 从用户的新 prompt 中提取关键词
  const keywords = extractKeywords(event.prompt);

  // 搜索历史 compaction summaries
  const relevant = searchCompactionSummaries(ctx.sessionManager, keywords);

  if (relevant.length > 0) {
    // 自动注入相关的历史摘要
    return {
      message: {
        customType: "git-mem-context",
        content: formatRelevantSummaries(relevant),
        display: false,
      }
    };
  }
});
```

这类似 RAG：用户的输入作为 query，历史 compaction summaries 作为文档库，
自动找到并注入相关的历史上下文。

---

## 六、保留什么、砍掉什么

### ✅ 保留（核心价值）

1. **Agent 可检索已压缩上下文的工具** — 这是真正的创新
2. **分页/截断的 recall 机制** — 解决 context 溢出
3. **compaction summary 中的 checkpoint 引用** — 提示 Agent 可以回忆
4. **system prompt 增强** — 告诉 Agent 有长期记忆
5. **自动回忆（RAG-like）** — 最可靠的记忆恢复方式

### ❌ 砍掉（过度设计）

1. **Git 作为必需存储后端** → 改为可选增强
2. **四文件结构** → 直接从 JSONL 读取
3. **messages.json 全保真存储** → 不需要冗余存储
4. **git 分支管理** → Pi tree 已经处理了
5. **mem_diff 工具** → 对话 diff 无意义
6. **方案 A（自定义 LLM 摘要调用）** → 复用 pi 内置 compaction，不增加 LLM 开销
7. **Serializer 类** → 直接用 pi 的 `serializeConversation()`

### ⚠️ 需要重新设计

1. **recall 的大小控制** — 必须有分页和截断
2. **自动回忆** — 从 future extension 提升为核心功能
3. **存储架构** — 从"冗余 git 存储"改为"JSONL 索引 + 检索"

---

## 七、修改后的实施阶段建议

### Phase 1: 最小可行版（纯 Pi 原生）

- 3 个工具：`mem_log`、`mem_recall`（带分页）、`mem_search`
- 数据源：直接读 `ctx.sessionManager.getEntries()`
- `session_compact` hook：记录 compaction 索引到内存
- `before_agent_start`：注入 system prompt 提示
- 不需要 git，不需要额外存储，不需要额外 LLM 调用

### Phase 2: 自动回忆

- `before_agent_start` 中根据用户 prompt 自动搜索相关历史
- 注入相关的 compaction summaries 到 context
- 关键词提取（简单的 tf-idf 或直接用 prompt 中的名词）

### Phase 3: Git 增强（可选）

- 可选的 git 后端用于跨 session 搜索
- 只存 `conversation.md`（单文件，不要四文件结构）
- 用于需要跨 session 记忆的高级用例
