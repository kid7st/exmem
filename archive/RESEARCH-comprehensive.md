# 前沿研究全景扫描与设计验证

> 说明：本文档基于截至 2025 年初的研究文献。无法实时联网检索最新论文，
> 但覆盖了该领域主要的研究方向和代表性工作。

---

## 一、LLM Agent 记忆系统：直接相关的研究

### 1.1 已参考的（RESEARCH.md 中已分析）

| 工作 | 核心机制 | 我们借鉴了什么 |
|------|---------|---------------|
| MemGPT (Packer et al., 2023) | OS 虚拟内存模型; LLM 通过工具管理自己的记忆 | 实时编码、core memory 概念 |
| Generative Agents (Park et al., 2023) | Memory stream + reflection + retrieval | 重要性评分、反思触发 |
| ACT-R / SOAR | 工作记忆与长期记忆交互 | 有限工作记忆、activation spreading |
| BDI (Bratman, 1987) | Belief-Desire-Intention 架构 | Context 文件的组织方式（已扁平化） |

### 1.2 未参考但高度相关的

#### MemoryBank (Zhong et al., 2024)

用 Ebbinghaus 遗忘曲线的**数学模型**管理记忆强度。

```
memory_strength(t) = e^{-t/S}
S = stability（由回忆次数决定，每次回忆 S 增大）
```

当 strength 低于阈值时，记忆被移入长期存储。

**对我们设计的启示**：

我们用离散阈值（2 次 compaction → Warm，5 次 → Cold）。
MemoryBank 用连续函数。

|  | 我们的方案 | MemoryBank |
|---|---|---|
| 衰减模型 | 离散阶梯：Hot → Warm → Cold | 连续指数衰减 |
| 回忆增强 | 引用时重置计数器 | 引用时增加 stability S |
| 优点 | 简单、可预测、易实现 | 更精细、更接近真实记忆 |
| 缺点 | 粒度粗 | 需要维护浮点数状态 |

**评估**：对 MVP 来说，离散阈值足够。但我们的 metadata.json 中应该
记录 `referenceCount`（总引用次数），为将来切换到连续模型留空间。
**→ 已在 COGNITIVE-RULES.md §6 中包含。无需修改。**

#### Reflexion (Shinn et al., 2023)

Agent 在失败后进行"反思"，生成语言化的经验教训，
存入"反思记忆"中，下次遇到类似情况时检索使用。

关键：反思不是在任何时候发生，而是**由失败信号触发**。

```
尝试 → 失败 → 反思 "为什么失败？" → 存储反思 → 下次检索
```

**对我们设计的启示**：

我们的 `rejected.md` 记录了"尝试过但放弃的方向"，
但没有明确要求记录**失败的原因和教训**。

反思记忆不仅是"我们试过 X"，而是"我们试过 X，因为 Y 所以失败了，
教训是 Z"。这种因果链条比简单列表更有价值。

**→ 需要修改：rejected.md 的格式应该包含失败原因和教训。**

#### Voyager (Wang et al., 2023)

Minecraft Agent，构建一个**可执行的技能库**。
每次成功完成一个任务，就把代码存为一个"技能"，
未来遇到类似任务时复用。

```
技能库:
  mine_wood(): "先找树 → 走过去 → 砍树"
  build_house(): "先收集材料 → 放地基 → 建墙 → 加屋顶"
```

**对我们设计的启示**：

我们存储的是**声明性知识**（事实、决策、参数）。
Voyager 还存储了**程序性知识**（怎么做）。

对编程 Agent 来说，程序性知识的例子：
- "这个项目的部署流程是：先跑测试 → build → push → deploy"
- "这个 API 的认证方式是：先获取 token → 在 header 中携带"
- "调试这类 bug 的方法是：先查日志 → 检查环境变量 → ..."

**评估**：程序性知识是有价值的扩展，但不是 MVP 必需。
当前的 `plan.md` 可以部分承担这个角色。
**→ 不修改 MVP 设计。在 Future Extensions 中记录。**

#### CoALA: Cognitive Architectures for Language Agents (Sumers et al., 2023)

提出了一个 LLM Agent 认知架构的统一框架，
将记忆分为四种类型：

```
┌─────────────────────────────────────┐
│         Working Memory              │  ← context window
│         (有限, 当前活跃)             │
├─────────────────────────────────────┤
│  Episodic     │ Semantic │ Procedural│
│  情景记忆      │ 语义记忆  │ 程序记忆  │
│  "发生了什么"  │ "知道什么" │ "怎么做"  │
│  (experiences)│ (facts)  │ (skills)  │
└─────────────────────────────────────┘
```

**对我们设计的映射**：

| CoALA 类型 | git-mem 对应 | 状态 |
|-----------|-------------|------|
| Working Memory | Context Window (Pi 管理) | ✅ |
| Episodic Memory | Git 版本历史 (每个 commit 是一个 episode) | ✅ |
| Semantic Memory | Context 文件 (facts, decisions, constraints) | ✅ |
| Procedural Memory | 无直接对应 | ⚠️ 缺失 |

**评估**：三种长期记忆中我们覆盖了两种。
程序记忆可以通过 `procedures.md` 或 `plan.md` 部分覆盖。
**→ 不修改 MVP。但在 context 文件初始模板中加入 `procedures.md` 作为可选文件。**

#### ReadAgent (Lee et al., 2024)

处理长文档的 Agent。核心机制：
1. 对整个文档生成"gist memory"（每页一句话的摘要）
2. 需要细节时，根据 gist 选择性地重新阅读原文

```
Long Document → [Gist page 1] [Gist page 2] ... [Gist page N]
                      │
              Query: "What happened in chapter 3?"
                      │
                      ▼
              Gist page 3 matches → re-read page 3 in full
```

**对我们设计的验证**：

ReadAgent 的机制与我们的分层导航**几乎完全一致**：

| ReadAgent | git-mem |
|-----------|---------|
| Gist memory (每页一句) | _index.md (每个文件一行摘要) |
| 选择性重新阅读原文 | mem_recall / bash git show (读历史版本) |
| 原始文档 | Git 历史中的完整 context 文件 |

**→ 验证了我们分层导航设计的合理性。无需修改。**

#### RAPTOR (Sarthi et al., 2024)

Recursive Abstractive Processing for Tree-Organized Retrieval。
从底层文本块出发，递归地聚类和摘要，构建一棵"摘要树"。

```
Level 0: [chunk1] [chunk2] [chunk3] [chunk4] [chunk5] [chunk6]
Level 1:    [summary 1-3]              [summary 4-6]
Level 2:         [summary 1-6]
```

检索时可以在不同层级搜索：
- Level 2 回答宏观问题
- Level 0 回答细节问题

**对我们设计的启示**：

我们的层级结构是**手动维护**的（_index.md → 文件 → git 历史）。
RAPTOR 的层级是**自动构建**的（聚类 + 摘要）。

自动构建的优势：不依赖 LLM 正确维护 _index.md。
手动维护的优势：结构更可控、更透明。

**评估**：对我们的规模（通常 5-15 个 context 文件），
手动维护 _index.md 比自动聚类更实际。
如果文件数量增长到 50+，可以考虑 RAPTOR 的自动聚类。
**→ 不修改。**

---

## 二、生产级记忆系统：工业实践

### 2.1 Mem0 (formerly EmbedChain, 2024)

开源的 AI Agent 记忆层。核心特点：

1. **自动化事实提取**：不需要 Agent 主动调用"记住这个"工具。
   系统自动从对话中提取事实，存入图结构记忆。
2. **图结构**：记忆之间有关系（"用户 → 偏好 → 深色模式"）
3. **三层记忆**：用户级（跨 session）、session 级、agent 级
4. **冲突检测**：新事实与旧事实冲突时自动处理

**对我们设计的关键启示**：

**自动化提取 vs Agent 主动编码**

| | 我们的方案 (Agent 主动) | Mem0 (自动提取) |
|---|---|---|
| 触发 | Agent 调用 ctx_update | 系统自动分析每轮对话 |
| 可靠性 | 依赖 Agent 判断 | 不依赖 Agent |
| 成本 | 零（只有 Agent 决定记录时） | 每轮对话一次 LLM 调用 |
| 质量 | Agent 做深层加工 | 系统做表面提取 |
| 结构 | Agent 决定放哪个文件 | 系统自动分类 |

**评估**：

Mem0 的自动提取解决了"Agent 忘记调用 ctx_update"的问题，
但它提取的是**原子事实**（key-value pairs），
不是我们需要的**结构化、多 facet 的 context**。

而且每轮对话一次额外 LLM 调用的成本不低。

我们的方案：Agent 主动编码（高质量，零成本）+ compaction 兜底（批量提取），
在质量和成本之间取得了更好的平衡。

**但有一个值得借鉴的点**：Mem0 的**冲突检测**。
当新事实与旧事实矛盾时，应该提示处理。
**→ 建议在固化 prompt 中增加冲突检测指令。**

### 2.2 Zep (2024)

AI 助手的记忆基础设施。核心特点：

1. **时间感知**：追踪事实何时被记录、何时过期
2. **自动事实提取 + 知识图谱**：从对话中提取实体和关系
3. **业务上下文**：区分用户偏好、会话上下文、业务知识

**对我们设计的验证**：

Zep 的时间感知机制与我们的来源追踪（`[recorded: date]`）一致。
他们的知识图谱比我们的文件系统更复杂，但对我们的场景（编程 Agent）
文件系统更合适（开发者熟悉、git 天然支持、易于阅读和调试）。

**→ 验证了我们的来源追踪设计。无需修改。**

---

## 三、检索增强：提升回忆质量

### 3.1 GraphRAG (Microsoft, 2024)

用知识图谱增强 RAG：
1. 从文档中提取实体和关系
2. 用社区检测算法对实体聚类
3. 对每个社区生成摘要
4. 检索时同时搜索社区摘要和原始文档

**对我们设计的启示**：

GraphRAG 的社区摘要层与我们的 `_index.md` 角色类似——
提供高层概览。但他们是自动生成的。

更重要的是 GraphRAG 的**实体关系追踪**。
我们的 context 文件之间存在隐含的关系：
- `strategy-params.md` 的参数变化 → `backtest-results.md` 的结果变化
- `goals.md` 的目标 → `constraints.md` 的约束

但我们没有显式追踪这些关系。

**评估**：显式的关系追踪增加复杂度，但确实能帮助关联分析。
例如，当用户问"MA 周期对 Sharpe 的影响"时，
如果系统知道 strategy-params 和 backtest-results 是关联的，
就能更精准地同时 recall 两个文件的对应版本。

**→ 不在 MVP 实现，但建议在 _index.md 中记录文件间的关联关系。**

```markdown
## File Relationships
- strategy-params.md ↔ backtest-results.md (参数变化影响回测结果)
- goals.md → plan.md (目标驱动计划)
```

### 3.2 Hybrid Search (BM25 + 向量检索)

RAG 研究的共识：**混合搜索优于单一方法**。

- BM25（关键词匹配）：精确但无语义理解
- 向量检索（embedding 相似度）：有语义理解但可能丢失精确匹配
- 混合：两者互补

我们的自动回忆用的是**纯关键词搜索**（git grep + git log --grep）。
这够用吗？

**评估**：

对编程场景来说，关键词搜索的命中率可能已经很高：
- 参数名、函数名、类名都是精确的（"MA 10/30"、"Sharpe"）
- 用户通常用精确术语提问

但对模糊查询（"之前那个效果最好的方案"）关键词搜索会失败。

**→ MVP 用关键词搜索。Future Extension 考虑加入 embedding 搜索。**

---

## 四、综合分析：我们的设计缺了什么？

### 4.1 发现的差距

| # | 差距 | 来源 | 严重性 | 建议 |
|---|------|------|--------|------|
| 1 | `rejected.md` 缺少失败原因和教训 | Reflexion | 🟡 | 修改格式，加入因果链 |
| 2 | 固化 prompt 缺少冲突检测 | Mem0 | 🟡 | 加入冲突检测指令 |
| 3 | 无程序记忆 (procedural memory) | CoALA, Voyager | 🟢 | 加入可选的 procedures.md |
| 4 | _index.md 缺少文件间关联关系 | GraphRAG | 🟢 | 加入 Relationships section |
| 5 | 自动回忆缺少语义搜索 | Hybrid Search | 🟢 | Future Extension |

### 4.2 设计已验证的部分

| 设计元素 | 被哪些研究验证 |
|---------|--------------|
| 外化心智模型 + 版本控制 | MemGPT (core memory), CoALA (external memory) |
| 多文件结构化存储 | CoALA (四种记忆类型), BDI |
| 分层导航 (index → file → history) | ReadAgent (gist → re-read), RAPTOR (tree levels) |
| 两阶段更新 (实时 + 固化) | Complementary Learning Systems (hippocampus + neocortex) |
| 冷热分层归档 | MemoryBank (forgetting curve), Ebbinghaus |
| 编码触发规则 | Generative Agents (importance scoring) |
| [pinned] 不可修改标记 | TMS (truth maintenance), AGM (belief revision) |
| Agent 主动编码 vs 纯自动提取 | MemGPT (agent-driven) vs Mem0 (automated) — 我们选择了 agent-driven + compaction 兜底，平衡了质量和成本 |

---

## 五、推荐的修改

### 修改 1：rejected.md 格式（来自 Reflexion）

```markdown
# 旧格式
## Rejected
- 用 zipline 做回测框架

# 新格式
## Rejected
### 用 zipline 做回测框架
- **尝试时间**: compaction 2
- **失败原因**: Python 3.10 兼容性问题，社区维护停滞
- **教训**: 优先选择活跃维护的框架
- **替代方案**: backtrader (已采用)
```

**理由**：Reflexion 证明，带有因果推理的反思记忆
比简单列表有效得多。Agent 在未来遇到类似情况时，
能从教训中学习，而不只是知道"这个试过了"。

### 修改 2：固化 prompt 增加冲突检测步骤（来自 Mem0）

在 COGNITIVE-RULES.md §2 的固化 prompt 的第一步后增加：

```
### 第 1.5 步：检测冲突

检查提取的新信息是否与当前 Context 中的已有信息矛盾。
如果发现矛盾：
- 明确标注矛盾：在更新的文件中标记
  "⚠️ 冲突: 之前记录 Sharpe=1.5，新对话显示 Sharpe=1.3（可能测试条件不同）"
- 保留两个版本直到确认，不默默覆盖

如果不矛盾，跳过此步。
```

**理由**：如果 LLM 默默覆盖了一个旧的正确值，
信息就无声地丢失了（即使 git 有历史，Agent 也不会知道去查）。
显式标注冲突比隐式覆盖更安全。

### 修改 3：_index.md 增加文件关联（来自 GraphRAG）

```markdown
# _index.md 新增 section

## Relationships
- strategy-params.md ↔ backtest-results.md
  (参数变化直接影响回测结果，通常应同步查看)
- goals.md → plan.md
  (目标变更时计划需要同步更新)
```

**理由**：当 Agent 查看一个文件的历史时，
关联关系提示它应该同时查看关联文件的历史。
这帮助回答"MA 周期对 Sharpe 的影响"这类跨 facet 的问题。

### 修改 4：可选的 procedures.md（来自 CoALA + Voyager）

在初始化模板中加入：

```markdown
# procedures.md (可选)
记录项目中的常用操作流程和解决方案模式。

## 回测流程
1. 修改 strategy.py 中的参数
2. 运行 python backtest.py --start 2020 --end 2023
3. 查看 results/report.html

## 部署流程
1. ...
```

**理由**：这补全了 CoALA 框架中缺失的"程序记忆"。
对编程 Agent 来说，记住"怎么做"和记住"知道什么"一样重要。
标记为可选——LLM 只在发现重复性操作时才创建。

---

## 六、最终评估

### 我们的设计在研究全景中的位置

```
                        自动化程度
                   低 ◄─────────────► 高
                   │                  │
        简单  ─────┤   Pi 默认        │
        存储       │   compaction     │
                   │                  │
                   │        ┌─────┐   │
                   │        │git- │   │
                   │        │mem  │   │  Mem0
                   │        └─────┘   │  Zep
        结构  ─────┤                  │
        化         │                  │
        存储       │   MemGPT        │
                   │                  │
                   │                  │
        知识  ─────┤                  │
        图谱       │           GraphRAG
                   │                  │
```

git-mem 的定位：**中等自动化 + 结构化存储 + 版本控制**。

它不是最自动化的（Mem0 更自动），
不是最精密的（GraphRAG 用知识图谱），
但它是**唯一具备版本控制和回滚能力的**，
也是**唯一能做 per-facet 历史追踪和 diff 的**。

这个定位是差异化的，也是我们需求驱动的。

### 设计是否最优？

**对我们的需求（编程 Agent 的结构化、可版本控制的记忆系统）来说，
当前设计是合理且接近最优的。**

主要理由：
1. 核心机制（两阶段更新、多文件 Context、git 版本控制）
   被多个独立研究验证
2. 差异化能力（版本回滚、per-facet diff）没有看到其他系统提供
3. 降级安全（最差 = 现状）降低了风险
4. 实施复杂度低（1 个工具 + 2 个 hook）

4 个小修改（rejected 格式、冲突检测、文件关联、procedures.md）
可以进一步提升质量，但不改变架构。
