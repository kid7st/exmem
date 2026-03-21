# 客观审视：goals.md 是真需要，还是理论执念？

## 自我质疑

我刚刚论证了"goals.md 必须是预设文件"。但让我反过来问：

### 质疑 1："Agent 会忘记目标"——真的吗？

compaction 后 Agent 看到的是 _index.md 的 Narrative：

```markdown
## Narrative
正在优化均线交叉策略参数。目标：Sharpe > 1.0, MaxDD < 25%。
经过 4 轮迭代，v2 (MA 10/30, RSI 70) 最优 (Sharpe 1.5)。
用户希望分析 MA 周期和 Sharpe 的关系。
```

**目标已经在 Narrative 里了。** Agent 读完就知道方向。
需要一个单独的 goals.md 来重复这个信息吗？

### 质疑 2："验证结果会丢失"——真的吗？

v1-v4 的参数和结果在哪里？
- `strategy-params.md` — 有每个版本的参数
- `backtest-results.md` — 有每个版本的结果

这些是**领域文件**，LLM 在第一次 compaction 时就会自然创建。
它们不需要 goals.md 来"收纳"。

Agent 要分析 MA-Sharpe 关系时：
```bash
bash("cd .git-mem && git log --oneline -- context/strategy-params.md")
bash("cd .git-mem && git diff ghi9012 abc1234 -- context/strategy-params.md")
```

**验证结果在领域文件 + git 历史中，不在 goals.md 中。**

### 质疑 3："Agent 不知道在循环的哪个位置"——真的吗？

_index.md 的 Narrative 说"正在验证"或"正在探索"。
这就是 phase 信息。不需要 goals.md 的 Phase 字段。

### 质疑 4：如果 goals.md 有价值，为什么不也预设 constraints.md、decisions.md？

如果理由是"目标太重要不能靠 LLM 自行创建"，
那约束也很重要（违反约束会造成实际损害），
决策也很重要（重复决策浪费时间）。

**如果预设 goals.md，就没有原则性的理由不预设其他文件。**
这就回到了 7 个预设文件的老路上。

## 正面论证：goals.md 在什么情况下真正有价值？

goals.md 的独特价值不在于记录目标（_index.md 能做），
不在于记录验证结果（领域文件能做），
而在于**把目标和验证结果关联起来**：

```
目标: Sharpe > 1.0 AND MaxDD < 25%
  v1: Sharpe 1.2 ✅, MaxDD -18% ✅ → 但 Sharpe 刚过线
  v2: Sharpe 1.5 ✅, MaxDD -15% ✅ → 达标
  v3: Sharpe 1.3 ✅, MaxDD -20% ✅ → 退步但仍达标
  v4: Sharpe 1.1 ✅, MaxDD -22% ✅ → 继续退步
```

这种"目标 × 结果"的交叉视图确实有价值。
但这**也可以是 backtest-results.md 的格式**，
不一定需要单独的 goals.md。

## 诚实结论

**goals.md 作为预设文件是一个"好主意"但不是"必需品"。**

| | 预设 goals.md | 不预设，靠 few-shot 引导 |
|---|---|---|
| 目标追踪 | ✅ 保证存在 | ✅ LLM 大概率自然创建 |
| 验证记录 | ✅ 集中在一处 | ✅ 分散在领域文件中 |
| Phase 追踪 | ✅ 明确字段 | ✅ _index.md Narrative 中 |
| 非目标驱动任务 | ⚠️ goals.md 可能空着 | ✅ 不创建不需要的文件 |
| 可预测性 | ✅ 总是知道去哪找目标 | 🟡 文件名不确定 |
| 实现复杂度 | +1 文件 +1 规则 | +0 |

**关键区别**：可预测性。
预设 goals.md 意味着 Agent 和用户总是知道"目标在 goals.md 里"。
不预设意味着目标可能在 `project-overview.md`、`notes.md`、
或 _index.md 中——取决于 LLM 的选择。

## 真正的问题：BDI 框架是 Agent 记忆的最优模型吗？

### BDI 的局限

BDI 是为**自主决策 Agent** 设计的（Bratman 1987, Rao & Georgeff 1995）。
它假设 Agent 有自己的信念、欲望和意图，独立做决策。

但 LLM Agent 不是这样的：
- 它没有真正的"信念"——它的"知识"来自 context window 中的文本
- 它没有真正的"欲望"——目标是用户给的
- 它没有真正的"意图"——计划是根据用户指令制定的

**BDI 描述的是 Agent 的内部认知状态。
LLM Agent 没有内部状态——它的全部"认知"都在外部文本中。**

### 更合适的框架：直接面向"什么需要跨 compaction 存活"

与其问"Agent 的信念/欲望/意图是什么"，
不如直接问：**compaction 后，Agent 需要什么信息才能继续工作？**

答案因任务而异：
- 参数优化任务：目标、参数版本、结果、约束
- 代码开发任务：架构决策、进度、已知 bug
- 研究探索任务：假设、发现、阅读笔记
- Bug 修复任务：重现步骤、根因分析、已试方案

**没有一个框架能预先覆盖所有任务类型。**

BDI（或任何认知框架）的价值不在于提供文件模板，
而在于提供**一种思考方式**——帮助 LLM 在 consolidation 时
想清楚"什么信息最重要、如何组织"。

### 最优方案：框架在 prompt 中，不在文件结构中

```
不要这样做（结构化到文件中）:
  context/
  ├── beliefs/constraints.md
  ├── desires/goals.md
  └── intentions/plan.md

也不要完全不提（纯自由发挥）:
  "更新 context 文件"

而是这样做（框架作为思维引导写入 prompt）:
  "更新 context 文件时，确保以下信息类型被优先保留：
   - 用户的目标和成功标准
   - 验证/测试结果和从中得到的 insights
   - 约束条件（标记 [pinned]）
   - 已尝试但失败的方向及原因
   根据这些信息的性质，组织到合适的文件中。"
```

**框架在 prompt 的指导语中，不在文件系统中。**
LLM 在 consolidation 时读到这个指导，
会自然地优先保留目标和验证结果——
不管它把这些信息放在 goals.md 还是 project.md 中。

## 对 DESIGN.md 的最终建议

**不增加 goals.md 为预设文件。不增加第 6 条规则。**

改为：**在固化 prompt 和 few-shot 示例中体现 goal-driven 思维。**

### 修改 1：固化 prompt 的规则 1 微调

```
原来:
  1. 新信息加到对应文件，没有合适文件就新建

修改为:
  1. 新信息加到对应文件，没有合适文件就新建
     优先保留：目标和成功标准、验证结果、约束条件 [pinned]、
     失败方向及原因
```

**一句话的增补。不是新规则，是对规则 1 的补充。**

### 修改 2：few-shot 示例体现目标追踪

确保首次固化的 few-shot 示例中包含目标的记录方式：

```
<file path="goals.md" action="create">
# Goals
## 🟢 Active: 构建 Amazon 价格爬虫
**Target**: 每日采集 top-100 商品价格
**Status**: implementing
</file>
```

LLM 看到这个示例，就知道应该创建类似的文件来追踪目标。
但如果任务不是 goal-driven 的（如纯探索），它不会被迫创建一个空的 goals.md。

### 不修改的部分

- 预设文件仍然只有 _index.md（1 个）
- 固化规则仍然是 5 条（规则 1 补充了一句话）
- 总设计元素仍然是 19 个
