# LLM Agent 记忆与注意力：领域全景 (2024-2026)

## 一、领域活跃度

这个领域正在快速发展：
- ICLR 2026 新开设了 **MemAgents Workshop**（专门针对 LLM Agent 记忆）
- ACM TOIS 2025 接收了综合 survey（477 stars）
- NeurIPS 2025、ACL 2025、ICML 2025 均有多篇相关论文
- 生产级项目：Mem0 (50K stars), claude-mem (39K stars), Letta/MemGPT

## 二、关键竞品与研究项目

### 2.1 生产级项目

#### Mem0 (50K ★, YC S24)
- **架构**：图结构记忆 + 向量检索 + 冲突检测
- **特点**：自动从对话中提取事实，构建实体关系图
- **研究成果**：+26% accuracy vs OpenAI Memory, 91% faster, 90% fewer tokens
- **与 exmem 的区别**：
  - Mem0 存储的是**原子事实**（key-value pairs），exmem 存储的是**结构化 context 文件**
  - Mem0 没有版本控制/diff/rollback，exmem 用 git 提供完整历史
  - Mem0 是通用记忆层，exmem 面向编程 Agent 的工作记忆

#### claude-mem (39K ★)
- **架构**：自动捕获 Claude Code 的工具调用 → 语义压缩 → 注入到未来 session
- **特点**：完全自动化，无需 Agent 主动调用
- **与 exmem 的区别**：
  - claude-mem 是**跨 session** 的记忆（session 结束后压缩，下次注入）
  - exmem 是**session 内**的结构化工作记忆 + 跨 compaction 持续性
  - claude-mem 做的是"记住上次做了什么"，exmem 做的是"组织当前在做什么"

#### Letta/MemGPT
- **架构**：OS 风格的虚拟内存管理（core memory + archival + recall）
- **与 exmem 的区别**：
  - Letta 的 core memory 是扁平文本块，exmem 是多文件结构化 context
  - Letta 没有 git 版本控制
  - Letta 最新方向：即使模型支持 1M，仍保持 8-16K 的核心 context

#### Zep
- **架构**：时间感知的知识图谱
- **特点**：自动事实提取 + 时间维度 + 实体关系
- **与 exmem 的区别**：Zep 用知识图谱，exmem 用 git 版本控制的文件

### 2.2 学术前沿（直接相关）

#### Memory-Probe (ICLR 2026 Workshop)
"Diagnosing Retrieval vs. Utilization Bottlenecks in LLM Agent Memory"

**核心发现**：LLM Agent 记忆的瓶颈不是**检索**（retrieval），
而是**利用**（utilization）。即使正确检索到了相关记忆，
LLM 仍然经常无法有效利用它们。

**三种策略对比**：
- Default RAG（原始对话块）
- Extracted Facts（结构化事实，Mem0 风格）
- Summarized Episodes（情景摘要，MemGPT 风格）

**对 exmem 的关键启示**：
> **检索到信息 ≠ 利用了信息。注意力管理比记忆存储更重要。**
> 这直接验证了我们从"存储"转向"注意力管理"的方向。

#### HiAgent (ACL 2025)
"Hierarchical Working Memory Management for Solving Long-Horizon Agent Tasks"

**核心思路**：分层工作记忆——subgoal 级别的摘要 + 细节按需展开。
与我们的 Level 3-0 分层导航高度一致。

#### AgentFold (Alibaba, 2025)
"Long-Horizon Web Agents with Proactive Context Management"

**核心思路**：**主动**管理 context，而非被动积累。
Agent 在执行过程中主动折叠（fold）不相关的上下文。

**对 exmem 的启示**：ctx_update 的角色不仅是"记录"，
也应该是"整理"——Agent 主动精简 context。

#### MemAgent (ByteDance/Tsinghua, 2025)
"Reshaping Long-Context LLM with Multi-Conv RL-based Memory Agent"

**核心思路**：用强化学习训练一个"记忆 Agent"来管理另一个 Agent 的记忆。
记忆管理本身是一个可学习的技能。

#### MEM1 (MIT, 2025)
"Learning to Synergize Memory and Reasoning for Efficient Long-Horizon Agents"

**核心思路**：记忆和推理应该协同，而非分离。
Agent 在推理时动态决定"此刻需要回忆什么"。

#### MemOS / Memory OS (2025)
"Memory OS of AI Agent" (EMNLP 2025)

**核心思路**：将记忆管理视为操作系统级别的关注点。
提供 memory allocation, deallocation, compaction 等 OS 原语。

### 2.3 最接近 exmem 的项目

#### git-context-controller (1 ★)
"Manage long-term LLM agent memory with Git-like commands"

描述和 exmem 几乎一致——用 Git 命令管理 Agent 记忆。
但只有 1 star，可能是早期实验或未完成。

**意义**：验证了"git + agent memory"的思路不止我们一家在想，
但目前没有成熟实现。

## 三、对 exmem 注意力管理设计的启示

### 3.1 Memory-Probe 的关键发现

**利用瓶颈 > 检索瓶颈**：

```
传统思路: 存储 → 检索 → 使用
          ✅       ✅      ❌ ← 瓶颈在这里

正确思路: 不仅要检索到信息，还要确保 LLM 在生成时实际利用它
```

这意味着：
- 我们的 auto-recall（Phase 2）只解决了检索问题
- context hook 注入摘要只解决了"信息在 context 中"的问题
- 真正需要解决的是：**如何让 LLM 在生成回复时实际利用注入的信息？**

可能的方案：
1. **位置优化**：注入到 context 末尾（recency bias）✅ 已设计
2. **格式优化**：用结构化格式让信息更显眼（而非淹没在长文本中）
3. **提示优化**：在注入的信息前加一句"请基于以下 context 回答"
4. **重复暴露**：关键信息在 system prompt 和消息中都出现

### 3.2 HiAgent 验证的分层方法

我们的 Level 3 → Level 0 分层与 HiAgent 的思路一致：

```
HiAgent:
  Task-level summary → Subgoal-level detail → Step-level execution

exmem:
  _index.md (overview) → context files (topic) → git history (version) → JSONL (raw)
```

**但 HiAgent 做得更细**：它在每个层级都有主动的"需要时展开"机制，
而不只是被动地等 Agent 去 read 文件。

### 3.3 AgentFold 的"主动折叠"

AgentFold 的核心洞察：Agent 应该**主动压缩**不需要的上下文，
而不是等 compaction 被动触发。

这暗示 ctx_update 可以有一个反向操作——不只是添加信息，
也应该允许 Agent 主动"折叠"（精简）不相关的 context 文件。

但这在我们的设计中已经覆盖了——ctx_update 可以用更精简的内容
覆盖原文件，相当于"折叠"。

### 3.4 从 Mem0 的成功中学什么

Mem0 50K stars 的成功说明了市场需求巨大。
它的核心竞争力是**全自动**——用户不需要做任何事，
Mem0 自动从对话中提取事实。

exmem 的设计是**半自动**的：
- 自动：compaction hook, auto-recall, context hook
- 手动：ctx_update 需要 Agent 主动调用

Mem0 的经验说明：**越自动越好。用户（或 Agent）的主动性不可靠。**

这强化了我们的 context hook（自动注入摘要）的重要性，
也暗示未来可以考虑更自动的 context 文件更新（比如在 tool_result 后自动提取）。

## 四、exmem 的差异化定位

在整个生态中，exmem 的独特位置：

| 特性 | Mem0 | claude-mem | Letta | Zep | exmem |
|------|------|-----------|-------|-----|-------|
| 存储形式 | 图/向量 | 压缩文本 | KV 文本块 | 知识图谱 | **git 版本控制文件** |
| 版本历史 | ❌ | ❌ | ❌ | 有时间维度 | **✅ 完整 git 历史** |
| Diff/回滚 | ❌ | ❌ | ❌ | ❌ | **✅** |
| Per-facet 追踪 | ❌ | ❌ | ❌ | ❌ | **✅** |
| 自动提取 | ✅ | ✅ | ✅ | ✅ | 半自动 (ctx_update + hook) |
| 注意力管理 | ❌ | ❌ | 有限 | ❌ | **✅ context hook** |
| 目标人群 | 通用 | Claude Code | 通用 | 通用 | 编程 Agent (Pi) |

**exmem 的独特价值：唯一提供 git 版本控制 + per-facet diff/rollback 
+ 注意力管理的 Agent 记忆系统。**

## 五、基于研究的设计更新建议

### 5.1 最高优先级：解决利用瓶颈（Memory-Probe 启示）

不仅要把信息放进 context，还要确保 LLM 实际利用它。

**方案：context hook 注入时使用"利用引导"格式**

```
不好的注入方式：
  [Context Refresh]
  # Project Context
  ## Narrative
  正在优化均线策略...

好的注入方式：
  [Working Memory — review before responding]
  Current goal: optimize MA crossover strategy (Sharpe > 1.0) [pinned]
  Best result so far: v2 (MA 10/30) Sharpe 1.5
  ⚠️ Active constraints: MaxDD ≤ 25%
```

后者更短、更结构化、有明确的行动引导（"review before responding"）。
这利用了 Memory-Probe 的发现：**结构化事实格式比叙事格式的利用率更高。**

### 5.2 从 Mem0 学习：提高自动化程度

考虑在 Phase 3+ 中增加自动事实提取：

```typescript
pi.on("tool_result", async (event, ctx) => {
  // 当工具返回量化结果时，自动记录到 context 文件
  if (isQuantitativeResult(event.result)) {
    await exMem.updateFile("results.md", ...);
  }
});
```

但这要谨慎——过度自动化可能产生噪音。
Mem0 的经验是配合冲突检测和去重。

### 5.3 验证 exmem 设计的正确性

多个独立研究验证了 exmem 的设计方向：

| exmem 设计元素 | 验证来源 |
|---------------|---------|
| 结构化 context 文件 | Mem0 研究（+26% vs 原始对话）|
| 分层导航 (Level 3→0) | HiAgent (ACL 2025) |
| 主动 context 管理 | AgentFold (Alibaba 2025) |
| 保持核心 context 小 | Letta 最新实践 (8-16K) |
| 注意力管理 > 存储 | Memory-Probe (ICLR 2026) |
| Git 版本控制 context | git-context-controller (独立验证) |

---

## 六、参考文献与来源

### 直接相关（同一问题域）

| # | 项目/论文 | 论文 | 代码 |
|---|----------|------|------|
| 1 | **Memory-Probe** — Retrieval vs Utilization (ICLR 2026 WS) | [arxiv:2603.02473](https://arxiv.org/abs/2603.02473) | [github](https://github.com/boqiny/memory-probe) |
| 2 | **LLM Agent Memory Survey** (ACM TOIS 2025, 477★) | [arxiv:2404.13501](https://arxiv.org/abs/2404.13501) | [github](https://github.com/nuster1128/LLM_Agent_Memory_Survey) |
| 3 | **Mem0** — Universal memory layer (YC S24, 50K★) | [arxiv:2504.19413](https://arxiv.org/abs/2504.19413) | [github](https://github.com/mem0ai/mem0) |
| 4 | **claude-mem** — Claude Code memory plugin (39K★) | — | [github](https://github.com/thedotmack/claude-mem) |
| 5 | **Letta / MemGPT** — OS-style memory management | [arxiv:2310.08560](https://arxiv.org/abs/2310.08560) | [github](https://github.com/letta-ai/letta) |
| 6 | **Zep** — Temporal knowledge graph | [arxiv:2501.13956](https://arxiv.org/abs/2501.13956) | [github](https://github.com/getzep/zep) |
| 7 | **HiAgent** — Hierarchical working memory (ACL 2025) | [arxiv:2408.09559](https://arxiv.org/abs/2408.09559) | [github](https://github.com/HiAgent2024/HiAgent) |
| 8 | **AgentFold** — Proactive context management (Alibaba) | [arxiv:2510.24699](https://arxiv.org/abs/2510.24699) | [github](https://github.com/Alibaba-NLP/DeepResearch) |
| 9 | **MemAgent** — RL-based memory agent (ByteDance) | [arxiv:2507.02259](https://arxiv.org/abs/2507.02259) | [github](https://github.com/BytedTsinghua-SIA/MemAgent) |
| 10 | **MEM1** — Memory + reasoning synergy (MIT) | [arxiv:2506.15841](https://arxiv.org/abs/2506.15841) | [github](https://github.com/MIT-MI/MEM1) |
| 11 | **MemOS** — Memory OS of AI Agent (EMNLP 2025) | [arxiv:2506.06326](https://arxiv.org/abs/2506.06326) | [github](https://github.com/BAI-LAB/MemoryOS) |
| 12 | **A-MEM** — Agentic Memory (NeurIPS 2025) | [arxiv:2502.12110](https://arxiv.org/abs/2502.12110) | [github](https://github.com/agiresearch/A-mem) |
| 13 | **git-context-controller** — Git-like agent memory | — | [github](https://github.com/Owner807/git-context-controller) |
| 14 | **SeCom** — Memory construction & retrieval (Microsoft, ICLR 2025) | [arxiv:2502.05589](https://arxiv.org/abs/2502.05589) | [github](https://github.com/microsoft/SeCom) |
| 15 | **MemoRAG** — Global memory enhanced RAG (TheWebConf 2025) | [arxiv:2409.05591](https://arxiv.org/abs/2409.05591) | [github](https://github.com/qhjqhj00/MemoRAG) |
| 16 | **LightMem** — Lightweight memory-augmented generation | [arxiv:2510.18866](https://arxiv.org/abs/2510.18866) | [github](https://github.com/zjunlp/LightMem) |
| 17 | **MemOS** (MemTensor) — Memory operating system | [arxiv:2507.03724](https://arxiv.org/abs/2507.03724) | [github](https://github.com/MemTensor/MemOS) |
| 18 | **Dynamic Cheatsheet** — Adaptive memory at test time | [arxiv:2504.07952](https://arxiv.org/abs/2504.07952) | [github](https://github.com/suzgunmirac/dynamic-cheatsheet) |

### 注意力与 Context 基础研究

| # | 论文 | 链接 |
|---|------|------|
| 19 | **Lost in the Middle** — U-shaped attention in long context (Stanford, 2023) | [arxiv:2307.03172](https://arxiv.org/abs/2307.03172) |
| 20 | **Attention Sinks** — First-token attention concentration (2023) | [arxiv:2309.17453](https://arxiv.org/abs/2309.17453) |
| 21 | **RAG vs Long Context** — Complementary, not competing (2024) | [arxiv:2407.16833](https://arxiv.org/abs/2407.16833) |
| 22 | **LLMLingua** — Prompt compression (2023) | [arxiv:2310.05736](https://arxiv.org/abs/2310.05736) |
| 23 | **RAPTOR** — Recursive abstractive tree retrieval (2024) | [arxiv:2401.18059](https://arxiv.org/abs/2401.18059) |
| 24 | **ReadAgent** — Gist memory for long documents (ICML 2024) | [arxiv:2402.09727](https://arxiv.org/abs/2402.09727) |

### 认知科学与 Agent 架构

| # | 论文 | 链接 |
|---|------|------|
| 25 | **Generative Agents** — Believable simulacra (Stanford, 2023) | [arxiv:2304.03442](https://arxiv.org/abs/2304.03442) |
| 26 | **CoALA** — Cognitive Architectures for Language Agents (2023) | [arxiv:2309.02427](https://arxiv.org/abs/2309.02427) |
| 27 | **Reflexion** — Reflection-driven memory (2023) | [arxiv:2303.11366](https://arxiv.org/abs/2303.11366) |
| 28 | **Voyager** — Skill library for agents (2023) | [arxiv:2305.16291](https://arxiv.org/abs/2305.16291) |
| 29 | **MemoryBank** — Long-term memory with forgetting curve (AAAI 2024) | [arxiv:2305.10250](https://arxiv.org/abs/2305.10250) |
| 30 | **Complementary Learning Systems** (McClelland et al., 1995) | [doi:10.1037/0033-295X.102.3.419](https://doi.org/10.1037/0033-295X.102.3.419) |

### 综合索引

| # | 资源 | 链接 |
|---|------|------|
| 31 | **Awesome Efficient Agents** — Survey & paper list | [github](https://github.com/yxf203/Awesome-Efficient-Agents) |
