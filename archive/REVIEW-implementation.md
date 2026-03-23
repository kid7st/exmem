# Implementation Review: Does the code solve the core problems?

## Method

Forget all design documents. Trace the actual code paths
and ask: does this work in the real world?

## Findings

### 🔴 Bug: XML parser requires specific attribute order

```typescript
// Current regex in prompts.ts:
/<file\s+path="([^"]+)"\s+action="(update|create|unchanged)"/
```

This requires `path` before `action`. But LLMs may output either order:
- `<file path="test.md" action="create">` → ✅ works
- `<file action="create" path="test.md">` → ❌ FAILS

If an LLM happens to output `action` first, the entire consolidation
silently fails and falls back to Pi default. This is the most critical
code path in the system — it must handle both attribute orders.

### 🟡 Concern: WMB injected as `user` role message

```typescript
// context hook in index.ts:
return {
  messages: [
    ...event.messages,
    { role: "user", content: [{ type: "text", text: wmb }], ... },
  ],
};
```

This adds a `user` message after the actual conversation. In a multi-turn
with tool calls, the LLM sees:

```
[user: actual prompt]
[assistant: response + tool calls]
[tool results]
[user: WMB]  ← looks like a new user turn
```

Risk: The LLM might treat WMB as a new question instead of metadata.
The "[Working Memory — review before responding]" header should mitigate this,
but it depends on model behavior.

Not a bug — but should be validated empirically. If models get confused,
consider injecting WMB into the last user message's content instead.

### 🟡 Concern: Zero integration testing

All 42 tests are unit tests. None test:
- The actual Pi extension hooks with Pi's runtime
- Whether real LLMs produce parseable XML from the consolidation prompt
- Whether WMB injection actually affects LLM behavior
- End-to-end: conversation → compaction → consolidation → context files → recall

The unit tests verify **plumbing** (data flows correctly between components).
They don't verify **outcomes** (does the LLM actually produce useful context files?).

This is expected for Phase 1-3 (can't mock LLM quality). But it means
the system is untested for its most critical value proposition.

### ✅ Correct: Architecture solves the stated problems

Tracing each problem to its solution:

```
Problem 1: Compaction loses context
  → session_before_compact hook intercepts
  → LLM updates context files (incremental, not from-scratch)
  → Git commits preserve history
  → _index.md returned as summary
  Status: Correctly architected. Quality depends on LLM. ✅

Problem 2: Can't retrieve historical details
  → Agent uses bash + git commands (log, show, diff, grep)
  → auto-recall injects relevant history automatically
  Status: Works. Keyword-only, not semantic. ✅

Problem 3: Attention dilution in long context
  → WMB injected at message list end (recency bias)
  → [pinned] items always visible
  → File list shows where to look
  Status: Correctly architected. Empirical validation needed. ✅
```

### ✅ Correct: Safety mechanisms are real

- [pinned] verification: Fixed in last review (was stub, now real) ✅
- Snapshot/rollback: Works (tested) ✅
- Segmented snapshot: Fixed in last review (was broken, now safe) ✅
- Post-validation: 5 checks, all deterministic ✅
- Fallback: Returns undefined → Pi default ✅

### ✅ Correct: Minimal surface area

- 1 tool, 4 hooks — verified in code
- No unnecessary abstractions
- tools.ts `createCtxUpdateTool` is unused dead code but harmless

## Action Items

| # | Issue | Severity | Fix |
|---|-------|----------|-----|
| 1 | XML parser attribute order | 🔴 Bug | Fix regex to handle both orders |
| 2 | WMB user-role injection | 🟡 Design | Validate empirically; document risk |
| 3 | No integration tests | 🟡 Maturity | Phase 4 — test with real Pi + LLM |
| 4 | tools.ts unused factory | 🟢 Cleanup | Keep for SDK users or remove |
