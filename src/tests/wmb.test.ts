import { describe, it, before, after } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ExMem } from "../core/exmem.ts";
import { generateWMB, shouldInjectWMB } from "../pi-extension/wmb.ts";

async function createPopulatedExMem(): Promise<{ exMem: ExMem; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "exmem-wmb-test-"));
  const exMem = new ExMem({ repoPath: join(dir, ".exmem") });
  await exMem.init();

  // Create context files with realistic content
  await exMem.updateFile(
    "_index.md",
    `# Project Context
Updated: 2025-03-21 | Commit: abc1234

## Narrative
Optimizing MA crossover strategy parameters. Target: Sharpe > 1.0.
v2 (MA 10/30, RSI 70) is current best with Sharpe 1.5.

## Files
- strategy-params.md: 4 versions, v2 best
- backtest-results.md: latest v4 Sharpe 1.1
- constraints.md: MaxDD ≤ 25%
`,
    "update index",
  );

  await exMem.updateFile(
    "constraints.md",
    `# Constraints
- MaxDD ≤ 25% [pinned]
- Data range: 2020-2023 [pinned]
- Must use adjusted close prices [pinned]
`,
    "add constraints",
  );

  await exMem.updateFile(
    "strategy-params.md",
    `# Strategy Parameters
## v2
- MA fast: 10
- MA slow: 30
- RSI threshold: 70
`,
    "v2 params",
  );

  await exMem.updateFile(
    "backtest-results.md",
    `# Backtest Results
- v1: Sharpe 1.2, MaxDD -18%
- v2: Sharpe 1.5, MaxDD -15%
`,
    "results",
  );

  return { exMem, dir };
}

// ── generateWMB ─────────────────────────────────────────────

describe("generateWMB", () => {
  let exMem: ExMem;
  let testDir: string;

  before(async () => {
    const t = await createPopulatedExMem();
    exMem = t.exMem;
    testDir = t.dir;
  });

  after(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("produces a WMB with Narrative, pinned items, and file list", async () => {
    const wmb = await generateWMB(exMem);
    assert.ok(wmb);

    // Header
    assert.ok(wmb.includes("[Working Memory"));

    // Narrative (full, not truncated)
    assert.ok(wmb.includes("Optimizing MA crossover"));
    assert.ok(wmb.includes("Sharpe 1.5"));

    // [pinned] items
    assert.ok(wmb.includes("MaxDD ≤ 25% [pinned]"));
    assert.ok(wmb.includes("Data range: 2020-2023 [pinned]"));

    // File list
    assert.ok(wmb.includes("strategy-params.md"));
    assert.ok(wmb.includes("backtest-results.md"));
    assert.ok(wmb.includes("constraints.md"));

    // Should NOT include _index.md in file list
    const fileListLine = wmb.split("\n").find((l) => l.startsWith("📁"));
    assert.ok(fileListLine);
    assert.ok(!fileListLine.includes("_index.md"));
  });

  it("includes full Narrative without truncation", async () => {
    const wmb = await generateWMB(exMem);
    assert.ok(wmb);

    // Both sentences of the Narrative should be present
    assert.ok(wmb.includes("Optimizing MA crossover strategy parameters"));
    assert.ok(wmb.includes("v2 (MA 10/30, RSI 70) is current best"));
  });

  it("deduplicates pinned items", async () => {
    // Add a file that also mentions a constraint already in constraints.md
    await exMem.updateFile(
      "notes.md",
      "# Notes\n- MaxDD ≤ 25% [pinned]\n- Some other note\n",
      "add notes",
    );

    const wmb = await generateWMB(exMem);
    assert.ok(wmb);

    // Count occurrences of "MaxDD ≤ 25% [pinned]"
    const matches = wmb.match(/MaxDD ≤ 25% \[pinned\]/g);
    assert.equal(matches?.length, 1, "pinned item should appear only once");
  });

  it("returns null for empty/initial context", async () => {
    const freshDir = await mkdtemp(join(tmpdir(), "exmem-wmb-empty-"));
    const fresh = new ExMem({ repoPath: join(freshDir, ".exmem") });
    await fresh.init();

    const wmb = await generateWMB(fresh);
    assert.equal(wmb, null);

    await rm(freshDir, { recursive: true, force: true });
  });

  it("caps pinned items at 5", async () => {
    const manyDir = await mkdtemp(join(tmpdir(), "exmem-wmb-many-"));
    const many = new ExMem({ repoPath: join(manyDir, ".exmem") });
    await many.init();

    // Create a file with 8 pinned items
    let content = "# Constraints\n";
    for (let i = 1; i <= 8; i++) {
      content += `- Constraint ${i} [pinned]\n`;
    }
    await many.updateFile("_index.md",
      "# Project Context\n\n## Narrative\nTesting many pinned items.\n\n## Files\n- constraints.md\n",
      "index",
    );
    await many.updateFile("constraints.md", content, "many pinned");

    const wmb = await generateWMB(many);
    assert.ok(wmb);

    // Should show 5 + "and 3 more"
    const pinnedLines = wmb.split("\n").filter((l) => l.startsWith("⚠️"));
    assert.equal(pinnedLines.length, 6); // 5 items + "... and 3 more"
    assert.ok(wmb.includes("and 3 more [pinned]"));

    await rm(manyDir, { recursive: true, force: true });
  });
});

// ── shouldInjectWMB ─────────────────────────────────────────

describe("shouldInjectWMB", () => {
  it("does not inject for short conversations without changes", () => {
    assert.equal(shouldInjectWMB(5, false), false);
    assert.equal(shouldInjectWMB(9, false), false);
  });

  it("injects for long conversations", () => {
    assert.equal(shouldInjectWMB(21, false), true);
    assert.equal(shouldInjectWMB(50, false), true);
  });

  it("injects when context changed even if short", () => {
    assert.equal(shouldInjectWMB(5, true), true);
    assert.equal(shouldInjectWMB(15, true), true);
  });

  it("boundary: 10 messages without changes = no inject", () => {
    assert.equal(shouldInjectWMB(10, false), false);
  });

  it("boundary: 20 messages without changes = no inject", () => {
    assert.equal(shouldInjectWMB(20, false), false);
  });

  it("boundary: 21 messages = inject", () => {
    assert.equal(shouldInjectWMB(21, false), true);
  });
});
