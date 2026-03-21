# 最终审查

## 设计的完整度

### 当前方案 (18 个元素)

```
唯一的自定义工具:  ctx_update (write + commit + verify)
唯一的存储:       .git-mem/ git 仓库
唯一的必需文件:   _index.md
LLM 调用:        compaction 时 1 次 (替换 Pi 默认的摘要生成)
Agent 读取方式:   bash + 标准 git 命令
```

### 从根上问：每一层都必要吗？

**Q: 需要 git 吗？用普通文件夹行不行？**
不行。没有 git，就没有版本历史、没有 diff、没有按文件追踪变更、
没有 `git show <hash>:file` 的精准回溯。
这些是核心需求，不是锦上添花。普通文件夹无法替代。

**Q: 需要 ctx_update 吗？Agent 用 write + bash 行不行？**
可以，但脆弱。write 和 git commit 是两步操作，
中间可能崩溃、commit message 格式不一致、忘记更新 _index.md。
ctx_update 的原子性是真实的工程价值，而且只是一个工具。

**Q: 需要 compaction hook 吗？光靠 Agent 调用 ctx_update 行不行？**
不行。Agent 不可能完美地实时记录所有信息。
compaction hook 是安全网——即使 Agent 一次都没调用 ctx_update，
compaction 时仍会通过 LLM 从对话中提取信息到 context 文件。

**Q: 需要 _index.md 吗？直接拼接所有 context 文件做 summary 行不行？**
可以但不好。如果有 5 个文件共 8k tokens，全部拼接就是 8k tokens 的 summary。
Pi 的 summary 通常 1-3k tokens，8k 太大了。
_index.md 是 8k → ~1k 的精炼视图。Agent 需要更多细节时再 read 具体文件。

**Q: [pinned] 机制必要吗？**
必要。这是整个系统中唯一的**硬性保障**。
LLM 更新 context 文件时可能在无意中改写或删除关键约束。
代码级别的 pinned 验证是最后一道防线，
且实现成本极低（几行字符串匹配）。

**Q: 快照 + 回滚必要吗？**
在 MVP 阶段是性价比最高的安全机制。
LLM 输出"可解析但垃圾"时，这是唯一的防护。
两行 git 命令的成本换来的安全网值得。

**结论：18 个元素中没有可以进一步去掉的。每一个都有明确的、不可替代的理由。**

---

## 还有没有更简单的方案？

### 替代方案 A：不要 context 文件，直接给 Agent 工具读 JSONL

在 REVIEW-v2 中讨论过。不可行，因为 JSONL 是原始对话，不是 Context。
从 JSONL 恢复 Context 等于让 LLM 重新读一遍所有对话。

### 替代方案 B：不用 git，用 SQLite + FTS

可行，但失去版本回滚、per-file diff、commit 历史浏览。
这些是核心需求。而且 git 是零依赖（所有开发机器都有）。

### 替代方案 C：不做 compaction 增强，只做检索工具

即：不用 hook 修改 compaction 行为，只给 Agent 提供搜索 JSONL 的工具。
可行但价值低——Agent 搜到的是原始对话，不是结构化 Context。
每次搜索需要 LLM 从原始对话中"重新理解"。

### 替代方案 D：用 Pi 的 custom entry 存储 context，不用 git

Pi 的 `appendCustomEntry` 可以存任意 JSON。
可以在里面存 context 文件内容，不需要外部 git 仓库。
但失去了 git 的 diff、log、grep、per-file history。
这些是 git 的核心价值。

**结论：没有找到能在保持核心能力的同时更简单的替代方案。**

---

## 残余风险的诚实评估

| 风险 | 能否通过设计解决 | 当前状态 |
|------|----------------|---------|
| LLM 固化质量随迭代次数衰减 | 部分（[pinned] 保护关键项） | ⚠️ 需要实测观察 |
| Agent 不主动调用 ctx_update | 部分（compaction hook 兜底） | ⚠️ 可接受的降级 |
| 首次固化质量 | 是（few-shot 示例） | ✅ 已解决 |
| 固化 LLM 输出格式错误 | 是（快照 + 回滚 + 降级） | ✅ 已解决 |
| 固化 LLM 输出"合法但垃圾" | 部分（后置验证捕获极端情况）| ⚠️ 需要实测 |
| Context 文件无限增长 | 是（大小预算 + prompt 指导） | ✅ 已解决 |
| 自动回忆的精确度 | 未知（Phase 3） | 🔵 延后 |

**两个 ⚠️ 风险（信息衰减、输出质量）只能通过实际运行来验证。
这是正确的——它们是经验问题，不是设计问题。
过度设计去解决经验问题是错误的（这正是我们从 50 砍到 18 的原因）。**

---

## 唯一的建议：固化 prompt 中的分段处理

当前设计中有一处未被清理步骤覆盖但依然重要的工程细节：

**当 messagesToSummarize 超过 ~40k tokens 时，应该分段处理。**

```
如果 conversation_tokens > 40k:
  split into 2 segments
  LLM call 1: current context + segment_1 → updated context v1
  LLM call 2: updated context v1 + segment_2 → updated context v2
```

这不是复杂机制——就是一个 if 判断 + 两次调用替代一次。
但它对长对话的固化质量有实质影响：
LLM 在 40k tokens 的上下文中提取信息的准确率
显著高于在 80k tokens 中提取。

**这是唯一一个应该加但当前设计文档中未明确包含的元素。**
加入后总设计元素 = 19 个。

---

## 最终结论

**设计已就绪。**

```
┌─────────────────────────────────────────────────────────┐
│                                                         │
│  1 个工具 (ctx_update)                                   │
│  + 2 个 hooks (compact, before_agent)                    │
│  + 1 个 git 仓库                                        │
│  + 1 个必需文件 (_index.md)                              │
│  + 5 条固化规则                                          │
│  + 5 项后置验证                                          │
│  + [pinned] 机制                                         │
│  + 快照回滚                                              │
│  + few-shot 示例                                         │
│  + 分段处理                                              │
│                                                         │
│  = 一个完整的、最小化的、有安全网的认知记忆系统            │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

不可进一步精简（每个元素都有不可替代的理由）。
不需要进一步复杂化（剩余风险是经验问题，不是设计问题）。
可以开始实现。
