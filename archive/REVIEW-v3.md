# 第三轮审查：Context 不是一篇文档，是一组结构化状态

## 上一轮的不足

REVIEW-v2 把 Context 定义为"一份持续维护的 CONTEXT.md"。
方向对了，但粒度太粗。一份单一的 markdown 文件无法满足实际需求。

## 用量化交易的例子说明

```
Session 进行中...

对话 1-20:  设计策略框架，确定用均线交叉 + RSI
对话 21-30: 参数 v1 (MA=10/20, RSI=70) → 回测 Sharpe=1.2, MaxDD=-18%
   ─── compaction ───
对话 31-40: 参数 v2 (MA=10/30, RSI=70) → 回测 Sharpe=1.5, MaxDD=-15%
   ─── compaction ───
对话 41-50: 参数 v3 (MA=10/30, RSI=65) → 回测 Sharpe=1.3, MaxDD=-20%
   ─── compaction ───
对话 51-60: 参数 v4 (MA=20/50, RSI=70) → 回测 Sharpe=1.1, MaxDD=-22%

此时用户说："v2 的结果最好，我们回到 v2 的参数，
                但是我想理解 MA 周期和 Sharpe 之间的关系"
```

**如果 Context 是单一文档**（REVIEW-v2 的方案），它长这样：

```markdown
# Context
## Strategy Parameters
MA fast=20, slow=50, RSI=70    ← 只有最新版
## Latest Backtest
Sharpe=1.1, MaxDD=-22%         ← 只有最新结果
## Decisions
- 选择均线交叉 + RSI 策略
```

v1、v2、v3 的参数和结果已经被"更新"掉了。Agent 没法回答用户的问题。

git 版本历史里虽然有 v1→v2→v3→v4 的 diff，但这些 diff 是整个文档的 diff，
参数变化和回测结果变化混在一起，不容易定向检索。

**如果 Context 是一组结构化文件**：

```
.git-mem/context/
├── strategy-params.md      ← 当前参数
├── backtest-results.md     ← 当前回测结果
├── strategy-design.md      ← 策略设计理念和框架
├── decisions.md            ← 决策日志
└── constraints.md          ← 约束条件
```

每个文件独立演化，git 分别追踪：

```
git log -- context/strategy-params.md
  abc1234  params v4: MA 20/50, RSI 70
  def5678  params v3: MA 10/30, RSI 65
  ghi9012  params v2: MA 10/30, RSI 70    ← 用户想要的版本
  jkl3456  params v1: MA 10/20, RSI 70

git log -- context/backtest-results.md
  abc1234  backtest v4: Sharpe 1.1, MaxDD -22%
  def5678  backtest v3: Sharpe 1.3, MaxDD -20%
  ghi9012  backtest v2: Sharpe 1.5, MaxDD -15%    ← 最优结果
  jkl3456  backtest v1: Sharpe 1.2, MaxDD -18%
```

Agent 可以：

```
mem_log(file="strategy-params.md")
→ 看到4个版本的参数历史

mem_recall(hash="ghi9012", file="strategy-params.md")
→ 拿到 v2 的确切参数

mem_recall(hash="ghi9012", file="backtest-results.md")
→ 拿到 v2 的确切回测结果

mem_diff(from="ghi9012", to="abc1234", file="strategy-params.md")
→ 看到 v2→v4 参数变化: MA 10/30→20/50, RSI 70→70(不变)

mem_diff(from="ghi9012", to="abc1234", file="backtest-results.md")
→ 看到 v2→v4 结果变化: Sharpe 1.5→1.1, MaxDD -15%→-22%
```

**Agent 就能回答："增大 MA 周期（10/30→20/50）导致 Sharpe 从 1.5 降到 1.1，建议回退到 v2 的 MA=10/30。"**

---

## 为什么多文件比单文件好

| | 单文件 CONTEXT.md | 多文件 context/ |
|---|---|---|
| 独立演化 | ❌ 所有 facet 混在一起 | ✅ 每个 facet 独立版本 |
| 定向检索 | ❌ 只能搜整个文档 | ✅ `git log -- <file>` |
| 定向 diff | ❌ diff 是整个文档的噪音 | ✅ 精确到某个 facet 的变化 |
| 定向回滚 | ❌ 回滚整个文档 | ✅ 只回滚某个 facet |
| 部分更新 | ❌ LLM 必须输出完整文档 | ✅ LLM 只输出变化的文件 |
| 大小控制 | ❌ 一个大文件难以分级 | ✅ 重要文件全量读，次要文件只看摘要 |

---

## 修正后的数据模型

### Context 目录结构

```
.git-mem/
├── .git/
└── context/
    ├── _index.md               ← 索引：列出所有 facet 及其当前摘要
    ├── goals.md                ← 通用：当前目标
    ├── decisions.md            ← 通用：决策日志（含理由）
    ├── constraints.md          ← 通用：约束条件
    ├── rejected.md             ← 通用：已探索但放弃的方向
    └── <domain-specific>.md    ← 领域相关：LLM 按需创建
```

**通用文件**（所有项目都有）：
- `_index.md` — 总索引，列出所有文件及其一行描述
- `goals.md` — 当前要达成的目标
- `decisions.md` — 关键决策及理由
- `constraints.md` — 约束条件
- `rejected.md` — 尝试过但放弃的方向

**领域文件**（LLM 根据对话内容创建）：
- 量化策略项目：`strategy-params.md`、`backtest-results.md`
- 系统设计项目：`architecture.md`、`api-design.md`
- Bug 修复：`bug-analysis.md`、`reproduction-steps.md`
- 重构项目：`refactor-plan.md`、`migration-status.md`

LLM 在更新 Context 时决定是否需要创建新文件。

### `_index.md` 的作用

```markdown
# Context Index

## Active Context Files

| File | Description | Last Updated |
|------|-------------|-------------|
| goals.md | 构建均线+RSI量化策略 | commit abc1234 |
| strategy-params.md | 当前参数: MA 20/50, RSI 70 | commit abc1234 |
| backtest-results.md | 最新回测: Sharpe 1.1, MaxDD -22% | commit abc1234 |
| decisions.md | 3个关键决策 | commit def5678 |
| constraints.md | 最大回撤限制-25%, 最小夏普1.0 | commit jkl3456 |

## Summary
正在迭代优化均线交叉+RSI策略的参数。已测试4组参数，
v2 (MA 10/30, RSI 70) 目前表现最优 (Sharpe 1.5)。
```

**`_index.md` 是整个 Context 的"摘要入口"。** 它的角色：
1. Compaction summary 从它生成（或它本身就是 summary）
2. Agent 先读 `_index.md` 了解有哪些 Context facet
3. 再定向读取需要的 facet

### Commit Message 格式

```
Update strategy-params (v3→v4), backtest-results

Changed:
- strategy-params.md: MA fast 10→20, slow 30→50
- backtest-results.md: Sharpe 1.3→1.1, MaxDD -20%→-22%
Unchanged: goals.md, decisions.md, constraints.md
```

Commit message 本身就是一份变更日志。
`git log --oneline` 给出 Context 演化的时间线。

---

## 修正后的操作流

### Compaction 流程

```
compaction 触发
    │
    ▼
session_before_compact hook
    │
    ├─ 1. 读取 .git-mem/context/ 所有当前文件
    │
    ├─ 2. 序列化 messagesToSummarize (+ turnPrefixMessages)
    │
    ├─ 3. Prompt LLM:
    │     "基于以下新对话，更新 Context 文件。
    │      你可以修改现有文件、创建新文件、或标记文件为不变。"
    │
    │     输入: 当前 Context 文件 + 新对话
    │     输出: 更新后的文件列表 (只需输出变化的文件)
    │
    ├─ 4. 写入变化的文件到 .git-mem/context/
    │     更新 _index.md
    │     git add + git commit
    │
    └─ 5. 返回给 pi:
          {
            compaction: {
              summary: _index.md 的内容 (作为 compaction summary),
              firstKeptEntryId: ...,
              tokensBefore: ...,
              details: { commitHash: "abc1234" }
            }
          }
```

**与 REVIEW-v2 的区别：**
- LLM 输出的不是一整份文档，而是一组文件的变更
- 只需要输出变化的文件，减少 LLM 输出量
- `_index.md` 自然地成为 compaction summary

### Recall 流程 (用量化交易场景)

```
用户: "v2 的参数是什么？回测结果怎么样？"

Agent 意识到当前 Context 中只有 v4 的信息
    │
    ▼
Agent 调用 mem_log(file="strategy-params.md")
    │
    ▼
返回:
  abc1234  params v4: MA 20/50, RSI 70
  def5678  params v3: MA 10/30, RSI 65
  ghi9012  params v2: MA 10/30, RSI 70
  jkl3456  params v1: MA 10/20, RSI 70
    │
    ▼
Agent 调用 mem_recall(hash="ghi9012", file="strategy-params.md")
→ "MA fast=10, slow=30, RSI threshold=70, ..."
    │
Agent 调用 mem_recall(hash="ghi9012", file="backtest-results.md")
→ "Sharpe=1.5, MaxDD=-15%, Win rate=58%, ..."
    │
    ▼
Agent 回答用户，并建议回退参数
```

每次 recall 返回的是一个精炼的 Context 文件（通常几百到几千字符），
**不是原始对话**，所以不会击穿 context window。

### 回滚流程

```
用户: "回到 v2 的参数"
    │
    ▼
Agent 调用 mem_recall(hash="ghi9012", file="strategy-params.md")
→ 获取 v2 的参数内容
    │
    ▼
Agent 用这些参数修改代码（通过 edit/write 工具）
    │
    ▼
下一次 compaction 时，Context 文件自然更新：
  strategy-params.md 回到 v2 的参数 (但在 git 里是一个新 commit)

git log 显示:
  new1234  params v5: reverted to v2 (MA 10/30, RSI 70)
  abc1234  params v4: MA 20/50, RSI 70
  ...
```

---

## 修正后的工具设计

```typescript
// mem_log — 查看 Context 的演化历史
parameters: {
  file: Optional(String),   // 指定查看某个 facet 的历史，不指定则看所有
  limit: Optional(Number),  // 默认 20
}
// 返回: commit 列表 (hash, 一行摘要, 时间, 变更的文件列表)

// mem_recall — 检索某个版本的 Context
parameters: {
  hash: String,              // commit hash
  file: Optional(String),    // 指定读某个文件，不指定则读 _index.md
}
// 返回: 指定文件在该 commit 时的内容

// mem_diff — 对比两个版本的 Context 变化
parameters: {
  from: String,              // 起始 commit hash
  to: String,                // 目标 commit hash
  file: Optional(String),    // 指定对比某个文件
}
// 返回: git diff 输出

// mem_search — 在 Context 历史中搜索
parameters: {
  query: String,             // 搜索关键词
  file: Optional(String),    // 限定在某个文件的历史中搜索
}
// 返回: 匹配的 commits + 匹配行
```

所有工具都新增了 `file` 参数来支持 per-facet 操作。
这是多文件架构的直接收益。

---

## 未解决问题 & 开放讨论

### 1. LLM 如何输出多文件更新？

compaction 时 LLM 需要输出"更新了哪些文件，内容是什么"。
需要一个结构化输出格式，例如：

```xml
<context-update>
<file path="strategy-params.md" action="update">
# Strategy Parameters (v4)
- MA fast period: 20
- MA slow period: 50
- RSI threshold: 70
</file>
<file path="backtest-results.md" action="update">
# Backtest Results (v4)
- Sharpe Ratio: 1.1
- Max Drawdown: -22%
</file>
<file path="goals.md" action="unchanged" />
<file path="_index.md" action="update">
...
</file>
</context-update>
```

### 2. Context 文件总大小预算

所有 Context 文件加起来不应超过一个阈值（如 8k tokens），
否则 _index.md 作为 compaction summary 会太大。

当总大小接近预算时，LLM 应该被指示精炼/合并信息。
低优先级信息移入 `rejected.md` 或直接删减。

### 3. 新建文件的时机

LLM 什么时候应该创建新的领域文件？应该在 prompt 中指导：
- 当对话引入了一个新的独立关注点时
- 当某类信息需要独立追踪版本时
- 不要为临时/一次性的信息创建文件

### 4. 与 JSONL 原始数据的桥接

Context 文件是精炼后的信息。偶尔 Agent 需要原始细节
（如某次回测的完整输出表格）。可以：
- 在 Context 文件中标注 `[ref: entry-id]` 指向 JSONL 中的原始 entry
- 提供一个补充工具从 session JSONL 读取原始 entry
- 这是 Context (精炼) + JSONL (原始) 的组合方案

### 5. 当前 DESIGN.md 中保留什么

| DESIGN.md 内容 | 处置 |
|---|---|
| 三层架构 (Core/Extension/Tools) | ✅ 保留 |
| git 作为版本控制 | ✅ 保留，但角色修正为"Context 版本控制" |
| Pi extension hook 映射 | ✅ 保留 |
| 4个记忆工具 | ✅ 保留，增加 `file` 参数 |
| system prompt 增强 | ✅ 保留 |
| 四文件结构 (conversation/messages/summary/metadata) | ❌ 替换为多文件 Context 目录 |
| conversation.md 存原始对话 | ❌ 删除 |
| messages.json 全保真存储 | ❌ 删除 |
| git 分支管理 | ⚠️ MVP 可以不做 |
| 方案 A (自定义 LLM) | ✅ 保留，但 prompt 改为"更新 Context 文件" |
