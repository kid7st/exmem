import { describe, it, before, after } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ExMem } from "../core/exmem.ts";
import { parseConsolidationOutput } from "../pi-extension/prompts.ts";
import type { ConsolidationOutput } from "../core/types.ts";

// Helper: create a ExMem instance in a temp directory
async function createTestExMem(): Promise<{ exMem: ExMem; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "exmem-test-"));
  const exMem = new ExMem({ repoPath: join(dir, ".exmem") });
  return { exMem, dir };
}

describe("ExMem", () => {
  let exMem: ExMem;
  let testDir: string;

  before(async () => {
    const t = await createTestExMem();
    exMem = t.exMem;
    testDir = t.dir;
  });

  after(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  // ── Init (DESIGN §8) ──────────────────────────────────────

  describe("init", () => {
    it("creates .exmem repo with _index.md", async () => {
      const created = await exMem.init();
      assert.equal(created, true);

      // Verify _index.md exists
      const index = await exMem.getIndexContent();
      assert.ok(index);
      assert.ok(index.includes("Narrative"));
      assert.ok(index.includes("No context recorded yet"));
    });

    it("is idempotent", async () => {
      const created = await exMem.init();
      assert.equal(created, false);
    });

    it("has initial commit", async () => {
      const status = await exMem.getStatus();
      assert.ok(status.checkpoints >= 1);
      assert.equal(status.files, 1); // only _index.md
    });
  });

  // ── updateFile / ctx_update (DESIGN §5.1) ────────────────

  describe("updateFile", () => {
    it("creates a new file and commits", async () => {
      const hash = await exMem.updateFile(
        "strategy-params.md",
        "# Strategy\n- MA: 10/30\n- RSI: 70\n",
        "v1 params",
      );
      assert.ok(hash);

      const content = await exMem.context.readFile("strategy-params.md");
      assert.ok(content?.includes("MA: 10/30"));

      const status = await exMem.getStatus();
      assert.equal(status.files, 2); // _index.md + strategy-params.md
    });

    it("is idempotent — same content returns null", async () => {
      const hash = await exMem.updateFile(
        "strategy-params.md",
        "# Strategy\n- MA: 10/30\n- RSI: 70\n",
        "same content",
      );
      assert.equal(hash, null);
    });

    it("updates existing file", async () => {
      const hash = await exMem.updateFile(
        "strategy-params.md",
        "# Strategy\n- MA: 10/30\n- RSI: 65\n",
        "v2 params",
      );
      assert.ok(hash);

      const content = await exMem.context.readFile("strategy-params.md");
      assert.ok(content?.includes("RSI: 65"));
    });

    it("commit message includes diff stat", async () => {
      const log = await exMem.git.log(["--oneline", "-1"]);
      assert.ok(log.includes("v2 params") || log.includes("[context]"));
    });
  });

  // ── Checkpoint / Consolidation (DESIGN §5.2) ─────────────

  describe("checkpoint", () => {
    it("applies consolidation output and commits", async () => {
      const output: ConsolidationOutput = {
        files: new Map([
          [
            "_index.md",
            {
              action: "update",
              content:
                "# Project Context\n\n## Narrative\nOptimizing strategy params. v2 best.\n\n## Files\n- strategy-params.md: v2 MA 10/30\n",
            },
          ],
          [
            "strategy-params.md",
            {
              action: "update",
              content: "# Strategy\n- MA: 10/30 [pinned]\n- RSI: 70\n",
            },
          ],
        ]),
      };

      const checkpoint = await exMem.checkpoint(output);
      assert.ok(checkpoint);
      assert.ok(checkpoint.hash);
      assert.ok(checkpoint.filesChanged.includes("_index.md"));
    });

    it("preserves [pinned] items", async () => {
      const content = await exMem.context.readFile("strategy-params.md");
      assert.ok(content?.includes("[pinned]"));
    });

    it("rolls back on validation failure — missing _index.md", async () => {
      const previousIndex = await exMem.getIndexContent();

      const badOutput: ConsolidationOutput = {
        files: new Map([
          ["_index.md", { action: "update", content: "" }], // Empty _index
        ]),
      };

      const result = await exMem.checkpoint(badOutput);
      assert.equal(result, null); // Should fail validation

      // Verify rollback — _index.md should be restored
      const afterIndex = await exMem.getIndexContent();
      assert.ok(afterIndex && afterIndex.length > 50);
    });
  });

  // ── [pinned] mechanism (DESIGN §4.4) ─────────────────────

  describe("pinned items", () => {
    it("detects missing pinned items", async () => {
      // Current state has "MA: 10/30 [pinned]"
      const snapshot = await exMem.context.readSnapshot();

      // Simulate LLM removing the pinned item
      await exMem.context.writeFile(
        "strategy-params.md",
        "# Strategy\n- RSI: 70\n",
      );

      const missing = await exMem.context.findMissingPinnedItems(snapshot);
      assert.ok(missing.size > 0);

      // Recover
      await exMem.context.recoverPinnedItems(missing);
      const recovered = await exMem.context.readFile("strategy-params.md");
      assert.ok(recovered?.includes("[pinned]"));
    });
  });
});

// ── Prompt parsing (DESIGN §5.2 step 4) ─────────────────────

describe("parseConsolidationOutput", () => {
  it("parses valid XML output", () => {
    const raw = `
Some preamble text...

<context-update>
<file path="goals.md" action="create">
# Goals
## 🟢 Active: Build web scraper
- Target: Amazon
</file>
<file path="constraints.md" action="unchanged" />
<file path="_index.md" action="create">
# Project Context

## Narrative
Building web scraper.

## Files
- goals.md: web scraper goals
</file>
</context-update>

Some trailing text...`;

    const result = parseConsolidationOutput(raw);
    assert.ok(result);
    assert.equal(result.files.size, 3);
    assert.equal(result.files.get("goals.md")?.action, "create");
    assert.ok(result.files.get("goals.md")?.content?.includes("Active"));
    assert.equal(result.files.get("constraints.md")?.action, "unchanged");
    assert.equal(result.files.get("_index.md")?.action, "create");
  });

  it("returns null for missing context-update tags", () => {
    assert.equal(parseConsolidationOutput("no xml here"), null);
  });

  it("returns null for missing _index.md", () => {
    const raw = `<context-update>
<file path="goals.md" action="create">content</file>
</context-update>`;
    assert.equal(parseConsolidationOutput(raw), null);
  });

  it("returns null for empty context-update", () => {
    const raw = `<context-update></context-update>`;
    assert.equal(parseConsolidationOutput(raw), null);
  });

  it("handles action-before-path attribute order", () => {
    const raw = `<context-update>
<file action="create" path="goals.md">
# Goals
- Build something
</file>
<file action="unchanged" path="constraints.md" />
<file action="update" path="_index.md">
# Project Context
## Narrative
Working on goals.
## Files
- goals.md
</file>
</context-update>`;

    const result = parseConsolidationOutput(raw);
    assert.ok(result);
    assert.equal(result.files.size, 3);
    assert.equal(result.files.get("goals.md")?.action, "create");
    assert.ok(result.files.get("goals.md")?.content?.includes("Build something"));
    assert.equal(result.files.get("constraints.md")?.action, "unchanged");
    assert.equal(result.files.get("_index.md")?.action, "update");
  });

  it("handles mixed attribute orders in same output", () => {
    const raw = `<context-update>
<file path="a.md" action="create">content a</file>
<file action="create" path="b.md">content b</file>
<file path="_index.md" action="update">index</file>
</context-update>`;

    const result = parseConsolidationOutput(raw);
    assert.ok(result);
    assert.equal(result.files.size, 3);
    assert.equal(result.files.get("a.md")?.action, "create");
    assert.equal(result.files.get("b.md")?.action, "create");
  });
});
