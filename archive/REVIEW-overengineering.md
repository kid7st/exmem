# 过度工程审查：从 50 个设计元素中找到真正必要的

## 问题

经过 6 轮迭代，我们积累了大量设计元素。让我清点一下：

- 1 个工具, 5 个 hooks
- 7 个标准文件 + 领域文件
- 1 个 metadata.json
- 6 条编码规则 + 4 条排除规则
- 3 种注解格式 ([pinned], [recorded:], [from-tool])
- 复杂的固化 prompt (提取分类 + 冲突检测 + 焦点管理 + 大小控制 + XML 输出)
- 3 层信息衰减对抗 (pinned + 来源追踪 + 周期校验)
- 4 级焦点切换规则
- 6 步自动回忆算法
- 3 层冷热分层 + metadata 追踪 + MAX_HOT_TOPICS=4
- 文件关联关系图
- 3 级降级方案

这加起来有约 **50 个独立的设计元素**。

对一个本质上只有 **1 个工具 + 2 个 hook** 的系统来说，
这个设计的复杂度和实际代码量之间有严重的不匹配。

---

## 逐项审查

### 1. 7 个标准文件 — 答案先于问题

```
_index.md, goals.md, constraints.md, plan.md,
decisions.md, rejected.md, procedures.md
```

这是我们**预设**的文件结构。但实际项目需要什么文件，
取决于项目内容，不取决于我们的预设。

- 量化项目需要 `strategy-params.md` 和 `backtest-results.md`，
  但可能不需要 `procedures.md`
- Bug 修复可能只需要 `bug-analysis.md`，不需要 `goals.md`
- 有些项目 `constraints.md` 和 `goals.md` 的界限模糊
  （"Sharpe > 1.0" 是约束还是目标？）

**预设 7 个文件 = 预设了问题的答案。**

更好的方式：**只预设 `_index.md`，其他文件由 LLM 根据内容自然创建。**
Prompt 里给组织原则（每个文件是一个独立话题），不给固定文件名。

```
之前:  初始化 → 创建 7 个空模板 → LLM 往里填内容
之后:  初始化 → 创建 _index.md → LLM 根据内容决定创建什么文件
```

**砍掉 6 个预设文件。**

### 2. metadata.json — 用 git 已有的信息重建一个数据库

metadata.json 追踪每个 topic 的：
- status, tier, lastReferencedAt, createdAt, referenceCount

但这些信息大部分**已经在 git 中**：
- 文件最后修改时间 → `git log -1 -- context/<file>`
- 状态 → 写在文件内容中（🟢/⏸️ 标注）
- 创建时间 → `git log --reverse -- context/<file> | head -1`

唯一 git 不直接提供的是"topic 最后被引用的 compaction 编号"。
但可以用更简单的方式：在文件内写行内注解。

```markdown
## ⏸️ Paused (since compaction 5): 均线交叉策略
```

代码在每次 consolidation 时更新 `(since compaction N)` 标记。
LLM 读到这个标记就知道这个话题已经不活跃多久了。

**砍掉 metadata.json。用行内注解替代。**

### 3. 三种注解格式 — 太多规矩，LLM 记不住

```
[pinned]
[recorded: 2025-03-21]
[from-tool: bash]
[v2, compaction:3]
```

LLM 需要在更新文件时一致地维护 4 种不同的注解语法。
格式越多，遵守得越差。

实际上：
- `[pinned]` — 有高价值（防止关键信息被删）✅ 保留
- `[recorded: date]` — 中等价值（来源追踪）
- `[compaction:N]` — 和 recorded 重叠
- `[from-tool]` — 低价值（很少需要追溯到原始工具调用）

**只保留 `[pinned]`。** 其他的有 git 历史本身提供溯源。
`git log -- context/strategy-params.md` 本身就告诉你
每条信息是什么时候、哪次 compaction 写入的。

### 4. 固化 prompt 的复杂度 — 一个 LLM 调用做了 7 件事

当前的固化 prompt 要求 LLM 同时：
1. 提取新信息
2. 分类为 EXPAND/REVISE/CONTRACT
3. 检测冲突
4. 处理焦点切换
5. 控制大小
6. 决定是否新建文件
7. 输出结构化 XML

**这是让一个 LLM 调用承担了太多认知负荷。**

实际上，LLM 最擅长的是：**"读一段对话，更新一组文件"。**
我们应该让它做它擅长的事，不要加太多规矩。

简化后的 prompt 核心指令：

```
你管理一组 Context 文件。基于新对话，更新这些文件。

规则很简单：
1. 新信息 → 加到对应文件（没有合适文件就新建一个）
2. 信息变了 → 更新对应条目
3. 信息被否定 → 删掉或标注为已否定
4. 不要删除 [pinned] 标记的条目
5. 总大小控制在 {budget} tokens 以内
   超出时精简不活跃的内容（标记了 ⏸️ 且长期未更新的）
```

5 条规则，不是 15 条。LLM 更可能一致地遵守。

EXPAND/REVISE/CONTRACT 分类、冲突检测、焦点切换判断规则——
这些不是不对，但它们是**希望 LLM 按照我们设计的认知理论来行动**。
实际上 LLM 有自己的"直觉"来处理这些情况，
给它过多的规则反而会干扰它的自然行为。

### 5. 冷热分层 — 解决一个可能不存在的问题

Hot/Warm/Cold 三层 + MAX_HOT_TOPICS=4 + metadata 追踪 +
确定性转换规则 + 由 LLM 执行精简...

这整套机制解决的问题是："Context 文件会无限增长。"

但会吗？

- 一次 compaction 大约处理 ~60k tokens 的对话
- 从中提取到 Context 文件的信息大约 ~1-3k tokens
- 经过 10 次 compaction，Context 文件大约 10-30k tokens
- 我们的预算是 ~8k tokens

所以确实会增长。但解决方案不需要这么复杂：

**简单方案**：在固化 prompt 中告诉 LLM 大小预算。
如果超出，LLM 自行决定精简哪些内容。
不需要 Hot/Warm/Cold、不需要 metadata 追踪、
不需要 MAX_HOT_TOPICS、不需要确定性转换规则。

```
"当前 Context 总大小: {current_size} tokens。
 预算: {budget} tokens。
 如果超出，请精简不活跃内容。
 被精简的内容仍保留在 git 历史中，可通过 git show 恢复。"
```

LLM 知道什么是不活跃的（标注了 ⏸️ 的内容），
它会自行判断精简什么。

**砍掉整个冷热分层机制。用一个大小预算 + 一句 prompt 替代。**

### 6. 自动回忆算法 — 过度设计未验证的功能

6 步算法：关键词提取 → 搜索 → 评分 → 预算控制 → 阈值 → 注入。

这是一个完整的检索系统，但它在 Phase 3 才实现，而且效果未知。
过度设计一个未验证的功能是浪费。

**简化**：Phase 3 实现时，从最简单的方案开始：

```
bash("cd .git-mem && git log --oneline --all")
→ 拿到所有 commit messages
→ 找到与用户输入有词汇重叠的 commit
→ 如果找到，注入对应的 _index.md 版本
```

如果这个简单方案不够用，再加复杂度。不要预先设计 6 步算法。

### 7. 周期性完整性校验 — 谁来处理警告？

"每 5 次 compaction 执行 git diff，检查信息衰减。"

然后呢？在 _index.md 中加一行警告。
Agent 会注意到这行警告吗？大概率不会。
用户会看到吗？不会，它在 .git-mem 里。

这个机制**没有行动方（actionable owner）**。

**砍掉。[pinned] + 代码验证已经覆盖了最重要的场景。**

### 8. 焦点切换 4 级规则 — 教 LLM 做它已经会的事

```
显式切换: 用户说"先做X"
临时探索: 用户说"顺便问一下"  
渐变切换: 连续 3 轮新话题
多线程: 同一轮多个话题
```

LLM **天生就理解这些情况**。
它是一个语言模型，理解对话中的话题转换是它的基本能力。

我们不需要教它"如果用户说'顺便问一下'就是临时探索"——
它读到这句话就知道是临时探索。

**砍掉 4 级规则。在 prompt 中只说一句：**

```
"用户切换话题时，将旧话题标记为 ⏸️ Paused，不要删除。"
```

### 9. Reflexion 式 rejected.md — 增加了复杂度但场景有限

完整的因果链格式：
```
### 用 zipline 做回测
- 尝试时间: compaction 2
- 失败原因: Python 3.10 兼容性问题
- 教训: 优先选择活跃维护的框架
- 替代方案: backtrader
```

这个格式很完整，但：
- 对 LLM 来说，维护这么结构化的条目负担重
- "rejected" 方向在实际编程中不是很多
- 简单记录"试了 X，因为 Y 放弃了"可能就够了

**简化为一行格式**：
```
- ❌ zipline (Python 3.10 兼容性问题) → 改用 backtrader
```

---

## 清理后的设计

### 保留

| 元素 | 理由 |
|------|------|
| ctx_update 工具 | 唯一的自定义工具，核心价值 |
| session_before_compact hook | 记忆固化，系统核心 |
| before_agent_start hook | system prompt 增强 |
| _index.md | 全局概览 + compaction summary |
| [pinned] + 代码验证 | 防信息丢失，简单高效 |
| 大小预算 | 防止 context 无限增长 |
| System prompt 中的编码指引 | 引导 Agent 使用 ctx_update |
| 降级方案 | 失败时回退到 Pi 默认 compaction |

### 砍掉

| 元素 | 理由 |
|------|------|
| 6 个预设标准文件 | 预设了答案。让 LLM 自行创建 |
| metadata.json | 用行内注解 + git 历史替代 |
| [recorded:], [from-tool], [compaction:N] 注解 | 只保留 [pinned]，其余靠 git 历史 |
| EXPAND/REVISE/CONTRACT 分类 | 过度结构化。LLM 直接更新就行 |
| 冲突检测步骤 | LLM 更新时自然会处理冲突 |
| Hot/Warm/Cold 三层 + 转换规则 | 一个大小预算 + 一句 prompt 替代 |
| metadata 追踪 + MAX_HOT_TOPICS | 同上 |
| 4 级焦点切换规则 | LLM 天生理解话题转换 |
| 6 步自动回忆算法 | Phase 3 再从最简单方案开始 |
| 周期性完整性校验 | 没有行动方 |
| Reflexion 式 rejected 格式 | 一行格式足够 |
| 文件关联关系图 | LLM 能自行推断 |
| 3 级降级方案 | 简化为 2 级：尝试解析 → 回退 Pi 默认 |
| procedures.md 标准文件 | LLM 需要时自行创建 |

### 清理后的系统

```
工具:     ctx_update (1 个)
Hooks:    session_before_compact + before_agent_start (2 个)
文件:     _index.md + LLM 自建的领域文件
标注:     [pinned] (1 种)
Prompt:   ~5 条清晰的规则
降级:     解析失败 → Pi 默认 compaction
```

### 清理后的固化 Prompt

```
你管理一组 Context 文件。基于以下新对话，更新这些文件。

当前文件:
<current-context>
{文件列表和内容}
</current-context>

新对话:
<conversation>
{序列化的对话}
</conversation>

规则：
1. 新信息加到对应文件，没有合适文件就新建
2. 信息变了就更新，被否定了就删掉或标注
3. 不要删除标记为 [pinned] 的条目
4. 用户切换话题时标记旧话题 ⏸️，不要删除内容
5. 总大小控制在 {budget} tokens 以内，超出时精简不活跃内容

输出格式：
<context-update>
<file path="..." action="update|create|unchanged">
(文件内容)
</file>
...
(务必包含更新后的 _index.md，其中要有 Narrative 段落概括当前状态)
</context-update>
```

**5 条规则。清晰、不冲突、LLM 容易遵守。**

---

## 最终对比

| | 清理前 | 清理后 |
|---|---|---|
| 自定义工具 | 1 | 1 |
| Hooks | 5 | 2 (+session_start 初始化) |
| 预设文件 | 7 | 1 (_index.md) |
| 注解格式 | 4 | 1 ([pinned]) |
| Prompt 规则 | ~15 | 5 |
| 额外状态文件 | metadata.json | 无 |
| 归档机制 | 3 层 + 转换规则 | 大小预算 + 1 句 prompt |
| 焦点管理 | 4 级判断规则 | 1 句 prompt |
| 总设计元素 | ~50 | ~12 |

**从 50 个设计元素砍到 12 个。
系统的核心能力没有减少：
版本控制 ✅、per-facet 追踪 ✅、历史检索 ✅、大小控制 ✅、防信息丢失 ✅。**
