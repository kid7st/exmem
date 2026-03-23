# 1M Context Gap: Complete Comparison

## Problem

In 1M context, compaction triggers ~1/328 turns.
Without compaction, consolidation hook is dormant.
Context files stop being updated. WMB has nothing to inject.
The entire system depends on Agent calling ctx_update voluntarily.

## Approach Comparison

|  | Direction 1: Behavior Guidance | Direction 2: Auto-Extraction | Direction 3: Periodic Consolidation |
|---|---|---|---|
| **What** | Stronger system prompt + WMB staleness reminder | System auto-extracts facts from conversation | Every N turns, trigger consolidation LLM call |
| **Depends on Agent?** | ✅ Yes | ❌ No | ❌ No |
| **Extra LLM calls** | 0 | 1 per turn (~328/session) | 1 per N turns (~16/session at N=20) |
| **Extra LLM cost** | $0 | ~$0.50-2.00/session | ~$0.03-0.10/session |
| **Implementation** | Change prompt text only | New hook + extraction prompt + parser | New hook + reuse consolidation logic |
| **Code changes** | ~10 lines (prompt + WMB) | ~200 lines (new module) | ~80 lines (new hook + message collection) |
| **Reliability** | Medium — models vary in tool-use compliance | High (if using LLM) / Low (if rules) | High — same proven consolidation path |
| **Noise risk** | None | Medium — may extract irrelevant facts | Low — consolidation prompt has 5 rules |
| **Latency impact** | 0 | +2-5s per turn | +2-5s every 20 turns |
| **Works when Agent ignores ctx_update?** | ❌ No — that's the failure case | ✅ Yes | ✅ Yes |
| **Works on first turn?** | ❌ No context yet | ✅ After first turn | ❌ After N turns |
| **Maintains _index.md?** | Only if Agent updates it | Partially (extracts facts, not overview) | ✅ Full — updates _index.md with Narrative |
| **Maintains topic files?** | Only if Agent creates them | ✅ Creates fact entries | ✅ Full — creates/updates all files |
| **Git history quality** | Good (intentional commits) | Noisy (auto commits every turn) | Good (meaningful commits every N turns) |
| **Precedent** | MemGPT system prompt | Mem0 (50K ★) | No direct precedent |
| **Graceful degradation** | System works, just with stale context | System works, may have noise | System works, gap of N turns |

## Cost Breakdown (per 328-turn session)

|  | Dir 1 | Dir 2 (LLM) | Dir 2 (Rules) | Dir 3 (N=20) | Dir 3 (N=10) |
|---|---|---|---|---|---|
| Extra LLM calls | 0 | 328 | 0 | 16 | 33 |
| Input tokens/call | 0 | ~5K | 0 | ~70K | ~40K |
| Output tokens/call | 0 | ~500 | 0 | ~3K | ~3K |
| Total extra input | 0 | ~1.6M | 0 | ~1.1M | ~1.3M |
| Total extra output | 0 | ~164K | 0 | ~48K | ~99K |
| Est. cost (GPT-4o-mini) | $0 | ~$0.30 | $0 | ~$0.04 | ~$0.05 |
| Est. cost (Claude Sonnet) | $0 | ~$2.00 | $0 | ~$0.10 | ~$0.15 |

## Risk Analysis

|  | Dir 1 | Dir 2 | Dir 3 |
|---|---|---|---|
| Agent never calls ctx_update | **System effectively offline** — WMB empty, no context files | System still works — auto-extracts | System still works — periodic sync |
| LLM produces bad extraction | N/A | Bad facts pollute context | Bad consolidation → rollback (existing safety net) |
| High API cost | N/A | Significant for expensive models | Manageable |
| System prompt ignored by model | Context files stay stale | N/A | N/A |
| Network/API failure | N/A | Turn fails silently, retries next turn | Consolidation fails, retries next interval |

## Interaction: What if we combine?

### Dir 1 + Dir 3 (Recommended)

```
Normal case (Dir 1):
  Agent calls ctx_update → context stays fresh → WMB works
  
Safety net (Dir 3):
  Every 20 turns, check: has context been updated recently?
  If yes → skip (Agent is doing its job)
  If no → trigger consolidation (Agent isn't maintaining context)
```

| Aspect | Result |
|--------|--------|
| Cost | Near-zero when Agent cooperates; ~$0.04-0.10/session when it doesn't |
| Reliability | High — Dir 3 covers Dir 1's failure case |
| Complexity | Low — Dir 3 reuses existing consolidation code |
| Noise | None — Dir 3 only runs when Dir 1 fails |
| _index.md freshness | Guaranteed within 20 turns |

### Dir 1 + Dir 2 (Not recommended)

| Aspect | Result |
|--------|--------|
| Cost | ~$0.30-2.00/session regardless of Agent behavior |
| Reliability | Highest — but at highest cost |
| Complexity | High — need extraction prompt + fact parser + dedup |
| Noise | Medium — auto-extraction may add irrelevant facts |
| Git history | Polluted with auto-commits every turn |

### Dir 1 + Dir 2 + Dir 3 (Over-engineered)

Three mechanisms doing overlapping work. Violates D8.

### Dir 3 alone (Without Dir 1)

| Aspect | Result |
|--------|--------|
| Cost | ~$0.04-0.10/session always |
| Reliability | High but coarse-grained (20-turn gaps) |
| _index.md freshness | Up to 20 turns stale |
| Real-time recording | None — no ctx_update guidance |

Worse than Dir 1 + Dir 3: loses the fine-grained, high-fidelity
real-time recording that ctx_update provides.

## Summary

```
                    Reliability
                    ▲
                    │     Dir 2 (LLM)
                    │     ●
          Dir 1+3   │
              ●     │
                    │         Dir 3
            Dir 1   │         ●
              ●     │
                    │   Dir 2 (rules)
                    │   ●
                    └──────────────────► Cost
                   $0              $2/session
```

**Dir 1 + Dir 3 offers the best reliability/cost ratio.**

Dir 3's "consolidate only when Agent hasn't updated" logic means:
- Zero extra cost when Agent is diligent (Dir 1 handles it)
- Minimal cost when Agent is lazy (~16 LLM calls as safety net)
- Maximum cost is bounded and predictable
