# git-mem: LLM Agent 的外部认知记忆系统

## 1. 问题

LLM Agent 在工作中会通过对话**逐步构建一个心智模型**——对项目的理解、
做出的决策、发现的约束、尝试过的方案。这个心智模型是对话的**产物**，
不是对话本身。

当 context window 满了，compaction 发生。现有的 compaction 机制将心智模型
压缩为一段摘要文本。这个过程有三个根本缺陷：

1. **每次从头生成**，不是在前一版基础上增量更新——信息在多轮 compaction 中逐渐衰减
2. **扁平无结构**——无法定向查询某个 facet（"v2 的参数是什么？"）
3. **没有历史**——无法回溯心智模型的演化过程（"什么时候改的参数？改了什么？"）

注意：原始对话数据并没有丢失（Pi 的 session JSONL 完整保留了所有 entry）。
**丢失的是 Agent 从对话中累积构建的结构化理解。**

### 具体场景

量化策略开发中，经过多轮参数迭代和回测：

```
v1: MA 10/20, RSI 70  → Sharpe 1.2
v2: MA 10/30, RSI 70  → Sharpe 1.5  ← 最优
v3: MA 10/30, RSI 65  → Sharpe 1.3
v4: MA 20/50, RSI 70  → Sharpe 1.1
```

用户说："v2 的结果最好，回到 v2 的参数。另外帮我分析 MA 周期和 Sharpe 的关系。"

在现有 compaction 下，v1-v3 的参数和结果已经被压缩成一句"测试了多组参数"。
Agent 无法回答这个问题。

---

## 2. 解法：外化心智模型，用 Git 版本控制

### 核心洞察

**对话是过程，Context 是产物。**

| | 对话 (Pi JSONL) | Context (git-mem) |
|---|---|---|
| 本质 | 事务日志 | 数据库当前状态 |
| 例子 | "用户说…" "助手回答…" "工具输出…" | "目标是X" "决定了Y因为Z" "v2参数最优" |
| 结构 | 线性追加 | 按 facet 组织，可增删改 |
| 体积 | 持续增长 | 相对稳定（更新替代堆积） |
| 已有方案 | Pi session JSONL 管理 | **缺失——git-mem 要解决的** |

git-mem 将 Agent 隐式的心智模型**外化**为一组结构化的 Context 文件，
用 Git 版本控制其演化过程。

```
对话流 → Agent 处理 → 心智模型更新
                          │
                     ┌────┴────┐
                     │ 外化为  │
                     │ Context │
                     │  文件   │
                     └────┬────┘
                          │
                     Git 版本控制
                     v1 → v2 → v3 → ...
```

### 为什么是 Git

Git 的语义**恰好**匹配 Context 的操作需求：

| 需求 | Git 能力 |
|------|---------|
| Context 文件随对话演化 | `commit` = 每次演化的快照 |
| 查看某个时刻的 Context | `git show <hash>:<file>` |
| 对比 Context 如何变化 | `git diff`（同一文件的版本间 diff，信号不是噪音）|
| 按 facet 追踪历史 | `git log -- <file>`（per-file history）|
| 搜索历史中的信息 | `git grep` / `git log --grep` |
| 回滚某个 facet | `git show <hash>:<file>` 恢复旧版本 |

关键区别：git 管理的是 **Context 文件**（精炼的心智模型），
**不是**原始对话（那是 Pi JSONL 的职责）。

---

## 3. 架构

```
┌─────────────────────────────────────────────────────────────────┐
│                    Metacognition Layer                           │
│                                                                 │
│  before_agent_start: 自动回忆                                    │
│    用户输入 → 提取关键词 → 搜索 Context 历史 → 注入相关信息        │
│    (前瞻记忆: 不等 Agent 主动搜索，系统预先提供)                    │
│                                                                 │
│  System Prompt: 告知 Agent 拥有记忆能力和可用工具                  │
├─────────────────────────────────────────────────────────────────┤
│                         Agent                                    │
│                    (Context Window)                               │
│                                                                  │
│  编码工具 (写):              检索工具 (读):                        │
│    ctx_note   — 记录事实      mem_log    — 查版本历史              │
│    ctx_status — 改主题状态    mem_recall — 读历史版本               │
│    ctx_update — 更新文件      mem_diff   — 对比版本变化            │
│                               mem_search — 搜索历史               │
├─────────────────────────────────────────────────────────────────┤
│                    Pi Extension Layer                             │
│                                                                  │
│  session_start          → 初始化 git-mem / 恢复状态               │
│  turn_end (可选)        → 自动 git 暂存实时更新                    │
│  session_before_compact → 记忆固化 (consolidation)                │
│  session_before_tree    → 分支管理                                │
│  before_agent_start     → 自动回忆 + system prompt 增强           │
│  session_shutdown       → 可选 git gc                             │
├─────────────────────────────────────────────────────────────────┤
│                    GitMem Core Library                            │
│                    (不依赖 Pi，可独立使用)                          │
│                                                                  │
│  GitMem       — 主入口                                            │
│  ├── GitOps   — Git CLI 封装                                      │
│  ├── Context  — 文件读写和结构管理                                 │
│  └── Types    — 类型定义                                          │
├─────────────────────────────────────────────────────────────────┤
│                    .git-mem/ (Git Repository)                     │
│                                                                  │
│  context/                                                        │
│  ├── _index.md              ← 全局概览 (= compaction summary)     │
│  ├── beliefs/               ← 事实、约束、领域知识                 │
│  ├── desires/               ← 目标 (多个，带状态)                  │
│  ├── intentions/            ← 当前计划                            │
│  └── history/               ← 已放弃的方向                        │
└─────────────────────────────────────────────────────────────────┘
```

---

## 4. 数据模型

### 4.1 Context 目录结构

```
.git-mem/
├── .git/
└── context/
    ├── _index.md                ← 全局索引 + 状态概览
    │
    ├── beliefs/                 ← "我们知道什么"
    │   ├── constraints.md       ← 约束条件 (通用)
    │   └── <domain>.md          ← 领域知识 (LLM 按需创建)
    │       例: strategy-params.md, backtest-results.md,
    │           architecture.md, api-design.md
    │
    ├── desires/                 ← "我们想要什么"
    │   └── goals.md             ← 所有目标，带状态标注
    │
    ├── intentions/              ← "我们正在做什么"
    │   └── plan.md              ← 当前行动计划 + 下一步
    │
    └── history/                 ← "我们尝试过什么"
        └── rejected.md          ← 探索过但放弃的方向
```

**通用文件**（所有项目都有）：`_index.md`、`goals.md`、`constraints.md`、
`plan.md`、`rejected.md`

**领域文件**（LLM 按需创建）：根据对话内容自动出现。
例如量化项目的 `strategy-params.md`、`backtest-results.md`。

每个文件是一个**认知组块**——一组语义密切相关的信息，作为一个单元被管理。

### 4.2 多主题管理与焦点切换

Context 文件记录**全部已知信息**，不只是当前焦点。
主题用状态标注区分：

```markdown
# goals.md

## 🟢 Active: 动量策略市场原理研究
- 理解动量因子的理论基础

## ⏸️ Paused: 均线交叉策略回测
- v2 参数最优 (MA 10/30, RSI 70, Sharpe 1.5)
- 暂停原因：先研究动量原理

## ✅ Done: 搭建回测框架
- backtrader + custom data loader
```

焦点切换时：
- `beliefs/` → 通常不变（事实不因焦点切换而改变）
- `desires/goals.md` → 旧目标 Paused，新目标 Active
- `intentions/plan.md` → 替换为新计划
- `history/` → 保持不变

### 4.3 冷热分层（大小控制）

所有 Context 文件总大小有预算限制（默认 ~8k tokens）。
超限时启动分层精简：

```
🔴 Hot  (完整内容)   ← Active 主题，不精简
🟡 Warm (一行引用)   ← 长期 Paused: "[均线交叉, see commit ghi9012]"
🔵 Cold (仅 git 中)  ← 通过 mem_search 才能找到

精简 ≠ 丢失。Agent 用 mem_recall(hash) 随时恢复完整内容。
```

### 4.4 `_index.md` — 全局概览

```markdown
# Project Context
Updated: 2025-03-21T10:30 | Commit: abc1234

## Active Focus
动量策略市场原理研究

## Context Files
| File | Summary |
|------|---------|
| desires/goals.md | 2 active, 1 paused, 1 done |
| beliefs/strategy-params.md | 均线策略 4 versions, v2 best |
| beliefs/backtest-results.md | Latest: v4 Sharpe 1.1 |
| beliefs/constraints.md | MaxDD ≤ 25%, min Sharpe 1.0 |
| intentions/plan.md | 研究动量因子理论基础 |

## Key Facts
- 均线策略 v2 (MA 10/30, RSI 70) 表现最优, Sharpe 1.5
- 动量策略尚在理论研究阶段
```

**`_index.md` 直接作为 compaction summary 返回给 Pi。**
它是整个心智模型的压缩视图——足以让 Agent 知道自己知道什么，
并在需要时知道去哪里深入。

### 4.5 Commit Message 格式

```
[context] 新增动量策略研究目标，均线策略暂停

Changed:
- desires/goals.md: 均线交叉 Active→Paused, 新增动量策略 Active
- intentions/plan.md: 切换为动量因子理论研究
Unchanged: beliefs/strategy-params.md, beliefs/backtest-results.md
```

---

## 5. 核心机制：两阶段记忆更新

### 设计原理

认知科学的编码特异性原理：**在信息产生的当下捕获，比事后回忆提取可靠得多。**

因此 git-mem 采用两阶段更新：

```
阶段 1: 实时编码 (对话过程中)
    Agent 通过 ctx_note / ctx_status / ctx_update 随时记录
    → 小增量、高保真
    → 信息在产生的瞬间被捕获 (编码情境完整)

阶段 2: 记忆固化 (compaction 时)
    LLM 审视即将压缩的对话 + 当前 Context 文件
    → 查漏补缺 (实时编码可能遗漏的)
    → 整理状态 (调整 Active/Paused/Archived)
    → 大小控制 (冷热分层精简)
    → git commit (固化为正式检查点)
```

### 5.1 实时编码：Agent 主动写入

Agent 在对话过程中通过 3 个写入工具更新 Context：

**`ctx_note(file, topic, content)`** — 记录一条事实

```
用户: "最大回撤不能超过 25%"
Agent 内部: 这是一个约束条件
→ ctx_note("beliefs/constraints.md", "drawdown", "MaxDD ≤ 25%")
```

**`ctx_status(topic, status, reason?)`** — 修改主题状态

```
用户: "先放下均线策略，研究一下动量策略"
→ ctx_status("均线交叉策略回测", "paused", "先研究动量原理")
→ ctx_status("动量策略市场原理研究", "active")
```

**`ctx_update(file, content)`** — 更新/创建整个文件

```
回测完成后，Agent 更新完整结果:
→ ctx_update("beliefs/backtest-results.md", "# Backtest Results\n## v4\n...")
```

实时更新暂存在 Context 目录中。
可选：每次工具调用都 git commit（细粒度历史）
或等 compaction 时统一 commit（粗粒度但更简洁）。

### 5.2 记忆固化：Compaction-time Consolidation

```
session_before_compact hook:
    │
    ├─ 1. 读取 .git-mem/context/ 所有当前文件
    │
    ├─ 2. 序列化 messagesToSummarize
    │     (用 pi 的 serializeConversation)
    │
    ├─ 3. LLM 调用: "基于新对话，更新 Context 文件"
    │     输入: 当前 Context 文件 + 新对话文本
    │     输出: 需要更新的文件列表
    │
    │     Prompt 关键指令:
    │     - 增量更新，不从头重写
    │     - 焦点切换时标记状态，不删除旧信息
    │     - 超出大小预算时精简 Paused 项为引用
    │     - 区分 Expansion(新增) / Revision(修正) / Contraction(撤回)
    │
    ├─ 4. 写入变化的文件 + 更新 _index.md
    │     git add && git commit
    │
    └─ 5. 返回给 pi:
          {
            compaction: {
              summary: _index.md 的内容,
              firstKeptEntryId: ...,
              tokensBefore: ...,
              details: { commitHash: "abc1234", ... }
            }
          }
```

### 5.3 LLM 输出格式

Context 更新以结构化格式输出，确保可解析：

```xml
<context-update>
<file path="desires/goals.md" action="update">
# Goals

## 🟢 Active: 动量策略市场原理研究
...
## ⏸️ Paused: 均线交叉策略回测
...
</file>
<file path="intentions/plan.md" action="update">
# Current Plan
...
</file>
<file path="beliefs/constraints.md" action="unchanged" />
<file path="_index.md" action="update">
...
</file>
</context-update>
```

只需输出变化的文件（`action="unchanged"` 的文件不需要包含内容）。

---

## 6. 检索工具

### 6.1 手动检索

Agent 通过 4 个工具主动查询 Context 历史：

**`mem_log(file?, limit?, grep?)`** — 查看演化历史

```
mem_log(file="beliefs/strategy-params.md")
→ abc1234  v4: MA 20/50, RSI 70
  def5678  v3: MA 10/30, RSI 65
  ghi9012  v2: MA 10/30, RSI 70     ← best
  jkl3456  v1: MA 10/20, RSI 70
```

**`mem_recall(hash, file?)`** — 检索历史版本

```
mem_recall(hash="ghi9012", file="beliefs/strategy-params.md")
→ 返回 v2 时刻的完整 strategy-params.md
```

返回的是精炼的 Context 文件（通常几百到几千字符），
不是原始对话，因此**不会击穿 context window**。

**`mem_diff(from, to, file?)`** — 对比版本变化

```
mem_diff(from="ghi9012", to="abc1234", file="beliefs/strategy-params.md")
→ - MA fast=10, slow=30    (v2)
  + MA fast=20, slow=50    (v4)
```

因为是**同一份文件的版本间 diff**，所以有意义——
不是两段不同对话的 diff。

**`mem_search(query, file?)`** — 搜索历史

```
mem_search(query="Sharpe 1.5")
→ commit ghi9012, file: beliefs/backtest-results.md
  match: "Sharpe Ratio: 1.5, MaxDD: -15%"
```

所有工具支持可选的 `file` 参数，实现 per-facet 精准操作。

### 6.2 自动回忆（前瞻记忆）

最重要的检索机制——不等 Agent 主动搜索，系统预先提供相关信息：

```typescript
pi.on("before_agent_start", async (event, ctx) => {
  // 从用户 prompt 提取关键词
  const keywords = extractKeywords(event.prompt);

  // 搜索 Context 历史中的相关内容
  const relevant = await gitMem.search(keywords);

  if (relevant.length > 0) {
    // 自动注入到 context 中
    return {
      message: {
        customType: "git-mem",
        content: formatRelevantContext(relevant),
        display: false,
      },
    };
  }
});
```

**为什么这是最重要的功能：**
Agent 的元认知不可靠——它不总是知道"自己不知道什么"。
自动回忆不依赖 Agent 的主动性，而是由系统保障信息不遗漏。

---

## 7. 分层记忆导航

Context 天然形成多粒度的信息层级，支持 zoom in / zoom out：

```
Level 3 (全局):   _index.md
                  "项目有 3 个目标，2 个活跃，v2 参数最优"

Level 2 (主题):   beliefs/strategy-params.md (当前版本)
                  "均线策略: 4 个版本, v2 Sharpe 1.5"

Level 1 (版本):   mem_recall(hash, file)
                  "v2 的完整参数、回测配置、结果"

Level 0 (原始):   Pi JSONL (通过 session entry 查原始对话)
                  "用户当时的原话和完整工具输出"
```

Agent 根据需要在层级间自然导航：
- 日常工作：Level 3-2（全局概览 + 当前主题细节）
- 需要历史数据：Level 1（特定版本的 Context）
- 需要原始细节：Level 0（回到 JSONL——但极少需要）

---

## 8. Pi Extension 集成

### 8.1 Hook 映射

| Pi Event | git-mem 行为 |
|----------|-------------|
| `session_start` | 初始化 .git-mem 仓库；从 session entries 恢复 compactionIndex |
| `before_agent_start` | 自动回忆（搜索相关 Context 历史）+ system prompt 增强 |
| `session_before_compact` | **核心**：记忆固化（LLM 更新 Context → git commit → 返回 summary）|
| `session_before_tree` | 如需 branch：在旧分支 commit + 创建新 git 分支 |
| `session_shutdown` | 可选 `git gc` |

### 8.2 工具注册

通过 `pi.registerTool()` 注册 7 个工具：

| 类别 | 工具 | 描述 |
|------|------|------|
| 写入 | `ctx_note` | 记录一条事实到指定文件/主题 |
| 写入 | `ctx_status` | 修改某个主题的状态 (Active/Paused/Done) |
| 写入 | `ctx_update` | 更新/创建整个 Context 文件 |
| 读取 | `mem_log` | 查看 Context 版本历史 |
| 读取 | `mem_recall` | 检索某个版本的 Context 文件 |
| 读取 | `mem_diff` | 对比两个版本的变化 |
| 读取 | `mem_search` | 在 Context 历史中搜索 |

### 8.3 System Prompt 增强

```markdown
## Cognitive Memory (git-mem)

你拥有一个外部认知记忆系统。你的知识和理解被持久化在结构化的 Context 文件中，
用 Git 版本控制。

**实时记录（对话中随时使用）：**
- `ctx_note(file, topic, content)`: 记录重要事实、约束、发现
- `ctx_status(topic, status)`: 当焦点切换时标记主题状态
- `ctx_update(file, content)`: 更新整个 Context 文件

**记忆检索（需要历史信息时使用）：**
- `mem_log(file?)`: 查看 Context 的版本历史
- `mem_recall(hash, file?)`: 读取某个历史版本的完整内容
- `mem_diff(from, to, file?)`: 对比两个版本间的变化
- `mem_search(query)`: 搜索所有历史版本

**使用原则：**
- 遇到重要信息（约束、决策、结果）时，立即用 ctx_note 记录
- 用户切换话题时，用 ctx_status 标记旧话题为 paused
- 需要回顾历史时，先 mem_log 看有哪些版本，再 mem_recall 获取细节
- 当 compaction summary 中出现 "Commit: <hash>" 时，表示有更多历史可查

当前记忆: {N} 个检查点, {M} 个 Context 文件
```

### 8.4 CompactionEntry.details

```typescript
interface GitMemCompactionDetails {
  commitHash: string;
  compactionIndex: number;
  contextFiles: string[];   // 本次更新的文件列表
  readFiles: string[];
  modifiedFiles: string[];
}
```

---

## 9. 模块结构

```
git-mem/
├── package.json
├── tsconfig.json
├── README.md
├── DESIGN.md                       ← 本文档
│
├── src/
│   ├── index.ts                    ← 公开导出
│   │
│   ├── core/
│   │   ├── types.ts                ← 类型定义
│   │   ├── git-ops.ts              ← Git CLI 封装
│   │   ├── context.ts              ← Context 文件读写和结构管理
│   │   └── git-mem.ts              ← GitMem 主类
│   │
│   ├── pi-extension/
│   │   ├── index.ts                ← Extension 入口 (export default)
│   │   ├── hooks.ts                ← 生命周期 hook 实现
│   │   ├── tools.ts                ← 7 个工具定义
│   │   └── auto-recall.ts          ← 自动回忆逻辑
│   │
│   └── tests/
│       ├── git-mem.test.ts
│       ├── context.test.ts
│       └── integration.test.ts
│
└── archive/                        ← 设计演化过程记录
    ├── DESIGN-v1.md
    ├── REVIEW-v1.md ~ v4.md
    ├── RESEARCH.md
    └── COGNITIVE-FRAMEWORK.md
```

---

## 10. Edge Cases

| 场景 | 处理方式 |
|------|---------|
| Git 不可用 | `session_start` 检测并警告，降级为普通 compaction |
| 首次 compaction | 无前序 Context，从零生成（等价于普通 compaction） |
| Context 总大小超限 | LLM 被指示精简 Paused 项为引用 `[see commit <hash>]` |
| 焦点切换 | 旧主题标记 Paused，保留内容；新主题标记 Active |
| Split turn | turnPrefixMessages 和 messagesToSummarize 一起处理 |
| 多 session 共享 .git-mem | 通过 git 分支隔离不同 session |
| LLM 更新质量不佳 | prompt 中明确指令 + 可选的自校验步骤 |
| 图片内容 | conversation 中标记 `[Image: type, size]`，不存二进制 |
| 实时更新的 git commit 策略 | 可配置：每次工具调用都 commit，或暂存等 compaction 时统一 commit |

---

## 11. 实施阶段

### Phase 1: 最小可行系统

- [ ] `GitOps` — Git CLI 封装
- [ ] `Context` — 文件读写（_index.md + 基础文件结构）
- [ ] `GitMem` — init, checkpoint, log, recall, search, diff
- [ ] `session_before_compact` hook — 记忆固化核心流程
- [ ] 4 个读取工具: mem_log, mem_recall, mem_diff, mem_search
- [ ] `before_agent_start` — system prompt 增强
- [ ] 基础测试

### Phase 2: 实时编码

- [ ] 3 个写入工具: ctx_note, ctx_status, ctx_update
- [ ] Context 文件的实时更新机制
- [ ] 大小预算和冷热分层精简

### Phase 3: 自动回忆

- [ ] `before_agent_start` 自动回忆
- [ ] 关键词提取 + Context 历史匹配
- [ ] 注入控制（避免注入过多历史信息导致 context 膨胀）

### Phase 4: 打磨

- [ ] Pi `/tree` 的 git 分支联动
- [ ] `/mem-status` 命令
- [ ] 配置系统 (context 大小预算、commit 策略等)
- [ ] 文档和示例

---

## 12. 设计演化记录

本设计经历了 4 轮审查迭代，每轮修正了一个关键认知：

| 版本 | 关键认知跃迁 |
|------|------------|
| v1 (DESIGN) | "用 git 存储原始对话作为备份" |
| v2 (REVIEW → REVIEW-v2) | "JSONL 已存了对话。丢失的不是数据，是 Context（结构化理解）" |
| v3 (REVIEW-v3) | "Context 不是单一文档，是多 facet 结构化状态，需要 per-file 版本控制" |
| v4 (REVIEW-v4 → RESEARCH → COGNITIVE) | "实时编码 > 批量提取；这本质上是一个认知记忆系统" |

archive/ 目录保留了完整的演化过程。
