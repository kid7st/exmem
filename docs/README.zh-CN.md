# exmem

**LLM Agent 的外部认知记忆系统。**

[English](../README.md)

将 Agent 的心智模型（目标、决策、约束、验证结果等）外化为 Git 版本控制的 Context 文件，使其在 compaction 后可检索、可回溯、可比较。

## 问题

LLM 的 context window 有限。对话超长后 compaction 将历史压缩为一段摘要——信息在多轮 compaction 中逐渐衰减，无法定向查询，无法回溯演化。

**对话是过程，Context 是产物。** exmem 将 Context 持久化在 git 仓库中，compaction 只是一次 commit，历史永远可以回来看。

## 前提条件

- [Pi](https://github.com/badlogic/pi-mono) (>=0.40.0)
- Git

## 安装

```bash
# 试用（不安装，当次生效）
pi -e /path/to/exmem

# 安装到全局（所有项目生效）
pi install /path/to/exmem

# 安装到项目（可与团队共享 .pi/settings.json）
pi install -l /path/to/exmem

# 从 Git 仓库安装（发布后可用）
pi install git:github.com/user/exmem
```

安装后 pi 启动时自动加载，**无需额外配置**。

> 建议在项目的 `.gitignore` 中加入 `.exmem/`，
> 避免 exmem 的内部 git 仓库被提交到项目仓库中。

## 安装后会发生什么

1. Pi 启动时，exmem 在项目目录下创建 `.exmem/` 仓库（自动）
2. System prompt 增加 "Context Memory" 说明，告诉 Agent 它有记忆能力
3. 一个新工具 `ctx_update` 可用——Agent 可以随时将重要信息写入 context 文件
4. 每次 compaction 时，exmem 自动将对话中的信息整合到 context 文件并 git commit

## 工作原理

```
对话流 → Agent 处理 → ctx_update 记录重要信息 → git commit
                                                      │
                              git log / show / diff / grep
                              随时可回溯任意历史版本
```

### 两阶段记忆更新

**阶段 1：实时编码** — Agent 在对话中遇到重要信息时主动调用 `ctx_update`

**阶段 2：记忆固化** — compaction 触发时，LLM 审视即将压缩的对话 + 当前 context 文件，查漏补缺并 git commit

### Agent 如何使用记忆

**写入**（唯一的新工具）：

```
ctx_update(file="constraints.md", content="...", message="add MaxDD constraint")
```

**读取**（使用已有的 read 和 bash）：

```bash
read(".exmem/context/strategy-params.md")                              # 当前 context
bash("cd .exmem && git log --oneline -- context/strategy-params.md")   # 版本历史
bash("cd .exmem && git show abc123:context/strategy-params.md")        # 历史版本
bash("cd .exmem && git log --all --oneline --grep='Sharpe'")           # 搜索
bash("cd .exmem && git diff abc123 def456 -- context/")                # 版本对比
```

### 安全机制

- **`[pinned]`** — 关键约束标记为不可删除，代码级验证 + 自动恢复
- **快照回滚** — 固化前 git commit 快照，验证失败自动回滚
- **后置验证** — 5 项检查（_index.md 完整性、[pinned] 保留、大小预算、文件非空、解析成功）
- **降级保底** — 任何失败自动回退到 Pi 默认 compaction，不会比没装 exmem 更差

## 示例

量化策略开发中，经过 4 轮参数迭代后：

```
用户: "v2 结果最好，回到 v2 参数，帮我分析 MA 周期和 Sharpe 的关系"

Agent:
  bash("cd .exmem && git log --oneline -- context/strategy-params.md")
  → ghi9012  v2: MA 10/30, RSI 70

  bash("cd .exmem && git show ghi9012:context/strategy-params.md")
  → 拿到 v2 完整参数

  bash("cd .exmem && git diff ghi9012 abc1234 -- context/strategy-params.md")
  → MA 10/30 → 20/50

  bash("cd .exmem && git diff ghi9012 abc1234 -- context/backtest-results.md")
  → Sharpe 1.5 → 1.1

  Agent: "增大 MA 周期导致 Sharpe 下降，建议回退到 v2。"
```

没有 exmem 时，v1-v3 的参数和结果已被 compaction 压缩成"测试了多组参数"，Agent 无法回答这个问题。

## Context 文件结构

```
.exmem/
└── context/
    ├── _index.md            ← 全局概览（= compaction summary）
    └── <topic>.md           ← LLM 按需创建的领域文件
```

只有 `_index.md` 是系统必需的。其他文件由 LLM 根据对话内容自行创建。
不预设固定文件结构——文件按实际内容自然涌现。

## 配置

开箱即用，无需配置。以下参数可在代码中调整：

| 参数 | 默认值 | 说明 |
|------|-------|------|
| `tokenBudget` | 8000 | Context 文件总大小上限 (tokens) |
| `segmentThreshold` | 40000 | 对话超过此长度时分段处理 (tokens) |
| `repoPath` | `.exmem` | git 仓库路径 |

## 设计文档

- [DESIGN.md](DESIGN.md) — 完整系统设计
- [DECISIONS.md](DECISIONS.md) — 12 个设计决策及 trade-off 记录

## License

MIT
