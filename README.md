# git-mem

LLM Agent 的外部认知记忆系统。

将 Agent 的心智模型（目标、决策、约束、验证结果等）外化为 Git 版本控制的 Context 文件，使其在 compaction 后可检索、可回溯、可比较。

## 问题

LLM 的 context window 有限。对话超长后 compaction 将历史压缩为一段摘要——信息在多轮 compaction 中逐渐衰减，无法定向查询，无法回溯演化。

git-mem 解决这个问题：**对话是过程，Context 是产物。** git-mem 将 Context 持久化在 git 仓库中，compaction 只是一次 commit，历史永远可以回来看。

## 安装

### 方式 1：直接试用（不安装）

```bash
pi -e /path/to/git-mem
```

### 方式 2：安装到全局

```bash
pi install /path/to/git-mem
```

### 方式 3：安装到项目

```bash
pi install -l /path/to/git-mem
```

### 方式 4：从 Git 仓库安装

```bash
# 发布后可用：
pi install git:github.com/user/git-mem
```

安装后，pi 启动时自动加载 git-mem 扩展。

## 安装后会发生什么

1. Pi 启动时，git-mem 在项目目录下创建 `.git-mem/` 仓库（自动，无需手动操作）
2. System prompt 增加一段 "Context Memory" 说明，告诉 Agent 它有记忆能力
3. 一个新工具 `ctx_update` 可用——Agent 可以随时将重要信息写入 context 文件
4. 每次 compaction 时，git-mem 自动将对话中的信息整合到 context 文件并 git commit

**你不需要做任何额外配置。** 安装即生效。

## 工作原理

```
对话流 → Agent 处理 → ctx_update 记录重要信息 → git commit
                                                      │
                              git log / show / diff / grep
                              随时可回溯任意历史版本
```

### 两阶段记忆更新

**阶段 1：实时编码** — Agent 在对话中遇到重要信息时主动调用 `ctx_update` 记录

**阶段 2：记忆固化** — compaction 触发时，LLM 审视即将压缩的对话 + 当前 context 文件，查漏补缺并 git commit

### Agent 如何使用记忆

**写入**（唯一的新工具）：

```
ctx_update(file="constraints.md", content="...", message="add MaxDD constraint")
```

**读取**（使用已有的 read 和 bash）：

```bash
# 读当前 context
read(".git-mem/context/strategy-params.md")

# 查看版本历史
bash("cd .git-mem && git log --oneline -- context/strategy-params.md")

# 读取历史版本
bash("cd .git-mem && git show abc123:context/strategy-params.md")

# 搜索历史
bash("cd .git-mem && git log --all --oneline --grep='Sharpe'")

# 对比版本变化
bash("cd .git-mem && git diff abc123 def456 -- context/strategy-params.md")
```

### 安全机制

- **`[pinned]`**：关键约束标记为不可删除，代码级验证
- **快照回滚**：固化前 git commit 快照，验证失败自动回滚
- **后置验证**：5 项检查（_index.md 完整性、[pinned] 保留、大小预算、文件非空、解析成功）
- **降级保底**：任何失败自动回退到 Pi 默认 compaction，不会比没装 git-mem 更差

## 示例场景

量化策略开发中，经过 4 轮参数迭代后：

```
用户: "v2 结果最好，回到 v2 参数，帮我分析 MA 周期和 Sharpe 的关系"

Agent:
  bash("cd .git-mem && git log --oneline -- context/strategy-params.md")
  → ghi9012  v2: MA 10/30, RSI 70

  bash("cd .git-mem && git show ghi9012:context/strategy-params.md")
  → 拿到 v2 完整参数

  bash("cd .git-mem && git diff ghi9012 abc1234 -- context/strategy-params.md")
  → 看到 MA 10/30 → 20/50

  bash("cd .git-mem && git diff ghi9012 abc1234 -- context/backtest-results.md")
  → 看到 Sharpe 1.5 → 1.1

  Agent: "增大 MA 周期导致 Sharpe 下降，建议回退到 v2。"
```

**在没有 git-mem 的情况下，v1-v3 的参数和结果已被 compaction 压缩成"测试了多组参数"，Agent 无法回答这个问题。**

## 文件结构

```
.git-mem/                    ← 自动创建的 git 仓库
└── context/
    ├── _index.md            ← 全局概览（= compaction summary）
    └── <topic>.md           ← LLM 按需创建的领域文件
```

- 只有 `_index.md` 是系统必需的
- 其他文件由 LLM 根据对话内容自行创建（如 goals.md, strategy-params.md 等）
- 不预设固定文件结构——文件按实际内容自然涌现

## 配置

git-mem 开箱即用，无需配置。以下参数可在代码中调整：

| 参数 | 默认值 | 说明 |
|------|-------|------|
| `tokenBudget` | 8000 | Context 文件总大小上限 (tokens) |
| `segmentThreshold` | 40000 | 对话超过此长度时分段处理 (tokens) |
| `repoPath` | `.git-mem` | git 仓库路径 |

## 技术细节

详见 [DESIGN.md](DESIGN.md) 和 [DECISIONS.md](DECISIONS.md)。

## License

MIT
