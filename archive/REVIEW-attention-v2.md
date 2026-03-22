# 基于前沿研究的设计修正

## 研究的核心共识

从 Anthropic、OpenAI、Cursor、Letta、以及学术研究中，
有一个一致的结论：

> **不要信任大 context。即使模型支持 1M tokens，
> 也应该像只有 100K 一样组织信息。**

原因：
1. 注意力在长 context 中退化 (Lost in the Middle, U 型曲线)
2. 有效 context 远小于声称的 window (1M 声称 → ~100-300K 有效)
3. 结构化的少量信息 > 无结构的大量信息 (RAG vs Long Context)
4. 大 context 延迟高、成本高

## 这如何改变 exmem 的设计

### 重新定位

```
旧: "External memory — survive compaction"
新: "Structured working memory — stay focused in any context size"
```

exmem 的核心价值不再是"防止 compaction 丢信息"，
而是"在任何长度的 context 中保持 Agent 的注意力聚焦"。

compaction 场景仍然被覆盖（作为一个特例），
但它不再是设计的中心。

### 注意力管理的三个层次

基于研究，注意力管理可以分为三层：

```
Layer 1: 位置管理 (WHERE in context)
  利用 LLM 的 primacy bias 和 recency bias
  把关键信息放在注意力最高的位置

Layer 2: 密度管理 (HOW MUCH in context)
  不要塞满 context
  概览始终在，细节按需获取

Layer 3: 主动刷新 (WHEN to remind)
  长对话中周期性刷新关键信息
  不依赖 LLM 自己"记得去看"
```

### 具体的设计修改

#### 修改 1: 新增 `context` hook — 位置感知注入

Pi 的 `context` 事件在每次 LLM 调用前触发。
利用它在消息列表的**末尾**注入 _index.md 摘要：

```typescript
pi.on("context", async (event, ctx) => {
  if (!exMem) return;
  
  // 只在对话足够长时注入（短对话不需要注意力刷新）
  if (event.messages.length < 10) return;

  const index = await exMem.getIndexContent();
  if (!index || index.includes("No context recorded yet")) return;

  // 构建精简版摘要（只取 Narrative + Files 列表，不超过 500 tokens）
  const summary = extractNarrativeAndFiles(index);
  if (!summary) return;

  // 注入到消息列表末尾——利用 recency bias
  return {
    messages: [
      ...event.messages,
      {
        role: "user" as const,
        content: [{
          type: "text" as const,
          text: `[Context Refresh]\n${summary}`,
        }],
        timestamp: Date.now(),
      },
    ],
  };
});
```

**为什么放在末尾**：Lost in the Middle 研究表明
LLM 对末尾消息的注意力最高（仅次于开头）。
_index.md 摘要放在末尾 = 每次 LLM 调用前最后看到的东西。

**为什么不是每次都注入**：短对话（<10 消息）不需要注意力刷新。
只有对话变长后，注意力稀释才成为问题。

#### 修改 2: system prompt 重新定位

从"记录以防丢失"转向"组织以保持聚焦"：

```markdown
## Context Memory

You have a structured working memory at `.exmem/`.
It helps you stay focused across long conversations.

**Maintain context** — Actively update context files to organize key information:
- Constraints and requirements → always [pinned]
- Goals, decisions, results → grouped by topic  
- Use ctx_update whenever information changes

**Review context** — In long conversations, refresh your understanding:
  read(".exmem/context/_index.md")

**Query history** — When you need past details:
  cd .exmem && git log --oneline -- context/<file>
  cd .exmem && git show <hash>:context/<file>
  cd .exmem && git diff <hash1> <hash2> -- context/
```

关键变化：
1. "Record information" → "Maintain context" (从被动记录到主动维护)
2. 新增 "Review context" section (鼓励主动回顾)
3. "External memory" → "Structured working memory" (从外部存储到工作记忆)

#### 修改 3: auto-recall 触发条件调整

当前：只在有 compaction 历史时触发
修改：在对话变长时也触发（不管有没有 compaction）

```typescript
// 旧: 至少 3 个 checkpoint (= 经历过 compaction)
if (status.checkpoints < 3) return null;

// 新: 至少 2 个 checkpoint (= 至少用过 ctx_update)
if (status.checkpoints < 2) return null;
```

同时，基于 context hook 已经做了注意力刷新，
auto-recall 专注于"历史检索"而非"注意力维护"。
两者分工：
- `context` hook：每次 LLM 调用前刷新当前摘要（注意力层）
- `auto-recall`：基于用户 prompt 检索相关历史（记忆层）

#### 修改 4: 分层上下文模型（对齐 Cursor/Cline）

明确三层模型：

```
Always in context (≤1K tokens):
  _index.md Narrative + Files list
  通过 context hook 持续注入

On demand (Agent 主动获取):
  read(".exmem/context/<file>")
  当 Agent 需要某个话题的完整信息时

Deep history (Agent 需要时查):
  bash("cd .exmem && git show/log/diff ...")
  当 Agent 需要历史版本、变更对比时
```

这和 Cursor 的模型完全一致：
- Always in context = 当前文件
- On demand = @file 引用
- Deep history = codebase search

## 对项目文档的影响

### README.md tagline
```
旧: External memory for LLM agents — 
    Git-versioned context files that survive compaction

新: Structured working memory for LLM agents —
    stay focused across long conversations
```

### DESIGN.md §1 问题定义
需要扩展，覆盖两个问题：
1. Compaction 导致信息丢失（原有，仍然有效）
2. 长 context 导致注意力稀释（新增，变为主要问题）

### Phase 3 优先级
```
Phase 3 (按优先级排序):
  1. [最高] context hook — 注意力锚点 (位置感知注入)
  2. [高]   system prompt 重新定位
  3. [高]   auto-recall 触发条件放宽
  4. [中]   README/DESIGN 重新定位
  5. [低]   /mem-status 命令
  6. [低]   配置系统
  7. [低]   Pi /tree 分支联动
```
