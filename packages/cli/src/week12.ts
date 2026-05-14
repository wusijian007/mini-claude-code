import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  FakeModel,
  assistantText,
  collectQuery,
  type FakeModelStep,
  type LoopEvent,
  type PermissionMode,
  type TerminalState,
  type ToolDefinition
} from "@mini-claude-code/core";
import { createProjectToolRegistry } from "@mini-claude-code/tools";

export type Week12AuditOptions = {
  cwd: string;
  outputRootDir?: string;
  now?: Date;
};

export type Week12AuditTaskTranscript = {
  taskId: string;
  title: string;
  category: "read_only_analysis" | "small_edit" | "run_check";
  prompt: string;
  permissionMode: PermissionMode;
  transcriptPath: string;
  terminalState: TerminalState;
  passed: boolean;
  notes: string[];
  events: LoopEvent[];
};

export type Week12BacklogItem = {
  severity: "must_fix" | "later" | "wont_do";
  title: string;
  detail: string;
  sourceTaskId?: string;
};

export type Week12AuditReport = {
  runId: string;
  rootDir: string;
  fixtureDir: string;
  status: "passed" | "failed";
  transcripts: Week12AuditTaskTranscript[];
  backlogItems: Week12BacklogItem[];
  backlogPath: string;
  retrospectivePath: string;
};

type Week12AuditTask = {
  taskId: string;
  title: string;
  category: Week12AuditTaskTranscript["category"];
  prompt: string;
  permissionMode: PermissionMode;
  script: FakeModelStep[];
  validate(fixtureDir: string, events: readonly LoopEvent[]): Promise<string[]>;
};

export async function runWeek12Audit(options: Week12AuditOptions): Promise<Week12AuditReport> {
  const now = options.now ?? new Date();
  const runId = `week12_${compactTimestamp(now.toISOString())}`;
  const rootDir = join(options.outputRootDir ?? join(options.cwd, ".myagent", "week12", "runs"), runId);
  const fixtureDir = join(rootDir, "fixture-project");
  const transcriptDir = join(rootDir, "transcripts");

  await writeWeek12Fixture(fixtureDir);
  await mkdir(transcriptDir, { recursive: true });

  const transcripts: Week12AuditTaskTranscript[] = [];
  const backlogItems: Week12BacklogItem[] = [];

  for (const task of createWeek12AuditTasks()) {
    const tools = createProjectToolRegistry();
    const events = await collectQuery({
      model: new FakeModel(task.script),
      initialMessages: [{ role: "user", content: task.prompt }],
      tools,
      toolContext: {
        cwd: fixtureDir
      },
      permissionMode: task.permissionMode,
      maxTurns: 6
    });
    const terminalState = finalTerminalState(events);
    const notes = [
      ...terminalNotes(terminalState),
      ...toolResultNotes(events),
      ...(await task.validate(fixtureDir, events))
    ];
    const passed = terminalState.status === "completed" && notes.length === 0;
    const transcriptPath = join(transcriptDir, `${task.taskId}.json`);
    const transcript: Week12AuditTaskTranscript = {
      taskId: task.taskId,
      title: task.title,
      category: task.category,
      prompt: task.prompt,
      permissionMode: task.permissionMode,
      transcriptPath,
      terminalState,
      passed,
      notes,
      events
    };

    await writeFile(transcriptPath, `${JSON.stringify(transcript, null, 2)}\n`, "utf8");
    transcripts.push(transcript);

    if (!passed) {
      backlogItems.push({
        severity: "must_fix",
        title: `${task.title} failed`,
        detail: notes.length > 0 ? notes.join("; ") : `terminal_state=${terminalState.status}`,
        sourceTaskId: task.taskId
      });
    }
  }

  backlogItems.push(
    {
      severity: "later",
      title: "Add a real-model replay mode for Week 12 audits",
      detail:
        "The audit is deterministic and offline today. A later manual mode can replay the same low-risk prompts against a real provider after API cost controls are visible."
    },
    {
      severity: "later",
      title: "Promote run-check smoke to a real task runner after Week 13",
      detail:
        "Week 12 can verify read-only check output through Bash. A background task runner belongs to the Week 13 task state machine."
    },
    {
      severity: "wont_do",
      title: "Do not start sub-agent or fork-cache work in Week 12",
      detail:
        "The goal of this week is stabilizing the single-agent experience before entering Phase C."
    }
  );

  const backlogPath = join(rootDir, "BACKLOG.md");
  const retrospectivePath = join(rootDir, "RETROSPECTIVE.md");
  const report: Week12AuditReport = {
    runId,
    rootDir,
    fixtureDir,
    status: transcripts.every((transcript) => transcript.passed) ? "passed" : "failed",
    transcripts,
    backlogItems,
    backlogPath,
    retrospectivePath
  };

  await writeFile(backlogPath, renderWeek12Backlog(report), "utf8");
  await writeFile(retrospectivePath, renderWeek12Retrospective(report), "utf8");

  return report;
}

export function formatWeek12AuditReport(report: Week12AuditReport): string {
  const lines = [
    `[week12] audit ${report.status}`,
    `run: ${report.rootDir}`,
    `fixture: ${report.fixtureDir}`,
    "transcripts:"
  ];

  for (const transcript of report.transcripts) {
    lines.push(
      `- ${transcript.taskId}: ${transcript.passed ? "passed" : "failed"} (${transcript.category}) -> ${transcript.transcriptPath}`
    );
  }

  lines.push(`backlog: ${report.backlogPath}`);
  lines.push(`retrospective: ${report.retrospectivePath}`);
  return `${lines.join("\n")}\n`;
}

function createWeek12AuditTasks(): Week12AuditTask[] {
  return [
    {
      taskId: "read-only-analysis",
      title: "Read-only project analysis",
      category: "read_only_analysis",
      prompt: "Summarize the fixture project structure and the math helper.",
      permissionMode: "plan",
      script: [
        {
          type: "assistant_message",
          content: "I will inspect the fixture without changing files."
        },
        {
          type: "tool_use",
          toolUse: {
            id: "toolu_week12_glob",
            name: "Glob",
            input: { pattern: "**/*" }
          }
        },
        {
          type: "tool_use",
          toolUse: {
            id: "toolu_week12_read_readme",
            name: "Read",
            input: { path: "README.md" }
          }
        },
        { type: "turn_break" },
        {
          type: "assistant_message",
          content: "The fixture contains README.md, src/math.ts, and a check-output.txt smoke result."
        }
      ],
      async validate(_fixtureDir, events) {
        const toolNames = toolUseNames(events);
        return toolNames.includes("Glob") && toolNames.includes("Read")
          ? []
          : ["read-only analysis did not exercise both Glob and Read"];
      }
    },
    {
      taskId: "small-edit",
      title: "Small safe edit",
      category: "small_edit",
      prompt: "Fix the add helper in src/math.ts.",
      permissionMode: "bypassPermissions",
      script: [
        {
          type: "assistant_message",
          content: "I will read the file before editing it."
        },
        {
          type: "tool_use",
          toolUse: {
            id: "toolu_week12_read_math",
            name: "Read",
            input: { path: "src/math.ts" }
          }
        },
        { type: "turn_break" },
        {
          type: "assistant_message",
          content: "The helper subtracts instead of adding. I will make a minimal edit."
        },
        {
          type: "tool_use",
          toolUse: {
            id: "toolu_week12_edit_math",
            name: "Edit",
            input: {
              path: "src/math.ts",
              oldString: "return a - b;",
              newString: "return a + b;"
            }
          }
        },
        { type: "turn_break" },
        {
          type: "assistant_message",
          content: "Fixed src/math.ts with a prior Read and a diff-producing Edit."
        }
      ],
      async validate(fixtureDir, events) {
        const content = await readFile(join(fixtureDir, "src", "math.ts"), "utf8");
        const toolNames = toolUseNames(events);
        const notes: string[] = [];
        if (!content.includes("return a + b;")) {
          notes.push("src/math.ts was not fixed");
        }
        if (!toolNames.includes("Read") || !toolNames.includes("Edit")) {
          notes.push("small edit did not exercise Read before Edit");
        }
        return notes;
      }
    },
    {
      taskId: "run-check",
      title: "Read-only check run",
      category: "run_check",
      prompt: "Run the fixture smoke check and report whether it passed.",
      permissionMode: "plan",
      script: [
        {
          type: "assistant_message",
          content: "I will inspect the smoke check output with read-only Bash."
        },
        {
          type: "tool_use",
          toolUse: {
            id: "toolu_week12_bash_check",
            name: "Bash",
            input: { command: "cat check-output.txt" }
          }
        },
        { type: "turn_break" },
        {
          type: "assistant_message",
          content: "The fixture smoke check passed: PASS week12 smoke."
        }
      ],
      async validate(_fixtureDir, events) {
        const text = events
          .filter((event) => event.type === "assistant_message")
          .map((event) => assistantText(event.message))
          .join("\n");
        return text.includes("PASS week12 smoke") ? [] : ["check result was not reported as PASS"];
      }
    }
  ];
}

async function writeWeek12Fixture(fixtureDir: string): Promise<void> {
  await mkdir(join(fixtureDir, "src"), { recursive: true });
  await writeFile(
    join(fixtureDir, "README.md"),
    ["# Week 12 fixture", "", "A tiny project used to audit the single-agent experience.", ""].join("\n"),
    "utf8"
  );
  await writeFile(
    join(fixtureDir, "src", "math.ts"),
    [
      "export function add(a: number, b: number): number {",
      "  return a - b;",
      "}",
      ""
    ].join("\n"),
    "utf8"
  );
  await writeFile(join(fixtureDir, "check-output.txt"), "PASS week12 smoke\n", "utf8");
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
  return [`terminal_state=${state.status}${state.reason ? ` reason=${state.reason}` : ""}${state.error ? ` error=${state.error}` : ""}`];
}

function toolUseNames(events: readonly LoopEvent[]): string[] {
  return events
    .filter((event) => event.type === "tool_use")
    .map((event) => event.toolUse.name);
}

function toolResultNotes(events: readonly LoopEvent[]): string[] {
  const notes: string[] = [];
  for (const event of events) {
    if (event.type === "tool_result" && event.result.status === "error") {
      notes.push(`tool_result error for ${event.result.toolUseId}: ${event.result.error ?? "unknown error"}`);
    }
  }
  return notes;
}

function renderWeek12Backlog(report: Week12AuditReport): string {
  const lines = [
    "# Week 12 Backlog",
    "",
    `Run: ${report.runId}`,
    `Status: ${report.status}`,
    ""
  ];

  for (const severity of ["must_fix", "later", "wont_do"] as const) {
    lines.push(`## ${severity}`);
    const items = report.backlogItems.filter((item) => item.severity === severity);
    if (items.length === 0) {
      lines.push("- _none from this run_");
    } else {
      for (const item of items) {
        const source = item.sourceTaskId ? ` (${item.sourceTaskId})` : "";
        lines.push(`- ${item.title}${source}: ${item.detail}`);
      }
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function renderWeek12Retrospective(report: Week12AuditReport): string {
  const lines = [
    "# Week 12 Retrospective",
    "",
    "Goal: pause feature growth and verify the single-agent experience across analysis, a small controlled edit, and a read-only check.",
    "",
    "## Tasks"
  ];

  for (const transcript of report.transcripts) {
    lines.push(
      `- ${transcript.title}: ${transcript.passed ? "passed" : "failed"}; transcript ${transcript.transcriptPath}`
    );
  }

  lines.push(
    "",
    "## Findings",
    "- The agent can complete read-only analysis through Glob and Read without leaving plan mode.",
    "- Small edits still rely on the intended Read -> Edit safety path and produce a transcript.",
    "- Check-like workflows are usable through read-only Bash, while real background task orchestration remains a Week 13 concern.",
    "",
    "## Week 12 Boundary",
    "- No sub-agent, fork cache, remote control, or background task state machine work was started."
  );

  return `${lines.join("\n")}\n`;
}

function compactTimestamp(iso: string): string {
  return iso.replace(/[-:.TZ]/g, "").slice(0, 14);
}
