# Synthesis: The Core of the Problem

After reading 31 research papers and projects across the field,
stepping back from exmem's specific design, and asking
"what is the ACTUAL problem everyone is trying to solve?"

---

## The One Problem

Every project in this field — Mem0, MemGPT, claude-mem, HiAgent, AgentFold,
Memory-Probe, all 31 of them — is solving variations of one problem:

> **An LLM agent needs to act on more information than it can
> effectively attend to at any given moment.**

This manifests in three ways depending on context size:

```
Small context (≤100K):  Information doesn't fit     → STORAGE problem
Medium context (~200K): Information fits but decays  → RETENTION problem  
Large context (≥500K):  Information fits but drowns  → ATTENTION problem
```

As context windows grow, the dominant challenge shifts downward.
But all three coexist — even with 1M context, some compaction still happens,
and attention degrades long before 1M.

**The field has converged on this understanding.** Memory-Probe (ICLR 2026)
made it explicit: the bottleneck is not retrieval, it's utilization.
You can store and retrieve perfectly — the LLM still doesn't USE the information.

## What Every Successful System Does

Across Mem0, Cursor, Letta, HiAgent, AgentFold, and the academic work,
four patterns appear universally. They are not design choices —
they are constraints imposed by how transformer attention works.

### Pattern 1: Curate, Don't Accumulate

```
❌ Store everything → context grows → attention dilutes → quality drops
✅ Extract the essential → context stays small → attention stays sharp
```

Every system does curation:
- Mem0: extracts atomic facts from conversation
- Cursor: indexes project files, loads only relevant ones
- Letta: keeps core memory at 8-16K, archives the rest
- HiAgent: maintains subgoal-level summaries
- AgentFold: proactively folds irrelevant context

**exmem alignment**: ✅ Context files are curated, not raw conversation.
But curation is only as good as the curator (LLM consolidation quality).

### Pattern 2: Organize Hierarchically

```
Level N (overview)  → always visible, ~500 tokens
Level N-1 (topics)  → available on demand, ~2K each
Level N-2 (details) → fetched when needed
Level N-3 (raw)     → rarely needed, stored elsewhere
```

Every system independently converges on this:
- HiAgent: task → subgoal → step
- RAPTOR: root summary → cluster → leaf chunk
- ReadAgent: gist → selective re-read → full page
- Cursor: project structure → file → code block
- Letta: core memory → archival memory → recall memory

**exmem alignment**: ✅ _index.md → files → git history → JSONL.
Architecture is correct.

### Pattern 3: Position Information at Attention-Optimal Zones

The U-shaped attention curve (Lost in the Middle) creates two
high-attention zones:

```
attention
   │
   ▇                                              ▇▇
   ▇▇                                           ▇▇
    ▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇
   └──────────────────────────────────────────────┘
   BEGINNING                                    END
   (system prompt)                        (recent messages)
```

Successful systems exploit both zones:
- **Beginning**: System prompt with instructions, identity, tool descriptions
- **End**: Most recent messages, tool results, injected summaries

Information placed in the middle effectively disappears in long contexts.

**exmem alignment**: ⚠️ Partially. System prompt (beginning) ✅.
But no continuous injection at the end. This is the gap Phase 3 fills.

### Pattern 4: Separate Always-On from On-Demand

```
Always-on (in context every turn):
  - Current goal + active constraints
  - Overview of what we know
  - ~500-1K tokens, curated, structured

On-demand (fetched via tools when needed):
  - Detailed context files
  - Historical versions
  - Raw data
```

Cursor does this perfectly: .cursorrules (always-on) vs @file (on-demand).
Letta does this: core memory (always-on) vs archival (on-demand).

**exmem alignment**: ⚠️ Currently _index.md is only "always-on" during
compaction (as the summary). Between compactions, it's just a file on disk.
Agent must actively read it. Phase 3's context hook makes it truly always-on.

---

## The Three Layers

These four patterns form three architectural layers
that every effective system needs:

```
┌─────────────────────────────────────────────────────┐
│ Layer 3: ATTENTION                                   │
│ "Does the agent USE the information?"                │
│                                                      │
│ - Position-aware injection (beginning + end)         │
│ - Utilization-guided format (structured, short)      │
│ - Continuous refresh (every LLM call, not just once) │
│                                                      │
│ Research: Memory-Probe, Lost in the Middle,          │
│           Attention Sinks                            │
├─────────────────────────────────────────────────────┤
│ Layer 2: RETRIEVAL                                   │
│ "Does the agent HAVE the information?"               │
│                                                      │
│ - Search across history                              │
│ - Proactive injection of relevant context            │
│ - On-demand access to details                        │
│                                                      │
│ Research: RAG, MemoRAG, auto-recall                  │
├─────────────────────────────────────────────────────┤
│ Layer 1: ORGANIZATION                                │
│ "Can the agent FIND the information?"                │
│                                                      │
│ - Curated, structured storage                        │
│ - Hierarchical: overview → detail → raw              │
│ - Version-controlled evolution                       │
│                                                      │
│ Research: Mem0, HiAgent, RAPTOR, ReadAgent            │
└─────────────────────────────────────────────────────┘
```

**Most systems solve Layer 1 (and sometimes Layer 2) but fail at Layer 3.**
This is Memory-Probe's key finding. exmem has Layer 1 and 2.
Layer 3 is where Phase 3 must deliver.

---

## What exmem Should Become

### Current State

```
Layer 1 (Organization): ✅ Phase 1 — context files + git + ctx_update
Layer 2 (Retrieval):    ✅ Phase 2 — auto-recall + keyword search
Layer 3 (Attention):    ❌ Not implemented
```

### Target State

```
Layer 1 (Organization): ✅ No changes needed
Layer 2 (Retrieval):    ✅ No changes needed  
Layer 3 (Attention):    ✅ Phase 3 — context hook + working memory brief
```

### Layer 3 Design

Based on all the research, the attention layer needs exactly three things:

**1. Working Memory Brief (WMB)**

A short (<500 tokens), structured, action-oriented snapshot
derived from _index.md. NOT the full _index.md — a compressed,
utilization-optimized extract:

```
[Working Memory — active context for this response]
⚡ GOAL: Sharpe > 1.0, MaxDD < 25% [pinned]
📊 BEST: v2 (MA 10/30) → Sharpe 1.5
⚠️ CONSTRAINTS: MaxDD ≤ 25% [pinned]
📝 LAST ACTION: tested v4 (MA 20/50) → Sharpe 1.1 (worse)
→ NEXT: analyze MA period effect on Sharpe
📁 FILES: strategy-params.md, backtest-results.md
```

Why this format:
- **Short**: 100-150 tokens, not 500-1000 tokens of full _index.md
- **Structured**: Facts, not narrative. Memory-Probe shows higher utilization.
- **Action-oriented**: "NEXT: ..." tells the LLM what to do
- **Visual markers**: ⚡📊⚠️📝📁 act as attention anchors (Landmark Attention concept)
- **[pinned] visible**: Constraints stay visible even in compressed form

**2. Position-Aware Injection**

Inject the WMB at the END of the message list, right before the LLM generates.
This exploits recency bias — the most recently seen information
gets the highest attention.

```
[system prompt]           ← beginning: high attention (instructions)
[message 1]
[message 2]
...
[message N]               ← middle: low attention (old conversation)
...
[message N+M]
[working memory brief]    ← end: high attention (current state)
[LLM generates response]
```

**3. Frequency Control**

Don't inject on every LLM call — that wastes tokens and
the agent may learn to ignore it. Inject when:

```
INJECT when:
  conversation.length > 20 messages    (attention is diluting)
  OR last_ctx_update was recent        (context files changed)
  OR user_prompt contains recall cues  (user asking about history)

DON'T INJECT when:
  conversation.length < 10             (too short, no attention problem)
  AND no recent context changes        (WMB hasn't changed)
```

### How WMB is Generated

The WMB is NOT generated by LLM. It's extracted from _index.md by code:

```typescript
function generateWMB(indexContent: string, contextFiles: string[]): string {
  // 1. Extract Narrative → take first 2 sentences
  // 2. Extract [pinned] items from all context files  
  // 3. List context file names
  // 4. Format as structured brief
  // Result: ~100-150 tokens, zero LLM cost
}
```

Pure code, zero LLM calls, zero latency. Runs on every context hook trigger.

---

## Updated exmem Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                          Agent                                  │
│                     (Context Window)                             │
│                                                                 │
│  ┌─ ATTENTION-OPTIMAL: BEGINNING ──────────────────────────┐    │
│  │ System Prompt + exmem instructions                       │    │
│  └──────────────────────────────────────────────────────────┘    │
│                                                                 │
│  ┌─ MIDDLE (attention fades) ──────────────────────────────┐    │
│  │ Conversation history...                                  │    │
│  └──────────────────────────────────────────────────────────┘    │
│                                                                 │
│  ┌─ ATTENTION-OPTIMAL: END ────────────────────────────────┐    │
│  │ Working Memory Brief (WMB)                               │    │
│  │ ⚡ GOAL  📊 BEST  ⚠️ CONSTRAINTS  📝 LAST  📁 FILES    │    │
│  └──────────────────────────────────────────────────────────┘    │
│                                                                 │
│  Tools: read, write, bash, edit, ctx_update                     │
├────────────────────────────────────────────────────────────────┤
│                     Pi Extension (4 hooks)                       │
│                                                                 │
│  session_start          → init .exmem/                          │
│  before_agent_start     → system prompt + auto-recall           │
│  context                → inject WMB at end (Layer 3)   ← NEW  │
│  session_before_compact → consolidation                         │
├────────────────────────────────────────────────────────────────┤
│                     .exmem/ (Git Repository)                     │
│                                                                 │
│  context/                                                       │
│  ├── _index.md    ← source for WMB generation                  │
│  └── <topic>.md   ← on-demand detail (Layer 2)                  │
│                                                                 │
│  .git/            ← version history, diff, rollback (Layer 1)   │
└────────────────────────────────────────────────────────────────┘
```

### What Changed from Current Design

| Element | Before | After |
|---------|--------|-------|
| Hooks | 3 (start, compact, agent_start) | 4 (+context) |
| _index.md role | compaction summary only | source for WMB (always-on) |
| Attention management | none | WMB injection at context end |
| WMB generation | n/a | pure code, ~0ms, no LLM |
| Injection frequency | never (or once via auto-recall) | conditional per LLM call |
| Project positioning | "external memory" | "structured working memory" |

### What Didn't Change

- ctx_update tool (1 tool, no additions)
- git versioning (organization layer untouched)
- auto-recall (retrieval layer untouched)
- Consolidation flow (compaction hook untouched)
- [pinned] mechanism (unchanged)
- Safety mechanisms (unchanged)

**Layer 3 is a 1-hook addition, not a redesign.**
