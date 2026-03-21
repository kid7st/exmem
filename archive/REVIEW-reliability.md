# 反向审查：高价值的可靠性增强

## 方法

从"系统会怎么坏"出发，找到失败模式，
然后只加入**实现简单（几行代码）但防护价值高**的措施。

---

## 失败模式分析

| # | 失败模式 | 后果 | 当前防护 | 缺口 |
|---|---------|------|---------|------|
| F1 | 固化 LLM 输出不可解析 | context 文件未更新 | 回退到 Pi 默认 | ✅ 已覆盖 |
| F2 | 固化 LLM 输出可解析但质量差 | context 文件被写入垃圾内容 | 无 | ❌ **危险** |
| F3 | 固化 LLM 删除了 [pinned] 条目 | 关键约束丢失 | [pinned] 代码验证 | ✅ 已覆盖 |
| F4 | 固化 LLM 篡改了非 pinned 的量化数据 | 精确数据无声劣化 | 无 | 🟡 |
| F5 | 首次 compaction 输出质量差 | 所有后续更新基于差基础 | 无 | ❌ **危险** |
| F6 | _index.md 与实际文件不一致 | Agent 被误导 | 无 | 🟡 |
| F7 | ctx_update 写入相同内容 | git 历史噪音 | 无 | 🟢 低风险 |
| F8 | 固化过程中途崩溃 | context 文件处于半更新状态 | 无 | 🟡 |

重点关注 F2 和 F5——**可解析但垃圾的输出**和**首次质量差**。
这两个是"静默失败"，不会触发降级，但会持续损害系统。

---

## 建议加入的可靠性措施

### 措施 1：固化前快照 + 验证失败时回滚

**解决**: F2, F8
**成本**: 2 行 git 命令
**价值**: 🔴 高

```
固化流程修改:

1. git add -A && git commit -m "[snapshot] pre-consolidation"   ← 新增
2. LLM 更新 context 文件
3. 后置验证 (见措施 2)
4a. 验证通过 → git add -A && git commit -m "[context] ..."
4b. 验证失败 → git checkout HEAD -- context/                    ← 新增：回滚
                回退到 Pi 默认 compaction
```

这样，即使 LLM 写了垃圾，一个 `git checkout` 就恢复到固化前的状态。
**git 天然支持这个操作，零额外依赖。**

### 措施 2：后置验证清单（确定性代码）

**解决**: F2, F6
**成本**: ~15 行代码
**价值**: 🔴 高

固化 LLM 输出写入文件后、git commit 前，跑一组简单检查：

```typescript
function validateConsolidation(contextDir: string): { ok: boolean; reason?: string } {
  // 1. _index.md 存在且非空
  if (!exists("_index.md") || size("_index.md") < 50) 
    return { ok: false, reason: "_index.md missing or empty" };
  
  // 2. _index.md 包含 Narrative
  if (!read("_index.md").includes("Narrative"))
    return { ok: false, reason: "_index.md missing Narrative section" };
  
  // 3. 总大小在预算内 (允许 20% 溢出)
  if (totalSize > budget * 1.2)
    return { ok: false, reason: "context size exceeds budget" };
  
  // 4. [pinned] 条目完整 (已有)
  if (!allPinnedPreserved(oldFiles, newFiles))
    return { ok: false, reason: "pinned items lost" };
  
  // 5. 没有文件被清空 (如果之前有内容)
  for (const file of existingFiles) {
    if (oldSize(file) > 100 && newSize(file) < 10)
      return { ok: false, reason: `${file} was emptied` };
  }
  
  return { ok: true };
}
```

**不判断"好不好"（做不到），只判断"明显坏了没有"。**
5 个检查，每个都是确定性的、无需 LLM、几乎零延迟。

### 措施 3：首次固化的 Few-shot 示例

**解决**: F5
**成本**: ~500 tokens 的静态 prompt 文本（只在首次使用）
**价值**: 🔴 高

Few-shot prompting 是提升 LLM 输出质量最可靠的技术之一。
首次固化时，在 prompt 末尾附加一个具体的输入→输出示例：

```
## 示例

给定空的 context 和以下对话:

<conversation>
[User]: 帮我写一个价格爬虫，爬 Amazon 的商品价格
[Assistant]: 好的，我来创建项目结构...
[Tool: bash]: mkdir scraper && cd scraper
[User]: CSS 选择器用 .price-whole，而且最大并发不要超过 5
[Assistant]: 了解，我设置并发限制...
</conversation>

应输出:

<context-update>
<file path="goals.md" action="create">
# Goals
## 🟢 Active: Amazon 价格爬虫
- 爬取 Amazon 商品价格
- 基础结构已创建
</file>
<file path="scraper-config.md" action="create">
# Scraper Configuration
- CSS selector: .price-whole
- Max concurrency: 5 [pinned]
</file>
<file path="_index.md" action="create">
# Project Context

## Narrative
正在构建 Amazon 商品价格爬虫。项目结构已创建。
用户要求使用 .price-whole 选择器，最大并发 5。

## Files
- goals.md: 开发 Amazon 价格爬虫
- scraper-config.md: 选择器和并发配置
</file>
</context-update>
```

这个示例告诉 LLM：
1. 输出格式长什么样
2. 什么信息值得创建为独立文件
3. 用户的硬性要求要标 [pinned]
4. _index.md 的 Narrative 怎么写
5. 文件要多大/多小

**首次固化后，后续的固化 prompt 不需要带这个示例**
（已有 context 文件作为隐式示例）。

### 措施 4：ctx_update 的幂等性检查

**解决**: F7
**成本**: 3 行代码
**价值**: 🟢 中

```typescript
async execute(params) {
  const currentContent = await readFile(filePath);
  if (currentContent === params.content) {
    return { content: [{ type: "text", text: "No changes needed." }] };
  }
  // ... proceed with write + commit
}
```

避免 Agent 重复写入相同内容产生空 commit。
保持 git 历史干净。

### 措施 5：自动生成 commit message

**解决**: 可调试性
**成本**: 5 行代码
**价值**: 🟡 中

Agent 调用 ctx_update 时提供的 message 可能不够好。
自动补充一行 `git diff --stat` 的输出：

```
[context] 用户提供的 message
---
 context/strategy-params.md | 5 +++--
 context/_index.md          | 3 ++-
 2 files changed, 6 insertions(+), 3 deletions(-)
```

这让 `git log` 的输出自带变更统计，Agent 用 `git log` 时能快速定位
哪些 commit 修改了哪些文件。

---

## 从砍掉的清单中恢复的元素

### 恢复：编码类型的信号词清单

被砍的理由是"LLM 天生理解"。但信号词清单不是教 LLM 理解语言——
它是**降低遗漏率的 checklist**。

飞行员天生会飞飞机，但起飞前仍然用 checklist。

```markdown
## 何时使用 ctx_update

遇到以下信号时记录信息：
- 用户的要求/约束 ("必须", "不要", "限制")
- 量化结果 (数值, 百分比, 指标)
- 参数变更 ("改为", "设置为")
- 决策 ("决定用", "选择", "不用")
- 目标变更 ("接下来做", "先放下")
```

**成本**：system prompt ~100 tokens。**价值**：减少编码遗漏。恢复。

### 恢复：冲突标注（简化版）

被砍的理由是"LLM 更新时自然会处理冲突"。
但"自然处理"通常意味着"默默覆盖"。

不需要完整的冲突检测步骤。只需在规则中加一句：

```
如果新信息与 [pinned] 条目矛盾，不要覆盖，
在旁边标注 "⚠️ 与 [pinned] 项冲突: ..."
```

**成本**：prompt 中 1 句话。**价值**：防止 pinned 信息被语义篡改
（文字保留但含义被新信息覆盖）。恢复。

---

## 不恢复的元素

| 元素 | 不恢复的理由 |
|------|------------|
| metadata.json | git 历史 + 行内标注已够用 |
| Hot/Warm/Cold 转换规则 | 大小预算足够控制增长 |
| EXPAND/REVISE/CONTRACT 分类 | 增加 prompt 复杂度，收益不大 |
| 周期性完整性校验 | 没有行动方处理警告 |
| 4 级焦点切换规则 | 1 句话够了 |
| 6 步自动回忆算法 | Phase 3 再设计 |
| 文件关联关系图 | LLM 能自行推断 |

---

## 最终清单

```
核心 (不可去掉):
  ✅ ctx_update 工具
  ✅ session_before_compact hook (固化)
  ✅ before_agent_start hook (system prompt)
  ✅ _index.md
  ✅ 降级方案 (解析失败 → Pi 默认)
  ✅ 大小预算

可靠性防护 (简单但高价值):
  ✅ [pinned] + 代码验证
  ✅ 固化前快照 + 验证失败回滚          ← 新增
  ✅ 后置验证清单 (5 项检查)             ← 新增
  ✅ 首次固化 few-shot 示例              ← 新增
  ✅ ctx_update 幂等性                   ← 新增
  ✅ 自动 commit message (含 diff stat)  ← 新增

引导性 (prompt 中):
  ✅ 编码信号词 checklist                ← 恢复
  ✅ 冲突标注规则 (1 句话)               ← 恢复
  ✅ 固化 5 条规则
  ✅ "切换话题时标 ⏸️，不删除"

总计: ~18 个设计元素
```

**从 50 → 12 → 18。恢复的 6 个元素都是几行代码或一句 prompt，
但每个都防住了一个具体的、可能导致静默失败的故障模式。**
