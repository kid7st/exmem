# git-mem: Git-based Context Memory for AI Agents

## 1. Problem Statement

### 1.1 当前的 Context 压缩是有损的

LLM 的 context window 有限。当对话增长到一定程度后，必须压缩。Pi 现有的压缩机制
（compaction）是**不可逆的有损压缩**：

```
完整 context (100k tokens)
    ↓ compaction
摘要 (2k tokens) + 最近的消息 (20k tokens)
```

被压缩掉的 ~78k tokens 的细节**永久丢失**。Agent 无法再回答：

- "之前那个 auth bug 的确切报错信息是什么？"
- "我们第一次尝试的方案具体是怎样的？"
- "用户半小时前提到的那个约束条件具体是什么？"

### 1.2 核心矛盾

- **活跃 context 必须小**（受限于 context window）
- **历史细节需要保留**（Agent 可能随时需要）

这是一个经典的"缓存 vs 存储"问题。现有方案只有缓存（活跃 context），没有存储（持久化的可检索记忆）。

---

## 2. Core Insight: Git 即 Context 版本管理

Git 的语义天然映射到 context 管理：

| Git 概念 | Context 管理 | 作用 |
|---------|-------------|------|
| Repository | 记忆存储 | 所有历史 context 的持久化容器 |
| Commit | 上下文检查点 | 完整 context 的一次快照 |
| Commit message | 压缩摘要 | 检查点的概览（即 compaction summary） |
| `git log` | 记忆索引 | 浏览所有检查点的摘要 |
| `git show` | 细节检索 | 从特定检查点恢复完整 context |
| `git branch` | 对话分支 | 平行的探索路径 |
| `git diff` | 变更对比 | 两个检查点之间的差异 |
| `git grep` | 全文搜索 | 跨所有检查点搜索具体信息 |

### 2.1 git-mem 的 context 流

```
完整 context (100k tokens)
    ↓ git commit (全量保存到 git)
    ↓ compaction
摘要 (2k tokens) + 最近的消息 (20k tokens)

    ... 后续 Agent 需要细节 ...
    ↓ mem_search / mem_recall (从 git 检索)
恢复出所需的完整细节
```

**活跃 context 的压缩比不变**（依然受限于 context window），但细节被完整保存在
git 中，可按需检索。

---

## 3. Architecture Overview

```
┌───────────────────────────────────────────────────────────┐
│                         Agent                             │
│  (LLM + active context window)                            │
│                                                           │
│  Tools available:                                         │
│    read, bash, edit, write          ← 常规工具             │
│    mem_log, mem_recall,             ← git-mem 提供的       │
│    mem_search, mem_diff                 记忆检索工具        │
├───────────────────────────────────────────────────────────┤
│                    Pi Extension Layer                      │
│                                                           │
│  session_before_compact  ──→  checkpoint (git commit)     │
│  session_before_tree     ──→  branch (git branch)         │
│  before_agent_start      ──→  system prompt 增强           │
│  session_start           ──→  初始化 / 状态恢复            │
│  session_shutdown        ──→  清理                         │
├───────────────────────────────────────────────────────────┤
│                    GitMem Core Library                     │
│                                                           │
│  GitMem          ── 主入口，编排所有操作                     │
│  ├── GitOps      ── Git CLI 封装（init, commit, log, ...） │
│  ├── Serializer  ── Context → 文件序列化                    │
│  └── Types       ── 类型定义                               │
├───────────────────────────────────────────────────────────┤
│                    Git Repository                          │
│                    (.git-mem/)                             │
│                                                           │
│  main ─── [ckpt-0] ─── [ckpt-1] ─── [ckpt-2]            │
│                │                                          │
│                └── session/abc/1 ─── [ckpt-3]             │
└───────────────────────────────────────────────────────────┘
```

系统分为三层：

1. **Core Library** — 纯粹的 git-based 记忆管理，不依赖 pi
2. **Pi Extension** — 接入 pi 的生命周期钩子和工具系统
3. **Agent Tools** — LLM 可调用的记忆检索工具

---

## 4. Data Model

### 4.1 Git 仓库结构

```
.git-mem/                         ← 独立的 git 仓库（不影响项目 .git）
├── .git/
└── context/                      ← 每次 commit 更新此目录
    ├── conversation.md           ← 人类可读的对话文本（截断的工具输出）
    ├── messages.json             ← 完整结构化消息（无截断，全保真）
    ├── summary.md                ← 本次 compaction 生成的摘要
    └── metadata.json             ← 检查点元数据
```

每次 compaction 时，更新 `context/` 目录下的文件并 commit。
Git 的 delta 压缩天然处理增量变化。

### 4.2 各文件内容详解

#### `conversation.md` — 人类可读 & 可搜索

```markdown
# Conversation Checkpoint
Timestamp: 2025-03-21T10:30:00Z
Messages: 24 | Tokens before: 98,432

---

## [User] (10:00)
帮我重构 auth 模块，把 JWT 验证逻辑抽出来

## [Assistant] (10:01)
好的，让我先看看现有的代码结构。

### Tool Call: read
path: src/auth/middleware.ts

### Tool Result
```typescript
export function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  // ... (showing first 3000 chars, 2847 chars truncated)
```

## [User] (10:05)
还要确保向后兼容，不要改变公开的 API 接口

...
```

**设计要点：**
- 工具输出截断到 `toolResultTruncation`（默认 3000 字符），保持可读性
- 保持完整的对话流结构，用 markdown heading 区分角色
- 适合 `git grep` 全文搜索

#### `messages.json` — 全保真结构化数据

```json
[
  {
    "role": "user",
    "content": "帮我重构 auth 模块...",
    "timestamp": 1711008000000
  },
  {
    "role": "assistant",
    "content": [
      { "type": "thinking", "thinking": "..." },
      { "type": "text", "text": "好的，让我先看看..." },
      { "type": "toolCall", "id": "call_1", "name": "read", "arguments": { "path": "src/auth/middleware.ts" } }
    ],
    "model": "claude-sonnet-4-5",
    "usage": { "input": 1234, "output": 567 }
  },
  {
    "role": "toolResult",
    "toolCallId": "call_1",
    "toolName": "read",
    "content": [{ "type": "text", "text": "... 完整文件内容，无截断 ..." }],
    "isError": false
  }
]
```

**设计要点：**
- 保留完整的消息结构，包括 thinking、tool calls、usage 等
- 不做任何截断 — 这是"全保真存储"
- 当 Agent 需要确切细节时，从这里读取

#### `summary.md` — Compaction 摘要

存储 pi compaction 生成的结构化摘要，格式与 pi 现有摘要一致：

```markdown
## Goal
重构 auth 模块，将 JWT 验证逻辑抽取为独立服务

## Progress
### Done
- [x] 分析了现有 auth middleware 结构
- [x] 识别出 JWT 验证、token 刷新、权限检查三个关注点

### In Progress
- [ ] 创建 JwtService 类

## Key Decisions
- **选择 class 而非函数**: 便于依赖注入和测试
- **保持 middleware 签名不变**: 向后兼容

## Next Steps
1. 完成 JwtService 实现
2. 更新 middleware 使用新 service

## Critical Context
- 用户要求不改变公开 API 接口
- Memory checkpoint: abc1234 (use mem_recall for full details)
```

**设计要点：**
- 最后一行嵌入 commit hash 引用，提示 Agent 可用 `mem_recall` 获取细节
- 格式与 pi 原生摘要完全兼容

#### `metadata.json` — 检查点元数据

```json
{
  "sessionId": "a1b2c3d4-...",
  "compactionIndex": 2,
  "tokensBefore": 98432,
  "messageCount": 24,
  "timestamp": "2025-03-21T10:30:00.000Z",
  "firstKeptEntryId": "e5f6g7h8",
  "readFiles": ["src/auth/middleware.ts", "src/auth/types.ts"],
  "modifiedFiles": ["src/auth/jwt-service.ts"],
  "branch": "main",
  "previousCheckpoint": "def5678"
}
```

### 4.3 Commit Message 格式

```
[checkpoint] 重构 auth 模块：完成 JWT 验证逻辑分析，开始创建 JwtService

## Goal
重构 auth 模块，将 JWT 验证逻辑抽取为独立服务

## Progress
### Done
- [x] 分析了现有 auth middleware 结构
...

---
session: a1b2c3d4
compaction: 2
tokens-before: 98432
messages: 24
```

**设计要点：**
- 第一行是单行摘要（适合 `git log --oneline`）
- 正文是完整结构化摘要（适合 `git log --grep` 搜索）
- 尾部元数据行方便脚本解析

### 4.4 Git 分支模型

```
Git 分支映射对话分支:

main ─── [ckpt-0] ─── [ckpt-1] ─── [ckpt-2] ─── [ckpt-3]
              │
              └── session/abc/branch-1 ─── [ckpt-4] ─── [ckpt-5]
                        │
                        └── session/abc/branch-2 ─── [ckpt-6]
```

分支命名规则：`session/<session-id-prefix>/<branch-index>`

当 Pi 的 `/tree` 导航触发时：
- 在旧分支上提交分支摘要
- 从当前检查点创建新 git 分支
- 后续检查点提交到新分支

---

## 5. Operation Flows

### 5.1 Checkpoint（压缩时保存）

```
Pi compaction 触发
    │
    ▼
session_before_compact 事件
    │
    ▼
git-mem 拦截:
    │
    ├─ 1. 序列化 messagesToSummarize
    │     ├─ → context/conversation.md  (人类可读, 截断)
    │     ├─ → context/messages.json    (结构化, 全保真)
    │     └─ → context/metadata.json    (元数据)
    │
    ├─ 2. 也序列化 turnPrefixMessages (如果是 split turn)
    │     (追加到 conversation.md 和 messages.json)
    │
    ├─ 3. 让 pi 正常生成摘要 (或自行生成)
    │     → context/summary.md
    │
    ├─ 4. git add context/ && git commit
    │     commit message = 结构化摘要
    │     得到 commitHash
    │
    └─ 5. 返回给 pi:
          {
            compaction: {
              summary: "摘要文本...\n\nMemory checkpoint: <hash>",
              firstKeptEntryId: ...,
              tokensBefore: ...,
              details: {
                commitHash: "abc1234",
                branch: "main",
                compactionIndex: 2,
                readFiles: [...],
                modifiedFiles: [...]
              }
            }
          }
```

**关键决策：先 commit 再 compact，还是先 compact 再 commit？**

选择 **拦截 → 存储 → 让 pi 生成摘要 → commit → 返回**：
- 拦截 `session_before_compact`
- 先将原始消息序列化到文件
- 然后将 pi 正常生成的摘要（或自行调用 LLM 生成）写入 summary.md
- 一次性 commit
- 在摘要末尾追加 checkpoint 引用，返回给 pi

但 pi 的 `session_before_compact` 钩子要求我们**直接返回**自定义摘要或不返回（让 pi 自己生成）。如果我们想用 pi 自己的摘要但同时存储原始消息，有两条路：

**方案 A：完全自定义 compaction**
- 在 `session_before_compact` 中：序列化消息 → 自行调用 LLM 生成摘要 → commit → 返回自定义 compaction
- 优点：完全控制
- 缺点：多一次 LLM 调用的开销

**方案 B：存储 + 透传**
- 在 `session_before_compact` 中：序列化消息 → commit（摘要用占位符）→ 返回 `undefined`（让 pi 正常生成摘要）
- 在 `session_compact` 中：用 pi 生成的摘要去 amend 最后的 commit message
- 优点：复用 pi 的摘要逻辑
- 缺点：需要 git amend，略复杂

**推荐方案 A**，因为：
1. 控制更完整
2. 可以选择更便宜的模型做摘要（如 Gemini Flash）
3. 可以在摘要中嵌入 checkpoint 引用
4. 避免 race condition

### 5.2 Recall（检索细节）

```
Agent 意识到需要历史细节
    │
    ▼
Agent 调用 mem_log(limit=10)
    │
    ▼
git-mem 执行 git log --oneline -10
    │
    ▼
返回检查点列表:
    abc1234  [checkpoint] 重构 auth 模块：完成分析
    def5678  [checkpoint] 实现 JwtService 基础结构
    ...
    │
    ▼
Agent 识别出需要 abc1234 的细节
    │
    ▼
Agent 调用 mem_recall(hash="abc1234", section="conversation")
    │
    ▼
git-mem 执行 git show abc1234:context/conversation.md
    │
    ▼
返回完整的对话文本
    │
    ▼
Agent 获得所需的细节信息，继续工作
```

### 5.3 Search（搜索记忆）

```
Agent 需要找 "JWT 验证失败的报错"
    │
    ▼
Agent 调用 mem_search(query="JWT 验证失败")
    │
    ▼
git-mem 执行两种搜索:
    │
    ├─ 1. git log --all --grep="JWT 验证失败"
    │     搜索 commit messages（摘要层面）
    │
    └─ 2. git grep "JWT 验证失败" <each-checkpoint>
          搜索文件内容（对话细节层面）
    │
    ▼
合并结果，返回:
    [
      { hash: "abc1234", summary: "...", matches: ["第15行: JWT 验证失败: TokenExpiredError..."] },
      { hash: "ghi9012", summary: "...", matches: ["第42行: 测试 JWT 验证失败场景..."] }
    ]
    │
    ▼
Agent 选择相关的 checkpoint，用 mem_recall 获取细节
```

### 5.4 Branch（分支管理）

```
Pi /tree 导航触发
    │
    ▼
session_before_tree 事件
    │
    ▼
git-mem 拦截:
    │
    ├─ 如果 userWantsSummary:
    │     1. 生成分支摘要
    │     2. commit 到当前 git 分支
    │     3. 创建新 git 分支 (从当前 checkpoint 分叉)
    │     4. 返回自定义摘要
    │
    └─ 如果不需要摘要:
          1. 创建新 git 分支
          2. 返回 undefined (不提供摘要)
    │
    ▼
后续 checkpoint 提交到新的 git 分支
```

### 5.5 Diff（变更对比）

```
Agent 调用 mem_diff(from="abc1234", to="def5678")
    │
    ▼
git-mem 执行 git diff abc1234 def5678 -- context/
    │
    ▼
返回差异:
    --- a/context/summary.md
    +++ b/context/summary.md
    @@ -3,7 +3,9 @@
     ## Progress
     ### Done
     - [x] 分析了现有 auth middleware 结构
    +- [x] 创建了 JwtService 类
    +- [x] 完成了基础验证逻辑
    ...
```

---

## 6. Hierarchical Memory Index

git-mem 天然形成多层级的记忆索引：

```
Level 3 (最粗):  git branch --list
                 → 有哪些对话分支

Level 2 (概览):  git log --oneline --all
                 → 所有检查点的单行摘要

Level 1 (摘要):  git show <hash>:context/summary.md
                 → 某个检查点的结构化摘要

Level 0 (全量):  git show <hash>:context/conversation.md
                 git show <hash>:context/messages.json
                 → 完整的对话细节
```

Agent 从粗到细导航：
1. `mem_log` → Level 2（哪些检查点存在？）
2. 识别目标检查点
3. `mem_recall(section="summary")` → Level 1（这个检查点的摘要是什么？）
4. `mem_recall(section="conversation")` → Level 0（具体对话内容是什么？）

---

## 7. Pi Extension Integration Points

### 7.1 Hook 映射

| Pi Event | git-mem 行为 | 必要性 |
|----------|-------------|--------|
| `session_start` | 初始化 git 仓库 / 从 session entries 恢复状态 | 必要 |
| `session_before_compact` | **核心**：序列化 → commit → 返回自定义 compaction | 必要 |
| `session_compact` | （如果用方案 B）用 pi 摘要 amend commit | 方案 B |
| `session_before_tree` | 创建 git 分支 | 必要 |
| `session_tree` | 切换到新 git 分支 | 必要 |
| `before_agent_start` | 注入记忆能力提示到 system prompt | 推荐 |
| `session_shutdown` | 可选的 git gc | 可选 |

### 7.2 工具注册

通过 `pi.registerTool()` 注册 4 个记忆工具：

| 工具 | 描述 | 参数 |
|------|------|------|
| `mem_log` | 浏览检查点历史 | `{ limit?, branch?, grep? }` |
| `mem_recall` | 检索检查点细节 | `{ hash, section? }` |
| `mem_search` | 跨检查点搜索 | `{ query, scope? }` |
| `mem_diff` | 对比两个检查点 | `{ from, to }` |

### 7.3 System Prompt 增强

在 `before_agent_start` 中追加：

```markdown
## Extended Memory (git-mem)

你拥有基于 Git 的持久长期记忆。当你的 context 被压缩时，完整的对话细节
会被保存为记忆检查点（memory checkpoints）。你可以随时检索过去的细节：

- `mem_log`: 浏览检查点历史（显示摘要列表）
- `mem_recall`: 从特定检查点检索完整细节
- `mem_search`: 跨所有检查点搜索特定信息
- `mem_diff`: 对比两个检查点之间的变化

**何时使用记忆工具：**
- 当你需要之前对话中的确切细节（报错信息、代码片段、具体数值）
- 当你注意到 context 已经被压缩，需要之前的信息
- 当用户询问之前讨论过但你无法完全回忆的内容
- 当你发现 summary 中有 "Memory checkpoint: <hash>" 引用时

当前记忆状态: {N} 个检查点, 分支 "{branch}"
```

### 7.4 CompactionEntry.details 结构

```typescript
interface GitMemCompactionDetails {
  /** git-mem commit hash for this checkpoint */
  commitHash: string;

  /** git branch name */
  branch: string;

  /** Sequential compaction index */
  compactionIndex: number;

  /** Files read during this context window */
  readFiles: string[];

  /** Files modified during this context window */
  modifiedFiles: string[];
}
```

这存储在 pi 的 session JSONL 中，作为 CompactionEntry 的 `details` 字段。
使 pi 的 session 和 git-mem 的 checkpoint 产生交叉引用。

---

## 8. API Design

### 8.1 Core Library: `GitMem` class

```typescript
class GitMem {
  constructor(config: Partial<GitMemConfig>)

  /** 初始化 git 仓库（如果不存在）*/
  init(): Promise<void>

  /** 创建检查点：序列化 context 并 commit */
  checkpoint(snapshot: ContextSnapshot): Promise<Checkpoint>

  /** 浏览检查点历史 */
  log(options?: LogOptions): Promise<Checkpoint[]>

  /** 检索检查点细节 */
  recall(hash: string, options?: RecallOptions): Promise<RecallResult>

  /** 搜索所有检查点 */
  search(query: string, scope?: "summaries" | "content" | "all"): Promise<SearchResult[]>

  /** 对比两个检查点 */
  diff(fromHash: string, toHash: string): Promise<string>

  /** 创建新分支 */
  createBranch(name: string, fromHash?: string): Promise<void>

  /** 切换分支 */
  switchBranch(name: string): Promise<void>

  /** 列出所有分支 */
  getBranches(): Promise<{ name: string; current: boolean }[]>

  /** 获取当前分支名 */
  getCurrentBranch(): Promise<string>

  /** 获取检查点数量 */
  getCheckpointCount(): Promise<number>
}
```

### 8.2 Core Library: `GitOps` class (内部)

```typescript
class GitOps {
  constructor(repoPath: string)

  /** 底层 git 命令执行 */
  exec(args: string[]): Promise<{ stdout: string; stderr: string; code: number }>

  init(): Promise<void>
  add(paths: string[]): Promise<void>
  commit(message: string, options?: { allowEmpty?: boolean }): Promise<string>  // returns hash
  log(format: string, options?: { limit?: number; all?: boolean; grep?: string; branch?: string }): Promise<string>
  show(ref: string, path: string): Promise<string>
  grep(query: string, ref?: string): Promise<string>
  diff(ref1: string, ref2: string, paths?: string[]): Promise<string>
  branch(name: string, startPoint?: string): Promise<void>
  checkout(ref: string): Promise<void>
  branchList(): Promise<string[]>
  currentBranch(): Promise<string>
  revParse(ref: string): Promise<string>
  isRepo(): Promise<boolean>
}
```

### 8.3 Core Library: `Serializer` class (内部)

```typescript
class Serializer {
  constructor(config: GitMemConfig)

  /** 将消息数组序列化为人类可读的 markdown */
  toConversationMd(messages: unknown[], metadata?: Record<string, unknown>): string

  /** 将消息数组序列化为 JSON (全保真) */
  toMessagesJson(messages: unknown[]): string

  /** 将元数据序列化为 JSON */
  toMetadataJson(metadata: CheckpointMetadata): string

  /** 将摘要文本写入 markdown，追加 checkpoint 引用 */
  toSummaryMd(summary: string, commitHash?: string): string

  /** 将 ContextSnapshot 写入到 repoPath/context/ 目录 */
  writeSnapshot(repoPath: string, snapshot: ContextSnapshot): Promise<void>

  /** 从 git show 输出反序列化 */
  parseConversationMd(content: string): string
  parseMessagesJson(content: string): unknown[]
  parseMetadataJson(content: string): CheckpointMetadata
}
```

### 8.4 Type Definitions

```typescript
// ─── Configuration ───
interface GitMemConfig {
  repoPath: string                // 默认: "<cwd>/.git-mem"
  defaultBranch: string           // 默认: "main"
  maxConversationSize: number     // 默认: 500_000 (chars)
  toolResultTruncation: number    // 默认: 3000 (chars)
}

// ─── Checkpoint ───
interface Checkpoint {
  hash: string
  summary: string        // 单行摘要 (commit message 第一行)
  fullMessage: string    // 完整 commit message
  timestamp: Date
  branch: string
  parentHash?: string
}

// ─── Context Snapshot ───
interface ContextSnapshot {
  conversation: string   // 人类可读 markdown
  messages: unknown[]    // 结构化消息 (全保真)
  summary: string        // compaction 摘要
  metadata: CheckpointMetadata
}

interface CheckpointMetadata {
  sessionId?: string
  compactionIndex: number
  tokensBefore?: number
  messageCount: number
  timestamp: string
  firstKeptEntryId?: string
  readFiles?: string[]
  modifiedFiles?: string[]
  branch: string
  previousCheckpoint?: string
}

// ─── Search & Retrieval ───
interface RecallResult {
  checkpoint: Checkpoint
  conversation?: string
  messages?: unknown[]
  metadata?: CheckpointMetadata
  summary?: string
}

interface SearchResult {
  checkpoint: Checkpoint
  matches: string[]      // 匹配的行/摘录
}

interface LogOptions {
  limit?: number          // 默认: 20
  branch?: string
  all?: boolean
  grep?: string
}

interface RecallOptions {
  section?: "conversation" | "messages" | "metadata" | "summary" | "all"
}
```

### 8.5 Pi Extension: 导出函数签名

```typescript
// pi-extension/index.ts
export default function gitMemExtension(pi: ExtensionAPI): void
```

内部注册的 hooks 和 tools（见 §7）。

### 8.6 Memory Tools Schema

```typescript
// mem_log
parameters: Type.Object({
  limit: Type.Optional(Type.Number({ description: "最多返回几个检查点 (默认 20)" })),
  branch: Type.Optional(Type.String({ description: "指定分支 (默认当前分支)" })),
  grep: Type.Optional(Type.String({ description: "在摘要中搜索关键词" })),
  all: Type.Optional(Type.Boolean({ description: "显示所有分支 (默认 false)" })),
})

// mem_recall
parameters: Type.Object({
  hash: Type.String({ description: "检查点的 git commit hash" }),
  section: Type.Optional(StringEnum([
    "conversation",  // 人类可读对话 (默认)
    "messages",      // 完整结构化消息
    "metadata",      // 元数据
    "summary",       // compaction 摘要
    "all",           // 全部内容
  ])),
})

// mem_search
parameters: Type.Object({
  query: Type.String({ description: "搜索关键词" }),
  scope: Type.Optional(StringEnum([
    "summaries",  // 只搜索 commit messages
    "content",    // 只搜索对话内容 (git grep)
    "all",        // 两者都搜索 (默认)
  ])),
})

// mem_diff
parameters: Type.Object({
  from: Type.String({ description: "起始检查点 hash" }),
  to: Type.String({ description: "目标检查点 hash" }),
})
```

---

## 9. File & Module Structure

```
git-mem/
├── package.json
├── tsconfig.json
├── README.md
├── DESIGN.md                     ← 本文档
│
├── src/
│   ├── index.ts                  ← 公开导出: GitMem, types
│   │
│   ├── core/
│   │   ├── types.ts              ← 所有类型定义
│   │   ├── git-ops.ts            ← Git CLI 封装
│   │   ├── serializer.ts         ← Context 序列化
│   │   └── git-mem.ts            ← GitMem 主类
│   │
│   ├── pi-extension/
│   │   ├── index.ts              ← Pi extension 入口 (export default)
│   │   ├── hooks.ts              ← session_before_compact 等 hook 实现
│   │   ├── tools.ts              ← mem_log/recall/search/diff 工具定义
│   │   └── prompt.ts             ← system prompt 增强文本
│   │
│   └── tests/
│       ├── git-mem.test.ts       ← Core library 测试
│       ├── serializer.test.ts    ← 序列化测试
│       └── integration.test.ts   ← 端到端集成测试
│
└── examples/
    ├── standalone.ts             ← 不依赖 pi 的独立用法
    └── pi-setup.md               ← Pi 集成配置指南
```

---

## 10. Edge Cases & Error Handling

### 10.1 Git 不可用

```typescript
async init(): Promise<void> {
  try {
    await this.gitOps.exec(["--version"]);
  } catch {
    throw new GitMemError(
      "Git is not installed or not in PATH. git-mem requires git.",
      "GIT_NOT_FOUND"
    );
  }
}
```

Pi extension 中优雅降级：初始化失败时 `ctx.ui.notify()` 警告，不阻断正常 compaction。

### 10.2 首次 Compaction

没有前序 checkpoint，`metadata.previousCheckpoint` 为 undefined。
直接初始化 repo + 首次 commit。

### 10.3 非常大的消息

- `conversation.md`: 工具输出截断到 `toolResultTruncation`
- `messages.json`: 不截断（全保真），但如果单个文件超过 `maxConversationSize`，
  在 metadata 中标记 `"truncated": true`
- Git 能处理大文件，但 `git grep` 在大文件上可能慢

### 10.4 图片内容

- `conversation.md`: 标记 `[Image: image/png, 125KB]`，不嵌入二进制
- `messages.json`: 保留 base64 data（全保真）
- 可配置是否在 messages.json 中跳过图片 base64 以节省空间

### 10.5 Concurrent Compaction

Git 有内置的 lockfile 机制。如果两个进程同时 commit，后者会等待或失败。
在 `checkpoint()` 中重试一次即可。

### 10.6 Git 仓库损坏

```typescript
async checkpoint(snapshot): Promise<Checkpoint> {
  try {
    // normal flow
  } catch (error) {
    // 仓库损坏: 尝试重新初始化
    await this.reinitialize();
    // 重试一次
    return this.checkpointInternal(snapshot);
  }
}
```

最坏情况下丢失 git 历史，但不影响 pi 的正常运行（compaction 回退到 pi 默认行为）。

### 10.7 Split Turn

Pi 的 split turn 场景下，`messagesToSummarize` 可能为空，
`turnPrefixMessages` 包含被分割的 turn 前半部分。

处理方式：将 `turnPrefixMessages` 也序列化到 checkpoint 中，
在 metadata 中标记 `isSplitTurn: true`。

### 10.8 Session 恢复

Pi extension 在 `session_start` 中需要从 session entries 恢复 git-mem 状态：
- 遍历 `ctx.sessionManager.getEntries()` 
- 找到所有 `type === "compaction"` 且 `details.commitHash` 存在的条目
- 恢复 `compactionIndex` 和当前 `branch`

### 10.9 仓库体积增长

长期使用后 `.git-mem/` 可能增大。缓解措施：
- Git 自身的 delta 压缩和 packfile 机制
- 可选：`session_shutdown` 时运行 `git gc`
- 可选：提供 `/mem-gc` 命令清理旧分支
- 可选配置：`maxCheckpoints` 超过后 squash 早期 commits

---

## 11. Design Trade-offs & Alternatives

### 11.1 为什么选择 Git 而非其他存储？

| 方案 | 优点 | 缺点 |
|------|------|------|
| **Git (chosen)** | 天然版本控制、分支、diff、grep；无额外依赖；开发者熟悉 | grep 搜索非语义化；大文件可能慢 |
| SQLite + FTS5 | 更快的全文搜索 | 无分支/diff概念；额外依赖 |
| Vector DB | 语义搜索 | 需要 embedding 模型；复杂；丧失精确检索 |
| 纯文件 + JSON Index | 最简单 | 无 diff、无分支、搜索差 |

Git 的优势在于它**天然就是为"版本化的文本存储 + 分支"设计的**，
这与 context 管理的需求完美匹配。

### 11.2 全保真 vs 选择性保存

我们选择**全保真存储**（`messages.json` 不截断），因为：
- 存储成本低（磁盘空间相对于 LLM API 费用微不足道）
- 无法预知哪些细节将来会被需要
- Git 的 delta 压缩处理重复内容

`conversation.md` 则做适度截断，用于搜索和快速浏览。

### 11.3 方案 A vs 方案 B（compaction 集成方式）

见 §5.1 的讨论。推荐方案 A（完全自定义 compaction）：
- 不依赖 pi 的 amend 流程
- 可用更便宜的模型
- 一次性完成 序列化 → 生成摘要 → commit → 返回

### 11.4 何时 commit？

**选项 1: 仅在 compaction 时 commit**（推荐初始版本）
- 简单，仅在需要时存储
- 每次 compaction = 一个 checkpoint

**选项 2: 每个 turn 结束时 commit**
- 更细粒度的历史
- 但 commit 过多，repo 增长快
- 可作为可选 feature

**选项 3: 手动 commit（/mem-save）**
- 用户控制，按需保存
- 可与选项 1 并存

初始版本实现选项 1，后续可扩展。

---

## 12. Future Extensions

### 12.1 语义搜索增强

在 `mem_search` 之上增加 embedding-based 语义搜索：
- 每次 checkpoint 时为 summary 和 conversation 生成 embedding
- 存储在 git repo 中的 `embeddings/` 目录
- 搜索时同时进行关键词搜索和向量搜索

### 12.2 跨 Session 记忆

将 git-mem 仓库设为项目级（而非 session 级），
不同 session 的记忆都在同一仓库的不同分支上。
Agent 可以跨 session 搜索历史信息。

### 12.3 远程记忆

`git push` 到远程仓库，实现：
- 团队共享的项目记忆
- 跨设备的记忆同步
- 记忆的备份和持久化

### 12.4 记忆合并

当两个分支产生互补的知识时，`git merge` 可以合并记忆。
需要自定义 merge strategy 处理 conversation.md 和 messages.json 的冲突。

### 12.5 自动回忆

在 `before_agent_start` 或 `context` hook 中，根据用户的新 prompt
自动搜索相关的历史记忆，并注入到 context 中（类似 RAG）。

```
用户输入: "继续之前的 auth 模块重构"
    ↓
git-mem 自动搜索 "auth 模块重构"
    ↓
找到相关 checkpoint, 注入 summary 到 context
    ↓
Agent 自动获得相关的历史上下文
```

---

## 13. Implementation Phases

### Phase 1: Core (MVP)
- [ ] `GitOps` — Git CLI 封装
- [ ] `Serializer` — 消息序列化 (conversation.md + messages.json)
- [ ] `GitMem` — 主类 (init, checkpoint, log, recall, search, diff)
- [ ] 基础测试

### Phase 2: Pi Extension
- [ ] `session_before_compact` hook — 核心 checkpoint 流程
- [ ] 4 个记忆工具 (mem_log, mem_recall, mem_search, mem_diff)
- [ ] `before_agent_start` — system prompt 增强
- [ ] `session_start` — 状态恢复
- [ ] `session_before_tree` / `session_tree` — 分支管理

### Phase 3: Polish
- [ ] 错误处理和优雅降级
- [ ] 配置系统（settings.json 集成）
- [ ] `/mem-status` 命令
- [ ] 文档和示例

### Phase 4: Advanced (Future)
- [ ] 每 turn commit (可选)
- [ ] 语义搜索
- [ ] 自动回忆 (RAG-like)
- [ ] 远程仓库同步
