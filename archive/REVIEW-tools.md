# 工具设计审查：Unix 原则检验

## 相关的 Unix 设计原则

1. **Do one thing and do it well** — 每个工具只做一件事
2. **Don't add a new tool when an existing one can do the job** — 不重复造轮子
3. **Compose small tools via pipes** — 组合优于集成
4. **Everything is a file / text stream** — 统一接口
5. **Least surprise** — 行为可预期

## 当前设计的 5 个工具

```
写入:  ctx_update(file, content)     — 更新 Context 文件
读取:  mem_log(file?, limit?, grep?) — 查版本历史
       mem_recall(hash, file?)       — 读历史版本
       mem_search(query, file?)      — 搜索历史
       mem_diff(from, to, file?)     — 对比版本
```

## 关键问题：Agent 已经有了什么？

这是一个**编程 Agent**。它已有 4 个内置工具：

```
read(path)                — 读文件
write(path, content)      — 写文件
bash(command)             — 执行任意命令
edit(path, old, new)      — 编辑文件
```

而 .git-mem 是一个**标准的 git 仓库**。

那么我们来逐一检验——每个 git-mem 工具做的事情，
Agent 用已有工具能不能做？

### mem_log → bash

```bash
# mem_log(file="strategy-params.md", limit=5)
# ↓ 等价于
bash("cd .git-mem && git log --oneline -5 -- context/strategy-params.md")
```

Agent 是编程助手，**它本来就会用 git log**。
包一层自定义工具，只是在 git log 外面套了个壳。

### mem_recall → bash

```bash
# mem_recall(hash="abc123", file="strategy-params.md")
# ↓ 等价于
bash("cd .git-mem && git show abc123:context/strategy-params.md")
```

一个标准的 `git show` 命令。

### mem_search → bash

```bash
# mem_search(query="Sharpe 1.5")
# ↓ 等价于
bash("cd .git-mem && git log --all --oneline --grep='Sharpe 1.5'")
bash("cd .git-mem && git grep 'Sharpe 1.5' $(git rev-list --all) -- context/")
```

标准的 `git grep` + `git log --grep`。

### mem_diff → bash

```bash
# mem_diff(from="abc123", to="def456", file="strategy-params.md")
# ↓ 等价于
bash("cd .git-mem && git diff abc123 def456 -- context/strategy-params.md")
```

标准的 `git diff`。

### 读取当前 Context → read

```bash
# 读当前版本的 strategy-params.md
read(".git-mem/context/strategy-params.md")
```

直接用 Pi 的 read 工具就行。

### ctx_update → write + bash?

```bash
# ctx_update("strategy-params.md", newContent)
# ↓ 尝试拆解为
write(".git-mem/context/strategy-params.md", newContent)
bash("cd .git-mem && git add -A && git commit -m 'update strategy-params'")
```

这里有区别了。`write + bash` 可以做，但有几个问题：
1. **不是原子操作**：write 和 git commit 是两步，中间可能失败
2. **commit message 需要有意义**：Agent 不会自动生成好的 commit message
3. **_index.md 需要同步更新**：更新一个文件后，索引也要更新
4. **大小预算检查**：写入后需要检查总大小是否超限

**这是唯一不能用现有工具完全替代的操作。**

---

## 结论：4 个读取工具中，0 个是必需的

| 工具 | 等价的已有方案 | 自定义工具增加的价值 |
|------|--------------|-------------------|
| `mem_log` | `bash("git log ...")` | 几乎为零 |
| `mem_recall` | `bash("git show ...")` | 几乎为零 |
| `mem_search` | `bash("git grep ...")` | 组合两种搜索，略有价值 |
| `mem_diff` | `bash("git diff ...")` | 零 |
| `ctx_update` | `write` + `bash` | **有实质价值**（原子性、commit message、索引同步） |

**按 Unix 原则"不要在现有工具能做的事情上造新轮子"，
4 个读取工具全部不需要。Agent 用 bash 跑 git 命令即可。**

---

## 那为什么还有人造 mem_log 这样的工具？

可能的理由和反驳：

### "Agent 不一定知道 git 命令"

**反驳**：这是一个**编程 Agent**（Pi）。它的核心能力就是写代码和用命令行。
它比任何 custom tool 更灵活地使用 git。
教它一个 git 命令（通过 system prompt）比教它一个 custom tool 更自然。

### "Custom tool 的参数更清晰，降低出错率"

**反驳**：git 的 CLI 接口已经非常成熟。`git show <hash>:<path>` 
是全世界每个开发者都会用的命令。
额外包一层反而引入了**新的出错可能**——Agent 需要学习一个新 API，
而不是使用它已经掌握的 git。

### "Custom tool 可以格式化输出"

**部分成立**：`git log --format="%h %s (%ar)"` 的输出格式
可以在 system prompt 中指定一次，Agent 就会一直用。
不需要 custom tool 来做格式化。

### "Custom tool 隐藏了 .git-mem 的路径细节"

**部分成立**：Agent 需要知道 `cd .git-mem` 这个前缀。
但这可以在 system prompt 中说一次："你的记忆仓库在 .git-mem/ 目录下"。

---

## 真正符合 Unix 原则的设计

### 只需要 1 个自定义工具

**`ctx_update(file, content, message?)`** — 原子性地更新 Context 文件

```
做 write + git add + git commit + 更新 _index.md + 检查大小预算
```

这是唯一需要自定义工具的操作，因为它涉及多个步骤的原子组合，
Agent 用 bash 做会很脆弱。

### 其他所有操作：bash + read + system prompt 引导

在 system prompt 中加一段：

```markdown
## Context Memory

你有一个外部记忆仓库在 `.git-mem/` 目录下。

**读取当前 Context：**
  read(".git-mem/context/_index.md")          — 全局概览
  read(".git-mem/context/goals.md")           — 当前目标
  read(".git-mem/context/<file>.md")          — 任何 context 文件

**查看历史：**
  bash("cd .git-mem && git log --oneline -10 -- context/<file>.md")

**读取历史版本：**
  bash("cd .git-mem && git show <hash>:context/<file>.md")

**搜索：**
  bash("cd .git-mem && git log --all --grep='<keyword>' --oneline")

**对比变化：**
  bash("cd .git-mem && git diff <hash1> <hash2> -- context/<file>.md")

**更新 Context：**
  ctx_update(file="goals.md", content="...", message="标记均线策略为 paused")
```

### 为什么这更好？

**1. 工具数量：11 → 5**
从 4 (Pi) + 7 (git-mem v1) = 11，
或 4 + 5 (review 建议) = 9，
降到 4 + 1 = **5**。

LLM 在 5 个工具中选择比在 9 或 11 个中选择更可靠。

**2. System prompt 更高效**
1 个工具定义 ≈ 200 tokens。
省掉 4 个工具 ≈ 省 **800 tokens** 的固定开销。
取而代之的 system prompt 指引 ≈ 300 tokens。
净省 **500 tokens/轮**。

**3. Agent 的灵活性更高**
Agent 可以自由组合 git 命令，不受 custom tool 的参数限制。
例如：
```bash
# 找到所有修改过 strategy-params.md 的 commit，并显示每次的摘要变化
cd .git-mem && git log --all --oneline -- context/strategy-params.md | \
  while read hash msg; do echo "=== $hash: $msg ==="; \
  git show $hash:context/strategy-params.md | head -5; echo; done
```
这种复杂查询用 custom tool 做不到，但 bash 天然支持。

**4. 遵循"不要重复造轮子"**
Git 是一个经过 20 年打磨的工具。它的 CLI 就是最好的 API。
包一层 TypeScript wrapper 不会比 git CLI 更好，
只会引入额外的 bug 可能和维护负担。

---

## 那 compaction 和 auto-recall 怎么办？

这些是**系统行为**，不是 Agent 工具。它们在 extension hooks 中实现：

```
session_before_compact:
  → extension 内部调用 git 命令做 commit
  → extension 内部调用 LLM 更新 context 文件
  → 返回 summary 给 Pi
  → Agent 完全不需要参与这个过程

before_agent_start:
  → extension 内部搜索 .git-mem 历史
  → 自动注入相关 context
  → Agent 完全不需要参与
```

这些不是工具，而是**基础设施**。
就像 Pi 的 auto-compaction 不需要 Agent 调用 "compact" 工具一样。

---

## 修正后的完整设计

```
Agent 的工具:
  read, write, bash, edit   ← Pi 内置 (4)
  ctx_update                ← git-mem 唯一新增 (1)
  ────────────────────────
  共 5 个

Agent 对 .git-mem 的访问:
  读: read + bash (git log, git show, git grep, git diff)
  写: ctx_update (原子性更新 + commit)

系统基础设施 (extension hooks, Agent 不感知):
  session_before_compact → 记忆固化
  before_agent_start     → 自动回忆
  session_start          → 初始化
```

### ctx_update 的细化设计

```typescript
// 唯一的自定义工具
{
  name: "ctx_update",
  description: "Update a context memory file. Handles git commit automatically.",
  parameters: Type.Object({
    file: Type.String({ 
      description: "File path relative to context/, e.g. 'goals.md', 'strategy-params.md'" 
    }),
    content: Type.String({ 
      description: "Complete new content for the file" 
    }),
    message: Type.Optional(Type.String({ 
      description: "Brief description of what changed" 
    })),
  }),
  
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // 1. Write file
    // 2. Regenerate _index.md
    // 3. Check size budget, warn if exceeding
    // 4. git add -A && git commit -m "[context] {message}"
    // 5. Return new commit hash
  }
}
```

### 这够用吗？

回到量化策略的场景：

```
用户: "用 v2 的参数重新跑一下"

Agent 心理过程:
  1. v2 的参数是什么？让我查一下
  → bash("cd .git-mem && git log --oneline -- context/strategy-params.md")
  → 看到: ghi9012  v2: MA 10/30, RSI 70

  2. 拿到具体参数
  → bash("cd .git-mem && git show ghi9012:context/strategy-params.md")
  → 看到完整的 v2 参数

  3. 执行回测... (用 bash 跑回测脚本)

  4. 记录新结果
  → ctx_update(file="backtest-results.md", content="...", message="v5: 用v2参数重跑")

  5. 更新参数记录
  → ctx_update(file="strategy-params.md", content="...", message="v5=v2, MA 10/30")
```

完全够用。Agent 用它最熟悉的工具（bash + git）来检索，
用唯一的 custom tool（ctx_update）来更新。

---

## 一个可能的反对意见

> "但这样 system prompt 需要教 Agent 用 git 命令操作 .git-mem，
>  这不就是把 custom tool 的逻辑搬到了 system prompt 里吗？"

是的，但有本质区别：

| | Custom tools | System prompt + bash |
|---|---|---|
| Token 成本 | 每个工具 ~200 tokens × 4 = 800 tokens | 一段指引 ~300 tokens |
| LLM 决策负担 | 在 9 个工具中选择 | 在 5 个工具中选择 + 记住几个命令模式 |
| 灵活性 | 受限于工具参数 schema | bash 可以做任何事 |
| 出错恢复 | 需要为每个工具写错误处理 | git 的错误信息本身就够好 |
| 维护成本 | 4 个工具的代码 | 0 代码 |

**总成本更低，灵活性更高。**
