# 设计决策记录

本文档记录 git-mem 设计过程中的关键决策、考虑过的替代方案、
以及最终选择的理由。按决策时间排序。

---

## D1: Git vs 其他存储后端

**决策**: 使用 Git 作为 Context 的版本控制后端。

**考虑过的替代方案**:

| 方案 | 优点 | 缺点 |
|------|------|------|
| **Git** ✅ | 版本历史、per-file diff、grep、branch；零额外依赖 | grep 非语义化 |
| SQLite + FTS5 | 更快的全文搜索 | 无版本历史、无 diff、额外依赖 |
| Vector DB | 语义搜索 | 需要 embedding 模型；丧失精确检索 |
| Pi custom entry | 无额外存储 | 无 diff、无 per-file history |
| 纯文件夹 | 最简单 | 无版本历史、无回滚 |

**决定理由**: Git 是唯一同时提供版本历史、per-file diff、全文搜索、
和分支能力的方案。且所有开发机器都已安装，零额外依赖。

**Trade-off**: 牺牲了语义搜索能力。关键词搜索（git grep）在编程场景下
通常足够（参数名、函数名、术语都是精确的），
但对模糊查询（"之前那个效果好的方案"）会失效。

---

## D2: 存什么 — Context 文件 vs 原始对话

**决策**: Git 仓库中只存 Context 文件（精炼的心智模型），
不存原始对话（那是 Pi JSONL 的职责）。

**关键认知跃迁**: 最初的设计（v1）试图用 git 存储原始对话
（conversation.md + messages.json + summary.md + metadata.json）。
审查后认识到这是冗余的——Pi JSONL 已经存了。

**真正需要存储的是**: 从对话中提炼出的结构化理解（Context），
这是 Pi JSONL 中没有的。

**Trade-off**: 牺牲了从 git-mem 直接获取原始对话的能力。
如果 Agent 需要原始对话细节，需要回到 Pi JSONL
（通过 `ctx.sessionManager.getEntries()`）。
这极少发生——Context 文件中的精炼信息通常足够。

---

## D3: 文件结构 — 预设 vs 自由

**决策**: 只预设 `_index.md`，其他文件由 LLM 根据内容自行创建。

**考虑过的方案**:

| 方案 | 优点 | 缺点 |
|------|------|------|
| BDI 目录 (beliefs/desires/intentions/) | 认知科学理论支撑 | 分类歧义、路径冗长 |
| 7 个标准文件 (goals, constraints, ...) | 结构清晰 | 预设了答案；很多文件可能空着 |
| **只有 _index.md** ✅ | 最灵活；文件按内容自然涌现 | 首次质量依赖 LLM 判断 |

**决定理由**: 不同项目需要不同的 Context 结构。
量化项目需要 `strategy-params.md`，web 项目需要 `api-design.md`。
预设文件等于预设了问题的答案。

**Trade-off**: 首次固化时 LLM 需要从零决定文件结构，
可能创建出不好的组织方式。通过首次格式示范缓解（见 D12）。

---

## D4: 工具数量 — 7 个 vs 1 个

**决策**: 只注册 1 个自定义工具（ctx_update）。
读取操作通过 bash + 标准 git 命令完成。

**演化过程**: 7 (初始) → 5 (合并写入工具) → 1 (去掉所有读取工具)

**关键论点**: Agent 是编程助手，它本来就会用 git。
`bash("cd .git-mem && git show abc123:context/file.md")`
等价于 `mem_recall("abc123", "file.md")`，
但前者不需要额外工具，后者需要注册工具、占 system prompt tokens、
增加 LLM 选择负担。

ctx_update 是唯一需要保留的工具，因为它提供了
write + git add + git commit + 幂等检查 的原子性——
这用 write + bash 分两步做会脆弱。

**Trade-off**: Agent 需要知道 git 命令（通过 system prompt 教）。
这对编程 Agent 来说不是问题。
但对非编程 Agent（如果 git-mem 被移植到其他场景），
可能需要恢复自定义读取工具。

---

## D5: 更新时机 — 实时 vs 批量

**决策**: 两阶段更新。实时编码（ctx_update）+ 批量固化（compaction hook）。

**理论依据**: 认知科学的编码特异性原理（Tulving, 1973）——
在信息产生的当下捕获，比事后回忆提取可靠得多。

**实际考量**: MemGPT (Packer et al., 2023) 验证了
LLM 通过工具管理自己记忆的可行性。
但 Agent 不总是可靠地调用 ctx_update。
compaction hook 是安全网——即使 Agent 从不调用 ctx_update，
compaction 时仍然会通过 LLM 从对话中提取信息。

**Trade-off**: 实时编码依赖 Agent 的主动性（不可靠）。
降级模式（只有 compaction 固化）仍然优于 Pi 默认 compaction
（因为增量更新 vs 从头生成），但不如两阶段结合的效果。

---

## D6: _index.md 作为 Compaction Summary

**决策**: `_index.md` 的内容直接作为 Pi 的 compaction summary 返回。

**考虑过的方案**:

| 方案 | 优点 | 缺点 |
|------|------|------|
| 拼接所有 context 文件 | Agent 直接看到所有细节 | 可能 8k tokens，summary 太大 |
| 独立生成 summary | 可以更精炼 | 额外 LLM 调用 |
| **_index.md** ✅ | 自然的压缩视图；零额外开销 | 需要 LLM 维护好 Narrative |

**Trade-off**: Agent 在 compaction 后只直接看到 _index.md 的内容
（~500-1000 tokens），不直接看到其他 context 文件。
需要主动 `read` 或 `bash git show` 来获取细节。
但 _index.md 的 Narrative + Files 列表给了足够的线索
让 Agent 知道"哪里有更多信息"。

---

## D7: 安全机制的选择

**决策**: 采用 快照+回滚+后置验证 的组合，而非更复杂的方案。

**考虑过但砍掉的方案**:

| 砍掉的方案 | 砍掉的理由 |
|-----------|-----------|
| 周期性完整性校验 (每 5 次 compaction) | 产生警告但没有行动方处理 |
| Hot/Warm/Cold 三层 + metadata.json | 大小预算 + 一句 prompt 就能控制增长 |
| EXPAND/REVISE/CONTRACT 分类 | 增加 prompt 复杂度，LLM 直接更新更自然 |
| 4 种注解格式 | 只保留 [pinned]，其余靠 git 历史 |
| 两阶段 LLM 调用 (先提取再更新) | 单次调用 + chain-of-thought 足够 |

**保留的方案**:

| 保留的方案 | 保留的理由 |
|-----------|-----------|
| [pinned] + 代码验证 | 成本极低（几行字符串匹配），防护关键信息丢失 |
| 固化前快照 + 回滚 | 成本极低（2 行 git 命令），防护 LLM 写垃圾 |
| 后置验证 (5 项) | 成本极低（~15 行代码），捕获明显失败 |
| 首次格式示范 | 仅首次使用（~500 tokens），显著提升首次输出质量 |
| ctx_update 幂等 | 3 行代码，保持 git 历史干净 |

**选择原则**: 只保留"几行代码就能实现，但防护价值高"的机制。
复杂机制（需要额外状态追踪、额外 LLM 调用、或没有行动方）全部砍掉。

---

## D8: 自动回忆的定位

**决策**: 延后到 Phase 2，从最简单方案开始。

**理论背景**: 认知科学的前瞻记忆（预期性检索）——
不等 Agent 主动搜索，系统预先提供相关信息。
这比 Agent 主动搜索更可靠（Agent 的元认知不可靠）。

**为什么延后**: 自动回忆需要解决检索质量问题（精确率 vs 召回率），
这是一个经验问题，需要在实际运行中调优。
过度预设计一个未验证的算法是浪费。

**Phase 2 的起点**: 最简单的关键词匹配——
从用户 prompt 提取名词 → 搜索 git commit messages → 注入匹配的 context。
如果不够好，再加向量检索等复杂方案。

**Trade-off**: Phase 1 中 Agent 需要主动搜索记忆。
如果 Agent 忘了搜索，历史信息不会自动出现。
_index.md 中的 Narrative 和 Files 列表部分缓解了这个问题。

---

## D9: 过度设计的教训

**背景**: 设计过程经历了 50 → 12 → 18 个设计元素的演化。
50 的阶段包含了大量"理论上有道理但实际增加复杂度"的机制。

**教训**:

1. **不要教 LLM 做它已经会的事**。
   焦点切换的 4 级规则、信息分类为 EXPAND/REVISE/CONTRACT——
   LLM 天生理解这些概念，给它过多的规则反而干扰自然行为。

2. **不要为经验问题设计理论方案**。
   信息衰减、LLM 固化质量这些问题只能通过实际运行来验证。
   过度预设计（如周期性完整性校验）是浪费，
   因为你不知道问题会以什么形式出现。

3. **如果一个机制没有行动方，就不需要这个机制**。
   警告/指标/校验的结果必须有人（或代码）会处理。
   否则就是噪音。

4. **已有的工具是最好的工具**。
   Agent 有 bash，git 是成熟的 CLI 工具。
   在它们之上包一层 custom tool 通常不会更好，只会更多。

---

## D10: 认知科学的实际应用边界

**背景**: 设计中参考了大量认知科学研究（MemGPT, Generative Agents,
Complementary Learning Systems, Ebbinghaus, BDI, 等等）。

**实际应用了的**:
- 两阶段更新（编码 + 固化）← Complementary Learning Systems
- 编码信号词清单 ← Generative Agents (importance scoring 的简化版)
- [pinned] ← Truth Maintenance Systems

**没有直接应用的**:
- Ebbinghaus 遗忘曲线（用简单的大小预算替代）
- BDI 目录结构（扁平化了）
- MAX_HOT_TOPICS=4（Cowan 2001 的工作记忆容量，不直接适用于文件系统）
- RAPTOR 的递归聚类（规模太小不需要）
- 向量检索（关键词搜索在编程场景下够用）

**教训**: 认知科学提供了有价值的**思维框架**
（理解问题的本质、指导设计方向），
但不应该直接搬运其机制到工程实现中。
工程需要的是简单、可靠、可维护的方案，
不是对理论的忠实复现。

---

## D11: BDI 认知框架的应用方式

**决策**: BDI (Belief-Desire-Intention) 作为思维框架指导 prompt 设计，
但不实现为文件结构或预设文件。

**考虑过的方案**:

| 方案 | 优点 | 缺点 |
|------|------|------|
| BDI 目录 (beliefs/, desires/, intentions/) | 理论完备 | 分类歧义、路径冗长 |
| 预设 goals.md | 保证目标被追踪 | 非目标驱动任务时空文件；预设了没有边界（为什么不也预设 constraints.md?） |
| **框架在 prompt 中，不在文件中** ✅ | 灵活；LLM 自然适配不同任务类型 | 首次文件结构取决于 LLM 判断 |

**决定理由**:

1. BDI 是为有内部认知状态的自主 Agent 设计的。
   LLM Agent 没有内部状态——它的全部"认知"来自 context 中的文本。
   硬套 BDI 到文件结构上是把哲学框架当工程规范。

2. 如果"目标太重要必须预设 goals.md"，
   那约束、决策同样重要——回到 7 个预设文件的滑坡。

3. 真正的问题不是"Agent 的信念和欲望是什么"，
   而是"compaction 后需要什么信息才能继续工作"。
   答案因任务而异，不能用固定框架预设。

**实际体现**:
- 固化 prompt 规则 1 补充了优先保留的信息类型
  （目标、验证结果、约束、失败原因）
- Few-shot 示例展示了 goal tracking 的模式
  （LLM 看到后自然学会，但不强制）
- 目标驱动任务 → LLM 自然创建 goals.md
- 探索性任务 → LLM 不会被迫创建空的 goals.md

---

## D12: Few-shot 示例的领域锚定风险

**决策**: 首次固化使用**纯格式示范**（占位内容），不使用领域具体的示例。

**问题**: 如果示例是量化策略场景（goals.md + backtest-results.md），
LLM 在处理 web 开发、bug 修复等完全不同的任务时，
会被锚定到示例的内容模式——模仿创建 goals.md、使用 v1/v2/v3 命名、
硬套 Target/Status 结构，即使这些不适合当前任务。

Few-shot 示例同时教了 FORMAT（需要）和 CONTENT PATTERN（不需要）。

**解决**: 用占位符 `<根据实际内容命名>.md` 替代具体文件名，
用 `<从对话中提取的关键信息>` 替代具体内容。
附加"格式要点"列表说明规则。

LLM 学会的是"怎么输出"，而不是"输出什么"。

---

## 设计演化时间线

```
v1   初始设计: git 存储原始对话 (4文件结构 + 7工具)
      ↓ "JSONL 已经存了对话"
v2   修正: git 存储 Context 文档 (单文件 CONTEXT.md)
      ↓ "Context 不是单一文档，是多 facet"
v3   多文件: 按领域组织 + per-file 版本控制
      ↓ "焦点切换怎么办？"
v4   状态管理: Active/Paused 标注 + 冷热分层
      ↓ "应该实时编码，不只是 compaction 时"
v5   认知框架: 两阶段更新 + 认知科学基础
      ↓ "前沿研究验证 + 补充"
v6   研究整合: Reflexion, Mem0, CoALA 的启示
      ↓ "是不是过度设计了？"
v7   精简: 50 → 12 个元素
      ↓ "有没有砍过头？"
v8   回填: 12 → 18 个元素 (加回高价值安全机制)
      ↓ "最终验证"
v9   定稿: 19 个元素 (加分段处理)
      ↓ "领域具体的示例会锚定 LLM"
v10  格式示范: 用占位符替代领域示例，避免锚定效应

完整的演化过程保留在 archive/ 目录中。
```
