# 1M Context 下的架构缺口：三个方向的研究

## 问题

在 1M context 下，compaction 可能整个 session 都不触发。
consolidation hook（设计中的安全网）几乎休眠。
系统的价值 100% 取决于 Agent 是否主动调用 ctx_update。

需要研究三个方向来解决这个问题。

---

## 方向 1: Agent 行为引导强化

### 原理

不改架构，通过更精确的 system prompt 和 tool 描述，
提高 Agent 使用 ctx_update 的频率和可靠性。

### 当前的引导

```markdown
**Maintain context** — Use ctx_update when you encounter:
- Constraints/requirements ("must", "don't", "limit")
- Quantitative results (numbers, percentages, metrics)
- Parameter changes ("change to", "set to")
- Decisions ("decided to use", "chose")
- Goal changes ("next we'll do", "put X on hold")
```

### 问题分析

当前引导是**被动的**——"当你遇到时，记录"。
Agent 需要自己判断"这个信息值得记录吗？"。
在实际中，Agent 专注于完成任务，记忆维护是次要的。

Mem0 的经验（50K stars）说明：**自动化 > 主动性**。

### 可能的改进

**改进 A: 从被动触发改为主动提醒**

在 system prompt 中加入主动行为指令：

```markdown
**After completing each task step**, update your context files to reflect
what you learned and what changed. This ensures your working memory
stays current even in very long conversations.
```

这比"当你遇到约束时记录"更具操作性——
绑定到 Agent 的工作节奏（每完成一步就更新），
而不是绑定到信息类型（遇到约束/结果时记录）。

**改进 B: Tool 描述中加入使用频率引导**

```typescript
promptGuidelines: [
  "Update context files after completing each major step or receiving test results.",
  "If you haven't used ctx_update in the last 5 turns, review whether any important information should be recorded.",
  ...
]
```

**改进 C: WMB 中加入"最后更新时间"提醒**

```
[Working Memory — review before responding]
📝 Optimizing strategy... v2 best.
⚠️ MaxDD ≤ 25% [pinned]
📁 strategy-params.md, backtest-results.md
⏰ Last ctx_update: 12 turns ago   ← 提醒 Agent 该更新了
```

如果距上次 ctx_update 超过 N 轮，WMB 显示提醒。
这利用了 WMB 的 recency bias 位置来提示 Agent 行动。

### 评估

| 改进 | 复杂度 | 可靠性 | 依赖 Agent？ |
|------|--------|--------|------------|
| A: 主动提醒 prompt | 零（纯文本） | 中 | 是 |
| B: Tool 频率引导 | 零（纯文本） | 中 | 是 |
| C: WMB 更新提醒 | 低（几行代码） | 中-高 | 是，但有持续提醒 |

**核心局限：无论怎么引导，最终仍然依赖 Agent 的主动性。**
不同 LLM 模型的遵从度不同，无法保证。

---

## 方向 2: 自动化提取

### 原理

不依赖 Agent 主动调用 ctx_update。
系统自动从对话中提取信息，更新 context 文件。

### Mem0 的做法

Mem0 在每轮对话后自动调用 LLM 提取事实：
```
对话内容 → LLM提取 → 原子事实 → 存入图/向量数据库
```
成本：每轮一次 LLM 调用。
效果：+26% accuracy vs OpenAI Memory。

### 适用于 exmem 的方案

**方案 A: 每轮对话后自动 LLM 提取**

```typescript
pi.on("turn_end", async (event, ctx) => {
  // 每轮对话结束后，用 LLM 判断是否有需要记录的信息
  const extraction = await extractFromTurn(event.message, event.toolResults);
  if (extraction.hasNewInfo) {
    await exMem.updateFile(extraction.file, extraction.content, extraction.message);
  }
});
```

问题：
- 每轮一次 LLM 调用——**成本高**
- 提取的信息可能质量不好——LLM 可能提取出噪音
- 需要一个"判断什么值得提取"的 prompt——又回到 prompt engineering

**方案 B: 基于规则的自动提取（不用 LLM）**

```typescript
pi.on("tool_result", async (event, ctx) => {
  // 规则1: 如果 bash 工具输出包含量化结果，自动记录
  if (event.toolName === "bash" && looksLikeTestResult(event.content)) {
    // 追加到 results 文件
  }
  
  // 规则2: 如果用户消息包含约束性语言，自动记录
  if (event.toolName === "user" && containsConstraintLanguage(event.content)) {
    // 追加到 constraints 文件
  }
});
```

问题：
- 规则是死的——无法覆盖所有场景
- "什么是量化结果？什么是约束？"的判断不可靠
- 可能产生大量噪音

**方案 C: 只自动提取用户消息中的 [pinned] 约束**

最小化的自动提取：只处理用户明确标记的信息。

```typescript
pi.on("message_end", async (event, ctx) => {
  if (event.message.role !== "user") return;
  const text = extractText(event.message);
  
  // 只自动提取用户消息中明确的约束性表述
  // "不要超过25%" → 自动加入 context
  // "必须兼容 Python 3.8" → 自动加入 context
  if (containsHardConstraint(text)) {
    await appendConstraint(exMem, text);
  }
});
```

问题：
- 需要自然语言理解来判断"硬约束"——不可靠
- 如果要可靠，就需要 LLM 调用——回到方案 A 的成本问题

### 评估

| 方案 | 成本 | 可靠性 | 噪音 |
|------|------|--------|------|
| A: 每轮 LLM 提取 | 高（LLM/轮） | 高 | 低-中 |
| B: 规则提取 | 零 | 低 | 高 |
| C: 只提取约束 | 零-低 | 低-中 | 低 |

**核心困境：可靠的自动提取需要 LLM 调用（贵），不用 LLM 的提取不可靠。**

Mem0 选择了方案 A（每轮 LLM 提取），因为他们是付费服务，成本可以转嫁给用户。
exmem 是本地插件，每轮一次额外 LLM 调用的成本对用户不友好。

---

## 方向 3: 主动触发 consolidation

### 原理

不等 compaction，每 N 轮对话主动触发一次 consolidation——
用现有的 consolidation 机制（LLM 更新 context 文件），
但由 turn_end 而非 session_before_compact 触发。

### 方案

```typescript
let turnsSinceLastConsolidation = 0;
const CONSOLIDATION_INTERVAL = 20; // 每 20 轮触发一次

pi.on("turn_end", async (event, ctx) => {
  turnsSinceLastConsolidation++;
  
  if (turnsSinceLastConsolidation < CONSOLIDATION_INTERVAL) return;
  turnsSinceLastConsolidation = 0;
  
  // 复用现有的 consolidation 逻辑
  // 但不是从 messagesToSummarize 提取——
  // 而是从最近 N 轮的消息中提取
  await periodicConsolidation(exMem, ctx);
});
```

### 关键区别

| | compaction-triggered | 主动触发 |
|---|---|---|
| 触发条件 | context 满了 | 每 N 轮 |
| 处理的消息 | 即将被压缩的 | 最近 N 轮的 |
| 消息是否被删除 | 是（compaction 后） | 否（留在 context 中） |
| LLM 调用 | 替换 Pi 默认 | **额外**的 LLM 调用 |
| 目的 | 保存即将丢失的信息 | **持续维护** context 文件 |

### 优点

- 复用现有的 consolidation prompt 和逻辑
- 不依赖 Agent 主动性
- 定期确保 context 文件（包括 _index.md）是最新的
- WMB 因此总有有意义的内容可以注入

### 成本

- 每 20 轮一次额外 LLM 调用
- 在 1M context 的 ~328 轮对话中，大约触发 ~16 次
- 每次调用输入：当前 context 文件 (~8K) + 最近 20 轮对话 (~60K) ≈ ~70K tokens
- 16 次 × 70K = ~1.1M input tokens 总成本

### 需要解决的问题

**1. 用哪些消息做 consolidation？**

compaction-triggered 时有 `messagesToSummarize`（Pi 提供的即将被压缩的消息）。
主动触发时没有这个——需要自己收集最近 N 轮的消息。

方案：用 `ctx.sessionManager.getBranch()` 获取最近的 entry，
取最后 N 条 message entry，序列化后传给 consolidation prompt。

**2. consolidation 后，消息不会被删除**

compaction-triggered 时，consolidation 后旧消息被 Pi 删除。
主动触发时，消息仍然留在 context 中——consolidation 只是更新了 context 文件，
但对话长度没有减少。

这意味着：主动 consolidation 不是"压缩"，而是"同步"——
把对话中的新信息同步到 context 文件中。

**3. 不应该返回 compaction result**

主动 consolidation 不触发 compaction，只更新 .exmem/ 文件。
不需要返回 summary 给 Pi。

### 实现复杂度

中等。需要：
- 新增一个 `turn_end` hook（或利用 `agent_end`）
- 从 sessionManager 获取最近消息并序列化
- 复用 consolidation prompt 和 parsing
- 不触发 Pi 的 compaction 流程

---

## 综合分析

| 方向 | 解决根因？ | 成本 | 可靠性 | 实现复杂度 |
|------|----------|------|--------|-----------|
| 1: 行为引导 | 部分（仍依赖 Agent） | 零 | 中 | 最低 |
| 2: 自动提取 | 是（不依赖 Agent） | 高（LLM/轮）或低（规则） | 高或低 | 中-高 |
| 3: 主动触发 | 是（不依赖 Agent） | 中（LLM/20轮） | 高 | 中 |

### 推荐：方向 1 + 3 组合

**方向 1（行为引导）作为默认**：零成本，适用于大部分场景。
大部分时候 Agent 会遵循引导使用 ctx_update。

**方向 3（主动触发 consolidation）作为安全网**：
当 Agent 不调用 ctx_update（或调用不够频繁）时，
每 N 轮自动同步一次 context 文件。

这个组合的好处：
- 方向 1 覆盖常见情况（Agent 主动记录）
- 方向 3 覆盖失败情况（Agent 忘了记录）
- 成本可控（每 20 轮一次 LLM 调用 vs 每轮一次）
- 不引入不可靠的规则提取（方向 2 的问题）

**方向 2（自动提取）暂不采用**：
成本和可靠性的困境无法在当前框架内优雅解决。
如果未来 LLM 推理成本大幅降低（比如 GPT-4o-mini 级别降到几乎免费），
可以重新考虑每轮提取。

### 对现有设计的具体影响

**方向 1 的改动**：
- system prompt 增加"每完成一步就更新 context"的主动引导
- WMB 中增加"最后更新时间"提醒（如果超过 N 轮未更新）
- ctx_update tool 的 promptGuidelines 更新

**方向 3 的改动**：
- 新增 `agent_end` hook（或 `turn_end`）
- 每 N 轮触发一次 periodic consolidation
- 复用现有 consolidation prompt + parsing + validation
- 不返回 compaction result，只更新 .exmem/ 文件
- 配置项：consolidation_interval（默认 20 轮）
