/**
 * Git CLI wrapper.
 *
 * All git operations execute against the .git-mem repository.
 * Uses execFile (not exec) to avoid shell injection.
 *
 * Design reference: DESIGN.md §10 module structure
 */

import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import type { ExecResult } from "./types.ts";

export class GitOps {
  constructor(private repoPath: string) {}

  // ── Core operations ────────────────────────────────────────────

  /**
   * Execute a git command in the repo directory.
   * All commands run with the repo as cwd.
   */
  async exec(args: string[], options?: { timeout?: number }): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      execFile(
        "git",
        args,
        {
          cwd: this.repoPath,
          timeout: options?.timeout ?? 30_000,
          maxBuffer: 10 * 1024 * 1024, // 10MB
        },
        (error, stdout, stderr) => {
          if (error && !("code" in error)) {
            reject(error);
            return;
          }
          resolve({
            stdout: stdout ?? "",
            stderr: stderr ?? "",
            code: (error as any)?.code ?? 0,
          });
        },
      );
    });
  }

  // ── Init ───────────────────────────────────────────────────────

  /** Check if the repo exists and is a valid git repository. */
  async isRepo(): Promise<boolean> {
    try {
      await access(this.repoPath);
      const result = await this.exec(["rev-parse", "--git-dir"]);
      return result.code === 0;
    } catch {
      return false;
    }
  }

  /** Initialize a new git repository. */
  async init(): Promise<void> {
    // git init creates the directory if it doesn't exist
    await this.execOrThrow(["init", this.repoPath], true);
  }

  // ── Staging & Committing ───────────────────────────────────────

  async addAll(): Promise<void> {
    await this.execOrThrow(["add", "-A"]);
  }

  async commit(message: string): Promise<string> {
    const result = await this.execOrThrow(["commit", "-m", message, "--allow-empty"]);
    // Extract short hash from commit output
    const match = result.stdout.match(/\[[\w-]+ ([a-f0-9]+)\]/);
    return match?.[1] ?? "";
  }

  /** Stage + commit. Returns commit hash. */
  async addAndCommit(message: string): Promise<string> {
    await this.addAll();
    return this.commit(message);
  }

  /** Get git diff --stat for the staged changes (for auto commit messages). */
  async diffStat(): Promise<string> {
    const result = await this.exec(["diff", "--cached", "--stat"]);
    return result.stdout.trim();
  }

  /** Get diff stat between HEAD and working tree. */
  async diffStatUnstaged(): Promise<string> {
    const result = await this.exec(["diff", "--stat"]);
    return result.stdout.trim();
  }

  // ── History ────────────────────────────────────────────────────

  async log(args: string[] = []): Promise<string> {
    const result = await this.exec(["log", ...args]);
    return result.stdout.trim();
  }

  async show(ref: string, path: string): Promise<string> {
    const result = await this.exec(["show", `${ref}:${path}`]);
    if (result.code !== 0) {
      throw new GitMemError(`git show failed: ${result.stderr}`, "GIT_SHOW_FAILED");
    }
    return result.stdout;
  }

  async diff(ref1: string, ref2: string, paths?: string[]): Promise<string> {
    const args = ["diff", ref1, ref2];
    if (paths?.length) {
      args.push("--", ...paths);
    }
    const result = await this.exec(args);
    return result.stdout;
  }

  async grep(query: string, ref?: string): Promise<string> {
    const args = ["grep", "-i", query];
    if (ref) args.push(ref);
    const result = await this.exec(args);
    return result.stdout;
  }

  // ── State ──────────────────────────────────────────────────────

  /** Check if there are uncommitted changes. */
  async hasChanges(): Promise<boolean> {
    const result = await this.exec(["status", "--porcelain"]);
    return result.stdout.trim().length > 0;
  }

  /** Get current HEAD hash (short). */
  async head(): Promise<string> {
    const result = await this.exec(["rev-parse", "--short", "HEAD"]);
    return result.stdout.trim();
  }

  /** Get total commit count. */
  async commitCount(): Promise<number> {
    const result = await this.exec(["rev-list", "--count", "HEAD"]);
    return parseInt(result.stdout.trim(), 10) || 0;
  }

  /** Restore context directory to a specific commit. DESIGN §5.2 step 6b. */
  async checkoutPath(ref: string, path: string): Promise<void> {
    await this.execOrThrow(["checkout", ref, "--", path]);
  }

  // ── Internal ───────────────────────────────────────────────────

  /**
   * Execute and throw on non-zero exit code.
   * @param runFromParent - if true, run from parent dir (for git init)
   */
  private async execOrThrow(args: string[], runFromParent = false): Promise<ExecResult> {
    const result = runFromParent
      ? await new Promise<ExecResult>((resolve, reject) => {
          execFile(
            "git",
            args,
            { cwd: undefined, timeout: 30_000 },
            (error, stdout, stderr) => {
              if (error && !("code" in error)) {
                reject(error);
                return;
              }
              resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code: (error as any)?.code ?? 0 });
            },
          );
        })
      : await this.exec(args);

    if (result.code !== 0) {
      throw new GitMemError(
        `git ${args[0]} failed (code ${result.code}): ${result.stderr}`,
        "GIT_COMMAND_FAILED",
      );
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class GitMemError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
    this.name = "GitMemError";
  }
}
