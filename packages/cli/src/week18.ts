import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  FakeModel,
  assistantText,
  collectQuery,
  createMemoryStore,
  createProfileRecorder,
  createProfileStore,
  estimateUsageCostUsd,
  loadHookSnapshot,
  type FakeModelStep,
  type LoopEvent,
  type PermissionMode,
  type ProfileRun,
  type TerminalState,
  type ToolDefinition
} from "@mini-claude-code/core";
import {
  createProjectToolRegistry,
  createProjectToolRegistryWithMcp
} from "@mini-claude-code/tools";

export type Week18FinalOptions = {
  cwd: string;
  outputRootDir?: string;
  now?: Date;
};

export type Week18SmokeTranscript = {
  taskId: string;
  title: string;
  category: "read_only" | "small_edit" | "memory" | "hook" | "mcp" | "sub_agent";
  prompt: string;
  permissionMode: PermissionMode;
  transcriptPath: string;
  terminalState: TerminalState;
  passed: boolean;
  notes: string[];
  events: LoopEvent[];
};

export type Week18BacklogItem = {
  bucket: "v1.1" | "v2" | "wont_do";
  title: string;
  detail: string;
};

export type Week18FinalReport = {
  runId: string;
  rootDir: string;
  fixtureDir: string;
  status: "passed" | "failed";
  smoke: Week18SmokeTranscript[];
  profile: ProfileRun;
  profilePath: string;
  readmePath: string;
  architecturePath: string;
  finalReviewPath: string;
  backlogPath: string;
  backlogItems: Week18BacklogItem[];
};

type Week18SmokeTask = {
  taskId: string;
  title: string;
  category: Week18SmokeTranscript["category"];
  prompt: string;
  permissionMode: PermissionMode;
  script: FakeModelStep[];
  tools?(fixtureDir: string): Promise<ToolDefinition[]> | ToolDefinition[];
  before?(fixtureDir: string): Promise<void>;
  system?(fixtureDir: string): Promise<string> | string;
  allowToolErrors?: boolean;
  validate(fixtureDir: string, events: readonly LoopEvent[]): Promise<string[]> | string[];
};

export async function runWeek18Final(options: Week18FinalOptions): Promise<Week18FinalReport> {
  const now = options.now ?? new Date();
  const runId = `week18_${compactTimestamp(now.toISOString())}`;
  const rootDir = join(options.outputRootDir ?? join(options.cwd, ".myagent", "week18", "runs"), runId);
  const fixtureDir = join(rootDir, "fixture-project");
  const transcriptDir = join(rootDir, "transcripts");
  const profile = createProfileRecorder({ runId: `${runId}_profile` });

  await writeWeek18Fixture(fixtureDir);
  await mkdir(transcriptDir, { recursive: true });

  const smoke: Week18SmokeTranscript[] = [];
  for (const task of createWeek18SmokeTasks()) {
    await task.before?.(fixtureDir);
    const tools = await (task.tools?.(fixtureDir) ?? createProjectToolRegistry());
    const hookSnapshot = task.category === "hook" ? await loadHookSnapshot(fixtureDir) : undefined;
    const system = await task.system?.(fixtureDir);
    const events = await profile.time(`smoke.${task.taskId}`, () =>
      collectQuery({
        model: new FakeModel(task.script),
        initialMessages: [{ role: "user", content: task.prompt }],
        tools,
        toolContext: {
          cwd: fixtureDir,
          hookSnapshot,
          profile
        },
        permissionMode: task.permissionMode,
        system,
        maxTurns: 8,
        profile
      })
    );
    const terminalState = finalTerminalState(events);
    const notes = [
      ...terminalNotes(terminalState),
      ...(task.allowToolErrors ? [] : toolResultNotes(events)),
      ...(await task.validate(fixtureDir, events))
    ];
    const passed = terminalState.status === "completed" && notes.length === 0;
    const transcriptPath = join(transcriptDir, `${task.taskId}.json`);
    const transcript: Week18SmokeTranscript = {
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
    smoke.push(transcript);
  }

  profile.addMetric("week18.smoke_total", smoke.length, "count");
  profile.addMetric("week18.smoke_passed", smoke.filter((task) => task.passed).length, "count");
  profile.addMetric(
    "week18.cost_estimate_sample_usd",
    estimateUsageCostUsd({ inputTokens: 1_000, outputTokens: 500 }, { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 5 }),
    "usd",
    { estimated: true }
  );
  const profileRun = profile.finish(smoke.every((task) => task.passed) ? "completed" : "failed");
  const profilePath = await createProfileStore(options.cwd, join(rootDir, "profiles")).save(profileRun);

  const backlogItems = createWeek18BacklogItems();
  const readmePath = join(rootDir, "README.md");
  const architecturePath = join(rootDir, "ARCHITECTURE.md");
  const finalReviewPath = join(rootDir, "FINAL_REVIEW.md");
  const backlogPath = join(rootDir, "BACKLOG.md");
  const report: Week18FinalReport = {
    runId,
    rootDir,
    fixtureDir,
    status: smoke.every((task) => task.passed) ? "passed" : "failed",
    smoke,
    profile: profileRun,
    profilePath,
    readmePath,
    architecturePath,
    finalReviewPath,
    backlogPath,
    backlogItems
  };

  await writeFile(readmePath, renderWeek18Readme(report), "utf8");
  await writeFile(architecturePath, renderWeek18Architecture(), "utf8");
  await writeFile(finalReviewPath, renderWeek18FinalReview(report), "utf8");
  await writeFile(backlogPath, renderWeek18Backlog(backlogItems), "utf8");
  return report;
}

export function formatWeek18FinalReport(report: Week18FinalReport): string {
  const lines = [
    `[week18] final ${report.status}`,
    `run: ${report.rootDir}`,
    `fixture: ${report.fixtureDir}`,
    "smoke:"
  ];

  for (const task of report.smoke) {
    lines.push(`- ${task.taskId}: ${task.passed ? "passed" : "failed"} (${task.category}) -> ${task.transcriptPath}`);
  }

  lines.push(`profile: ${report.profilePath}`);
  lines.push(`readme: ${report.readmePath}`);
  lines.push(`architecture: ${report.architecturePath}`);
  lines.push(`final_review: ${report.finalReviewPath}`);
  lines.push(`backlog: ${report.backlogPath}`);
  return `${lines.join("\n")}\n`;
}

function createWeek18SmokeTasks(): Week18SmokeTask[] {
  return [
    {
      taskId: "read-only-analysis",
      title: "Read-only analysis",
      category: "read_only",
      prompt: "Inspect the fixture project without changing files.",
      permissionMode: "plan",
      script: [
        { type: "assistant_message", content: "I will inspect the project safely." },
        { type: "tool_use", toolUse: { id: "toolu_w18_glob", name: "Glob", input: { pattern: "**/*" } } },
        { type: "tool_use", toolUse: { id: "toolu_w18_read", name: "Read", input: { path: "README.md" } } },
        { type: "turn_break" },
        { type: "assistant_message", content: "The fixture has README.md, src/math.ts, and smoke files." }
      ],
      validate(_fixtureDir, events) {
        const names = toolUseNames(events);
        return names.includes("Glob") && names.includes("Read") ? [] : ["read-only smoke did not use Glob and Read"];
      }
    },
    {
      taskId: "small-edit",
      title: "Small controlled edit",
      category: "small_edit",
      prompt: "Fix src/math.ts with a minimal edit.",
      permissionMode: "bypassPermissions",
      script: [
        { type: "assistant_message", content: "I will read before editing." },
        { type: "tool_use", toolUse: { id: "toolu_w18_read_math", name: "Read", input: { path: "src/math.ts" } } },
        { type: "turn_break" },
        { type: "assistant_message", content: "I will replace the subtraction bug." },
        {
          type: "tool_use",
          toolUse: {
            id: "toolu_w18_edit_math",
            name: "Edit",
            input: { path: "src/math.ts", oldString: "return a - b;", newString: "return a + b;" }
          }
        },
        { type: "turn_break" },
        { type: "assistant_message", content: "Fixed the math helper." }
      ],
      async validate(fixtureDir, events) {
        const notes: string[] = [];
        if (!(await readFile(join(fixtureDir, "src", "math.ts"), "utf8")).includes("return a + b;")) {
          notes.push("src/math.ts was not fixed");
        }
        if (!toolUseNames(events).includes("Edit")) {
          notes.push("Edit tool was not exercised");
        }
        return notes;
      }
    },
    {
      taskId: "memory",
      title: "Memory recall",
      category: "memory",
      prompt: "Use recalled project preference.",
      permissionMode: "plan",
      script: [
        { type: "assistant_message", content: "I will follow the remembered preference: prefer deterministic fixtures." }
      ],
      async before(fixtureDir) {
        await createMemoryStore(fixtureDir).save({
          taxonomy: "project",
          content: "Prefer deterministic fixtures in smoke tests."
        });
      },
      async system(fixtureDir) {
        return createMemoryStore(fixtureDir).formatContext("deterministic fixtures");
      },
      validate(_fixtureDir, events) {
        return assistantTextFromEvents(events).includes("deterministic fixtures")
          ? []
          : ["memory preference was not visible in assistant output"];
      }
    },
    {
      taskId: "hook",
      title: "Hook block",
      category: "hook",
      prompt: "Try a blocked write so the hook chain is verified.",
      permissionMode: "bypassPermissions",
      script: [
        { type: "assistant_message", content: "I will attempt the write and expect hooks to guard it." },
        { type: "tool_use", toolUse: { id: "toolu_w18_write_blocked", name: "Write", input: { path: "blocked.txt", content: "blocked\n" } } },
        { type: "turn_break" },
        { type: "assistant_message", content: "The hook blocked the write as expected." }
      ],
      async before(fixtureDir) {
        await writeBlockingHook(fixtureDir);
      },
      allowToolErrors: true,
      validate(_fixtureDir, events) {
        return toolResultNotes(events).some((note) => note.includes("Blocked by PreToolUse hook"))
          ? []
          : ["hook smoke did not observe a blocking hook"];
      }
    },
    {
      taskId: "mcp",
      title: "MCP fail-closed load",
      category: "mcp",
      prompt: "List available tools after loading an invalid MCP server.",
      permissionMode: "plan",
      script: [
        { type: "assistant_message", content: "I can still use built-in tools after MCP load failure." },
        { type: "tool_use", toolUse: { id: "toolu_w18_mcp_read", name: "Read", input: { path: "README.md" } } },
        { type: "turn_break" },
        { type: "assistant_message", content: "Built-in tools remained available and MCP failed closed." }
      ],
      async before(fixtureDir) {
        await mkdir(join(fixtureDir, ".myagent"), { recursive: true });
        await writeFile(
          join(fixtureDir, ".myagent", "mcp.json"),
          JSON.stringify({ servers: { broken: { command: "definitely-not-a-real-mcp-server" } } }, null, 2),
          "utf8"
        );
      },
      tools(fixtureDir) {
        return createProjectToolRegistryWithMcp(fixtureDir);
      },
      validate(_fixtureDir, events) {
        return toolUseNames(events).includes("Read") ? [] : ["built-in Read was not available after MCP load"];
      }
    },
    {
      taskId: "sub-agent",
      title: "Sub-agent delegation",
      category: "sub_agent",
      prompt: "Delegate a read-only exploration task.",
      permissionMode: "default",
      script: [
        { type: "assistant_message", content: "I will delegate exploration." },
        {
          type: "tool_use",
          toolUse: {
            id: "toolu_w18_agent",
            name: "Agent",
            input: {
              description: "Explore fixture",
              prompt: "Summarize README.md only.",
              subagent_type: "explore"
            }
          }
        },
        { type: "turn_break" },
        { type: "assistant_message", content: "Child agent inspected README.md safely." },
        { type: "turn_break" },
        { type: "assistant_message", content: "Delegation completed." }
      ],
      validate(_fixtureDir, events) {
        const agentResult = events.find((event) => event.type === "tool_result" && event.result.toolUseId === "toolu_w18_agent");
        return agentResult?.type === "tool_result" && agentResult.result.content.includes("Child agent")
          ? []
          : ["sub-agent did not return the expected child result"];
      }
    }
  ];
}

async function writeWeek18Fixture(fixtureDir: string): Promise<void> {
  await mkdir(join(fixtureDir, "src"), { recursive: true });
  await writeFile(join(fixtureDir, "README.md"), "# Week 18 fixture\n\nFinal smoke project.\n", "utf8");
  await writeFile(
    join(fixtureDir, "src", "math.ts"),
    "export function add(a: number, b: number): number {\n  return a - b;\n}\n",
    "utf8"
  );
}

async function writeBlockingHook(fixtureDir: string): Promise<void> {
  const hooksDir = join(fixtureDir, "hooks");
  await mkdir(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, "block-write.cjs");
  await writeFile(
    hookPath,
    [
      "process.stdin.resume();",
      "process.stdin.on('end', () => {",
      "  console.error('week18 write blocked');",
      "  process.exit(2);",
      "});",
      ""
    ].join("\n"),
    "utf8"
  );
  await mkdir(join(fixtureDir, ".myagent"), { recursive: true });
  await writeFile(
    join(fixtureDir, ".myagent", "hooks.json"),
    JSON.stringify(
      {
        hooks: [
          {
            name: "week18-block-write",
            event: "PreToolUse",
            command: `${quote(process.execPath)} ${quote(hookPath)}`,
            tools: ["Write"]
          }
        ]
      },
      null,
      2
    ),
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
  return state.status === "completed" ? [] : [`terminal_state=${state.status}`];
}

function toolUseNames(events: readonly LoopEvent[]): string[] {
  return events.filter((event) => event.type === "tool_use").map((event) => event.toolUse.name);
}

function toolResultNotes(events: readonly LoopEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === "tool_result" && event.result.status === "error"
      ? [`tool_result error for ${event.result.toolUseId}: ${event.result.error ?? "unknown error"}`]
      : []
  );
}

function assistantTextFromEvents(events: readonly LoopEvent[]): string {
  return events
    .filter((event) => event.type === "assistant_message")
    .map((event) => assistantText(event.message))
    .join("\n");
}

function createWeek18BacklogItems(): Week18BacklogItem[] {
  return [
    {
      bucket: "v1.1",
      title: "Add real-model replay for final smoke prompts",
      detail: "The final suite is deterministic and offline. A guarded manual replay can validate provider behavior with explicit cost caps."
    },
    {
      bucket: "v1.1",
      title: "Expose profile summaries in TUI",
      detail: "Profiles are recorded as JSON today. A compact TUI panel would make latency and token spend easier to inspect."
    },
    {
      bucket: "v2",
      title: "Remote browser UI",
      detail: "Week 16 provides the WebSocket protocol, but the browser client itself is intentionally outside this v1 build."
    },
    {
      bucket: "v2",
      title: "Production-grade tool sandbox",
      detail: "The current sandbox is a project-local safety model. A production clone needs OS/container isolation and richer policy."
    },
    {
      bucket: "wont_do",
      title: "Full Claude Code parity",
      detail: "This project is a learning implementation, not a production replacement for Claude Code."
    },
    {
      bucket: "wont_do",
      title: "Credential injection service",
      detail: "Secrets stay in local environment configuration and are not managed by the agent."
    }
  ];
}

function renderWeek18Readme(report: Week18FinalReport): string {
  return [
    "# Mini Claude Code",
    "",
    "A safety-first learning implementation of a Claude Code-style coding agent.",
    "",
    "## What Works",
    "",
    "- CLI chat and agent loop.",
    "- Read, Glob, Grep, read-only Bash, Edit, Write.",
    "- Permission modes, diff preview, staleness checks, hooks, memory, skills, MCP loading.",
    "- Background tasks, sub-agents, fork traces, local remote WebSocket control.",
    "- Profile metrics for model turns, first token, tool latency, token usage, and estimated cost.",
    "",
    "## Final Smoke",
    "",
    `Status: ${report.status}`,
    "",
    ...report.smoke.map((task) => `- ${task.taskId}: ${task.passed ? "passed" : "failed"} (${task.category})`),
    "",
    "## Run",
    "",
    "```powershell",
    "npm.cmd run build",
    "npm.cmd run myagent -- --help",
    "npm.cmd run myagent -- week18 finalize",
    "```",
    "",
    "## Safety Model",
    "",
    "- Tools fail closed by default.",
    "- Plan mode allows only read-only tools.",
    "- Default mode asks for non-read-only tool approval when an approval channel exists.",
    "- Headless Edit/Write requires explicit bypassPermissions.",
    "- Bash is whitelist-only and blocks redirection, pipes, chaining, subshells, absolute paths, parent traversal, and .env reads.",
    "",
    "## Limits",
    "",
    "- This is not a production Claude Code clone.",
    "- No cloud execution, OAuth, credential injection, production sandbox, or browser UI is included.",
    "- Cost estimates require caller-provided pricing rates."
  ].join("\n") + "\n";
}

function renderWeek18Architecture(): string {
  return [
    "# Architecture",
    "",
    "```mermaid",
    "flowchart LR",
    "  User[\"User / Remote Client\"] --> CLI[\"CLI / TUI / Remote Server\"]",
    "  CLI --> Query[\"Query Loop\"]",
    "  Query --> Model[\"Model Client\"]",
    "  Query --> Scheduler[\"Tool Scheduler\"]",
    "  Scheduler --> Permission[\"Permission Chain\"]",
    "  Permission --> Tools[\"Built-in Tools + MCP\"]",
    "  Tools --> Session[\"Session / Artifacts / Tasks\"]",
    "  Query --> Profile[\"Profile Metrics\"]",
    "  Query --> Agent[\"Agent Tool\"]",
    "  Agent --> Query",
    "```",
    "",
    "The stable center is the query loop: model output becomes tool_use blocks, tools return tool_result blocks, and the next model turn sees the transcript. Remote, TUI, memory, hooks, tasks, and sub-agents are adapters around that loop."
  ].join("\n") + "\n";
}

function renderWeek18FinalReview(report: Week18FinalReport): string {
  return [
    "# Final Review",
    "",
    "## Migrated Patterns",
    "",
    "- Transcript-first query loop.",
    "- Fail-closed tool registry.",
    "- Permission modes before dangerous writes.",
    "- Frozen hooks and explicit skills.",
    "- Task/sub-agent separation with persisted output.",
    "- Fork trace hashes for cache-oriented reasoning.",
    "",
    "## Not Worth Recreating For v1",
    "",
    "- Full cloud execution control plane.",
    "- Production credential brokering.",
    "- Complete Claude Code UI parity.",
    "",
    "## Phase Checklist",
    "",
    "- Phase A: safe usable agent achieved.",
    "- Phase B: smarter agent constraints and extensions achieved.",
    "- Phase C: tasks, sub-agents, remote, and measurable profile metrics achieved.",
    "",
    `Final smoke status: ${report.status}.`
  ].join("\n") + "\n";
}

function renderWeek18Backlog(items: readonly Week18BacklogItem[]): string {
  const lines = ["# Backlog", ""];
  for (const bucket of ["v1.1", "v2", "wont_do"] as const) {
    lines.push(`## ${bucket}`);
    for (const item of items.filter((entry) => entry.bucket === bucket)) {
      lines.push(`- ${item.title}: ${item.detail}`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function quote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function compactTimestamp(iso: string): string {
  return iso.replace(/[-:.TZ]/g, "").slice(0, 14);
}
