import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { formatEvalReport, runEvalSuite } from "../src/eval.js";

// B1: this file IS the regression gate. It runs the full offline eval
// suite and fails the build if any task regresses or the deterministic
// metrics drift.
describe("M2.3 eval regression suite", () => {
  it("all eval tasks pass and metrics are deterministic", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "myagent-eval-gate-"));
    const outputRootDir = join(cwd, ".myagent", "evals", "runs");

    const report = await runEvalSuite({
      cwd,
      outputRootDir,
      now: new Date("2026-05-15T00:00:00.000Z")
    });

    // Hard gate: every task must pass.
    expect(report.status).toBe("passed");
    expect(report.totals.passedCount).toBe(report.totals.taskCount);
    expect(report.totals.taskCount).toBe(5);

    // The five tasks we expect, by id + category.
    const byId = new Map(report.tasks.map((t) => [t.taskId, t]));
    expect([...byId.keys()].sort()).toEqual(
      [
        "bash-readonly",
        "plan-mode-blocks-write",
        "read-only-analysis",
        "safe-edit",
        "subagent-explore"
      ].sort()
    );
    expect(byId.get("plan-mode-blocks-write")?.category).toBe("permission");
    expect(byId.get("subagent-explore")?.category).toBe("sub_agent");

    // Deterministic metric pins — these are scripted via FakeModel usage,
    // so any change here means the agent loop's behavior changed, which
    // is exactly what this gate is meant to catch.
    const readOnly = byId.get("read-only-analysis");
    expect(readOnly?.metrics).toMatchObject({
      turns: 2,
      inputTokens: 1800,
      outputTokens: 180,
      cacheCreationInputTokens: 1500,
      cacheReadInputTokens: 1500
    });
    // cost = 1800/1e6*3 + 180/1e6*15 + 1500/1e6*3.75 + 1500/1e6*0.3
    //      = 0.0054 + 0.0027 + 0.005625 + 0.00045 = 0.014175
    expect(readOnly?.metrics.costUsd).toBeCloseTo(0.0142, 4);

    // Totals are a stable fingerprint of the whole suite.
    expect(report.totals.turns).toBe(11);
    expect(report.totals.inputTokens).toBe(8400);
    expect(report.totals.outputTokens).toBe(485);
    expect(report.totals.costUsd).toBeGreaterThan(0);

    // The markdown report file exists and has the summary table.
    const md = readFileSync(report.reportPath, "utf8");
    expect(md).toContain("# Eval Regression Report");
    expect(md).toContain("| **total** |");
    expect(md).toContain("Status: passed");
  });

  it("permission task actually denies the plan-mode Write (no leaked file)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "myagent-eval-perm-"));
    const report = await runEvalSuite({
      cwd,
      outputRootDir: join(cwd, ".myagent", "evals", "runs")
    });
    const perm = report.tasks.find((t) => t.taskId === "plan-mode-blocks-write");
    expect(perm?.passed).toBe(true);
    expect(perm?.notes).toEqual([]);
    // If the Write had leaked, validate() would have produced a note and
    // the task would be failed — the green pass IS the assertion that
    // plan mode held.
  });

  it("formatEvalReport renders a stable human summary", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "myagent-eval-fmt-"));
    const report = await runEvalSuite({
      cwd,
      outputRootDir: join(cwd, ".myagent", "evals", "runs")
    });
    const text = formatEvalReport(report);
    expect(text.startsWith("[eval] passed")).toBe(true);
    expect(text).toContain("totals: tasks=5 passed=5 turns=11");
    expect(text).toContain("read-only-analysis: passed (read_only)");
  });
});
