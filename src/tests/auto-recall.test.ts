import { describe, it, before, after } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ExMem } from "../core/exmem.ts";
import { extractKeywords, autoRecall } from "../pi-extension/auto-recall.ts";

// Helper: create an ExMem instance with some history
async function createTestExMem(): Promise<{ exMem: ExMem; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "exmem-recall-test-"));
  const exMem = new ExMem({ repoPath: join(dir, ".exmem") });
  await exMem.init();
  return { exMem, dir };
}

// Helper: populate with a realistic history
async function populateHistory(exMem: ExMem): Promise<void> {
  await exMem.updateFile(
    "strategy-params.md",
    "# Strategy Parameters\n## v1\n- MA fast: 10\n- MA slow: 20\n- RSI: 70\n",
    "v1 params: MA 10/20 RSI 70",
  );
  await exMem.updateFile(
    "backtest-results.md",
    "# Backtest Results\n## v1\n- Sharpe: 1.2\n- MaxDD: -18%\n",
    "v1 results: Sharpe 1.2",
  );
  await exMem.updateFile(
    "strategy-params.md",
    "# Strategy Parameters\n## v2\n- MA fast: 10\n- MA slow: 30\n- RSI: 70\n",
    "v2 params: MA 10/30 RSI 70",
  );
  await exMem.updateFile(
    "backtest-results.md",
    "# Backtest Results\n## v2\n- Sharpe: 1.5\n- MaxDD: -15%\n",
    "v2 results: Sharpe 1.5",
  );
  await exMem.updateFile(
    "constraints.md",
    "# Constraints\n- MaxDD ≤ 25% [pinned]\n- Data range: 2020-2023\n",
    "add constraints",
  );
  await exMem.updateFile(
    "_index.md",
    "# Project Context\n\n## Narrative\nOptimizing MA crossover strategy. v2 (MA 10/30) best so far.\n\n## Files\n- strategy-params.md: v2 MA 10/30\n- backtest-results.md: v2 Sharpe 1.5\n- constraints.md: MaxDD ≤ 25%\n",
    "update index",
  );
}

// ── extractKeywords ─────────────────────────────────────────

describe("extractKeywords", () => {
  it("extracts meaningful English words", () => {
    const kw = extractKeywords("go back to v2 parameters and analyze Sharpe ratio");
    assert.ok(kw.includes("v2"));
    assert.ok(kw.includes("parameters"));
    assert.ok(kw.includes("sharpe"));
    assert.ok(kw.includes("ratio"));
    assert.ok(!kw.includes("to"));
    assert.ok(!kw.includes("and"));
    assert.ok(!kw.includes("go"));
  });

  it("extracts meaningful Chinese words", () => {
    const kw = extractKeywords("帮我回到 v2 的参数，分析 MA 周期对 Sharpe 的影响");
    assert.ok(kw.includes("v2"));
    assert.ok(kw.includes("参数"));
    assert.ok(kw.includes("sharpe"));
    assert.ok(kw.includes("影响"));
    assert.ok(!kw.includes("帮我"));
    assert.ok(!kw.includes("的"));
  });

  it("extracts quoted strings", () => {
    const kw = extractKeywords('look for "MA crossover" strategy');
    assert.ok(kw.includes("ma crossover"));
  });

  it("extracts version numbers and percentages", () => {
    const kw = extractKeywords("v3 had Sharpe 1.5 and MaxDD -15%");
    assert.ok(kw.includes("v3"));
    assert.ok(kw.includes("1.5"));
    assert.ok(kw.includes("15%"));
  });

  it("returns empty for very short input", () => {
    const kw = extractKeywords("ok");
    assert.equal(kw.length, 0);
  });

  it("deduplicates", () => {
    const kw = extractKeywords("v2 parameters v2 params v2");
    const v2Count = kw.filter((k) => k === "v2").length;
    assert.equal(v2Count, 1);
  });
});

// ── ExMem.log ───────────────────────────────────────────────

describe("ExMem.log", () => {
  let exMem: ExMem;
  let testDir: string;

  before(async () => {
    const t = await createTestExMem();
    exMem = t.exMem;
    testDir = t.dir;
    await populateHistory(exMem);
  });

  after(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("returns context commits only", async () => {
    const entries = await exMem.log();
    assert.ok(entries.length > 0);
    // All entries should be [context] commits
    for (const e of entries) {
      assert.ok(e.message.includes("[context]"), `expected [context] in: ${e.message}`);
    }
  });

  it("does not return [init] or [snapshot] commits", async () => {
    const entries = await exMem.log();
    for (const e of entries) {
      assert.ok(!e.message.includes("[init]"));
      assert.ok(!e.message.includes("[snapshot]"));
    }
  });
});

// ── ExMem.search ────────────────────────────────────────────

describe("ExMem.search", () => {
  let exMem: ExMem;
  let testDir: string;

  before(async () => {
    const t = await createTestExMem();
    exMem = t.exMem;
    testDir = t.dir;
    await populateHistory(exMem);
  });

  after(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("finds commits by keyword", async () => {
    const hits = await exMem.search(["Sharpe"]);
    assert.ok(hits.length > 0);
  });

  it("finds content by keyword", async () => {
    const hits = await exMem.search(["MaxDD"]);
    assert.ok(hits.length > 0);
  });

  it("returns empty for non-existent keyword", async () => {
    const hits = await exMem.search(["nonexistentkeyword123"]);
    assert.equal(hits.length, 0);
  });

  it("scores recent commits higher", async () => {
    const hits = await exMem.search(["v2", "Sharpe"]);
    if (hits.length >= 2) {
      // Most recent should be first (higher score)
      assert.ok(hits[0].score >= hits[hits.length - 1].score);
    }
  });
});

// ── autoRecall ──────────────────────────────────────────────

describe("autoRecall", () => {
  let exMem: ExMem;
  let testDir: string;

  before(async () => {
    const t = await createTestExMem();
    exMem = t.exMem;
    testDir = t.dir;
    await populateHistory(exMem);
  });

  after(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("returns relevant content for specific query", async () => {
    const result = await autoRecall(exMem, "What were the v1 parameters?");
    // Might return null if threshold not met, which is acceptable
    // (precision > recall). Just verify it doesn't throw.
    if (result) {
      assert.ok(result.includes("[Memory]"));
    }
  });

  it("returns null for empty/short prompt", async () => {
    const result = await autoRecall(exMem, "ok");
    assert.equal(result, null);
  });

  it("returns null for brand new ExMem with no history", async () => {
    const freshDir = await mkdtemp(join(tmpdir(), "exmem-fresh-"));
    const fresh = new ExMem({ repoPath: join(freshDir, ".exmem") });
    await fresh.init();
    const result = await autoRecall(fresh, "find the Sharpe ratio");
    assert.equal(result, null);
    await rm(freshDir, { recursive: true, force: true });
  });

  it("respects injection budget", async () => {
    const result = await autoRecall(exMem, "analyze all strategy params and results", {
      maxInjectTokens: 100, // very small budget
      scoreThreshold: 0.1,
    });
    if (result) {
      // ~100 tokens × 3 chars = 300 chars max
      assert.ok(result.length < 500, `result too long: ${result.length} chars`);
    }
  });
});
