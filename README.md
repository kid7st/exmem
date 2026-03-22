# exmem

**External memory for LLM agents.**

[中文文档](docs/README.zh-CN.md)

exmem externalizes your AI agent's mental model — goals, decisions, constraints, experiment results — into Git-versioned context files that survive compaction. When context is compressed, nothing is lost. Every version can be recalled, diffed, and searched.

## The Problem

LLM agents have limited context windows. When conversations grow too long, compaction compresses the history into a brief summary. This process:

1. **Regenerates from scratch** each time — information decays across multiple compactions
2. **Produces flat text** — can't query a specific aspect ("what were v2's parameters?")
3. **Discards history** — can't trace how understanding evolved

The raw conversation is still in Pi's session file, but **conversation is process, context is product**. Reconstructing context from raw conversation means re-processing everything — impractical.

### Example

During quantitative strategy development, after 4 rounds of parameter tuning:

```
v1: MA 10/20, RSI 70  → Sharpe 1.2
v2: MA 10/30, RSI 70  → Sharpe 1.5  ← best
v3: MA 10/30, RSI 65  → Sharpe 1.3
v4: MA 20/50, RSI 70  → Sharpe 1.1
```

User: "v2 was best. Go back to v2 params and analyze how MA period affects Sharpe."

With standard compaction, v1-v3 have been compressed to "tested several parameter sets." The agent can't answer.

## How exmem Solves This

exmem **externalizes the agent's mental model** into structured context files, version-controlled with Git.

```
conversation → agent processes → ctx_update records key info → git commit
                                                                    │
                                        git log / show / diff / grep
                                        any historical version recoverable
```

### Two-Phase Memory Update

**Phase 1: Real-time encoding** — Agent calls `ctx_update` during conversation to capture important information as it happens (high fidelity, small increments)

**Phase 2: Consolidation** — At compaction time, LLM reviews the conversation being compressed + current context files, fills gaps, and commits

### How the Agent Uses Memory

**Write** (single new tool):

```
ctx_update(file="constraints.md", content="...", message="add MaxDD constraint")
```

**Read** (existing tools — no new tools needed):

```bash
read(".exmem/context/strategy-params.md")                              # current context
bash("cd .exmem && git log --oneline -- context/strategy-params.md")   # version history
bash("cd .exmem && git show abc123:context/strategy-params.md")        # historical version
bash("cd .exmem && git log --all --oneline --grep='Sharpe'")           # search
bash("cd .exmem && git diff abc123 def456 -- context/")                # compare versions
```

The agent already knows Git. No wrapper tools needed.

## Installation

### Prerequisites

- [Pi](https://github.com/badlogic/pi-mono) (>=0.40.0)
- Git

### Install

```bash
# Try without installing (current session only)
pi -e /path/to/exmem

# Install globally (all projects)
pi install /path/to/exmem

# Install per-project (shareable via .pi/settings.json)
pi install -l /path/to/exmem

# From Git repository (when published)
pi install git:github.com/user/exmem
```

After installation, exmem loads automatically when Pi starts. **No configuration needed.**

> Add `.exmem/` to your project's `.gitignore` to avoid committing
> exmem's internal Git repository to your project.

## What Happens After Installation

1. Pi creates a `.exmem/` Git repository in your project directory (automatic)
2. System prompt gains a "Context Memory" section explaining available memory tools
3. A new `ctx_update` tool becomes available for recording important information
4. Each compaction automatically consolidates conversation into context files and commits

## Safety Mechanisms

| Mechanism | Protects Against | Implementation |
|-----------|-----------------|----------------|
| Pre-consolidation snapshot | LLM producing bad output | `git commit` before consolidation |
| Post-consolidation checks (5) | Obvious consolidation failures | Deterministic code checks |
| `[pinned]` verification | Critical constraints being deleted | String matching + auto-recovery |
| `[pinned]` conflict marking | Critical constraints being semantically overridden | Consolidation prompt rule |
| Idempotent `ctx_update` | Duplicate commits from same content | Content comparison before commit |
| Segmented processing | Quality loss on long conversations | Split at >40k tokens |
| Fallback to Pi default | Total consolidation failure | Return `undefined` → Pi handles it |

**Worst case = status quo.** If exmem fails completely, Pi falls back to its default compaction. You're never worse off than without exmem.

## Example: Full Scenario

```
── v1-v4 iteration (multiple conversations + compactions) ──

Agent records each parameter change:
  ctx_update("strategy-params.md", "...v2: MA 10/30, RSI 70...", "v2 params")
  ctx_update("backtest-results.md", "...v2: Sharpe 1.5...", "v2 results")

── User: "v2 was best, go back to v2 params" ──

Agent:
  bash("cd .exmem && git log --oneline -- context/strategy-params.md")
  → abc1234  v4: MA 20/50
    def5678  v3: MA 10/30 RSI 65
    ghi9012  v2: MA 10/30 RSI 70     ← target
    jkl3456  v1: MA 10/20

  bash("cd .exmem && git show ghi9012:context/strategy-params.md")
  → gets v2 parameters

── User: "Analyze how MA period affects Sharpe" ──

Agent:
  bash("cd .exmem && git diff ghi9012 abc1234 -- context/strategy-params.md")
  → MA fast 10→20, slow 30→50

  bash("cd .exmem && git diff ghi9012 abc1234 -- context/backtest-results.md")
  → Sharpe 1.5→1.1, MaxDD -15%→-22%

  Agent: "Increasing MA period (10/30→20/50) decreased Sharpe from 1.5 to 1.1.
          Recommend reverting to v2's MA 10/30."
```

## Context File Structure

```
.exmem/
└── context/
    ├── _index.md            ← overview (= compaction summary)
    └── <topic>.md           ← LLM creates as needed
```

Only `_index.md` is required by the system. Other files are created by the LLM based on conversation content. No fixed file structure is imposed — files emerge naturally from the content.

## Configuration

Works out of the box. These parameters can be adjusted in code:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `tokenBudget` | 8000 | Total token limit for all context files |
| `segmentThreshold` | 40000 | Conversation length that triggers segmented processing |
| `repoPath` | `.exmem` | Path to the Git repository |

## Design

exmem's design went through 10 rounds of iteration, from 50 design elements down to 19, informed by research from MemGPT, Generative Agents, Complementary Learning Systems theory, and the BDI cognitive architecture.

- [DESIGN.md](DESIGN.md) — Full system design (Chinese)
- [DECISIONS.md](DECISIONS.md) — 12 design decisions with trade-offs (Chinese)
- [archive/](archive/) — Complete design evolution across all iterations

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
