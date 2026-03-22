# 前沿研究：LLM 长上下文中的注意力问题

## 一、问题定义

随着 context window 从 200K 扩展到 1M+，核心问题从"信息丢失"迁移到"注意力稀释"：

- 信息物理上在 context 中
- 但 LLM 实际上无法有效利用全部 context
- 尤其是 context 中间位置的信息被严重忽略

---

## 二、基础研究

### 2.1 Lost in the Middle (Liu et al., 2023, Stanford)

**核心发现**：LLM 在长 context 中呈现 U 型注意力曲线——
对开头和结尾的信息利用率高，对中间位置的信息利用率显著下降。

```
注意力强度
  │
高 ├─▇                                           ▇▇▇
  │ ▇▇                                         ▇▇
  │  ▇▇                                      ▇▇
  │   ▇▇                                   ▇▇
低 │    ▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇
  └──────────────────────────────────────────────
   开头              中间                    结尾
                  context 位置
```

**关键数据**：
- 当答案在 context 开头：准确率 ~75%
- 当答案在 context 中间：准确率 ~45%
- 当答案在 context 末尾：准确率 ~70%
- 中间位置损失高达 30 个百分点

**即使模型声称支持 1M tokens，这不意味着它能有效使用 1M tokens。**

### 2.2 Needle in a Haystack 测试

业界标准的长 context 能力测试。在长文本的不同位置插入一条关键信息，
测试模型能否准确提取。

**各模型表现**：
- Claude 3.5/4 系列：在 200K 内表现良好，超过后开始退化
- GPT-4o：128K 内稳定，超过后退化
- Gemini 1.5 Pro：1M 声称，但实际在 500K+ 开始退化

**结论**：有效 context 远小于声称的 context window。
"1M context" 更准确地说是"1M 容量，有效注意力约 100-300K"。

### 2.3 Anthropic 的 Context Window 研究

Anthropic 在 Claude 的技术报告中提到的相关工作：

**Prompt Caching**：
- 缓存长 system prompt 的 KV cache
- 减少重复计算，但不解决注意力稀释
- 工程优化，不是注意力问题的解法

**System Prompt 位置**：
- Anthropic 建议把最重要的指令放在 system prompt 中（context 最前面）
- 因为开头位置的注意力最高
- 但这只解决了"指令"的注意力，没有解决"数据/事实"的注意力

**Extended thinking (Claude)**：
- Chain-of-thought 在处理前"预处理"长 context
- 思考过程中 LLM 可以主动检索 context 中的信息
- 但思考本身也受 context 长度影响

### 2.4 OpenAI 的方法

**Retrieval-Augmented Generation (RAG)**：
- OpenAI 大力推广 RAG 作为长 context 的替代方案
- 不要把所有信息塞进 context，而是按需检索
- Assistants API 中的 file_search 工具就是这个思路

**Structured Outputs**：
- 约束 LLM 输出的格式，减少注意力浪费在"如何格式化"上
- JSON Schema 模式让 LLM 专注于内容

**实际建议**：OpenAI 的最佳实践文档中一直建议
"keep context focused and relevant" 而非 "put everything in context"。

---

## 三、工程实践

### 3.1 Cursor 的做法

Cursor（AI 代码编辑器）处理长代码库的策略：

1. **不把整个项目塞进 context**——即使模型支持
2. **按需检索相关文件**——用 embedding 索引项目文件
3. **分层上下文**：
   - 始终在 context 中：当前文件 + 用户选中的代码
   - 按需加入：通过 @file 引用的其他文件
   - 背景信息：.cursorrules 文件（类似 system prompt）
4. **codebase indexing**：建立项目级索引，但不全部加载

**核心策略：精确的少量信息 > 海量但模糊的全部信息**

### 3.2 Cline / Aider 的做法

这些编程 Agent 的策略：

1. **repo map**：生成项目结构的压缩表示（函数签名、类名），
   而非完整文件内容
2. **按需展开**：只有 Agent 需要某个文件时才加载完整内容
3. **会话管理**：每轮只加载相关文件，用完就移除

**这本质上就是我们的分层导航**：
Level 3 (概览) → Level 2 (文件) → Level 1 (详情)

### 3.3 MemGPT/Letta 的更新

MemGPT 团队在 Letta 框架中的最新进展：

1. **不再依赖大 context**——即使模型支持 1M，仍使用"小 context + 外部存储"
2. **原因**：大 context 的延迟高、成本高、注意力差
3. **策略**：保持核心 context 在 ~8-16K tokens，其余按需从外部检索

**这验证了我们的方向：结构化的小 context > 无结构的大 context**

### 3.4 Anthropic 的 MCP (Model Context Protocol)

MCP 是 Anthropic 推出的标准协议，让 LLM 连接外部数据源：

1. **按需获取**而非预加载——不把所有数据塞进 context
2. **Tool-based access**——通过工具调用获取需要的数据
3. **Resources**——类似于 exmem 的 context 文件概念

**MCP 的理念与 exmem 一致**：外部组织数据，按需注入 context。

---

## 四、学术前沿

### 4.1 Selective Attention / Attention Sinks

**Attention Sinks (Xiao et al., 2023)**：
- 发现 LLM 的注意力会集中在第一个 token 上（"sink" 现象）
- 即使第一个 token 没有语义，它也吸收了大量注意力
- 后续研究利用这个现象做长 context 优化

**对 exmem 的启示**：在 context 的关键位置（开头、结尾）
放置结构化信息，比在中间位置更有效。

### 4.2 Hierarchical Context Compression

**LLMLingua / LongLLMLingua (Jiang et al., 2023)**：
- 压缩 prompt 中的冗余信息，保留关键信息
- 用小模型评估每个 token 的重要性
- 压缩 2-5x 而几乎不影响质量

**对 exmem 的启示**：context 文件本身就是一种"人工压缩"——
由 LLM 从长对话中提取关键信息，放入结构化文件。
这比让 LLM 在 1M tokens 中自己找信息更有效。

### 4.3 Memory-Augmented Transformers

**Memorizing Transformers (Wu et al., 2022)**：
- 模型内部维护一个 KV cache 的"外部记忆"
- 类似于人脑的外部记忆系统
- 但这是模型层面的，不是应用层的

**Landmark Attention (Mohtashami & Jaggi, 2023)**：
- 在长 context 中插入"地标" token
- 模型学会通过地标快速定位信息
- 不需要对整个 context 做全注意力

**对 exmem 的启示**：_index.md 的 Narrative 就是一种"地标"——
它告诉 LLM 关键信息在哪里，让 LLM 能快速定位。

### 4.4 RAG vs Long Context — 哪个更好？

**Xu et al., 2024 "Retrieval-Augmented Generation or Long Context?"**：

结论：**它们互补而非替代**。
- 简单的事实查询：RAG 和长 context 差不多
- 复杂的推理任务：长 context 更好（因为需要全局理解）
- 最佳实践：**长 context 装全局概览，RAG 装具体细节**

**这恰好是 exmem 的架构**：
- _index.md (全局概览) 在 context 中
- 具体细节通过 git show / read 按需获取 (类似 RAG)

---

## 五、综合分析：exmem 应该怎么做

### 核心原则

前沿研究和工程实践的共识：

> **不要信任大 context。即使模型支持 1M tokens，
> 也应该像只有 100K 一样组织信息。**
>
> — 来自 Cursor、Letta、OpenAI best practices 的一致结论

原因：
1. 注意力在长 context 中退化（Lost in the Middle）
2. 大 context 延迟高、成本高
3. 结构化的少量信息 > 无结构的大量信息

### exmem 的位置

exmem 恰好处于研究前沿推荐的最佳位置：

```
                少量信息                      大量信息
                   │                            │
  结构化  ─────────┤ ★ exmem                    │
                   │ (curated context files      │
                   │  in context,                │
                   │  details on demand)         │
                   │                            │
  无结构  ─────────┤                ★ 1M raw     │
                   │              conversation   │
                   └────────────────────────────┘
```

### 需要强化的方向

基于研究发现，exmem 需要强化"注意力管理"维度：

**1. 位置感知注入**
- 利用 recency bias：关键信息放在消息列表末尾
- 利用 primacy bias：system prompt 中保持结构化概览
- 避免信息沉入中间位置

**2. 分层上下文（对齐 Cursor/Cline 的做法）**
- Always in context：_index.md (概览)
- On demand：具体 context 文件 (通过 read/bash)
- Background：git 历史 (通过 bash + git)

**3. 主动聚焦（对齐 RAG vs Long Context 研究）**
- 长 context 中放全局概览（_index.md）
- 具体细节通过工具按需获取（git show, read）
- 不要试图把所有 context 文件的内容都注入到对话中

**4. 注意力刷新**
- 每 N 轮对话或每次工具调用后，重新注入 _index.md 摘要
- 利用 `context` hook 在 LLM 调用前做注入
- 控制注入频率避免 token 浪费
