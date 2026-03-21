# 第四轮：当焦点切换时，Context 怎么办？

## 场景还原

```
时间线:

T1  用户: "帮我回测均线交叉策略"
    → goals.md: 回测均线交叉策略
    → strategy-params.md: MA 10/30, RSI 70
    → backtest-results.md: Sharpe 1.5

T2  [compaction, Context 更新到 v2]

T3  用户: "等等，我突然想研究一下动量策略的市场原理"
    → goals.md 怎么办？
    → 均线交叉的 context 怎么办？
    → 新建什么文件？

T4  [compaction, Context 更新到 v3]

T5  用户: "好，动量策略先放着，回到均线交叉，
           用之前 v2 的参数重新跑一下"
    → 需要恢复均线交叉的 context
    → 动量策略的研究成果也不能丢
```

## 问题拆解

这里有三个子问题：

1. **焦点切换时，旧焦点的 Context 是被覆盖还是保留？**
2. **多个主题并存时，Context 文件如何组织？**
3. **回到旧主题时，如何恢复那个主题的 Context？**

---

## 两条路线分析

### 路线 A：文件内部管理多主题（简单方案）

Context 文件**不代表当前焦点，而是代表全部已知信息**。
主题切换时不覆盖，而是**标注状态**。

```markdown
# goals.md

## 🟢 Active: 动量策略市场原理研究
- 理解动量因子的理论基础
- 探索适用的市场环境

## ⏸️ Paused: 均线交叉策略回测
- 参数优化（目前 v2 最优: MA 10/30, RSI 70, Sharpe 1.5）
- 暂停原因：先研究动量原理

## ✅ Done: 搭建回测框架
- 使用 backtrader
```

每个领域文件同理——不是"当前参数"，而是"所有策略的参数"：

```markdown
# strategy-params.md

## 均线交叉策略 ⏸️
### Current Best (v2)
- MA fast=10, slow=30, RSI=70
### History
- v1: MA 10/20, RSI 70 → Sharpe 1.2
- v2: MA 10/30, RSI 70 → Sharpe 1.5 ★best
- v3: MA 10/30, RSI 65 → Sharpe 1.3
- v4: MA 20/50, RSI 70 → Sharpe 1.1

## 动量策略 🟢
### Exploring
- 尚未确定具体参数
- 研究中：动量因子周期选择
```

**优点：**
- 简单，不需要 git 分支管理
- 所有信息在同一个分支上，一目了然
- git diff 显示"从 T2 到 T3，goals.md 中均线交叉从 Active 变为 Paused"

**问题：**
- 文件会膨胀（多个主题的信息堆叠）
- 主题越多，每个文件越复杂
- LLM 需要可靠地维护状态标注（不总是做得好）

**缓解膨胀的方式：**
- Git 是安全网。当一个 Paused 主题长期不活跃，可以从文件中移除，
  只在 _index.md 中留一行引用 `[see commit ghi9012]`
- 需要时通过 `mem_recall` 从 git 历史中恢复

### 路线 B：Git 分支管理主题（隔离方案）

每个主题在独立的 git 分支上：

```
main ─── [v1: 均线初始] ─── [v2: 参数优化] ───────────────── [v5: 恢复均线]
              │                                                ↑
              └── explore/momentum ─── [v3: 动量原理] ─── [v4: 初步结论]
                                                          (合并洞察到 main)
```

切换主题 = 切换 git 分支：
- `git checkout explore/momentum` → 焦点切到动量
- `git checkout main` → 回到均线
- 每个分支有自己的 goals.md、strategy-params.md 等
- 彼此完全隔离

**优点：**
- 干净的隔离，不会互相干扰
- 符合 git 的原生用法
- 文件不会膨胀

**问题：**
- 分支管理本身有复杂度（命名、创建时机、清理）
- LLM 需要判断"什么时候该创建新分支"（不可靠）
- 跨主题查询变复杂（"均线参数是什么？"→ 要知道去哪个分支看）
- 合并的语义不清（合并两个策略的 goals.md？）

---

## 推荐：路线 A 为主，路线 B 为自然延伸

### 核心设计原则

> **Context 文件记录"我们所有已知的"，不是"我们当前在做的"。**
> **当前焦点只是状态标注，不是文件组织方式。**

这意味着：
- 切换焦点 = 修改状态标注，不是覆盖内容
- 旧焦点的 Context 保留在文件中（标记为 Paused）
- git 历史提供安全网（极旧的 Paused 内容可以从文件中精简掉）

### 膨胀控制机制

```
Context 文件总大小预算: 比如 8k tokens

当前文件总大小 = 6k tokens → 正常

当前文件总大小 = 10k tokens → 超预算
    │
    ▼
LLM 在 compaction 更新时被指示:
    "Context 文件总大小超过预算。
     请将长期 Paused/Done 的主题精简为一行引用：
     '[topic: 均线交叉策略, last commit: ghi9012, status: paused]'
     详细内容可通过 mem_recall(hash='ghi9012') 恢复。"
    │
    ▼
精简后的 goals.md:
    ## 🟢 Active: 动量策略研究
    - ...（完整内容）

    ## 📦 Archived
    - 均线交叉策略 [paused, details: commit ghi9012]
```

**精简 ≠ 丢失。** 被精简的主题通过 commit hash 引用，
Agent 用 `mem_recall` 随时可以恢复完整内容。

这就形成了一个自然的冷热数据分层：
- **Hot（在文件中，完整内容）**：当前 Active 的主题
- **Warm（在文件中，一行引用）**：Paused 的主题，快速唤醒
- **Cold（只在 git 历史中）**：久远的 Archived 主题，需要搜索才能找到

### Git 分支什么时候用？

不是用于"主题切换"（路线 A 已经处理了），
而是用于 **Pi 的 /tree 分叉**——
当用户真正 fork 对话路径时，git-mem 跟随 Pi 创建分支。

这是一个自然的、由 Pi 触发的操作，不需要 git-mem 自己判断分支时机。

---

## 更新后的 Compaction Prompt 关键指令

以下是 LLM 更新 Context 文件时需要遵循的补充指令:

```
6. **焦点切换处理**：
   - 如果用户的关注点从主题 A 转移到主题 B：
     a. 将主题 A 标记为 ⏸️ Paused，保留其完整内容
     b. 为主题 B 创建或更新对应的内容，标记为 🟢 Active
     c. 不要删除主题 A 的信息
   - 如果用户明确说"放弃"或"不要了"：
     a. 将该主题移到 rejected.md

7. **大小控制**：
   - 如果 Context 文件总大小接近预算（{budget} tokens），
     将长期 Paused（超过 2 个 compaction 周期未活跃）的主题
     精简为一行引用: "[topic: <name>, see commit <hash>]"
   - Active 的主题不做精简

8. **多主题共存**：
   - 同一个文件中可以有多个主题的信息
   - 用 heading + 状态 emoji 区分
   - 如果一个文件因多主题而过大，拆分为独立文件
```

---

## 这解决了什么、没解决什么

### ✅ 解决了

1. **焦点切换不丢信息**
   旧焦点标记为 Paused，内容保留

2. **多主题并存**
   文件内部用状态标注管理多个主题

3. **长期膨胀控制**
   git 引用机制实现冷热分层，Paused 主题被精简但不丢失

4. **恢复旧焦点**
   短期 Paused：直接从文件中读取
   长期 Archived：通过 `mem_recall` 从 git 恢复

### ⚠️ 依赖于 LLM 执行质量

- LLM 是否能可靠地维护状态标注？
- LLM 是否能正确判断"焦点切换"vs"补充信息"？
- LLM 是否能在大小预算下做出好的精简决策？

这些都依赖 prompt engineering。需要测试和迭代。

### ❓ 开放问题

一个根本性的问题：
**这些 Context 管理规则本身也是 Context 的一部分吗？**

也就是说，如果用户有特殊的 Context 管理偏好
（比如"我的回测结果永远不要精简"），
这个偏好本身应该记录在哪里？

可能的方案：
- 记录在 `constraints.md` 中 → 作为 Context 的一部分被维护
- 记录在 `.git-mem/config.md` 中 → 独立于 Context，不参与版本控制
- 记录在 pi 的 settings.json 中 → 与其他 pi 设置一起管理
