# Design Decisions

Trade-offs and rationale behind exmem's design.
Grouped by theme, ordered chronologically within each group.

---

## Foundational Choices

### D1: Git as storage backend

**Decision**: Use Git for context version control.

| Option | Pros | Cons |
|--------|------|------|
| **Git** ✅ | Version history, per-file diff, grep, branch; zero dependencies | No semantic search |
| SQLite + FTS5 | Fast full-text search | No versioning, no diff |
| Vector DB | Semantic search | Needs embedding model; loses exact retrieval |
| Plain folder | Simplest | No versioning, no rollback |

**Trade-off**: No semantic search. Keyword search (git grep) is sufficient
for coding scenarios (precise terms), but fails for vague queries
("that approach that worked better").

### D2: Store context, not conversation

**Decision**: Git stores curated Context files (the agent's mental model),
not raw conversation (Pi JSONL handles that).

**Key insight**: Conversation is process, Context is product.
Storing raw conversation in git is redundant with Pi's JSONL.
What's missing is the structured understanding extracted FROM conversation.

**Trade-off**: Can't retrieve raw conversation from exmem.
Agent must use Pi's `ctx.sessionManager.getEntries()` for that.
Rarely needed — Context files contain the essential information.

### D3: No prescribed file structure

**Decision**: Only `_index.md` is required. Other files created by LLM as needed.

| Option | Pros | Cons |
|--------|------|------|
| BDI directories (beliefs/desires/intentions/) | Theoretical backing | Classification ambiguity, long paths |
| 7 standard files (goals, constraints, ...) | Clear structure | Preset answers; many files may be empty |
| **Only _index.md** ✅ | Most flexible; files emerge from content | First consolidation quality depends on LLM |

**Trade-off**: LLM must decide file organization from scratch on first
consolidation. Mitigated by format demo (D7).

### D4: One custom tool

**Decision**: Register only `ctx_update`. Reading via bash + standard git commands.

**Evolution**: 7 tools → 5 → 1.

The agent is a coding assistant — it already knows git.
`bash("cd .exmem && git show abc123:context/file.md")` doesn't need a wrapper.

`ctx_update` is the exception: it provides atomic write + git commit + idempotency
that would be fragile with separate write + bash calls.

**Trade-off**: Agent needs git command knowledge (taught via system prompt).
Fine for coding agents. Non-coding agents may need read tools restored.

---

## Mechanism Design

### D5: Two-phase update

**Decision**: Real-time encoding (ctx_update) + batch consolidation (compaction hook).

**Basis**: Encoding specificity (Tulving, 1973) — capturing information at the
moment it's produced is more reliable than retrospective extraction.

**Trade-off**: Real-time encoding depends on agent initiative (unreliable).
Degraded mode (consolidation only) is still better than Pi's default compaction
(incremental update vs regeneration from scratch).

### D6: _index.md dual role

**Decision**: `_index.md` serves as both Pi's compaction summary
AND the data source for Working Memory Brief (WMB) generation.

| Option | Pros | Cons |
|--------|------|------|
| Concatenate all context files | Agent sees all detail | Up to 8k tokens — too large for summary |
| Separate summary generation | More refined | Extra LLM call |
| **_index.md for both** ✅ | Zero overhead; naturally compatible | Narrative quality must serve both purposes |

Good compaction summary = good WMB source. Narrative's first sentences
naturally state goal + status, which is exactly what WMB needs.

**Trade-off**: Agent only sees ~500-1000 tokens (_index.md) directly after
compaction. Must actively `read` other files for detail. WMB mitigates this
by continuously surfacing key facts during conversation.

### D7: Safety mechanisms — simple + high-value only

**Decision**: Snapshot + rollback + post-validation + [pinned] verification.

**Kept**:

| Mechanism | Cost | Value |
|-----------|------|-------|
| [pinned] + code verification | Few lines of string matching | Prevents critical info loss |
| Pre-consolidation snapshot | 2 git commands | Enables rollback on bad output |
| Post-validation (5 checks) | ~15 lines | Catches obvious failures |
| Format demo (first time) | ~500 tokens, first time only | Improves first consolidation |
| ctx_update idempotency | 3 lines | Clean git history |

**Cut**: Periodic integrity checks (no action owner), Hot/Warm/Cold tiers
+ metadata.json (budget + prompt suffices), EXPAND/REVISE/CONTRACT
classification (LLM does this naturally), multiple annotation formats
(only [pinned] kept).

**Principle**: Keep only mechanisms that take a few lines of code
but protect against real failure modes.

---

## Design Principles (from lessons learned)

### D8: Don't over-engineer, don't over-theorize

**Background**: Design went through 50 → 12 → 19 elements.

**Lessons**:

1. **Don't teach LLMs what they already know.**
   Topic switching rules, EXPAND/REVISE/CONTRACT classification —
   LLMs understand these concepts natively. Excessive rules interfere.

2. **Don't design theoretical solutions for empirical problems.**
   Information decay and consolidation quality can only be validated
   through actual use. Pre-designing periodic integrity checks is waste.

3. **No mechanism without an action owner.**
   If nothing handles a warning, don't generate it.

4. **Existing tools are the best tools.**
   Agent has bash. Git has a mature CLI. Wrapping them usually
   adds complexity without adding value.

5. **Cognitive science provides thinking frameworks, not engineering specs.**
   BDI, Ebbinghaus curves, and ACT-R informed our understanding
   but shouldn't be directly implemented as file structures or metadata.
   Engineering needs simplicity, not theoretical fidelity.

6. **Domain-specific examples anchor LLMs.**
   Format demos should show FORMAT, not CONTENT patterns.
   Use placeholders to avoid biasing toward specific domains.

---

## Attention Management (v11-v12)

### D9: Three-layer architecture

**Decision**: System organized as Organization (L1) → Retrieval (L2) → Attention (L3).

**Finding**: Most agent memory systems solve L1-L2 but fail at L3.
Memory-Probe (ICLR 2026) showed the bottleneck is utilization, not retrieval.

**Impact**: Phase 3 redefined from "extensions" to "attention management."

### D10: Working Memory Brief (WMB)

**Decision**: Full Narrative (no truncation) + [pinned] scan + file list.
Pure code generation. Injected at message list end.

| Option | Reliability | Complexity | Chosen? |
|--------|------------|------------|---------|
| A: Add structured Status fields to _index.md | Highest | Medium | ❌ Over-structures |
| B: NLP extraction of goal/status | Medium | Medium | ❌ May extract wrong info |
| **C: Use full Narrative as-is** | **High** | **Lowest** | ✅ |

**Rationale**:
- No truncation — 300 extra tokens in 1M context is 0.03%
- Cannot produce wrong info (displays text as-is)
- [pinned] extraction is 100% reliable (regex)
- File list is 100% reliable (readdir)

**Position**: End of message list (recency bias).
Combined with auto-recall at front (primacy bias),
covers both high-attention zones of the U-shaped attention curve.

**Frequency**: Inject when conversation > 20 messages OR context changed.

### D11: Problem shift — storage → attention

**Decision**: Reposition from "External memory" to "Structured working memory."

**Context**: Context windows grew from 200K to 1M+.
Compaction triggers less often, but attention dilution becomes dominant.

**Evidence**:
- Lost in the Middle: 30% accuracy drop at middle positions
- Memory-Probe: Utilization bottleneck > retrieval bottleneck
- Letta: Keeps core context at 8-16K even with 1M available
- Cursor/Cline: Focused few > unfocused many

**Both problems coexist**: Compaction (L1 + consolidation hook) still matters.
Attention (L3 + WMB + context hook) becomes primary concern.

---

## Evolution Timeline

```
v1   git stores raw conversation (4 files + 7 tools)
      ↓ "JSONL already stores conversation"
v2   git stores Context document (single CONTEXT.md)
      ↓ "Context is multi-facet, not single doc"
v3   multi-file: per-topic + per-file versioning
      ↓ "how to handle focus switching?"
v4   status management: Active/Paused + tiering
      ↓ "real-time encoding, not just compaction-time"
v5   cognitive framework: two-phase update
      ↓ "validate against research"
v6   research integration: Reflexion, Mem0, CoALA
      ↓ "is this over-engineered?"
v7   simplification: 50 → 12 elements
      ↓ "cut too much?"
v8   restore: 12 → 19 (add back high-value safety)
      ↓ "domain examples anchor LLMs"
v9   format demo: placeholders, no domain content
      ↓ "1M context → attention dilution is the new problem"
v10  three-layer model: Organization → Retrieval → Attention
      ↓ "31 papers confirm utilization bottleneck"
v11  WMB: Working Memory Brief, pure code, recency bias injection

Full evolution in archive/
```
