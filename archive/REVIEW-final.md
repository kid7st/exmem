# Final DESIGN.md Review

## 总评

设计方向正确，核心概念清晰。问题定义（"丢失的是心智模型，不是原始数据"）、
解法选择（"外化心智模型 + git 版本控制"）、两阶段更新机制，
都经过了充分的推敲，逻辑自洽。

以下审查聚焦于**实施层面的可行性风险**——这些问题不影响方向，
但如果不提前考虑，会在实现阶段成为障碍。

---

## 一、核心风险：整个系统的质量上限 = LLM 的状态管理能力

设计中有三个关键动作完全依赖 LLM 的执行质量：

| 动作 | 依赖 LLM 做什么 | 失败后果 |
|------|----------------|---------|
| 实时编码 (ctx_note) | Agent 自主判断"这个信息重要，应该记录" | 遗漏重要信息 / 过度记录噪音 |
| 记忆固化 (compaction) | LLM 输出结构化 XML，正确增量更新多个文件 | Context 文件损坏或信息丢失 |
| 焦点切换 | LLM 正确判断"用户切换了话题"并更新状态 | 旧主题被覆盖或新主题未建立 |

这不是 git-mem 特有的问题——MemGPT 也面临同样的挑战。
但需要在设计中明确：**什么是"足够好"，什么是"不可接受"，以及后备方案是什么。**

### 建议

**每个 LLM 依赖点都需要一个确定性后备（deterministic fallback）：**

```
ctx_note 失败 (Agent 没调用):
  → 后备: compaction 时的 LLM 调用兜底（第二道防线）

compaction LLM 输出解析失败:
  → 后备: 将原始消息序列化为 conversation.md 追加到 context/ 目录，
          不做结构化更新，直接 commit
  → 再后备: 返回 undefined，让 pi 走默认 compaction 流程

ctx_status 未被正确调用:
  → 后备: compaction 时 LLM 审视整个 Context，调整状态
```

**文档 §10 Edge Cases 中应该加一行：**

| 场景 | 处理方式 |
|------|---------|
| compaction LLM 输出不可解析 | 降级为追加原始对话摘要到 context/，不做结构化更新；再失败则回退到 pi 默认 compaction |

---

## 二、BDI 目录结构可能是过度设计

### 问题

`beliefs/`、`desires/`、`intentions/`、`history/` 四级目录有两个实际问题：

**1. 分类歧义**

"MaxDD ≤ 25%"——这是 belief（我们知道的约束）还是 desire（我们想要的目标）？
"回退到 v2 参数"——这是 intention（当前计划）还是 desire（目标）？

LLM 需要在每次 ctx_note 时做这个分类决策。分类错了不致命，
但会导致 `mem_search` 搜不到东西（因为在错误的目录里）。

**2. 路径冗长**

每次工具调用需要完整路径：`ctx_note("beliefs/constraints.md", ...)`。
这增加了 token 消耗和出错概率（拼错路径）。

### 建议

**MVP 用扁平结构 + 命名约定，而不是嵌套目录：**

```
context/
├── _index.md
├── goals.md              ← 目标 (原 desires/)
├── plan.md               ← 当前计划 (原 intentions/)
├── constraints.md        ← 约束
├── decisions.md          ← 决策日志
├── rejected.md           ← 已放弃的方向 (原 history/)
└── strategy-params.md    ← 领域文件 (LLM 按需创建)
```

BDI 概念保留在**认知框架的思维方式**中（指导 prompt 设计），
但不需要体现在**文件目录结构**中。

文件名就是语义，不需要目录分类来补充。
`ctx_note("constraints.md", ...)` 比 `ctx_note("beliefs/constraints.md", ...)` 
更简洁，也更不容易出错。

如果将来确实需要分类，可以在 `_index.md` 中用表格标注类别，
而不是用目录层级来强制。

---

## 三、7 个工具的 token 成本

### 问题

Pi 默认有 4 个工具（read, bash, edit, write）。
git-mem 新增 7 个（3 写 + 4 读），总计 **11 个工具**。

每个工具的 name + description + parameters schema 大约占 100-300 tokens 的 system prompt。
7 个工具 ≈ 700-2100 tokens 的固定开销，**每轮对话都要付这个成本**。

而且 LLM 在 11 个工具中做选择的认知负担比 4 个工具大得多。
工具越多，LLM 选错工具的概率越高。

### 建议

**Phase 1 只注册 5 个工具，用 `promptSnippet` 控制 system prompt 占用：**

| Phase 1 (MVP) | Phase 2 |
|---------------|---------|
| `ctx_update` (合并了 note/status/update) | 拆分为 ctx_note + ctx_status + ctx_update |
| `mem_log` | 保持 |
| `mem_recall` | 保持 |
| `mem_search` | 保持 |
| `mem_diff` | 保持 |

`ctx_update` 在 MVP 阶段是一个通用的"更新 Context 文件"工具。
Agent 不需要区分"记录事实"和"改状态"——它只需要更新文件内容。

拆分为 3 个细粒度写入工具是一个**优化**（让特定操作更方便），
不是 MVP 必需。

---

## 四、`_index.md` 作为 Compaction Summary 可能不够

### 问题

设计说 `_index.md 直接作为 compaction summary 返回给 Pi`。

但看 §4.4 中 _index.md 的示例内容：

```markdown
## Active Focus
动量策略市场原理研究
## Context Files
| File | Summary |
|------|---------|
| ... | ... |
## Key Facts
- 均线策略 v2 表现最优
```

这更像一个**目录**，而不是一个 **summary**。

Pi 的 compaction summary 出现在 context 的最前面，
是 Agent "续上之前工作"的唯一线索。
如果它只是一个文件列表，Agent 可能不知道：
- 我们之前在讨论什么具体的技术问题？
- 用户最后说的是什么？
- 接下来应该做什么？

Pi 默认的 summary 格式（Goal / Progress / Key Decisions / Next Steps）
之所以有效，是因为它提供了**叙事性上下文**（narrative context），
不仅仅是数据索引。

### 建议

**`_index.md` 应该是"结构化索引 + 叙事摘要"的混合体：**

```markdown
# Project Context
Updated: 2025-03-21T10:30 | Commit: abc1234

## Narrative
正在从均线交叉策略转向研究动量策略的市场原理。
均线策略经过 4 轮参数优化，v2 (MA 10/30, RSI 70) 表现最优 (Sharpe 1.5)，
已暂停等待进一步决策。用户希望先理解动量因子的理论基础再做对比。

## Active Focus
动量策略市场原理研究

## Context Files
| File | Summary |
|------|---------|
| ... | ... |

## Key Facts
- 均线策略 v2 Sharpe 1.5, 目前最优
- 用户约束: MaxDD ≤ 25%

## Next Steps
1. 研究动量因子的理论框架
2. 确定适用的市场环境和标的
```

`Narrative` section 提供了 Agent 续上工作所需的叙事线索。
其他 section 提供了精确的数据索引。

---

## 五、Compaction 时的 Prompt 大小问题

### 问题

记忆固化的 LLM 调用输入包括：
1. 当前所有 Context 文件（~8k tokens，预算上限）
2. 序列化的 messagesToSummarize（可能 ~60-80k tokens）
3. 更新指令 prompt（~1k tokens）

总计：**~70-90k tokens 的输入**。

这对 compaction 模型的 context window 有要求。
如果用便宜的小模型做 compaction（如设计中提到的 Gemini Flash），
它的 context window 可能不够。

同时，让 LLM 从 80k tokens 的对话中提取信息并正确更新 8k tokens 的
Context 文件，这是一个难度很高的任务。LLM 的注意力在长文本中会稀释。

### 建议

**考虑分段处理：**

如果 messagesToSummarize 超过一定阈值（如 30k tokens），
分成 2-3 段分别处理：

```
段 1 (消息 1-10):  读取 Context → 更新 → 写入 Context
段 2 (消息 11-20): 读取更新后的 Context → 继续更新 → 写入
段 3 (消息 21-30): 最终更新 + 生成 _index.md
```

每段的 LLM 调用输入更小，更新更精准。
代价是多次 LLM 调用。

或者在 prompt 中明确指示：
"对话很长。请重点关注：新出现的事实、发生变化的决策、需要更新的状态。
不需要逐条处理每一条消息。"

---

## 六、实时更新与 Compaction 更新的一致性

### 问题

场景：
1. 对话中，Agent 调用 `ctx_note("strategy-params.md", "RSI", "RSI=65")`
2. strategy-params.md 被更新
3. 对话继续，更多参数变化
4. Compaction 触发
5. LLM 读取当前 strategy-params.md（含步骤 2 的更新）+ 新对话
6. LLM 输出更新后的 strategy-params.md

问题是：步骤 6 的输出是否会**覆盖**步骤 2 的更新？

理论上不会——因为 LLM 在步骤 5 读取了包含步骤 2 更新的文件。
但如果 LLM 决定"重写"该文件（而非增量更新），
步骤 2 的精确措辞可能被改写。

### 建议

这不是一个阻断问题，但应在设计中明确：

> Compaction 时 LLM 看到的 Context 文件已经包含了实时更新的内容。
> LLM 的任务是**在此基础上继续更新**，而不是从头重写。
> 实时更新和 compaction 更新不是两个独立的流，
> 而是同一个文件状态的连续演化。

---

## 七、缺失：如何衡量系统是否在工作？

### 问题

设计没有讨论**可观测性**。上线后，如何知道 git-mem 在正常工作？

- Context 文件质量在多次 compaction 后是提升还是退化？
- 实时编码的命中率是多少？（Agent 调用 ctx_note 的频率 vs 应该调用的频率）
- 自动回忆的精确率/召回率？
- Context 文件大小的增长曲线？

### 建议

**Phase 1 中加入基础指标收集：**

```typescript
// 每次 compaction 时记录
interface GitMemMetrics {
  compactionIndex: number;
  contextFilesCount: number;
  contextTotalTokens: number;
  filesChanged: number;
  realtimeUpdatesCount: number;    // 本轮中 ctx_note/update 调用次数
  autoRecallInjected: boolean;     // 是否触发了自动回忆
  commitHash: string;
}
```

这些指标存在 git commit message 的尾部或 metadata 中。
可以通过 `mem_log` 回看系统的运行状态。

---

## 八、缺失：Context 文件的初始化引导

### 问题

首次 compaction 时，Context 文件从零开始。
LLM 需要凭空决定：创建哪些文件？什么结构？

如果 LLM 在首次 compaction 时创建了不好的文件结构
（比如只创建了一个巨大的 `notes.md`），
后续 compaction 会在这个不好的基础上继续。

### 建议

**提供一个初始化模板：**

首次 compaction 时（检测到 .git-mem/context/ 不存在），
自动生成骨架文件：

```
context/
├── _index.md        ← 空模板，带格式说明
├── goals.md         ← 空模板: "# Goals\n\n(No goals recorded yet)"
├── constraints.md   ← 空模板
├── plan.md          ← 空模板
└── rejected.md      ← 空模板
```

LLM 在首次 compaction 时看到这些模板，就知道应该往哪里写什么。
这比让 LLM 凭空创建文件结构可靠得多。

---

## 九、小问题汇总

| # | 问题 | 建议 |
|---|------|------|
| 1 | git commit 策略（实时 vs 暂存）未给出默认选择 | 建议默认暂存，compaction 时统一 commit。理由：减少 git 操作次数，commit 历史更清晰 |
| 2 | `mem_diff` 的实际使用频率可能很低 | 保留但降低优先级。Phase 1 可以不实现 |
| 3 | 自动回忆的关键词提取方案未定 | Phase 3 实现。先用简单方案（提取名词/专有名词），再迭代 |
| 4 | 多 session 共享 .git-mem 的分支策略未展开 | Phase 4。MVP 阶段一个 session 用一个分支 (main)  |
| 5 | Context 文件中标注 `[see commit <hash>]` 后，Agent 是否知道用 mem_recall 去查？ | 需要在 system prompt 中明确说明这个模式 |
| 6 | §5.3 的 XML 输出格式可能对某些模型不友好 | 准备 JSON 作为备选格式 |

---

## 总结

| 类别 | 项目 | 严重性 |
|------|------|--------|
| 风险 | LLM 状态管理可靠性需要 deterministic fallback | 🔴 高 |
| 过度设计 | BDI 目录结构 → 建议扁平化 | 🟡 中 |
| 过度设计 | 7 个工具 → MVP 5 个足够 | 🟡 中 |
| 缺失 | _index.md 需要叙事性摘要，不只是索引 | 🟡 中 |
| 缺失 | compaction prompt 大小控制和分段策略 | 🟡 中 |
| 缺失 | 可观测性指标 | 🟡 中 |
| 缺失 | 首次 compaction 的初始化模板 | 🟢 低 |
| 明确 | 实时更新与 compaction 更新的一致性语义 | 🟢 低 |
| 明确 | 默认 commit 策略 | 🟢 低 |
