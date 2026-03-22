# 审查：Layer 1-2 是否是 WMB 的最优基础？

## 从 WMB 反推：它需要什么原料？

WMB 是一段 ~100-150 token 的结构化摘要：

```
⚡ GOAL: ...
📊 BEST/STATUS: ...
⚠️ CONSTRAINTS: ... [pinned]
📁 FILES: ...
```

它的原料来自 Layer 1-2：

| WMB 字段 | 数据来源 | 提取方式 |
|---------|---------|---------|
| ⚡ GOAL | _index.md Narrative 第 1 句 | 代码：取第一个句号/换行之前 |
| 📊 STATUS | _index.md Narrative 第 2 句 | 代码：取第二句 |
| ⚠️ CONSTRAINTS | 所有文件中的 [pinned] 项 | 代码：regex 扫描 |
| 📁 FILES | context/ 目录列表 | 代码：readdir |

问题是：**这些原料足够好吗？提取够可靠吗？**

---

## 逐一审查

### ⚡ GOAL 提取 — 脆弱

**理想情况：**
```
Narrative: "正在优化均线交叉策略参数。v2 表现最优 (Sharpe 1.5)。"
提取结果: ⚡ 正在优化均线交叉策略参数。✅
```

**失败情况：**
```
Narrative: "经过长时间的讨论和多轮迭代，我们从最初的均线交叉策略
            出发，逐步探索了多种参数组合和策略变体..."
提取结果: ⚡ 经过长时间的讨论和多轮迭代... ❌ (没有目标信息)
```

**根因**：goal 的提取依赖 LLM 写出的 Narrative 质量。
如果 LLM 用叙事风格而非事实风格写 Narrative，
代码提取出来的就不是 goal 而是废话。

**这是唯一的真实脆弱点。**

**但它可以解决吗？** 有三条路：

**路径 A：在 _index.md 中增加结构化字段**
```markdown
## Status
goal: optimize MA crossover strategy
phase: verifying
best: v2 Sharpe 1.5

## Narrative
正在优化均线策略参数...
```
WMB 从 Status section 提取，不依赖 Narrative 的措辞。

代价：consolidation prompt 需要额外一条规则（"maintain Status section"）。
违反 D9 原则（"不要教 LLM 做它已经会的事"）。
增加了 LLM 需要维护的结构。

**路径 B：不改 _index.md，让 WMB 生成代码更鲁棒**
```typescript
function extractGoal(narrative: string): string {
  // 策略 1: 取第一句
  const firstSentence = narrative.split(/[。.!？\n]/)[0];
  if (firstSentence.length < 100) return firstSentence;
  
  // 策略 2: 如果第一句太长，截断到第一个逗号
  const firstClause = firstSentence.split(/[，,]/)[0];
  return firstClause + "...";
}
```
代价：零。纯代码层面的鲁棒性处理。
缺陷：仍然可能提取到非 goal 的内容。

**路径 C：WMB 不提取 goal，直接用 Narrative 前 N 个 token**
```
[Working Memory]
📝 正在优化均线策略参数。v2 表现最优。
⚠️ MaxDD ≤ 25% [pinned]
📁 strategy-params.md, backtest-results.md
```
不区分 GOAL 和 STATUS，直接用 Narrative 前 100 tokens。
最鲁棒——Narrative 写什么就展示什么。

代价：WMB 的 goal/status 区分消失。但对注意力管理来说，
LLM 看到"Narrative 前两句"已经足够知道当前焦点。

**评估**：

| 路径 | 可靠性 | 复杂度 | 违反原则？ |
|------|--------|--------|-----------|
| A: 增加 Status 字段 | 最高 | 中（+1 规则 +1 section） | 是（D9: 不过度结构化） |
| B: 鲁棒代码 | 中等 | 低（纯代码） | 否 |
| C: 直接截取 Narrative | 高（不会提取错） | 最低 | 否 |

**推荐路径 C**。理由：
1. 最简单，最不会出错
2. Narrative 的前 2 句本来就是写给 LLM 看的（compaction summary）
3. 不需要区分 "goal" 和 "status"——LLM 自己能理解
4. 不增加任何结构要求

### ⚠️ CONSTRAINTS 提取 — 稳固

[pinned] 是一个精确的文本标记。regex 扫描不会误判。

**唯一的风险**：太多 [pinned] 项。如果有 15 个 [pinned] 约束，
WMB 会超长。

**解法**：WMB 生成时最多展示 3 个 [pinned] 项，
超出的标注 "... and N more [pinned] items"。

```
⚠️ MaxDD ≤ 25% [pinned]
⚠️ Python 3.8+ [pinned]
⚠️ ... and 3 more [pinned]
```

**→ Layer 1 不需要改。WMB 生成代码处理截断。**

### 📁 FILES 提取 — 稳固

readdir 不会出错。

**→ 不需要改。**

---

## Layer 2 对 WMB 的作用

**结论：Layer 2 不直接喂给 WMB。**

WMB 展示的是**当前状态**（Layer 1），不是**历史**（Layer 2）。
auto-recall 和 WMB 服务不同的目的：

```
auto-recall: "用户在问一个过去的事" → 注入历史 context
WMB:         "让 Agent 记住现在的状态" → 注入当前摘要
```

**但有一个间接关系**：

如果 auto-recall 找到了高度相关的历史 context，
是否应该影响 WMB 的内容？

例如：用户说"回到 v2 的参数"。
auto-recall 找到了 v2 的历史 context 文件。
WMB 是否应该显示 v2 的信息而非当前（v4）的信息？

**不应该。** WMB 展示当前状态，auto-recall 补充历史。
各司其职。如果 WMB 根据 auto-recall 结果动态变化，
就引入了 Layer 2 → Layer 3 的耦合，增加了复杂度。

**→ Layer 2 不影响 WMB 设计。解耦是正确的。**

---

## 真正的问题：Layer 1 需要改吗？

回到核心问题：Layer 1 的组织方式是否是 WMB 的最优基础？

**替代方案比较**：

| Layer 1 设计 | WMB 生成难度 | 优点 | 缺点 |
|-------------|-------------|------|------|
| 当前：自由 Narrative + [pinned] | 中等 | 灵活、简单 | Narrative 质量不可控 |
| 结构化 _index.md (Status section) | 简单 | 提取可靠 | 增加 LLM 维护负担 |
| 独立 WMB 状态文件 (.wmb.yml) | 最简单 | 完全可靠 | 多一个文件；ctx_update 需要额外更新它 |
| Key-value store (非文件) | 简单 | 精确 | 偏离 git-versioned files 的核心设计 |

**核心 trade-off**：

```
WMB 提取可靠性 ←→ Layer 1 的简单性和灵活性
```

如果我们让 Layer 1 更结构化 → WMB 更可靠 → 但 Layer 1 更复杂。
如果我们保持 Layer 1 灵活 → Layer 1 简单 → 但 WMB 提取不太可靠。

**我们在整个设计过程中反复选择了"灵活+简单"而非"结构化+可靠"**
（D3: 只预设 _index.md, D9: 不过度结构化, D11: 不用 BDI）。

WMB 的加入不应该推翻这个基本决策。

**但它暴露了一个我们需要正视的事实**：

> WMB 的质量上限 = _index.md Narrative 的质量上限。
> 而 Narrative 的质量取决于 consolidation LLM。
> 这是一个我们无法完全控制的变量。

**这是可以接受的。** 因为：
1. 坏的 WMB（从坏 Narrative 提取）仍然优于没有 WMB
2. [pinned] 部分不受 Narrative 质量影响（100% 可靠）
3. 文件列表不受影响（100% 可靠）
4. 只有 "goal/status" 信息受 Narrative 质量影响
5. 而且路径 C（直接截取 Narrative 前 N tokens）避免了"提取错误"的问题——
   它可能不精确，但不会提取出错误的信息

---

## 最终结论

**Layer 1-2 是 WMB 的足够好（good enough）的基础，不是完美（perfect）的基础。**

差距在于：
- WMB 的 goal/status 信息依赖 Narrative 质量（LLM 生成，不可完全控制）
- 这可以通过更结构化的 _index.md 来解决，但违反了"保持简单"的核心设计原则

**我们选择"简单但够用"而非"完美但复杂"。** 这与 D9 的教训一致。

**具体采用路径 C（直接截取 Narrative + [pinned] + files）**：
- 不增加 _index.md 的结构要求
- 不增加 consolidation prompt 的规则
- WMB 生成代码处理截断和格式化
- 100% 鲁棒（不会提取出错误信息，最多不够精确）

唯一的代码层面改进：
- WMB 的 [pinned] 展示最多 3 项，超出标注 "and N more"
- Narrative 截取用多种分隔符（。.!？\n）做 sentence splitting
