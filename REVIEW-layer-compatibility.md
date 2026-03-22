# Layer 1-2 兼容性审查：在 Layer 3 (WMB) 加入后

## 审查方法

逐一检查 Layer 1-2 的每个设计元素：
1. 它在 Layer 3 下是否仍然正确？
2. 它的职责是否发生了变化？
3. 相关的 trade-off 是否需要更新？

---

## Layer 1: Organization

### _index.md — 职责变了

**原来的职责（1 个）**：
compaction summary——compaction 后 Agent 看到的唯一上下文。

**加入 WMB 后的职责（2 个）**：
1. compaction summary（不变）
2. WMB 的数据源——代码从 _index.md 提取 Narrative 的前 1-2 句，
   结合 [pinned] 扫描和文件列表，生成 WMB

**问题：一个文件服务两个目的，会不会冲突？**

测试：用当前 _index.md 示例生成 WMB：

```
_index.md:
  ## Narrative
  正在从均线策略转向研究动量策略。均线策略经过 4 轮参数优化，
  v2 (MA 10/30, RSI 70) 表现最优 (Sharpe 1.5)。
  用户希望先理解动量因子理论基础再做对比。

WMB 提取结果：
  ⚡ 正在从均线策略转向研究动量策略。
  📊 v2 (MA 10/30, RSI 70) 表现最优 (Sharpe 1.5)。
  ⚠️ MaxDD ≤ 25% [pinned]        ← 来自 constraints.md
  📁 goals.md, strategy-params.md, backtest-results.md, constraints.md
```

**结论：兼容。** 好的 compaction summary = 好的 WMB 数据源。
Narrative 的前 1-2 句天然就是 goal + status。

**但有一个小风险**：如果 LLM 写出的 Narrative 很长、很模糊，
WMB 提取出来的就不好。需要确保 Narrative 的第一句话
简洁地说明当前目标/焦点。

**微调：固化 prompt 的 Narrative 要求**

```
原来: "务必包含更新后的 _index.md，其中要有 Narrative 段落"

修改: "_index.md must include Narrative 
       (first sentence = current goal/focus, 
        second sentence = current status/progress,
        keep concise)"
```

一句话的补充。不增加规则数量。

**→ 需要修改：固化 prompt 的 _index.md 描述。极小改动。**

### [pinned] 机制 — 职责扩展了

**原来的职责**：防止 consolidation 时关键约束被 LLM 删除。
验证 + 自动恢复。

**WMB 后的新增职责**：[pinned] 条目出现在每次 WMB 注入中，
确保 Agent 在每轮都看到关键约束。

```
WMB:
  ⚠️ MaxDD ≤ 25% [pinned]    ← 每次 LLM 调用都看到
```

**这是一个纯增益**——[pinned] 不仅在 consolidation 时保护，
还在对话过程中持续提醒。不需要修改 [pinned] 的实现，
只需要 WMB 生成代码扫描所有文件中的 [pinned] 项。

**→ 不需要修改。[pinned] 的实现已经足够（extractPinnedItems）。**

### ctx_update 工具 — 不需要修改

ctx_update 写入文件 → 下次 context hook 触发时 → WMB 从最新文件生成。
自动衔接，不需要额外逻辑。

**→ 不需要修改。**

### Git 版本控制 — 不需要修改

WMB 不影响 git 操作。WMB 是读取操作，不产生 commit。

**→ 不需要修改。**

### 大小预算 — 不需要修改

WMB 从 context 文件中提取，不增加 context 文件大小。
WMB 本身占 ~100-150 tokens，在 context window 中
（不在 context 文件中），不受 8K 预算约束。

**→ 不需要修改。**

### Context 文件结构 — 不需要修改

WMB 不关心有哪些文件、叫什么名字。
它只需要：_index.md 的 Narrative + 所有文件的 [pinned] 项 + 文件列表。

**→ 不需要修改。**

---

## Layer 2: Retrieval

### auto-recall — 职责需要明确化

**原来的定位**：
Agent 的"主要记忆检索机制"——在 before_agent_start 时
搜索历史并注入相关 context。

**WMB 后的定位变化**：

WMB 处理的是"当前状态的持续注意力"。
auto-recall 处理的是"历史状态的按需检索"。

```
WMB 负责:
  "你现在的目标是 X，约束是 Y，最好结果是 Z"
  → 当前状态，每次 LLM 调用都可见

auto-recall 负责:
  "5 次 compaction 前你试过方案 A，结果是 B"
  → 历史状态，仅在用户 prompt 相关时触发
```

**它们互补，不重叠：**
- WMB 占据 context 末尾（recency bias）
- auto-recall 注入消息出现在 context 前部（primacy bias，via before_agent_start）
- 合在一起 = 注意力曲线的两端都有结构化信息 = 最优

**但有一个重复问题**：

如果 auto-recall 注入了当前 context 文件的内容
（不是历史版本，而是当前版本），那它和 WMB 重复了。

当前代码有重叠检测（Step 4: overlap detection），
会跳过与 _index.md 高度重叠的内容。
但 WMB 不是 _index.md 全文——它是提取的摘要。

**微调：auto-recall 的重叠检测应该也考虑 WMB 内容。**

实现方式：auto-recall 在注入前，检查候选内容
是否与当前 _index.md 重叠超过 60%。
这已经在代码中了（countOverlap 函数）。
无需改动——现有的重叠检测足以避免重复。

**→ 不需要代码修改。但职责定位需要在文档中明确。**

### auto-recall 触发条件 — 可以放宽

当前：`if (status.checkpoints < 3) return null`
（至少 3 个 context commit 才触发）

WMB 之前，这个阈值是合理的——没有足够历史就不值得搜索。

WMB 之后，auto-recall 的重要性降低了（WMB 处理了"保持聚焦"），
但历史检索的价值不变。

实际上可以放宽到 `checkpoints < 2`——只要有过至少一次 ctx_update，
就值得搜索历史（用户可能在问"刚才那个参数是什么"）。

**→ 小修改：阈值从 3 改为 2。非关键。**

### auto-recall 注入位置 — 已经最优

auto-recall 通过 before_agent_start 的 message 注入。
这个消息出现在对话的前部（agent turn 开始时）。

WMB 通过 context hook 注入到消息末尾。

```
[system prompt]                    ← 始终开头（primacy bias）
[auto-recall: 历史 context]        ← 前部（primacy bias 的尾部）
[conversation messages...]         ← 中间（attention dead zone）
[WMB: 当前状态摘要]                ← 末尾（recency bias）
```

**这是注意力曲线上的最优布局**——
结构化信息占据两端，原始对话在中间。

**→ 不需要修改。已经是最优。**

---

## Trade-off 审查

### D6 (_index.md 作为 compaction summary) — 需要更新

**变化**：_index.md 现在服务两个目的。

```
原来: _index.md 只需要做好 compaction summary
现在: _index.md 还需要能被代码解析出 WMB
```

**风险**：如果优化 _index.md 的 compaction summary 质量
（更长、更叙事），WMB 提取可能变差（需要短、结构化）。

**评估**：实际上不冲突。WMB 只取 Narrative 的前 1-2 句 + [pinned] 项。
这些数据在任何合理的 _index.md 中都存在。
Narrative 的前两句天然就是"在做什么 + 做到哪了"。

**→ 记录这个双重职责，但不改变设计。**

### D8 (auto-recall 延后到 Phase 2) — 定位调整

**变化**：auto-recall 从"主要记忆机制"变为"补充历史检索"。

```
原来: auto-recall 是 Agent 在 compaction 后获取历史信息的唯一途径
现在: WMB 提供持续的当前状态注意力，
      auto-recall 只在用户询问历史时补充
```

**→ 在 DECISIONS.md 中更新 D8 的描述。**

### 其他 trade-off — 不变

D1-D5, D7, D9-D12 不受 Layer 3 影响。

---

## 总结

| Layer 1-2 元素 | 需要改吗？ | 改什么？ |
|-------------|----------|---------|
| _index.md 格式 | 🟡 微调 | 固化 prompt 中补充 Narrative 的首句要求 |
| [pinned] 机制 | ✅ 不改 | 职责扩展（WMB 中展示），实现已够用 |
| ctx_update | ✅ 不改 | |
| Git 版本控制 | ✅ 不改 | |
| 大小预算 | ✅ 不改 | |
| 文件结构 | ✅ 不改 | |
| auto-recall 实现 | ✅ 不改 | 重叠检测已有 |
| auto-recall 阈值 | 🟡 微调 | checkpoints < 3 → < 2 |
| auto-recall 定位 | 🟡 文档 | 明确"历史检索"而非"主要记忆机制" |
| auto-recall 注入位置 | ✅ 不改 | 已是最优（primacy zone） |
| 固化 prompt | 🟡 微调 | Narrative 首句要求 |
| 后置验证 | ✅ 不改 | |
| 降级方案 | ✅ 不改 | |

**代码级修改：0 处必改，2 处微调（consolidation prompt 一句话 + auto-recall 阈值数字）。**

**文档级修改：D6 和 D8 的描述更新。**

Layer 1-2 与 Layer 3 兼容。不需要重新设计。
