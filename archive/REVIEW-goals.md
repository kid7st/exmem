# 审查：Goal-driven 模型是否被错误地砍掉了？

## 重新理解问题

在过度工程审查中，我们把 BDI 目录结构和 7 个预设文件一起砍掉了。
理由是"不预设答案，让 LLM 自行创建文件"。

但这里混淆了两件事：
- **BDI 目录结构**（beliefs/desires/intentions/）→ 确实是过度设计 ✅ 应砍
- **Goal 作为一等公民**→ 不是过度设计 ❌ 不该砍

## Goal-driven Agent 的实际工作流

长任务中，Agent 的工作本质上是一个循环：

```
             ┌──────────────────────────┐
             │                          │
             ▼                          │
设定目标 → 探索方案 → 实现 → 验证 ──→ 达成？
  │                              │      │
  │                              │     否
  │                              │      │
  │                           发现问题   │
  │                              │      │
  │                              ▼      │
  │                            修复 ────┘
  │
  └── 目标变更 (用户调整方向)
```

每个节点都会产生信息：
- **目标**: 要达成什么？成功标准是什么？
- **探索**: 试了什么方案？结果如何？
- **验证**: 通过了吗？哪里没通过？
- **修复**: 修了什么？修好了吗？

**关键问题：compaction 之后，Agent 需要知道自己在循环的哪个位置。**

如果没有明确的 goal 追踪：
- Agent 可能忘记原始目标，追着枝节跑
- Agent 可能重复已经失败的方案（不记得试过了）
- Agent 可能不知道下一步该做什么（验证？继续探索？修复？）

## 用量化策略场景说明

```
目标: Sharpe > 1.0, MaxDD < 25%

探索 v1 → 验证 → Sharpe 1.2, MaxDD -18% → 部分达成 (MaxDD ok, Sharpe 偏低)
  → 继续探索

探索 v2 → 验证 → Sharpe 1.5, MaxDD -15% → ✅ 达成

探索 v3 → 验证 → Sharpe 1.3, MaxDD -20% → 退步
  → 分析原因: RSI 阈值降低导致信号过多

探索 v4 → 验证 → Sharpe 1.1, MaxDD -22% → 退步
  → 分析原因: MA 周期太长，错过短期趋势
```

如果这些信息只是散落在随机的 context 文件里，
compaction 后 Agent 需要拼凑才能理解"我们在做什么、做到哪了"。

但如果有一个 goals.md 明确记录：

```markdown
# Goals

## 🟢 Active: 均线交叉策略参数优化
**Success Criteria**: Sharpe > 1.0 AND MaxDD < 25% [pinned]
**Phase**: verifying
**Current Best**: v2 (MA 10/30, RSI 70) — Sharpe 1.5, MaxDD -15%

### Verification Log
- v1 (MA 10/20, RSI 70): Sharpe 1.2, MaxDD -18%
  → 部分达成，Sharpe 偏低
- v2 (MA 10/30, RSI 70): Sharpe 1.5, MaxDD -15%
  → ✅ 达成所有标准
- v3 (MA 10/30, RSI 65): Sharpe 1.3, MaxDD -20%
  → 退步。原因: RSI 阈值降低导致信号过多
- v4 (MA 20/50, RSI 70): Sharpe 1.1, MaxDD -22%
  → 退步。原因: MA 周期太长

### Insights
- MA slow period 30 优于 20 和 50
- RSI 70 优于 65
- 短周期 MA 在此数据集上表现更好
```

**Compaction 后，Agent 读到这个文件就能立即知道：**
1. 目标是什么（Sharpe > 1.0, MaxDD < 25%）
2. 在循环的哪个位置（verifying 阶段）
3. 什么已经试过了（4 个版本，各自结果）
4. 什么是最好的（v2）
5. 有什么规律（MA 短周期好，RSI 70 好）
6. 下一步该做什么（用 v2 还是继续探索）

**这些信息不是"可有可无"的，它们是 Agent 继续工作的基础。**

## 什么被错误地砍掉了

### 砍掉的是 BDI 的"形式" ← 正确
- beliefs/, desires/, intentions/ 目录 → 分类歧义、路径冗长

### 但同时砍掉了 BDI 的"本质" ← 错误

Goal-driven 工作流中，有三种本质不同的信息：

| 类型 | 生命周期 | 变化频率 | compaction 后的重要性 |
|------|---------|---------|---------------------|
| **Goal** (目标+标准+验证结果) | 长期稳定 | 低 | 🔴 最高 — Agent 的方向 |
| **Knowledge** (事实+约束+领域知识) | 累积增长 | 中 | 🟡 高 — Agent 的知识 |
| **Plan** (当前步骤+下一步) | 短期易变 | 高 | 🟢 中 — Agent 的行动 |

这三种信息的**生命周期完全不同**：
- Goal 可能整个 session 不变
- Knowledge 随每次实验累积
- Plan 几乎每轮对话都在变

把它们混在一起（"让 LLM 随便创建文件"），
LLM 可能创建一个 `notes.md` 把所有信息堆在一起。
Compaction 时精简不活跃内容，可能把 goal 的验证结果
（看起来像旧数据）精简掉——但那恰好是最重要的信息。

## 建议的最小修改

**不恢复 BDI 目录结构。只做两件事：**

### 1. 将 goals.md 提升为预设文件（与 _index.md 同级）

初始化时创建 goals.md 模板：

```markdown
# Goals

(No goals recorded yet. When the user states a goal, record it here with:
- Goal statement
- Success criteria
- Current phase: exploring / implementing / verifying / achieved / blocked)
```

goals.md 不是"LLM 可能创建的文件"，
而是"系统保证存在的文件"——和 _index.md 一样。

### 2. 在固化 prompt 中加一条规则

```
6. 始终维护 goals.md：
   - 记录目标、成功标准、当前阶段 (exploring/implementing/verifying)
   - 每次验证的结果追加到 Verification Log
   - 从验证结果中提炼 Insights
   - 成功标准标记为 [pinned]
```

**这是第 6 条规则。5 条变 6 条。新增的这一条解决了
"Agent compaction 后忘记目标和进度"的问题。**

### 3. 不变的部分

- 其他文件仍然由 LLM 自行创建（domain knowledge 文件）
- 不预设 plan.md（goals.md 中的 Phase 字段已覆盖"当前在做什么"）
- 不预设 constraints.md（约束可以作为 goals 的 success criteria 的一部分）
- 不用 BDI 目录（扁平结构不变）

## 修改后的影响

| | 修改前 | 修改后 |
|---|---|---|
| 预设文件 | 1 (_index.md) | 2 (_index.md + goals.md) |
| 固化规则 | 5 条 | 6 条 |
| 其他 | 不变 | 不变 |

**总设计元素: 19 → 20。**

这是一个极小的改动，但它确保了 goal-driven 工作流中
最重要的信息（目标、进度、验证结果）被系统性地维护，
而不是靠 LLM 的自发行为。
