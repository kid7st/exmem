# 审查：从"扩展记忆"到"管理注意力"

## 环境变化

```
2024:  context window ~200K tokens → compaction 频繁 → 信息丢失是主要问题
2025+: context window ~1M tokens  → compaction 很少 → 信息在但找不到是主要问题
```

## 问题的迁移

| | 200K 时代 | 1M 时代 |
|---|---|---|
| 核心矛盾 | 信息**不在** context 中 | 信息**在** context 中但不被注意 |
| 类比 | 书架太小，书被扔掉了 | 书架巨大，书在但找不到 |
| compaction 频率 | 频繁 | 罕见 |
| 信息丢失原因 | compaction 压缩 | 注意力稀释（lost in the middle） |
| 需要的解法 | 外部存储 + 检索 | 信息组织 + 注意力引导 |

**"Lost in the middle" (Liu et al., 2023)**：
LLM 在长 context 中，对开头和结尾的信息关注度高，
对中间的信息关注度低。1M token 的 context 中，
500K 位置的信息几乎等于不存在——不是因为被删了，
而是因为 LLM 的注意力到不了那里。

## exmem 的角色变化

```
200K 时代:
  对话 → compaction → 信息丢失
                        ↓
              exmem 保存并检索丢失的信息
  
  exmem = 文件柜（存储）

1M 时代:
  对话 → 越来越长 → 注意力稀释
                       ↓
              exmem 组织信息 + 引导注意力
  
  exmem = 桌面整理器（组织）
```

**桌面越大，整理器越重要。**
存储问题被更大的 context window 解决了，
但组织问题随着 context 增大而恶化。

## 这对当前设计的影响

### 现有组件的价值变化

| 组件 | 200K 时代的价值 | 1M 时代的价值 | 变化 |
|------|---------------|-------------|------|
| ctx_update (实时编码) | 高——保存可能丢失的信息 | **更高**——持续整理工作记忆 | ↑ |
| auto-recall (自动回忆) | 中——检索已压缩的信息 | **更高**——刷新被稀释的注意力 | ↑ |
| compaction hook (固化) | **核心**——唯一的保存时机 | 低——很少触发 | ↓ |
| git 版本控制 | 高——检索历史版本 | 高——仍然需要 diff/rollback | → |
| [pinned] 机制 | 高——防 compaction 丢失 | 中——compaction 少了但仍有用 | → |
| _index.md | 高——compaction summary | **更高**——持续的注意力锚点 | ↑ |

### 需要新增的机制

**当前设计缺少一个关键能力：在每次 LLM 调用前注入结构化摘要。**

现有流程：
```
用户输入 → [before_agent_start: 加 system prompt + auto-recall]
         → LLM 处理 (在 1M tokens 中找信息)
         → 回复
```

问题：system prompt 在 context 最前面，auto-recall 只在第一轮注入。
后续轮次中，LLM 面对越来越长的 context，结构化信息越来越"远"。

需要的流程：
```
用户输入 → [before_agent_start: system prompt + auto-recall]
         → LLM 调用 1 → 回复 → 工具调用
         → [context hook: 注入 _index.md 摘要]      ← 新增
         → LLM 调用 2 → 回复 → 工具调用
         → [context hook: 注入 _index.md 摘要]      ← 每次都注入
         → ...
```

Pi 的 `context` 事件在**每次 LLM 调用前**触发，
可以修改发送给 LLM 的消息。
利用这个 hook，在每次调用前注入一个轻量的"注意力锚点"：

```typescript
pi.on("context", async (event, ctx) => {
  if (!exMem) return;
  
  const index = await exMem.getIndexContent();
  if (!index) return;

  // 在消息列表的末尾（最近位置）插入一个简短的 context 摘要
  // 利用 "recency bias" —— LLM 更关注最近的消息
  return {
    messages: [
      ...event.messages,
      {
        role: "user",
        content: `[Context Summary]\n${index}`,
        timestamp: Date.now(),
      },
    ],
  };
});
```

这利用了 LLM 的 **recency bias**（对最近消息关注度更高），
把结构化摘要放在消息列表的最后，确保 LLM 每次都"看到"它。

## 重新定位

### 旧定位
> exmem: External memory for LLM agents — 
> Git-versioned context files that survive compaction

### 新定位
> exmem: Structured working memory for LLM agents — 
> Git-versioned context that keeps your agent focused across long conversations

关键词变化：
- "external memory" → "structured working memory"
- "survive compaction" → "keeps focused across long conversations"

### 两个角色并存

exmem 不需要二选一。它同时服务两个场景：

```
场景 A（仍然存在）: compaction 发生 → exmem 保持 context 连续性
场景 B（越来越重要）: context 很长 → exmem 保持注意力聚焦
```

当前设计已经覆盖了场景 A。
场景 B 需要新增 `context` hook 做持续的注意力刷新。

## 具体的设计修改

### 1. 新增 `context` hook — 注意力锚点

**实现**：在每次 LLM 调用前，将 _index.md 内容作为最近的消息注入。

**约束**：
- _index.md 通常 500-1000 tokens，注入开销可接受
- 但不应在每次调用都读文件——缓存 _index.md 内容
- 当 ctx_update 修改了 _index.md 时，刷新缓存

### 2. 修改 system prompt 的定位

从"记录信息以防丢失"转向"组织信息以保持聚焦"：

```
旧：Record information when you encounter important facts
新：Keep your context files organized as a working summary. 
    Use them to stay focused in long conversations.
    When the conversation grows long, read your context files 
    to refresh your understanding.
```

### 3. auto-recall 放宽触发条件

当前 guard：`if (status.checkpoints < 3) return null`
（至少 3 个 checkpoint = 至少经历过 compaction）

在 1M 时代，可能从未 compaction 过但对话已经很长。
改为：`if (status.checkpoints < 2) return null`
（至少有过 ctx_update 写入即可触发）

### 4. 新增"主动刷新"引导

在 system prompt 中增加：
```
When you notice the conversation is getting long, read your 
context files to refresh your focus:
  read(".exmem/context/_index.md")
```

这鼓励 Agent 主动"回看笔记"，而不是只在需要历史数据时才查。

## 不需要修改的部分

- git 版本控制 — 仍然有价值（diff, rollback）
- ctx_update 工具 — 价值更高了
- compaction hook — 仍然需要（虽然触发少了）
- [pinned] — 仍然有效
- 后置验证 + 快照回滚 — 仍然需要
- 解析逻辑 — 不变

## 对 Phase 3 的影响

Phase 3 原计划是 git 分支联动、/mem-status 命令等。
建议优先级调整：

```
Phase 3 (修改后):
  1. [高] context hook — 注意力锚点 (最有价值的新增)
  2. [中] system prompt 重新定位
  3. [中] auto-recall 放宽触发条件
  4. [低] /mem-status 命令
  5. [低] Pi /tree 分支联动
  6. [低] 配置系统
```
