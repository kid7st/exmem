# 需求验证：当前设计能否完成预期目标？

## 当前设计方案概要

```
组件:
  1 个自定义工具: ctx_update
  读取: bash + git 命令
  系统行为: compaction hook (记忆固化) + auto-recall (自动回忆)
  存储: .git-mem/ 下的多文件 Context + git 版本控制

Agent 工具集: read, write, bash, edit, ctx_update (共 5 个)
```

---

## 需求追溯与检验

### 原始需求 (用户第一条消息)

| # | 需求 | 满足？ | 如何满足 |
|---|------|--------|---------|
| 1 | context 超过模型最大空间后需要压缩 | ✅ | 保持 Pi 原有 compaction 机制，git-mem 作为 extension 增强 |
| 2 | 现有压缩太粗暴，直接把长文本压成短文本 | ✅ | 改为增量更新结构化 Context 文件，而非每次从头生成摘要 |
| 3 | 压缩丢失大部分信息 | ✅ | 信息被结构化地保留在 Context 文件中 + git 历史保留所有版本 |
| 4 | 需要细节时无法检索已压缩的信息 | ✅ | `bash("git show <hash>:context/<file>")` 检索任意历史版本 |
| 5 | git commit 可以作为压缩过程 | ✅ | 每次 compaction/ctx_update = 一个 git commit |
| 6 | commit message 作为压缩后的信息 | ✅ | commit message 描述 Context 变更内容 |
| 7 | 可以 checkout 特定 commit 获取细节 | ✅ | `git show <hash>:context/<file>` |
| 8 | 可以用新 branch 来切换 context | ⚠️ | 设计中提到但降为 Phase 4，MVP 不实现 |

### 演化出的需求 (讨论过程中明确的)

| # | 需求 | 满足？ | 如何满足 |
|---|------|--------|---------|
| 9 | Context ≠ 原始对话，是累积构建的结构化理解 | ✅ | Context 文件是精炼的心智模型，JSONL 存原始对话 |
| 10 | 多 facet 独立演化 (参数 vs 结果 vs 目标) | ✅ | 多个 Context 文件，每个独立版本控制 |
| 11 | 按 facet 追踪历史 | ✅ | `git log -- context/<file>` |
| 12 | 跨版本对比 (参数变了 → 结果怎么变) | ✅ | `git diff <h1> <h2> -- context/<file>` |
| 13 | 回滚到特定版本 | ✅ | git show 读旧版 → ctx_update 写回 |
| 14 | 焦点切换不丢信息 | ✅ | Active/Paused 状态标注 |
| 15 | 实时编码 (不只在 compaction 时) | ✅ | ctx_update 在对话中随时可调用 |
| 16 | 自动回忆 | ✅ | before_agent_start hook |
| 17 | 冷热分层大小控制 | ✅ | Hot/Warm/Cold + 预算限制 |

### 量化交易场景端到端验证

```
场景：经过 4 轮参数迭代，用户要求回到 v2 并分析 MA 周期对 Sharpe 的影响

─── 对话阶段 (v1 → v4) ───

[Agent 在每次参数变更后调用]
ctx_update("strategy-params.md", "# Strategy Params\n## v1\nMA 10/20, RSI 70", "v1 params")
ctx_update("backtest-results.md", "# Results\n## v1\nSharpe 1.2, MaxDD -18%", "v1 results")
  ... (compaction 可能在中间发生，context 文件的历史被 git 保留) ...
ctx_update("strategy-params.md", "...v2: MA 10/30...", "v2 params")
ctx_update("backtest-results.md", "...v2: Sharpe 1.5...", "v2 results")
  ... v3, v4 同理 ...

─── 用户: "v2 的结果最好，回到 v2 的参数" ───

Agent:
  bash("cd .git-mem && git log --oneline -- context/strategy-params.md")
  → abc1234 v4 params
    def5678 v3 params
    ghi9012 v2 params     ← 目标
    jkl3456 v1 params

  bash("cd .git-mem && git show ghi9012:context/strategy-params.md")
  → MA fast=10, slow=30, RSI=70

  bash("cd .git-mem && git show ghi9012:context/backtest-results.md")
  → Sharpe=1.5, MaxDD=-15%

  [用 v2 参数修改代码, 重新回测]

  ctx_update("strategy-params.md", "...v5=v2: MA 10/30...", "revert to v2 params")
  ctx_update("backtest-results.md", "...v5 results...", "v5 backtest")

─── 用户: "帮我分析 MA 周期和 Sharpe 的关系" ───

Agent:
  bash("cd .git-mem && git log --oneline -- context/strategy-params.md")
  → 看到 5 个版本

  bash("cd .git-mem && git diff ghi9012 abc1234 -- context/strategy-params.md")
  → v2→v4: MA fast 10→20, slow 30→50 (RSI 不变)

  bash("cd .git-mem && git diff ghi9012 abc1234 -- context/backtest-results.md")
  → v2→v4: Sharpe 1.5→1.1, MaxDD -15%→-22%

  Agent 回答: "增大 MA 周期 (10/30→20/50) 导致 Sharpe 从 1.5 降到 1.1，
              MaxDD 从 -15% 恶化到 -22%。MA 周期越大表现越差。
              v2 的 MA 10/30 是最优配置。"

  ✅ 完全满足需求
```

### 焦点切换场景验证

```
─── 用户: "先放下均线策略，研究一下动量策略的原理" ───

Agent:
  ctx_update("goals.md",
    "# Goals\n## 🟢 Active: 动量策略研究\n...\n## ⏸️ Paused: 均线策略\n...",
    "switch focus to momentum")

  [对话继续讨论动量策略, compaction 可能发生]
  [compaction hook 更新 context 文件, _index.md 显示 "Active: 动量策略"]

─── 用户: "好，回到均线策略" ───

Agent:
  read(".git-mem/context/goals.md")
  → 看到均线策略标记为 Paused，有 v2 最优参数的摘要

  如果需要更多细节:
  bash("cd .git-mem && git log --oneline -- context/strategy-params.md")
  → 看到完整的参数演化历史

  ctx_update("goals.md", "...Active: 均线策略, Paused: 动量策略...",
    "switch back to mean-reversion")

  ✅ 两个主题的 context 都被保留，随时切换
```

---

## 尚存的风险点

### 1. ctx_update 的使用率决定系统上限

```
最佳情况: Agent 勤勉地在关键时刻调用 ctx_update
  → context 文件实时反映最新状态
  → git 历史细粒度

降级情况: Agent 从不主动调用 ctx_update
  → context 文件只在 compaction 时更新 (通过 hook)
  → 依然比 Pi 默认 compaction 好 (增量更新 vs 从头生成)
  → 但 git 历史粒度粗 (只有 compaction 间隔的检查点)

最差情况: Agent 不调用 ctx_update，且 compaction hook 的 LLM 输出质量差
  → 降级为 Pi 默认 compaction
  → 不会比现在更差
```

**结论**：系统有优雅降级，最差情况 = 现状。

### 2. 首次 compaction 的冷启动质量

第一次 compaction 时 context 文件从零开始（或从空模板开始）。
这次更新的质量决定了后续所有增量更新的基础。

**缓解**：初始化模板 + compaction prompt 中的明确指令。

### 3. 实际中 Agent 会不会在 bash 中写错 git 命令？

Agent 可能写出有语法错误的 git 命令，或者用错 hash。
但这与 Agent 使用 bash 做其他事（grep, find, sed）时面临的风险相同。
git 的错误信息足够清晰，Agent 通常能自我纠正。

### 4. 自动回忆的精确度未验证

`before_agent_start` 中的关键词提取 + 搜索 → 注入，
这条路径的实际效果需要实验验证。

关键词提取太粗 → 注入不相关内容 → 浪费 context 空间。
关键词提取太细 → 漏掉相关内容 → 没有帮助。

**建议**：Phase 3 实现，先用简单方案 (提取名词 + 搜索 commit messages)，
根据实际效果迭代。

---

## 最终评估

| 维度 | 评估 |
|------|------|
| 核心需求满足度 | ✅ 全部满足 (分支管理降级到 Phase 4) |
| 量化交易场景 | ✅ 端到端可行 |
| 焦点切换场景 | ✅ 端到端可行 |
| 降级安全性 | ✅ 最差 = 现状 (Pi 默认 compaction) |
| 实施复杂度 | ✅ 极简 (1 个工具 + 2 个 hook + system prompt) |
| 设计是否过度 | ✅ 经过 5 轮精简，没有多余的组件 |
| 未验证的风险 | ⚠️ LLM 的 ctx_update 使用率 + 自动回忆精确度 |

**可以开始实施 Phase 1。**
