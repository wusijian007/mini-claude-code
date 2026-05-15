import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  FakeModel,
  collectQuery,
  estimateUsageCostUsd,
  type CostRates,
  type FakeModelStep,
  type LoopEvent,
  type ModelUsage,
  type PermissionMode,
  type TerminalState
} from "@mini-claude-code/core";
import { createProjectToolRegistry } from "@mini-claude-code/tools";

// Fixed reference pricing so the eval's cost column is a deterministic,
// reproducible regression signal regardless of the caller's environment.
// Roughly Sonnet-class rates; the absolute number does not matter, only
// that it never changes between runs unless token counts do.
const EVAL_REFERENCE_RATES: CostRates = {
  inputUsdPerMillionTokens: 3,
  outputUsdPerMillionTokens: 15,
  cacheWriteUsdPerMillionTokens: 3.75,
  cacheReadUsdPerMillionTokens: 0.3
};

export type EvalSuiteOptions = {
  cwd: string;
  outputRootDir?: string;
  now?: Date;
};

export type EvalTaskMetrics = {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  costUsd: number;
};

export type EvalTaskResult = {
  taskId: string;
  title: string;
  category: "read_only" | "safe_edit" | "bash" | "permission" | "sub_agent";
  prompt: string;
  permissionMode: PermissionMode;
  transcriptPath: string;
  terminalState: TerminalState;
  passed: boolean;
  notes: string[];
  metrics: EvalTaskMetrics;
};

export type EvalSuiteReport = {
  runId: string;
  rootDir: string;
  fixtureDir: string;
  status: "passed" | "failed";
  tasks: EvalTaskResult[];
  totals: EvalTaskMetrics & { taskCount: number; passedCount: number };
  reportPath: string;
};

type EvalTask = {
  taskId: string;
  title: string;
  category: EvalTaskResult["category"];
  prompt: string;
  permissionMode: PermissionMode;
  maxTurns?: number;
  script: FakeModelStep[];
  validate(fixtureDir: string, events: readonly LoopEvent[]): Promise<string[]>;
};

export async function runEvalSuite(options: EvalSuiteOptions): Promise<EvalSuiteReport> {
  const now = options.now ?? new Date();
  const runId = `eval_${compactTimestamp(now.toISOString())}`;
  const rootDir = join(options.outputRootDir ?? join(options.cwd, ".myagent", "evals", "runs"), runId);
  const fixtureDir = join(rootDir, "fixture-project");
  const transcriptDir = join(rootDir, "transcripts");

  await writeEvalFixture(fixtureDir);
  await mkdir(transcriptDir, { recursive: true });

  const tasks: EvalTaskResult[] = [];
  for (const task of createEvalTasks()) {
    const toolRegistry = createProjectToolRegistry();
    const events = await collectQuery({
      model: new FakeModel(task.script),
      initialMessages: [{ role: "user", content: task.prompt }],
      tools: toolRegistry,
      toolContext: { cwd: fixtureDir },
      permissionMode: task.permissionMode,
      maxTurns: task.maxTurns ?? 8
    });

    const terminalState = finalTerminalState(events);
    const notes = [
      ...terminalNotes(terminalState),
      ...toolResultNotes(events, task),
      ...(await task.validate(fixtureDir, events))
    ];
    const passed = terminalState.status === "completed" && notes.length === 0;
    const metrics = computeMetrics(events);
    const transcriptPath = join(transcriptDir, `${task.taskId}.json`);
    const result: EvalTaskResult = {
      taskId: task.taskId,
      title: task.title,
      category: task.category,
      prompt: task.prompt,
      permissionMode: task.permissionMode,
      transcriptPath,
      terminalState,
      passed,
      notes,
      metrics
    };
    await writeFile(transcriptPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    tasks.push(result);
  }

  const totals = tasks.reduce(
    (acc, t) => ({
      taskCount: acc.taskCount + 1,
      passedCount: acc.passedCount + (t.passed ? 1 : 0),
      turns: acc.turns + t.metrics.turns,
      inputTokens: acc.inputTokens + t.metrics.inputTokens,
      outputTokens: acc.outputTokens + t.metrics.outputTokens,
      cacheCreationInputTokens: acc.cacheCreationInputTokens + t.metrics.cacheCreationInputTokens,
      cacheReadInputTokens: acc.cacheReadInputTokens + t.metrics.cacheReadInputTokens,
      costUsd: acc.costUsd + t.metrics.costUsd
    }),
    {
      taskCount: 0,
      passedCount: 0,
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      costUsd: 0
    }
  );

  const reportPath = join(rootDir, "REPORT.md");
  const report: EvalSuiteReport = {
    runId,
    rootDir,
    fixtureDir,
    status: tasks.every((t) => t.passed) ? "passed" : "failed",
    tasks,
    totals,
    reportPath
  };
  await writeFile(reportPath, renderEvalMarkdown(report), "utf8");
  return report;
}

export function formatEvalReport(report: EvalSuiteReport): string {
  const lines = [
    `[eval] ${report.status}`,
    `run: ${report.rootDir}`,
    `fixture: ${report.fixtureDir}`,
    "tasks:"
  ];
  for (const t of report.tasks) {
    const m = t.metrics;
    lines.push(
      `- ${t.taskId}: ${t.passed ? "passed" : "failed"} (${t.category}) ` +
        `turns=${m.turns} in=${m.inputTokens} out=${m.outputTokens} ` +
        `cache_w=${m.cacheCreationInputTokens} cache_r=${m.cacheReadInputTokens} ` +
        `cost=$${m.costUsd.toFixed(4)} -> ${t.transcriptPath}`
    );
    if (!t.passed && t.notes.length > 0) {
      lines.push(`  notes: ${t.notes.join("; ")}`);
    }
  }
  const tot = report.totals;
  lines.push(
    `totals: tasks=${tot.taskCount} passed=${tot.passedCount} turns=${tot.turns} ` +
      `in=${tot.inputTokens} out=${tot.outputTokens} ` +
      `cache_w=${tot.cacheCreationInputTokens} cache_r=${tot.cacheReadInputTokens} ` +
      `cost=$${tot.costUsd.toFixed(4)}`
  );
  lines.push(`report: ${report.reportPath}`);
  return `${lines.join("\n")}\n`;
}

function computeMetrics(events: readonly LoopEvent[]): EvalTaskMetrics {
  let turns = 0;
  const summed: ModelUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0
  };
  for (const event of events) {
    if (event.type !== "assistant_message") {
      continue;
    }
    turns += 1;
    const u = event.usage;
    if (u) {
      summed.inputTokens = (summed.inputTokens ?? 0) + (u.inputTokens ?? 0);
      summed.outputTokens = (summed.outputTokens ?? 0) + (u.outputTokens ?? 0);
      summed.cacheCreationInputTokens =
        (summed.cacheCreationInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0);
      summed.cacheReadInputTokens =
        (summed.cacheReadInputTokens ?? 0) + (u.cacheReadInputTokens ?? 0);
    }
  }
  return {
    turns,
    inputTokens: summed.inputTokens ?? 0,
    outputTokens: summed.outputTokens ?? 0,
    cacheCreationInputTokens: summed.cacheCreationInputTokens ?? 0,
    cacheReadInputTokens: summed.cacheReadInputTokens ?? 0,
    costUsd: estimateUsageCostUsd(summed, EVAL_REFERENCE_RATES)
  };
}

function usage(
  inputTokens: number,
  outputTokens: number,
  cacheCreationInputTokens = 0,
  cacheReadInputTokens = 0
): ModelUsage {
  return { inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens };
}

function createEvalTasks(): EvalTask[] {
  return [
    {
      taskId: "read-only-analysis",
      title: "Read-only project analysis (Glob + Read in plan mode)",
      category: "read_only",
      prompt: "Summarize the fixture project and its math helper.",
      permissionMode: "plan",
      script: [
        {
          type: "assistant_message",
          content: "I will inspect the fixture without modifying anything.",
          usage: usage(1500, 60, 1500, 0)
        },
        { type: "tool_use", toolUse: { id: "ev_glob", name: "Glob", input: { pattern: "**/*" } } },
        { type: "tool_use", toolUse: { id: "ev_read", name: "Read", input: { path: "README.md" } } },
        { type: "turn_break" },
        {
          type: "assistant_message",
          content: "The fixture has README.md and src/math.ts (an add helper).",
          usage: usage(300, 120, 0, 1500)
        }
      ],
      async validate(_fixtureDir, events) {
        const names = toolUseNames(events);
        return names.includes("Glob") && names.includes("Read")
          ? []
          : ["read-only analysis did not exercise both Glob and Read"];
      }
    },
    {
      taskId: "safe-edit",
      title: "Read-before-write safe edit (bypassPermissions)",
      category: "safe_edit",
      prompt: "Fix the add helper in src/math.ts so it actually adds.",
      permissionMode: "bypassPermissions",
      script: [
        {
          type: "assistant_message",
          content: "I will read the file before editing it.",
          usage: usage(1600, 40, 1600, 0)
        },
        { type: "tool_use", toolUse: { id: "ev_read_math", name: "Read", input: { path: "src/math.ts" } } },
        { type: "turn_break" },
        {
          type: "assistant_message",
          content: "It subtracts; I'll make a minimal one-line edit.",
          usage: usage(400, 50, 0, 1600)
        },
        {
          type: "tool_use",
          toolUse: {
            id: "ev_edit_math",
            name: "Edit",
            input: { path: "src/math.ts", oldString: "return a - b;", newString: "return a + b;" }
          }
        },
        { type: "turn_break" },
        {
          type: "assistant_message",
          content: "The add helper now returns a + b.",
          usage: usage(450, 30, 0, 1600)
        }
      ],
      async validate(fixtureDir, _events) {
        const content = await readFile(join(fixtureDir, "src", "math.ts"), "utf8");
        return content.includes("return a + b;")
          ? []
          : ["safe-edit did not produce the corrected add helper"];
      }
    },
    {
      taskId: "bash-readonly",
      title: "Read-only Bash whitelist (pwd) in plan mode",
      category: "bash",
      prompt: "Show the working directory.",
      permissionMode: "plan",
      script: [
        {
          type: "assistant_message",
          content: "Running pwd, a whitelisted read-only command.",
          usage: usage(900, 30, 0, 0)
        },
        { type: "tool_use", toolUse: { id: "ev_bash_pwd", name: "Bash", input: { command: "pwd" } } },
        { type: "turn_break" },
        {
          type: "assistant_message",
          content: "Reported the working directory.",
          usage: usage(150, 20, 0, 0)
        }
      ],
      async validate(_fixtureDir, events) {
        const ok = events.some(
          (e) => e.type === "tool_result" && e.result.status === "success"
        );
        return ok ? [] : ["bash pwd did not succeed"];
      }
    },
    {
      taskId: "plan-mode-blocks-write",
      title: "Permission enforcement: Write denied in plan mode",
      category: "permission",
      prompt: "Try to create a file (should be blocked in plan mode).",
      permissionMode: "plan",
      script: [
        {
          type: "assistant_message",
          content: "Attempting a Write; plan mode should block it.",
          usage: usage(800, 25, 0, 0)
        },
        {
          type: "tool_use",
          toolUse: {
            id: "ev_write_blocked",
            name: "Write",
            input: { path: "should-not-exist.txt", content: "nope" }
          }
        },
        { type: "turn_break" },
        {
          type: "assistant_message",
          content: "As expected, the write was denied by the plan-mode policy.",
          usage: usage(200, 30, 0, 0)
        }
      ],
      async validate(fixtureDir, events) {
        const denied = events.some(
          (e) => e.type === "tool_result" && e.result.status === "error"
        );
        if (!denied) {
          return ["plan-mode Write was NOT denied (permission regression!)"];
        }
        const leaked = await readFile(join(fixtureDir, "should-not-exist.txt"), "utf8")
          .then(() => true)
          .catch(() => false);
        return leaked ? ["plan-mode Write leaked a file to disk"] : [];
      }
    },
    {
      taskId: "subagent-explore",
      title: "Explore sub-agent runs through the same query loop",
      category: "sub_agent",
      prompt: "Delegate a read-only exploration of the math helper.",
      permissionMode: "plan",
      script: [
        {
          type: "assistant_message",
          content: "Delegating to a read-only explore sub-agent.",
          usage: usage(1800, 40, 1800, 0)
        },
        {
          type: "tool_use",
          toolUse: {
            id: "ev_agent",
            name: "Agent",
            input: {
              description: "explore math helper",
              prompt: "Read src/math.ts and report what add does",
              subagent_type: "explore"
            }
          }
        },
        { type: "turn_break" },
        {
          type: "tool_use",
          toolUse: { id: "ev_child_read", name: "Read", input: { path: "src/math.ts" } }
        },
        { type: "turn_break" },
        {
          type: "assistant_message",
          content: "src/math.ts defines an add helper.",
          usage: usage(250, 60, 0, 1800)
        },
        { type: "turn_break" },
        {
          type: "assistant_message",
          content: "The sub-agent confirmed src/math.ts has an add helper.",
          usage: usage(300, 40, 0, 1800)
        }
      ],
      async validate(_fixtureDir, events) {
        const ranAgent = events.some(
          (e) =>
            e.type === "tool_result" &&
            e.result.toolUseId === "ev_agent" &&
            e.result.status === "success"
        );
        return ranAgent ? [] : ["explore sub-agent did not complete successfully"];
      }
    }
  ];
}

async function writeEvalFixture(fixtureDir: string): Promise<void> {
  await mkdir(join(fixtureDir, "src"), { recursive: true });
  await writeFile(
    join(fixtureDir, "README.md"),
    ["# Eval fixture", "", "A tiny project used by the offline eval regression suite.", ""].join("\n"),
    "utf8"
  );
  await writeFile(
    join(fixtureDir, "src", "math.ts"),
    ["export function add(a: number, b: number): number {", "  return a - b;", "}", ""].join("\n"),
    "utf8"
  );
}

function finalTerminalState(events: readonly LoopEvent[]): TerminalState {
  const terminal = [...events].reverse().find((event) => event.type === "terminal_state");
  return terminal?.type === "terminal_state"
    ? terminal.state
    : { status: "error", error: "query ended without terminal_state" };
}

function terminalNotes(state: TerminalState): string[] {
  if (state.status === "completed") {
    return [];
  }
  return [
    `terminal_state=${state.status}${state.reason ? ` reason=${state.reason}` : ""}${
      state.error ? ` error=${state.error}` : ""
    }`
  ];
}

function toolUseNames(events: readonly LoopEvent[]): string[] {
  return events
    .filter((event) => event.type === "tool_use")
    .map((event) => event.toolUse.name);
}

function toolResultNotes(events: readonly LoopEvent[], task: EvalTask): string[] {
  // The permission task expects a tool_result error (the denied Write),
  // so its validate() owns the semantics -- don't flag errors here.
  if (task.category === "permission") {
    return [];
  }
  const notes: string[] = [];
  for (const event of events) {
    if (event.type === "tool_result" && event.result.status === "error") {
      notes.push(
        `tool_result error for ${event.result.toolUseId}: ${event.result.error ?? "unknown error"}`
      );
    }
  }
  return notes;
}

function renderEvalMarkdown(report: EvalSuiteReport): string {
  const lines = [
    "# Eval Regression Report",
    "",
    `Run: ${report.runId}`,
    `Status: ${report.status}`,
    `Fixture: ${report.fixtureDir}`,
    "",
    "| Task | Category | Result | Turns | In | Out | Cache W | Cache R | Cost |",
    "|---|---|---|--:|--:|--:|--:|--:|--:|"
  ];
  for (const t of report.tasks) {
    const m = t.metrics;
    lines.push(
      `| ${t.taskId} | ${t.category} | ${t.passed ? "pass" : "FAIL"} | ${m.turns} | ${m.inputTokens} | ${m.outputTokens} | ${m.cacheCreationInputTokens} | ${m.cacheReadInputTokens} | $${m.costUsd.toFixed(4)} |`
    );
  }
  const tot = report.totals;
  lines.push(
    `| **total** | (${tot.taskCount} tasks) | ${tot.passedCount}/${tot.taskCount} | ${tot.turns} | ${tot.inputTokens} | ${tot.outputTokens} | ${tot.cacheCreationInputTokens} | ${tot.cacheReadInputTokens} | $${tot.costUsd.toFixed(4)} |`
  );
  lines.push("");
  const failed = report.tasks.filter((t) => !t.passed);
  if (failed.length > 0) {
    lines.push("## Failures", "");
    for (const t of failed) {
      lines.push(`- **${t.taskId}**: ${t.notes.join("; ") || t.terminalState.status}`);
    }
    lines.push("");
  }
  lines.push(
    "## Notes",
    "",
    "Offline, deterministic. Token counts are scripted via FakeModel so the",
    "cost column is a stable regression signal -- a diff in tokens/turns means",
    "the agent loop's behavior changed, not the model's."
  );
  return `${lines.join("\n")}\n`;
}

function compactTimestamp(iso: string): string {
  return iso.replace(/[-:.TZ]/g, "").slice(0, 14);
}
