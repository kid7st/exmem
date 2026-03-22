# Contributing to exmem

Thank you for your interest in contributing to exmem!

## Development Setup

```bash
git clone https://github.com/<user>/exmem.git
cd exmem
npm install
npm test
```

Requires Node.js ≥ 22 and Git.

## Running Tests

```bash
npm test
```

Tests create temporary Git repositories in the OS temp directory and clean up after themselves.

## Project Structure

```
src/
├── core/           # Core library (Pi-independent)
│   ├── types.ts    # Type definitions
│   ├── git-ops.ts  # Git CLI wrapper
│   ├── context.ts  # Context file management + validation
│   └── exmem.ts    # ExMem main class
├── pi-extension/   # Pi integration
│   ├── index.ts    # Extension entry point
│   ├── hooks.ts    # Lifecycle hooks
│   ├── tools.ts    # ctx_update tool
│   └── prompts.ts  # Consolidation prompt + format demo
└── tests/
    └── exmem.test.ts
```

The core library (`src/core/`) has no Pi dependency and can be used independently.

## Design Documents

The design went through 10 rounds of iteration. Key documents:

- [DESIGN.md](DESIGN.md) — Full system design
- [DECISIONS.md](DECISIONS.md) — 12 design decisions with trade-offs
- [archive/](archive/) — Complete design evolution

These are currently in Chinese. Translations welcome.

## Guidelines

- Keep the design minimal. Read [DECISIONS.md D9](DECISIONS.md) before adding complexity.
- One custom tool (`ctx_update`). Resist adding more — the agent has `bash` + `git`.
- Every safety mechanism must have an action owner. If no code handles a warning, don't generate it.
- Test core functionality. The `src/tests/` directory should cover init, update, checkpoint, validation, and rollback.

## Reporting Issues

Please include:
- Pi version
- Node.js version
- Steps to reproduce
- Expected vs actual behavior
