# 前沿研究与技术分析：LLM 的结构化状态管理

## 我们要解决的根本问题

抽象来看，我们面对的问题是：

> **一个 LLM Agent 需要在有限的工作记忆（context window）下，
> 可靠地维护一份结构化的、持续演化的外部知识状态。**

这个问题可以分解为：

| 子问题 | 描述 |
|--------|------|
| **何时写入** | 什么时候把信息从对话提取到外部状态？ |
| **写什么** | 提取哪些信息？以什么结构存储？ |
| **何时更新/删除** | 信息过时、被纠正、或焦点切换时怎么办？ |
| **何时读取** | 什么时候从外部状态加载信息到 context？ |
| **读什么** | 加载哪些信息？如何避免过载 context？ |
| **一致性** | 多次更新后，状态如何保持内部一致？ |

这些子问题在不同的研究领域都有对应的工作。

---

## 1. 最直接相关：MemGPT / Letta

**论文**: *MemGPT: Towards LLMs as Operating Systems* (2023, UC Berkeley)
**项目**: https://github.com/letta-ai/letta

### 核心思路

MemGPT 把 LLM context 管理类比为**操作系统的虚拟内存**：

```
┌─────────────────────────────┐
│   Main Context (RAM)         │  ← LLM 能看到的（有限）
│   - System prompt            │
│   - Core Memory (editable)   │  ← "always on" 的关键信息
│   - Recent messages          │
├─────────────────────────────┤
│   External Storage (Disk)    │  ← LLM 看不到，但可通过工具访问
│   - Archival Memory          │  ← 长期存储，可搜索
│   - Recall Memory            │  ← 对话历史，可搜索
└─────────────────────────────┘
```

关键设计：
- **Core Memory**：一块始终在 context 中的可编辑文本区（类似我们的 Context 文件）
- **LLM 自己管理内存**：通过函数调用 `core_memory_append`、`core_memory_replace`、
  `archival_memory_insert`、`archival_memory_search` 等
- **在对话过程中实时管理**，不是事后批量处理

### 对我们的启示

**MemGPT 验证了一个关键假设：LLM 可以通过工具调用来管理自己的外部记忆。**

但 MemGPT 有几个局限，恰好是我们设计要解决的：

| MemGPT | git-mem 的改进 |
|--------|---------------|
| Core Memory 是扁平文本块 | 多文件结构化 Context，按 facet 组织 |
| 没有版本历史 | git 追踪每个文件的完整演化 |
| 无法回到过去的状态 | `mem_recall(hash)` 检索任意历史版本 |
| 无法对比状态变化 | `mem_diff` 看 Context 如何演化 |
| Archival Memory 是无结构的 | Context 文件有明确的 schema |

**但 MemGPT 有一个我们尚未采纳的关键设计：实时内存管理。**

---

## 2. 关键启示：WHEN to update — 实时 vs 批量

### 我们当前的设计：compaction-time 批量更新

```
对话进行 (20轮) → compaction 触发 → LLM 从 20 轮对话中一次性提取信息 → 更新 Context
```

**问题**：
- 这 20 轮对话中，LLM 需要**回顾性地**识别哪些信息重要
- 但此时它可能已经"忘记"了对话初期的上下文
- 批量提取容易遗漏细节
- 类似于"一个月做一次笔记" vs "每天做笔记"

### MemGPT 的设计：实时增量更新

```
每轮对话中，LLM 随时可以调用:
  core_memory_append("用户偏好: 不要超过 -25% 的最大回撤")
  core_memory_replace("当前参数", "MA 10/30, RSI 70")
  archival_memory_insert("v2回测完整结果: ...")
```

**优势**：
- 信息在**产生的瞬间**被捕获，此时 LLM 拥有完整上下文
- 小增量更新比大批量更新更可靠
- 不依赖 compaction 作为唯一的更新时机

### 对 git-mem 的设计影响

**这可能是整个设计中最重要的一个决策：应该采用实时更新 + compaction 校准的混合模式。**

```
实时更新 (turn_end 或 agent 主动调用):
    Agent 在对话过程中随时更新 Context 文件
    → 小增量修改，高保真
    → git 自动 commit (或暂存)

Compaction 校准 (compaction 时):
    LLM 审视当前 Context 文件 + 即将被压缩的消息
    → 确认没有遗漏
    → 调整状态标注 (Active/Paused/Archived)
    → 执行大小预算控制
    → git commit (正式检查点)
```

好处：
- 实时更新保证信息不丢失（在 LLM 有完整上下文时捕获）
- Compaction 校准保证 Context 的整洁和一致性
- 两者互补，而不是只依赖其中一个

---

## 3. Generative Agents 的记忆架构

**论文**: *Generative Agents: Interactive Simulacra of Human Behavior*
(2023, Stanford, Park et al.)

### 三层记忆模型

```
Observation → Memory Stream → Reflection → Planning
                  │                │
                  │                └─→ 高阶洞察（从多个观察中提炼）
                  │
                  └─→ 原始观察记录
```

- **Memory Stream**：所有观察的时间线记录（类似 JSONL）
- **Reflection**：周期性地从观察中提炼高阶洞察（类似 compaction）
- **Retrieval**：基于 recency × importance × relevance 打分检索

### 对我们的启示

**Reflection 的触发机制值得借鉴：**

Generative Agents 不是按固定时间间隔做 reflection，
而是在**累积的观察重要性超过阈值**时触发。

映射到我们的场景：
- 不只在 compaction 时更新 Context
- 当对话中出现"重要信息"（新决策、参数变更、测试结果）时，主动触发 Context 更新
- "重要性"可以由 LLM 在每轮对话后评估

**Retrieval 的打分机制也值得借鉴：**

检索历史 Context 版本时，不只按时间排序，还应考虑：
- **Recency**：最近的更相关
- **Importance**：关键决策、测试结果比日常讨论更重要
- **Relevance**：与当前对话主题的相关性

---

## 4. 认知架构的经验

### ACT-R / SOAR 的工作记忆管理

经典认知架构研究了几十年的问题：**有限的工作记忆如何与大量的长期记忆交互？**

核心概念：

- **Activation spreading**：当前任务激活相关的长期记忆
- **Decay**：不被使用的记忆逐渐衰减
- **Chunk**：信息被组织为有意义的"块"，提高工作记忆效率

映射到 git-mem：
- Context 文件中的每个 section/topic 是一个"chunk"
- Active 主题 = 高激活水平 → 完整保留
- Paused 主题 = 低激活水平 → 可以被精简
- 长期不用 = 衰减到 archived → 只保留引用

**这给了我们 REVIEW-v4 中冷热分层机制一个理论基础。**

### BDI (Belief-Desire-Intention) 架构

BDI 模型明确区分了三种心理状态：

| BDI | 映射到 Context |
|-----|---------------|
| Belief（信念）| 对世界/项目的理解：约束条件、技术事实、测试结果 |
| Desire（愿望）| 目标：goals.md 中的内容 |
| Intention（意图）| 当前计划：正在执行的步骤、下一步行动 |

**启示**：Context 文件的结构可以按 BDI 三层组织：
- **Beliefs**：我们知道什么（facts、constraints、test results）
- **Desires**：我们想要什么（goals，可以有多个，有优先级）
- **Intentions**：我们正在做什么（current plan、next steps）

焦点切换时：
- Beliefs 通常保持不变（除非新信息修正了旧认知）
- Desires 改变优先级（旧目标 pause，新目标 activate）
- Intentions 完全切换（新的行动计划）

这比简单的"给所有东西打 Active/Paused 标签"更精细。

---

## 5. 知识库维护与信念修正

### Truth Maintenance Systems (TMS)

经典 AI 中的 TMS 解决的问题：**当你撤回一个假设时，所有依赖该假设的推论都应该被撤回。**

例如：
- 假设 A："MA 10/30 是最优参数"
- 基于 A 的推论 B："因此我们应该用 10/30 部署"
- 如果我们发现 A 不对（新的回测显示 MA 20/50 更好），B 也应该自动失效

**启示**：Context 文件中的信息之间有依赖关系。
更新一条信息时，相关的推论也应该被重新审视。

实际上很难在 LLM 系统中实现完整的 TMS。但可以：
- 在 Context 文件中标注信息的依赖关系
  （如 `决策: 用 MA 10/30 部署 [基于: backtest-v2]`）
- 当 LLM 更新上游事实时，提示它检查下游推论

### Belief Revision (AGM Theory)

AGM 理论定义了信念修正的三种操作：
- **Expansion**：添加新信念（不与现有信念冲突）
- **Revision**：添加新信念，必要时移除冲突的旧信念
- **Contraction**：移除一条信念

映射到 Context 更新：
- **Expansion**：新增信息（新策略参数、新测试结果）→ 简单追加
- **Revision**：修正信息（"之前说 Sharpe 是 1.5，实际跑下来是 1.3"）→ 更新并标注修正
- **Contraction**：撤回信息（"那个约束条件其实不需要了"）→ 移入 rejected.md

**启示**：LLM 的 Context 更新 prompt 应该区分这三种操作，
而不是只说"更新 Context 文件"。

---

## 6. 实用技术：提高状态管理可靠性

### 6.1 结构化输出 (Structured Output)

不要让 LLM 输出自由格式的 markdown，而是输出结构化的更新指令：

```json
{
  "operations": [
    {
      "type": "update_status",
      "file": "goals.md",
      "topic": "均线交叉策略回测",
      "from": "active",
      "to": "paused",
      "reason": "用户想先研究动量策略原理"
    },
    {
      "type": "add_topic",
      "file": "goals.md",
      "topic": "动量策略市场原理研究",
      "status": "active",
      "content": "理解动量因子的理论基础和适用市场环境"
    },
    {
      "type": "update_fact",
      "file": "strategy-params.md",
      "topic": "均线交叉",
      "key": "best_version",
      "value": "v2 (MA 10/30, RSI 70, Sharpe 1.5)"
    }
  ]
}
```

**优势**：
- 每个操作是原子的、可验证的
- 可以 deterministic 地应用（不依赖 LLM 写 markdown 的一致性）
- 容易做冲突检测（两个操作修改同一个 key）
- 容易做 undo

**劣势**：
- 需要预定义操作类型和 schema
- 可能限制 LLM 的灵活性（真正的知识很难完全结构化）

### 6.2 两阶段更新 (Plan-then-Execute)

```
阶段 1 (Plan): 
    LLM 读取当前 Context + 新对话
    → 输出"更新计划"：哪些文件需要什么操作
    （轻量输出，便于人工审查或自动校验）

阶段 2 (Execute):
    基于更新计划，LLM 生成具体的文件内容
    （或由确定性代码执行简单操作，LLM 只处理复杂的内容更新）
```

**优势**：
- Plan 阶段便于校验（"你确定要把均线策略标记为 paused？"）
- 分离"决策"和"执行"，降低出错概率
- Plan 可以被缓存/审计

### 6.3 自校验 (Self-Verification)

更新 Context 后，让 LLM 做一次一致性检查：

```
"请检查更新后的 Context 文件是否存在以下问题：
1. 信息冲突（同一事实在不同文件中有不同值）
2. 悬垂引用（引用了不存在的主题或 commit）
3. 状态不一致（goals 说 Active 但 strategy-params 说 Paused）
4. 遗漏信息（新对话中提到的重要信息未被记录）"
```

**成本**：额外一次 LLM 调用。
**价值**：在错误被固化到 git 历史之前捕获。

### 6.4 实时更新工具 (MemGPT 式)

给 Agent 提供在对话过程中更新 Context 的工具：

```typescript
// Agent 在对话中可以随时调用
context_note(topic, fact)        // "均线策略", "v2 Sharpe=1.5"
context_status(topic, status)    // "均线策略", "paused"
context_update(file, content)    // 更新整个文件
```

**不需要等 compaction。Agent 在有完整上下文的时候，主动记录重要信息。**

这可能是**比 compaction-time 批量更新更可靠的方式**。

---

## 7. 综合建议：git-mem 应该借鉴什么

### 采纳

| 来源 | 借鉴什么 | 在 git-mem 中如何体现 |
|------|---------|---------------------|
| **MemGPT** | 实时内存管理（不只在 compaction 时） | Agent 拥有 `context_*` 工具，在对话中随时更新 Context |
| **MemGPT** | LLM 自主管理记忆 | Agent 决定什么信息写入/更新/归档 |
| **Generative Agents** | 重要性驱动的更新触发 | 不只按时间/大小触发，也按信息重要性触发 |
| **BDI** | Belief/Desire/Intention 三层结构 | Context 文件按此组织，焦点切换时分别处理 |
| **AGM** | 区分 Expansion/Revision/Contraction | 更新 prompt 区分这三种操作类型 |
| **结构化输出** | 原子化更新操作 | Context 更新以结构化指令形式输出，确定性应用 |

### 观望（Phase 2+）

| 技术 | 原因 |
|------|------|
| TMS 式的依赖追踪 | 太复杂，先观察 LLM 自身的一致性维护能力 |
| 自校验 | 额外 LLM 调用成本高，先看是否必要 |
| 重要性评分 | 需要实验确定评分策略 |

### 不采纳

| 技术 | 原因 |
|------|------|
| 向量检索 | Context 文件量小，关键词搜索足够 |
| 完整的知识图谱 | 过度结构化，限制灵活性 |

---

## 8. 这如何改变 git-mem 的设计

### 最大的变化：更新时机

```
旧设计:
  对话进行 → compaction → 批量更新 Context → git commit

新设计:
  对话进行 → Agent 随时通过工具更新 Context (实时, 小增量)
           → compaction → 校准/整理 Context (批量, 大调整)
           → git commit (正式检查点)
```

### 新增工具

除了 4 个检索工具 (mem_log/recall/diff/search)，
新增 **3 个写入工具**：

| 工具 | 作用 | 调用时机 |
|------|------|---------|
| `ctx_note` | 记录一条事实到指定 topic | Agent 在对话中发现重要信息时 |
| `ctx_status` | 修改某个 topic 的状态 | 焦点切换时 |
| `ctx_update` | 更新/创建整个 Context 文件 | 需要大幅修改时 |

这 3 个工具的更新**暂存**在 Context 目录中（不立即 git commit），
等 compaction 时再做一次校准 + git commit。

或者，每次工具调用都 commit（给 Agent 提供极细粒度的版本历史）。

### Context 文件结构（BDI 启发）

```
context/
├── _index.md            ← 总索引 + 当前状态概要
├── beliefs/             ← 我们知道什么
│   ├── facts.md         ← 具体事实（参数值、测试结果、配置项）
│   ├── constraints.md   ← 约束条件
│   └── <domain>.md      ← 领域知识（LLM 按需创建）
├── desires/             ← 我们想要什么
│   └── goals.md         ← 所有目标，带状态标注
├── intentions/          ← 我们正在做什么
│   ├── current-plan.md  ← 当前行动计划
│   └── next-steps.md    ← 下一步
└── history/             ← 已完成/已放弃的
    └── rejected.md      ← 探索过但放弃的方向
```

焦点切换时的变化：
- `beliefs/` → 通常不变（事实不因焦点切换而改变）
- `desires/goals.md` → 旧目标 Pause，新目标 Active
- `intentions/` → 完全替换为新计划
- `history/` → 旧的 rejected 方向保留
