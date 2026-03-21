# 认知过程规则设计

本文档为 DESIGN.md 中每个认知过程提供具体的、可实现的规则。
规则分为两类：
- **确定性规则**（代码实现，不依赖 LLM，可靠）
- **引导性规则**（通过 prompt 引导 LLM，尽力而为）

---

## 1. 即时编码 — "什么值得记？"

### 理论基础

**Levels of Processing (Craik & Lockhart, 1972)**：
深层加工（理解含义、建立关联）比浅层加工（记录表面特征）
产生更强的记忆。Agent 的编码不应是"复制用户说的话"，
而应是"提取用户表达的含义并关联到已有 Context"。

**Generative Agents (Park et al., 2023)**：
Stanford 的模拟人类行为的 Agent 系统中，
每个观察被 LLM 评估重要性（1-10 分），
超过阈值的才触发记忆存储和反思。
这证明了**不是所有信息都值得编码**。

### 编码规则

#### 什么应该编码（写入 system prompt）

```markdown
## 何时使用 ctx_update 记录信息

在对话中遇到以下类型的信息时，使用 ctx_update 记录到对应的 context 文件中：

1. **用户的约束/要求**
   "不要超过 25% 的回撤" → constraints.md
   "必须兼容 Python 3.8" → constraints.md
   信号词：必须、不要、不能、要求、限制、must、don't、never、always

2. **决策及其理由**
   "我们用 backtrader 而不是 zipline，因为..." → decisions.md
   信号词：决定、选择、用X不用Y、因为、let's go with

3. **量化的结果/数据**
   "Sharpe ratio 是 1.5" → 对应的领域文件
   信号词：结果是、显示、测量到、等于、数值

4. **参数/配置变更**
   "把 MA 周期改成 10/30" → 对应的领域文件
   信号词：改为、设置为、调整到、参数

5. **新的目标或目标变更**
   "接下来我们做 X" → goals.md
   "先放下 Y" → goals.md (标记为 Paused)

6. **发现的问题/异常**
   "这个 bug 是因为..." → 对应的领域文件
   信号词：发现、问题是、原因是、bug

不需要记录：
- 你自己的中间推理过程
- 临时的代码尝试（可以重新生成）
- 用户的确认性回复（"好的"、"继续"）
- 已经存在于 context 文件中的信息
```

#### 编码格式规范

```markdown
记录时遵循以下格式：

- 提取含义，不要逐字复制用户的话
- 附加来源时间：[recorded: 2025-03-21]
- 关键约束标记为不可删除：[pinned]
- 量化数据保留精确值，不要近似

示例：
  用户说: "哦对了回撤不能超过百分之二十五，这个很重要"
  记录为: "- MaxDD ≤ 25% [pinned, recorded: 2025-03-21]"
  而非: "- 用户说回撤不能超过百分之二十五"
```

---

## 2. 记忆固化 — Compaction 时的 Context 更新

### 理论基础

**Complementary Learning Systems (McClelland et al., 1995)**：
大脑有两套学习系统：海马体（快速记录情景记忆）和新皮层（缓慢整合为语义记忆）。
睡眠中的记忆固化是海马体的记录被逐步整合到新皮层中。

映射：JSONL = 海马体（快速、完整、但无组织）。
Context 文件 = 新皮层（结构化、语义化、但容量有限）。
Compaction = 睡眠中的固化过程。

**关键原则**：固化是**逐步整合**，不是**批量转储**。
LLM 应该"将新对话中的信息整合到已有 Context 中"，
而不是"从新对话中重新生成 Context"。

**Memory Reconsolidation (Nader et al., 2000)**：
回忆一段记忆时，它会变得不稳定，需要重新固化。
这意味着每次"更新"Context 文件都有引入失真的风险。
因此应该做**定向修改**（只改变化的部分），而不是**整体重写**。

### 固化流程（确定性部分）

```
session_before_compact 触发:
    │
    ├─ 1. [代码] 读取所有 context 文件
    │     计算当前总 token 数
    │     确定大小预算剩余空间
    │
    ├─ 2. [代码] 检查归档条件
    │     对每个 topic: 计算距上次引用的 compaction 次数
    │     标记需要归档的 topic (规则见 §6)
    │     生成归档指令列表
    │
    ├─ 3. [代码] 序列化 messagesToSummarize
    │     如果超过 30k tokens，分段处理 (见下文)
    │
    ├─ 4. [LLM] 调用固化 prompt (见下文)
    │
    ├─ 5. [代码] 解析 LLM 输出
    │     如果解析失败 → 降级方案 (见下文)
    │     验证 _index.md 存在且有 Narrative section
    │     验证 [pinned] 项未被删除
    │
    ├─ 6. [代码] 写入文件 + git commit
    │
    └─ 7. [代码] 返回 _index.md 作为 compaction summary
```

### 固化 Prompt

```
你是一个 Context 记忆管理器。你的任务是将新的对话信息整合到结构化的 Context 文件中。

## 当前 Context 文件

<current-context>
{每个文件的路径和完整内容}
</current-context>

## 新对话（需要整合的内容）

<conversation>
{序列化的对话文本}
</conversation>

## 系统指令

{如果有需要归档的 topic:}
以下 topic 已长期不活跃，请将它们精简为一行引用格式：
- topic "均线交叉策略" → 精简为 "[均线交叉策略, see commit {hash}]"

当前大小预算剩余：约 {remaining} tokens

## 你的任务

### 第一步：识别新信息

从对话中提取每条新信息，分类为：
- EXPAND：全新的事实/决策/结果（当前 context 中没有的）
- REVISE：对已有信息的修正或更新
- CONTRACT：被证明错误或过时的信息

列出你识别到的每条信息及其分类。

### 第二步：输出更新后的文件

<context-update>
<file path="goals.md" action="update">
（完整的更新后内容）
</file>
<file path="constraints.md" action="unchanged" />
<file path="_index.md" action="update">
（必须更新，包含 Narrative section）
</file>
</context-update>

## 规则

1. **定向修改，不整体重写**
   在现有内容上做增删改。保持已有信息的措辞和结构。
   只改需要改的部分。

2. **[pinned] 不可触碰**
   标记为 [pinned] 的条目不得删除、修改措辞或移动位置。

3. **焦点切换处理**
   - 用户明确切换话题 → 旧话题标 ⏸️ Paused，新话题标 🟢 Active
   - 用户明确放弃某方向 → 移到 rejected.md，标 ❌
   - 不确定是否切换 → 保持原状态

4. **不要虚构**
   只记录对话中明确出现的信息。不要推测、补充或"改进"。

5. **量化数据精确保留**
   数值、百分比、参数值必须精确记录，不得近似或概括。
   "Sharpe 1.5" 不能变成 "Sharpe 较高"。

6. **_index.md 必须包含 Narrative**
   Narrative 是一段自然语言描述，概括当前工作的状态和方向，
   让 Agent 读完后能续上工作。
   
7. **新建文件**
   当对话引入了一个独立的新领域（新的策略类型、新的子系统），
   且该领域有 ≥3 条独立信息需要追踪时，创建新的领域文件。
   文件名使用小写加连字符：`momentum-strategy.md`
```

### 分段处理（对话过长时）

当 messagesToSummarize 超过 30k tokens 时：

```
segment_1 = messages[0 : len/2]
segment_2 = messages[len/2 : len]

LLM call 1:
  输入: current context + segment_1
  输出: updated context files (v1)
  → 写入 context 文件（不 commit）

LLM call 2:
  输入: updated context (v1) + segment_2
  输出: updated context files (v2)
  → 写入 context 文件 + git commit
```

每次调用的输入更小，更新更精准。
代价：2 次 LLM 调用。

### 降级方案

```
LLM 输出解析失败:
  ├─ 降级 1: 去掉 XML 标签，尝试按文件名分割纯文本
  ├─ 降级 2: 将对话摘要追加到 _index.md 的 "Unprocessed" section
  │          git commit
  │          返回 _index.md 作为 summary
  └─ 降级 3: 返回 undefined → Pi 走默认 compaction
```

---

## 3. 信息衰减对抗

### 理论基础

**Catastrophic Forgetting (McCloskey & Cohen, 1989)**：
神经网络学习新任务时会覆盖旧任务的知识。
在 LLM 更新 context 文件的场景下，
多次"更新"可能逐步磨损早期信息的精确度。

**Source Monitoring (Johnson et al., 1993)**：
人脑追踪信息来源（在哪里学到的），这有助于区分可靠记忆和不可靠记忆。
Context 文件中的信息也应追踪来源。

### 对抗机制

#### 机制 1：Pinned 标记（确定性规则）

```markdown
标记语法：[pinned]

示例：
  - MaxDD ≤ 25% [pinned, recorded: 2025-03-21]
  - 必须兼容 Python 3.8+ [pinned, recorded: 2025-03-21]

规则：
  - 用户的明确约束/要求自动标记为 [pinned]
  - LLM 在 ctx_update 或固化时不得删除/改写 [pinned] 条目
  - 只有用户明确说"这个约束取消了"才能去掉 [pinned]

实现：
  - 固化后验证步骤 (§2 步骤 5)：
    代码扫描上一版文件中的 [pinned] 条目
    检查新版文件中是否都存在
    如果缺失 → 自动恢复缺失的 [pinned] 条目
```

#### 机制 2：来源追踪（引导性规则）

```markdown
记录格式：
  - Sharpe = 1.5 [v2, compaction:3, recorded: 2025-03-21]
  - MA fast=10, slow=30 [v2, compaction:3]

字段含义：
  - v2: 这是参数的第 2 个版本
  - compaction:3: 在第 3 次 compaction 时记录
  - recorded: 首次记录日期

作用：
  - 帮助 LLM 识别"这条信息已经存在很久且未变化，不应随意修改"
  - 帮助用户追溯信息来源
```

#### 机制 3：周期性完整性校验（确定性规则）

```
每 5 次 compaction 执行一次（代码触发）：

1. git diff <5-compactions-ago>:context/ HEAD:context/
2. 提取被删除/修改的 [pinned] 条目
3. 提取被显著缩短的段落（字符数减少 >50%）
4. 如果发现异常：
   - 记录到 metrics
   - 在 _index.md 中添加警告：
     "⚠️ Integrity check: {N} items may have decayed. 
      Run mem_diff to review."
```

---

## 4. 注意力/焦点管理

### 理论基础

**Task Switching Costs (Monsell, 2003)**：
任务切换有认知成本。频繁切换会降低效率。
因此不应对每个话题变化都做焦点切换，
而是区分**临时注意力转移**和**真正的焦点切换**。

### 焦点切换判断规则（写入 prompt）

```markdown
## 焦点切换判断

当用户的话题看起来发生变化时，判断属于以下哪种情况：

**显式切换**（立即更新状态）：
- 用户说 "先做X" / "放下Y" / "换个方向"
- 用户说 "这个先到这里" / "我们来看看别的"
→ 旧话题标记 ⏸️ Paused，新话题标记 🟢 Active
→ 使用 ctx_update 更新 goals.md

**临时探索**（不更新状态）：
- 用户问了一个相关但不同的问题
- 用户说 "顺便问一下..." / "另外一个小问题"
- 讨论持续 ≤2 轮就回到原话题
→ 保持原状态不变
→ 如果探索中产生了有价值的信息，记录到对应 context 文件

**渐变切换**（在 compaction 时由固化 prompt 处理）：
- 用户没有明确说切换，但连续多轮讨论新话题
→ 固化时由 LLM 判断：如果新话题持续 ≥3 轮且未提及旧话题，
  标记旧话题为 ⏸️ Paused

**多线程**（同时进行多个话题）：
- 用户在同一轮中讨论多个话题
→ 所有话题都标记为 🟢 Active
```

---

## 5. 自动回忆

### 理论基础

**Spreading Activation (Collins & Loftus, 1975)**：
激活一个概念会自动激活与之相关的概念。
当用户提到 "v2 参数"，大脑自动联想到 "回测结果"、"Sharpe ratio"。

**RAG (Lewis et al., 2020)** 的实践经验：
检索增强生成的关键经验——精确率比召回率重要。
注入不相关内容会干扰 LLM 的推理，比不注入更糟。

### 自动回忆的确定性流程

```
before_agent_start 触发:
    │
    ├─ 1. [代码] 从用户 prompt 中提取信号词
    │     方法：简单的 NLP（不需要 LLM 调用）
    │     - 提取名词和专有名词（"v2", "参数", "均线", "Sharpe"）
    │     - 提取数值（"1.5", "25%"）
    │     - 提取引号中的内容
    │
    ├─ 2. [代码] 搜索 git commit messages
    │     bash: git log --all --oneline | grep -i "<keyword>"
    │     对每个关键词做搜索，收集匹配的 commit hash
    │
    ├─ 3. [代码] 评分和排序
    │     score = keyword_match_count × recency_weight
    │     recency_weight = 1.0 / (1 + compactions_ago)
    │     取 top-2 匹配的 commits
    │
    ├─ 4. [代码] 检查注入预算
    │     max_inject = 2000 tokens
    │     读取匹配 commit 对应的 context 文件（最相关的 1-2 个文件）
    │     如果超过预算，截断到前 2000 tokens
    │
    ├─ 5. [代码] 判断是否值得注入
    │     如果最高 score < threshold → 不注入（精确率 > 召回率）
    │     如果匹配内容已经在当前 context 文件中 → 不注入（避免重复）
    │
    └─ 6. [代码] 注入为 custom message
          return {
            message: {
              customType: "git-mem",
              content: "[Memory] 相关历史上下文:\n\n" + relevant_content,
              display: false,
            }
          }
```

**关键设计决策：整个流程不需要 LLM 调用。**
纯代码实现，延迟低（~50ms），成本零。

**关键原则：宁可不注入，也不注入错误的内容。**

### 何时不触发自动回忆

```
不触发的情况：
  - 当前 context 文件为空（还没有历史）
  - 用户的 prompt 少于 5 个字（太短，无法提取有意义的关键词）
  - 上一次 compaction 到现在不到 3 轮对话（context 还没过时）
```

---

## 6. 遗忘/归档

### 理论基础

**Ebbinghaus 遗忘曲线 (1885)**：
记忆强度随时间指数衰减，每次回忆重置衰减曲线。
未被回忆的记忆自然遗忘。

**Working Memory Capacity (Cowan, 2001)**：
工作记忆实际容量约 4 个组块（不是 Miller 的 7）。
这意味着 Hot topic 的数量应该控制在 ~4 个以内。

### 归档规则（确定性代码实现）

#### 数据追踪

每个 topic 需要追踪的元数据：

```typescript
interface TopicMetadata {
  name: string;
  status: "active" | "paused" | "done" | "rejected";
  tier: "hot" | "warm" | "cold";
  lastReferencedAt: number;       // compaction index
  createdAt: number;              // compaction index
  referenceCount: number;         // 总引用次数
}
```

**追踪方式**：在 `.git-mem/metadata.json` 中维护（不在 context 文件中，
这样 LLM 不会干扰它）。
每次 ctx_update 或 compaction 时由代码更新。

#### 状态转换规则

```
            ┌──────────────────────────────────┐
            │        用户或 Agent 引用          │
            │        (重置计数器)               │
            ▼                                  │
         ┌──────┐    2 次 compaction       ┌──────┐
         │ Hot  │    未被引用 + Paused  ──→ │ Warm │
         │      │◄─── 被 recall/引用 ──────│      │
         └──────┘                          └──────┘
                                               │
                                    5 次 compaction
                                    未被引用
                                               │
                                               ▼
                                           ┌──────┐
                              被 search ──→│ Cold │
                              找到并引用    │      │
                                           └──────┘

转换规则（确定性代码）：
  Hot → Warm:
    条件: status == "paused" AND (currentCompaction - lastReferencedAt) >= 2
    动作: 在固化 prompt 中指示 "将 {topic} 精简为一行引用"

  Warm → Cold:
    条件: (currentCompaction - lastReferencedAt) >= 5
    动作: 在固化 prompt 中指示 "从文件中移除 {topic} 引用"
           (git 历史中仍然保留完整内容)

  Warm/Cold → Hot:
    条件: 用户提及该 topic 或 Agent 通过 bash/mem 访问了该 topic
    动作: 代码更新 lastReferencedAt
           下次固化时 LLM 自然会保留该 topic 的完整内容

引用计数更新时机：
  - ctx_update 提及该 topic → referenceCount++, lastReferencedAt = current
  - bash 命令中包含该 topic 的文件名 → lastReferencedAt = current
  - 用户 prompt 中提及该 topic 关键词 → lastReferencedAt = current
  - compaction 的对话中提及该 topic → lastReferencedAt = current
```

#### Hot topic 数量上限

```
MAX_HOT_TOPICS = 4 (基于 Cowan 2001)

当 Active topics > 4 时：
  代码识别出最久未引用的 Active topic
  在固化 prompt 中提示:
  "当前有 {N} 个 Active topic，超过建议上限 (4)。
   考虑将最不相关的 topic 标记为 Paused。"
```

---

## 7. 粒度切换（Level 0 溯源）

### 规则

当 ctx_update 记录一条信息时，如果该信息来自某个具体的工具输出
（如回测结果、错误日志），在 context 文件中添加溯源标记：

```markdown
- Sharpe = 1.5, MaxDD = -15% [v2, from-tool: bash, recorded: 2025-03-21]
```

`from-tool` 标记表示这条信息来自工具调用。
如果 Agent 需要原始输出，可以在 Pi session JSONL 中
按时间范围搜索对应的 tool result entry。

这是一个**弱链接**——不保证能精确找到原始 entry，
但提供了溯源方向。对 MVP 来说够用。

---

## 总结：各过程的设计状态

| 认知过程 | 确定性规则 | 引导性规则 (prompt) | 状态 |
|---------|-----------|-------------------|------|
| 即时编码 | — | ✅ 编码类型清单 + 格式规范 | 已设计 |
| 记忆固化 | ✅ 归档检查 + 解析验证 + pinned 验证 | ✅ 完整的固化 prompt + 分段策略 | 已设计 |
| 信息衰减 | ✅ pinned 验证 + 周期校验 | ✅ 来源追踪格式 | 已设计 |
| 焦点管理 | — | ✅ 三级切换判断规则 | 已设计 |
| 自动回忆 | ✅ 完整的纯代码流程 | — | 已设计 |
| 遗忘/归档 | ✅ 状态转换规则 + metadata 追踪 | — | 已设计 |
| 粒度切换 | — | ✅ from-tool 溯源标记 | 已设计 |
