#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";

import {
  addTokenUsage,
  compactSessionRecord,
  createAnthropicModelClientFromEnv,
  createMemoryStore,
  createSessionStore,
  createTaskStore,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL,
  formatSkillContext,
  getBootstrapState,
  initializeBootstrapState,
  isMemoryTaxonomy,
  loadHookSnapshot,
  loadSkills,
  collectTaskNotifications,
  createRemoteAgentServer,
  createRemoteSessionStore,
  createProfileRecorder,
  createProfileStore,
  markTaskKilled,
  ModelError,
  runLocalBashTask,
  scanSkillSnapshot,
  skillDisplayName,
  assistantText,
  query,
  replayMessagesFromSession,
  streamTextWithFallback,
  summarizeSession,
  updateBootstrapState,
  estimateUsageCostUsd,
  formatProfileReport,
  formatRemoteSessionList,
  type Message,
  type MemoryEntry,
  type ModelClient,
  type ModelStreamEvent,
  type PermissionDecision,
  type PermissionMode,
  type PermissionRequest,
  type MemoryStore,
  type HookSnapshot,
  type SkillSnapshot,
  type TaskRecord,
  type ForkTrace,
  type CostRates,
  type ProfileRecorder,
  type RemoteTurnInput,
  type RemoteTurnSink,
  type ToolDefinition
} from "@mini-claude-code/core";
import {
  createMcpToolRegistry,
  createProjectToolRegistry,
  createProjectToolRegistryWithMcp,
  loadMcpConfig
} from "@mini-claude-code/tools";
import { formatWeek12AuditReport, runWeek12Audit } from "./week12.js";
import { formatWeek18FinalReport, runWeek18Final } from "./week18.js";

const VERSION = "0.0.0";
const DEFAULT_TOOL_RESULT_BUDGET_CHARS = 8_192;

const HELP_TEXT = `myagent ${VERSION}

Usage:
  myagent --version
  myagent --help
  myagent chat <prompt>
  myagent agent [--permission-mode <plan|default|bypassPermissions>] [--skill <name>] <prompt>
  myagent tui
  myagent memory <path|list|save>
  myagent skill <list|show>
  myagent mcp <list|tools>
  myagent week12 audit
  myagent week18 finalize
  myagent profile <startup|list|show>
  myagent task <start-bash|list|read|kill|notify>
  myagent remote <serve|sessions>
  myagent resume <sessionId> [prompt]
  myagent compact <sessionId>
  myagent /compact <sessionId>

Week 18 scope:
  chat <prompt> sends a single text-only message to Anthropic.
  agent <prompt> runs the safe tool loop with Read, Glob, Grep, read-only Bash, Edit, and Write.
  agent reserves its final turn for a concise answer instead of stopping cold at max_turns.
  tui starts an interactive terminal session with history, slash commands, permissions, and Ctrl+C.
  memory save <taxonomy> <content> writes long-term memory under .myagent/projects/<project>/memory.
  skill list scans SKILL.md frontmatter; --skill <name> loads the body into agent context.
  command hooks run as frozen PreToolUse/PostToolUse snapshots from .myagent/hooks.json.
  mcp tools load from .myagent/mcp.json after built-in tools, sorted by mcp__server__tool name.
  week12 audit runs three offline low-risk agent tasks and writes transcripts/backlog/retrospective.
  task start-bash runs read-only Bash in a persisted background task state machine.
  task read supports incremental output reads by byte offset; task notify emits each terminal task once.
  Agent sub-agents reuse the same query loop; explore is read-only and verifier defaults to background.
  fork traces record stable system/tool/prefix hashes for cache debugging.
  remote serve starts a local-only WebSocket endpoint for browser or local clients.
  remote writes require client UUIDs for dedupe; metadata supports detach/resume.
  profile startup records fast-path and cold-path checkpoints under .myagent/profiles.
  week18 finalize runs the final offline smoke suite and writes a portfolio report.
  memory list shows editable long-term memory entries that will be recalled into future turns.
  resume <sessionId> prints a saved transcript, or continues it when a prompt is provided.
  compact <sessionId> runs headless simple snip compaction on a saved transcript.
  --permission-mode controls tool execution policy. Default: default.
  Edit and Write require --permission-mode bypassPermissions in this headless CLI.
  Set ANTHROPIC_API_KEY before using chat, or place it in .env.
  Override the default model with MYAGENT_MODEL.
  Optional cost estimates use MYAGENT_INPUT_USD_PER_MTOK and MYAGENT_OUTPUT_USD_PER_MTOK.

Not yet implemented:
  richer custom rendering arrives in later weeks.
`;

const SLASH_HELP_TEXT = `/help                 Show slash commands
/clear                Clear the in-memory conversation and start a new session
/compact [sessionId]  Compact the active or specified session
/model [model]        Show or set the model for new turns
/memory save <taxonomy> <content>
/memory list          Show recalled memory entries
/memory path          Show memory directory
/skill list           Show scanned skills
/skill use <name>     Enable a skill for future TUI turns
/skill clear          Disable active skills
/resume <sessionId>   Load a saved session into the TUI
/exit                 Exit the TUI
`;

type WritableLike = {
  write(chunk: string): unknown;
};

function captureWriter() {
  const chunks: string[] = [];
  return {
    writer: {
      write(chunk: string) {
        chunks.push(chunk);
      }
    },
    text: () => chunks.join("")
  };
}

export type CliEnvironment = {
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_BASE_URL?: string;
  MYAGENT_MODEL?: string;
  MYAGENT_PERMISSION_MODE?: PermissionMode;
  MYAGENT_INPUT_USD_PER_MTOK?: string;
  MYAGENT_OUTPUT_USD_PER_MTOK?: string;
};

export type CliDependencies = {
  env?: CliEnvironment;
  createModelClient?: (env: CliEnvironment) => ModelClient;
  cwd?: string;
  sessionRootDir?: string;
  artifactRootDir?: string;
  memoryRootDir?: string;
  skillRootDir?: string;
  hookConfigPath?: string;
  mcpConfigPath?: string;
  taskRootDir?: string;
  remoteRootDir?: string;
  startTaskWorker?: (
    taskId: string,
    options: { cwd: string; taskRootDir?: string }
  ) => Promise<void> | void;
  toolResultBudgetChars?: number;
  prompt?: PromptReader;
  input?: Readable;
  output?: Writable;
};

export type PromptReader = (question: string, signal?: AbortSignal) => Promise<string | null>;

export async function runCli(
  argv: readonly string[] = process.argv.slice(2),
  stdout: WritableLike = process.stdout,
  stderr: WritableLike = process.stderr,
  dependencies: CliDependencies = {}
): Promise<number> {
  if (argv.includes("--version") || argv.includes("-v")) {
    stdout.write(`${VERSION}\n`);
    return 0;
  }

  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    stdout.write(HELP_TEXT);
    return 0;
  }

  if (argv[0] === "chat") {
    return runChat(argv.slice(1), stdout, stderr, dependencies);
  }

  if (argv[0] === "agent") {
    return runAgent(argv.slice(1), stdout, stderr, dependencies);
  }

  if (argv[0] === "tui" || argv[0] === "repl") {
    return runTui(argv.slice(1), stdout, stderr, dependencies);
  }

  if (argv[0] === "memory") {
    return runMemory(argv.slice(1), stdout, stderr, dependencies);
  }

  if (argv[0] === "skill") {
    return runSkill(argv.slice(1), stdout, stderr, dependencies);
  }

  if (argv[0] === "mcp") {
    return runMcp(argv.slice(1), stdout, stderr, dependencies);
  }

  if (argv[0] === "week12") {
    return runWeek12(argv.slice(1), stdout, stderr, dependencies);
  }

  if (argv[0] === "week18") {
    return runWeek18(argv.slice(1), stdout, stderr, dependencies);
  }

  if (argv[0] === "profile") {
    return runProfile(argv.slice(1), stdout, stderr, dependencies);
  }

  if (argv[0] === "task") {
    return runTask(argv.slice(1), stdout, stderr, dependencies);
  }

  if (argv[0] === "remote") {
    return runRemote(argv.slice(1), stdout, stderr, dependencies);
  }

  if (argv[0] === "resume") {
    return runResume(argv.slice(1), stdout, stderr, dependencies);
  }

  if (argv[0] === "compact" || argv[0] === "/compact") {
    return runCompact(argv.slice(1), stdout, stderr, dependencies);
  }

  stderr.write(`Unknown command or option: ${argv[0]}\n\n${HELP_TEXT}`);
  return 1;
}

async function runCompact(
  args: readonly string[],
  stdout: WritableLike,
  stderr: WritableLike,
  dependencies: CliDependencies
): Promise<number> {
  const sessionId = args[0];
  if (!sessionId) {
    stderr.write("Missing session id. Usage: myagent compact <sessionId>\n");
    return 1;
  }

  const cwd = dependencies.cwd ?? process.cwd();
  const sessionStore = createSessionStore(cwd, dependencies.sessionRootDir);

  try {
    const record = await sessionStore.load(sessionId);
    const compacted = compactSessionRecord(record);
    await sessionStore.save(compacted);
    const compactEvent = [...compacted.events].reverse().find((event) => event.type === "compact");
    stdout.write(
      `Compacted ${sessionId}: ${compactEvent?.beforeTokens ?? "?"}->${compactEvent?.afterTokens ?? "?"} estimated tokens\n`
    );
    return 0;
  } catch (error) {
    stderr.write(`Could not compact session ${sessionId}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function runMemory(
  args: readonly string[],
  stdout: WritableLike,
  stderr: WritableLike,
  dependencies: CliDependencies
): Promise<number> {
  const cwd = dependencies.cwd ?? process.cwd();
  const store = createMemoryStore(cwd, dependencies.memoryRootDir);
  const [command, ...rest] = args;

  if (command === "path") {
    stdout.write(`${store.rootDir}\n`);
    return 0;
  }

  if (command === "list") {
    const entries = await store.load();
    stdout.write(formatMemoryList(entries, store.rootDir));
    return 0;
  }

  if (command === "save") {
    const taxonomy = rest[0];
    const content = rest.slice(1).join(" ").trim();
    if (!taxonomy || !isMemoryTaxonomy(taxonomy) || !content) {
      stderr.write("Usage: myagent memory save <user|feedback|project|reference> <content>\n");
      return 1;
    }

    const result = await store.save({
      taxonomy,
      content,
      source: "cli"
    });
    if (!result.ok) {
      stderr.write(`[memory] rejected: ${result.reason}\n`);
      return 1;
    }

    stdout.write(`[memory] saved ${result.entry.taxonomy}/${result.entry.id}\n`);
    return 0;
  }

  stderr.write("Usage: myagent memory <path|list|save>\n");
  return 1;
}

async function runSkill(
  args: readonly string[],
  stdout: WritableLike,
  stderr: WritableLike,
  dependencies: CliDependencies
): Promise<number> {
  const cwd = dependencies.cwd ?? process.cwd();
  const snapshot = await scanSkillSnapshot(cwd, dependencies.skillRootDir);
  const [command, name] = args;

  if (command === "list") {
    stdout.write(formatSkillList(snapshot));
    return 0;
  }

  if (command === "show" && name) {
    const [skill] = await loadSkills(snapshot, [name]);
    if (!skill) {
      stderr.write(`Skill not found: ${name}\n`);
      return 1;
    }
    stdout.write(`${formatSkillContext([skill])}\n`);
    return 0;
  }

  stderr.write("Usage: myagent skill <list|show> [name]\n");
  return 1;
}

async function runMcp(
  args: readonly string[],
  stdout: WritableLike,
  stderr: WritableLike,
  dependencies: CliDependencies
): Promise<number> {
  const cwd = dependencies.cwd ?? process.cwd();
  const [command] = args;

  if (command === "list") {
    const config = await loadMcpConfig(cwd, dependencies.mcpConfigPath);
    const names = Object.keys(config.servers).sort();
    stdout.write(names.length > 0 ? names.map((name) => `- ${name}`).join("\n") + "\n" : "[mcp] no servers configured\n");
    return 0;
  }

  if (command === "tools") {
    const tools = await createMcpToolRegistry(cwd, dependencies.mcpConfigPath);
    stdout.write(tools.length > 0 ? tools.map((tool) => `- ${tool.name}`).join("\n") + "\n" : "[mcp] no tools\n");
    return 0;
  }

  stderr.write("Usage: myagent mcp <list|tools>\n");
  return 1;
}

async function runWeek12(
  args: readonly string[],
  stdout: WritableLike,
  stderr: WritableLike,
  dependencies: CliDependencies
): Promise<number> {
  const [command] = args;
  if (command !== "audit") {
    stderr.write("Usage: myagent week12 audit\n");
    return 1;
  }

  const cwd = dependencies.cwd ?? process.cwd();
  const report = await runWeek12Audit({ cwd });
  stdout.write(formatWeek12AuditReport(report));
  return report.status === "passed" ? 0 : 1;
}

async function runWeek18(
  args: readonly string[],
  stdout: WritableLike,
  stderr: WritableLike,
  dependencies: CliDependencies
): Promise<number> {
  const [command] = args;
  if (command !== "finalize") {
    stderr.write("Usage: myagent week18 finalize\n");
    return 1;
  }

  const cwd = dependencies.cwd ?? process.cwd();
  const report = await runWeek18Final({ cwd });
  stdout.write(formatWeek18FinalReport(report));
  return report.status === "passed" ? 0 : 1;
}

async function runProfile(
  args: readonly string[],
  stdout: WritableLike,
  stderr: WritableLike,
  dependencies: CliDependencies
): Promise<number> {
  const cwd = dependencies.cwd ?? process.cwd();
  const store = createProfileStore(cwd);
  const [command, ...rest] = args;

  if (command === "startup") {
    const profile = createProfileRecorder({ runId: `startup_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}` });
    await profile.time("fast_path.version", async () => {
      const output = captureWriter();
      const error = captureWriter();
      await runCli(["--version"], output.writer, error.writer, { ...dependencies, cwd });
      profile.addMetric("version_output_chars", output.text().length, "chars");
    });
    await profile.time("fast_path.help", async () => {
      const output = captureWriter();
      const error = captureWriter();
      await runCli(["--help"], output.writer, error.writer, { ...dependencies, cwd });
      profile.addMetric("help_output_chars", output.text().length, "chars");
    });
    await profile.time("remote.sessions", async () => {
      const output = captureWriter();
      const error = captureWriter();
      await runCli(["remote", "sessions"], output.writer, error.writer, { ...dependencies, cwd });
      profile.addMetric("remote_sessions_output_chars", output.text().length, "chars");
    });
    const run = profile.finish("completed");
    const path = await store.save(run);
    stdout.write(formatProfileReport(run, path));
    return 0;
  }

  if (command === "list") {
    const runs = await store.list();
    if (runs.length === 0) {
      stdout.write("[profile] no runs\n");
      return 0;
    }
    stdout.write(runs.map((run) => `[profile] ${run.runId} ${run.status} durationMs=${run.durationMs ?? 0}\n`).join(""));
    return 0;
  }

  if (command === "show") {
    const runId = rest[0];
    if (!runId) {
      stderr.write("Usage: myagent profile show <runId>\n");
      return 1;
    }
    const run = await store.load(runId);
    stdout.write(formatProfileReport(run, store.pathFor(runId)));
    return 0;
  }

  stderr.write("Usage: myagent profile <startup|list|show>\n");
  return 1;
}

async function runTask(
  args: readonly string[],
  stdout: WritableLike,
  stderr: WritableLike,
  dependencies: CliDependencies
): Promise<number> {
  const cwd = dependencies.cwd ?? process.cwd();
  const envTaskRootDir = process.env.MYAGENT_TASK_ROOT_DIR || undefined;
  const taskRootDir = dependencies.taskRootDir ?? envTaskRootDir;
  const store = createTaskStore(cwd, taskRootDir);
  const [command, ...rest] = args;

  if (command === "start-bash") {
    const bashCommand = rest.join(" ").trim();
    if (!bashCommand) {
      stderr.write("Usage: myagent task start-bash <read-only-command>\n");
      return 1;
    }
    const task = await store.create({
      type: "local_bash",
      description: `local_bash: ${bashCommand}`,
      cwd,
      command: bashCommand
    });
    await (dependencies.startTaskWorker ?? startDetachedTaskWorker)(task.id, {
      cwd,
      taskRootDir
    });
    stdout.write(formatTaskStarted(task));
    return 0;
  }

  if (command === "list") {
    stdout.write(formatTaskList(await store.list()));
    return 0;
  }

  if (command === "read") {
    const taskId = rest[0];
    if (!taskId) {
      stderr.write("Usage: myagent task read <taskId> [offset]\n");
      return 1;
    }
    const offset = rest[1] === undefined ? undefined : Number(rest[1]);
    if (offset !== undefined && (!Number.isFinite(offset) || offset < 0)) {
      stderr.write("Offset must be a non-negative number.\n");
      return 1;
    }
    const output = await store.readOutput(taskId, { offset });
    stdout.write(
      `[task] ${output.task.id} ${output.task.state} offset=${output.offset} next=${output.nextOffset} eof=${output.eof}\n`
    );
    stdout.write(output.content);
    if (output.content && !output.content.endsWith("\n")) {
      stdout.write("\n");
    }
    return 0;
  }

  if (command === "kill") {
    const taskId = rest[0];
    if (!taskId) {
      stderr.write("Usage: myagent task kill <taskId>\n");
      return 1;
    }
    const task = await markTaskKilled(store, taskId, "killed by CLI");
    stdout.write(formatTaskLine(task));
    return 0;
  }

  if (command === "notify") {
    const notifications = await collectTaskNotifications(store);
    stdout.write(formatTaskNotifications(notifications));
    return 0;
  }

  if (command === "worker") {
    const taskId = rest[0];
    if (!taskId) {
      stderr.write("Usage: myagent task worker <taskId>\n");
      return 1;
    }
    const task = await runLocalBashTask(store, taskId);
    return task.state === "completed" || task.state === "killed" ? 0 : 1;
  }

  stderr.write("Usage: myagent task <start-bash|list|read|kill|notify>\n");
  return 1;
}

async function runRemote(
  args: readonly string[],
  stdout: WritableLike,
  stderr: WritableLike,
  dependencies: CliDependencies
): Promise<number> {
  const cwd = dependencies.cwd ?? process.cwd();
  const store = createRemoteSessionStore(cwd, dependencies.remoteRootDir);
  const [command, ...rest] = args;

  if (command === "sessions") {
    stdout.write(formatRemoteSessionList(await store.list()));
    return 0;
  }

  if (command !== "serve") {
    stderr.write("Usage: myagent remote <serve|sessions> [--host <host>] [--port <port>]\n");
    return 1;
  }

  const parsed = parseRemoteServeArgs(rest);
  if (!parsed.ok) {
    stderr.write(`${parsed.error}\n`);
    return 1;
  }

  const env = dependencies.env ?? loadEnvironment(cwd, process.env);
  const server = await createRemoteAgentServer({
    cwd,
    host: parsed.host,
    port: parsed.port,
    rootDir: dependencies.remoteRootDir,
    runPrompt: (input, sink) => runRemoteAgentTurn(input, sink, stdout, stderr, dependencies, cwd, env)
  });
  stdout.write(`[remote] listening ${server.url}\n`);
  stdout.write(`[remote] metadata ${server.store.rootDir}\n`);

  await waitForShutdownSignal();
  await server.close();
  stdout.write("[remote] stopped\n");
  return 0;
}

async function runRemoteAgentTurn(
  input: RemoteTurnInput,
  sink: RemoteTurnSink,
  _stdout: WritableLike,
  _stderr: WritableLike,
  dependencies: CliDependencies,
  cwd: string,
  env: CliEnvironment
): Promise<{ sessionId: string; exitCode: number }> {
  const sessionStore = createSessionStore(cwd, dependencies.sessionRootDir);
  const initialMessages = input.agentSessionId
    ? replayMessagesFromSession(await sessionStore.load(input.agentSessionId))
    : [];
  const permissionMode = input.permissionMode ?? env.MYAGENT_PERMISSION_MODE ?? "default";
  return runAgentTurn({
    prompt: input.prompt,
    initialMessages,
    sessionId: input.agentSessionId,
    cwd,
    env,
    permissionMode,
    stdout: {
      write(chunk) {
        sink.writeStdout(chunk);
      }
    },
    stderr: {
      write(chunk) {
        sink.writeStderr(chunk);
      }
    },
    dependencies,
    skillNames: input.skillNames,
    abortSignal: sink.signal,
    requestPermission: (request) => sink.requestPermission(request)
  });
}

type ParsedRemoteServeArgs =
  | {
      ok: true;
      host: string;
      port: number;
    }
  | {
      ok: false;
      error: string;
    };

function parseRemoteServeArgs(args: readonly string[]): ParsedRemoteServeArgs {
  let host = "127.0.0.1";
  let port = 8765;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--host") {
      const value = args[index + 1];
      if (!value) {
        return { ok: false, error: "Missing value for --host" };
      }
      host = value;
      index += 1;
      continue;
    }

    if (arg === "--port") {
      const value = args[index + 1];
      const parsed = Number(value);
      if (!value || !Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
        return { ok: false, error: "Invalid --port value" };
      }
      port = parsed;
      index += 1;
      continue;
    }

    return { ok: false, error: `Unknown remote serve option: ${arg}` };
  }

  return { ok: true, host, port };
}

async function waitForShutdownSignal(): Promise<void> {
  await new Promise<void>((resolvePromise) => {
    const finish = () => {
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
      resolvePromise();
    };
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}

function startDetachedTaskWorker(
  taskId: string,
  options: { cwd: string; taskRootDir?: string }
): void {
  const entrypointPath = process.argv[1];
  if (!entrypointPath) {
    throw new Error("Cannot start task worker without a CLI entrypoint path");
  }
  const env = { ...process.env };
  if (options.taskRootDir) {
    env.MYAGENT_TASK_ROOT_DIR = options.taskRootDir;
  } else {
    delete env.MYAGENT_TASK_ROOT_DIR;
  }
  const child = spawn(process.execPath, [entrypointPath, "task", "worker", taskId], {
    cwd: options.cwd,
    detached: true,
    env,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
}

function formatTaskStarted(task: TaskRecord): string {
  return [
    `[task] started ${task.id}`,
    `state: ${task.state}`,
    `type: ${task.type}`,
    `description: ${task.description}`,
    `output: ${task.outputFile}`
  ].join("\n") + "\n";
}

function formatTaskList(tasks: readonly TaskRecord[]): string {
  if (tasks.length === 0) {
    return "[task] empty\n";
  }
  return `${tasks.map(formatTaskLine).join("")}`;
}

function formatTaskLine(task: TaskRecord): string {
  const exit = task.exitCode === undefined ? "" : ` exit=${task.exitCode}`;
  const pid = task.pid === undefined ? "" : ` pid=${task.pid}`;
  return `[task] ${task.id} ${task.state}${exit}${pid} offset=${task.outputOffset} ${task.description}\n`;
}

function formatTaskNotifications(tasks: readonly TaskRecord[]): string {
  if (tasks.length === 0) {
    return "[task] no notifications\n";
  }
  return tasks
    .map((task) => `[task notification] ${task.id} ${task.state} ${task.description}\n`)
    .join("");
}

function formatMemoryList(entries: readonly MemoryEntry[], rootDir: string): string {
  if (entries.length === 0) {
    return `[memory] empty\npath: ${rootDir}\n`;
  }

  const lines = [`[memory] ${entries.length} entr${entries.length === 1 ? "y" : "ies"}`, `path: ${rootDir}`];
  for (const entry of entries) {
    lines.push(`- [${entry.taxonomy}] ${entry.id}: ${entry.content.replace(/\s+/g, " ")}`);
  }
  return `${lines.join("\n")}\n`;
}

function formatSkillList(snapshot: SkillSnapshot): string {
  if (snapshot.skills.length === 0) {
    return `[skills] empty\npath: ${snapshot.rootDir}\n`;
  }

  const lines = [`[skills] ${snapshot.skills.length}`, `path: ${snapshot.rootDir}`];
  for (const skill of snapshot.skills) {
    lines.push(`- [${skill.source}] ${skillDisplayName(skill)}`);
  }
  return `${lines.join("\n")}\n`;
}

async function runAgent(
  args: readonly string[],
  stdout: WritableLike,
  stderr: WritableLike,
  dependencies: CliDependencies
): Promise<number> {
  const parsedArgs = parseAgentArgs(args);
  if (!parsedArgs.ok) {
    stderr.write(`${parsedArgs.error}\n`);
    return 1;
  }

  const prompt = parsedArgs.prompt;
  if (!prompt) {
    stderr.write("Missing prompt. Usage: myagent agent [--permission-mode <mode>] [--skill <name>] <prompt>\n");
    return 1;
  }

  let client: ModelClient;
  const cwd = dependencies.cwd ?? process.cwd();
  const env = dependencies.env ?? loadEnvironment(cwd, process.env);
  const permissionMode = parsedArgs.permissionMode ?? env.MYAGENT_PERMISSION_MODE ?? "default";

  const result = await runAgentTurn({
    prompt,
    initialMessages: [],
    sessionId: undefined,
    cwd,
    env,
    permissionMode,
    stdout,
    stderr,
    dependencies,
    skillNames: parsedArgs.skillNames
  });
  return result.exitCode;
}

async function runResume(
  args: readonly string[],
  stdout: WritableLike,
  stderr: WritableLike,
  dependencies: CliDependencies
): Promise<number> {
  const sessionId = args[0];
  if (!sessionId) {
    stderr.write("Missing session id. Usage: myagent resume <sessionId> [prompt]\n");
    return 1;
  }

  const cwd = dependencies.cwd ?? process.cwd();
  const env = dependencies.env ?? loadEnvironment(cwd, process.env);
  const sessionStore = createSessionStore(cwd, dependencies.sessionRootDir);

  let record;
  try {
    record = await sessionStore.load(sessionId);
  } catch (error) {
    stderr.write(`Could not load session ${sessionId}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const prompt = args.slice(1).join(" ").trim();
  if (!prompt) {
    stdout.write(summarizeSession(record));
    return 0;
  }

  const result = await runAgentTurn({
    prompt,
    initialMessages: replayMessagesFromSession(record),
    sessionId: record.sessionId,
    cwd,
    env,
    permissionMode: env.MYAGENT_PERMISSION_MODE ?? record.bootstrap.permissionMode,
    stdout,
    stderr,
    dependencies,
    tokenUsage: record.bootstrap.tokenUsage,
    costUsd: record.bootstrap.costUsd
  });
  return result.exitCode;
}

async function runTui(
  _args: readonly string[],
  stdout: WritableLike,
  stderr: WritableLike,
  dependencies: CliDependencies
): Promise<number> {
  const cwd = dependencies.cwd ?? process.cwd();
  let env = dependencies.env ?? loadEnvironment(cwd, process.env);
  let permissionMode: PermissionMode = env.MYAGENT_PERMISSION_MODE ?? "default";
  let sessionId: string | undefined;
  let messages: Message[] = [];
  let tokenUsage: { inputTokens: number; outputTokens: number } | undefined;
  let costUsd: number | undefined;
  let activeSkillNames: string[] = [];
  const tools = await createProjectToolRegistryWithMcp(cwd, dependencies.mcpConfigPath);
  const sessionStore = createSessionStore(cwd, dependencies.sessionRootDir);
  const memoryStore = createMemoryStore(cwd, dependencies.memoryRootDir);
  const skillSnapshot = await scanSkillSnapshot(cwd, dependencies.skillRootDir);
  const hookSnapshot = await loadHookSnapshot(cwd, dependencies.hookConfigPath);
  const promptSession = createPromptSession(dependencies, stdout);
  let activeAbortController: AbortController | undefined;

  const sigintHandler = () => {
    if (activeAbortController && !activeAbortController.signal.aborted) {
      activeAbortController.abort();
      stdout.write("\n[interrupted current turn]\n");
      return;
    }
    stdout.write("\nUse /exit or Ctrl+D to quit.\n");
  };

  const useProcessSigint = !dependencies.prompt;
  if (useProcessSigint) {
    process.on("SIGINT", sigintHandler);
  }

  stdout.write("myagent interactive Week 18. Type /help for commands, Ctrl+D to exit.\n");

  try {
    while (true) {
      const line = await promptSession.ask("myagent> ");
      if (line === null) {
        stdout.write("bye\n");
        return 0;
      }

      const input = line.trim();
      if (!input) {
        continue;
      }

      if (input.startsWith("/")) {
        const commandResult = await handleSlashCommand({
          input,
          stdout,
          stderr,
          cwd,
          sessionStore,
          memoryStore,
          skillSnapshot,
          getActiveSkillNames: () => activeSkillNames,
          setActiveSkillNames(names) {
            activeSkillNames = [...names];
          },
          getSessionId: () => sessionId,
          setSession(record) {
            sessionId = record.sessionId;
            messages = replayMessagesFromSession(record);
            tokenUsage = record.bootstrap.tokenUsage;
            costUsd = record.bootstrap.costUsd;
            env = { ...env, MYAGENT_MODEL: record.bootstrap.model };
            permissionMode = record.bootstrap.permissionMode;
          },
          clearSession() {
            sessionId = undefined;
            messages = [];
            tokenUsage = undefined;
            costUsd = undefined;
          },
          getModel: () => env.MYAGENT_MODEL ?? DEFAULT_MODEL,
          setModel(model) {
            env = { ...env, MYAGENT_MODEL: model };
          }
        });
        if (commandResult === "exit") {
          stdout.write("bye\n");
          return 0;
        }
        continue;
      }

      activeAbortController = new AbortController();
      const result = await runAgentTurn({
        prompt: input,
        initialMessages: messages,
        sessionId,
        cwd,
        env,
        permissionMode,
        stdout,
        stderr,
        dependencies,
        tokenUsage,
        costUsd,
        tools,
        abortSignal: activeAbortController.signal,
        hookSnapshot,
        skillSnapshot,
        skillNames: activeSkillNames,
        requestPermission: (request) =>
          requestPermissionFromPrompt(request, promptSession.ask, stdout)
      });
      activeAbortController = undefined;
      sessionId = result.sessionId;

      if (sessionId) {
        const record = await sessionStore.load(sessionId);
        messages = replayMessagesFromSession(record);
        tokenUsage = record.bootstrap.tokenUsage;
        costUsd = record.bootstrap.costUsd;
      }
    }
  } finally {
    activeAbortController = undefined;
    promptSession.close();
    if (useProcessSigint) {
      process.off("SIGINT", sigintHandler);
    }
  }
}

type PromptSession = {
  ask: PromptReader;
  close(): void;
};

function createPromptSession(dependencies: CliDependencies, stdout: WritableLike): PromptSession {
  if (dependencies.prompt) {
    return {
      ask: dependencies.prompt,
      close() {}
    };
  }

  const readline = createInterface({
    input: dependencies.input ?? process.stdin,
    output: dependencies.output ?? process.stdout,
    historySize: 100
  });

  return {
    async ask(question, signal) {
      try {
        return signal ? await readline.question(question, { signal }) : await readline.question(question);
      } catch (_error) {
        return null;
      }
    },
    close() {
      readline.close();
      stdout.write("");
    }
  };
}

type SlashCommandContext = {
  input: string;
  stdout: WritableLike;
  stderr: WritableLike;
  cwd: string;
  sessionStore: ReturnType<typeof createSessionStore>;
  memoryStore: MemoryStore;
  skillSnapshot: SkillSnapshot;
  getActiveSkillNames(): readonly string[];
  setActiveSkillNames(names: readonly string[]): void;
  getSessionId(): string | undefined;
  setSession(record: Awaited<ReturnType<ReturnType<typeof createSessionStore>["load"]>>): void;
  clearSession(): void;
  getModel(): string;
  setModel(model: string): void;
};

async function handleSlashCommand(context: SlashCommandContext): Promise<"continue" | "exit"> {
  const [command, ...args] = context.input.split(/\s+/);

  if (command === "/exit" || command === "/quit") {
    return "exit";
  }

  if (command === "/help") {
    context.stdout.write(SLASH_HELP_TEXT);
    return "continue";
  }

  if (command === "/clear") {
    context.clearSession();
    context.stdout.write("[cleared conversation]\n");
    return "continue";
  }

  if (command === "/model") {
    const nextModel = args.join(" ").trim();
    if (!nextModel) {
      context.stdout.write(`[model] ${context.getModel()}\n`);
      return "continue";
    }
    context.setModel(nextModel);
    context.stdout.write(`[model] ${nextModel}\n`);
    return "continue";
  }

  if (command === "/memory") {
    await handleMemorySlashCommand(args, context);
    return "continue";
  }

  if (command === "/skill") {
    await handleSkillSlashCommand(args, context);
    return "continue";
  }

  if (command === "/resume") {
    const sessionId = args[0];
    if (!sessionId) {
      context.stderr.write("Usage: /resume <sessionId>\n");
      return "continue";
    }
    try {
      const record = await context.sessionStore.load(sessionId);
      context.setSession(record);
      context.stdout.write(summarizeSession(record));
    } catch (error) {
      context.stderr.write(
        `Could not load session ${sessionId}: ${error instanceof Error ? error.message : String(error)}\n`
      );
    }
    return "continue";
  }

  if (command === "/compact") {
    const sessionId = args[0] ?? context.getSessionId();
    if (!sessionId) {
      context.stderr.write("No active session. Usage: /compact [sessionId]\n");
      return "continue";
    }
    try {
      const record = await context.sessionStore.load(sessionId);
      const compacted = compactSessionRecord(record);
      await context.sessionStore.save(compacted);
      context.setSession(compacted);
      const compactEvent = [...compacted.events].reverse().find((event) => event.type === "compact");
      context.stdout.write(
        `[compact] ${sessionId}: ${compactEvent?.beforeTokens ?? "?"}->${compactEvent?.afterTokens ?? "?"} estimated tokens\n`
      );
    } catch (error) {
      context.stderr.write(
        `Could not compact session ${sessionId}: ${error instanceof Error ? error.message : String(error)}\n`
      );
    }
    return "continue";
  }

  context.stderr.write(`Unknown slash command: ${command}. Type /help.\n`);
  return "continue";
}

async function handleMemorySlashCommand(
  args: readonly string[],
  context: Pick<SlashCommandContext, "stdout" | "stderr" | "memoryStore">
): Promise<void> {
  const [command, ...rest] = args;

  if (!command || command === "help") {
    context.stdout.write("Usage: /memory <path|list|save>\n");
    return;
  }

  if (command === "path") {
    context.stdout.write(`[memory] ${context.memoryStore.rootDir}\n`);
    return;
  }

  if (command === "list") {
    context.stdout.write(formatMemoryList(await context.memoryStore.load(), context.memoryStore.rootDir));
    return;
  }

  if (command === "save") {
    const taxonomy = rest[0];
    const content = rest.slice(1).join(" ").trim();
    if (!taxonomy || !isMemoryTaxonomy(taxonomy) || !content) {
      context.stderr.write("Usage: /memory save <user|feedback|project|reference> <content>\n");
      return;
    }

    const result = await context.memoryStore.save({
      taxonomy,
      content,
      source: "slash"
    });
    if (!result.ok) {
      context.stderr.write(`[memory] rejected: ${result.reason}\n`);
      return;
    }

    context.stdout.write(`[memory] saved ${result.entry.taxonomy}/${result.entry.id}\n`);
    return;
  }

  context.stderr.write("Usage: /memory <path|list|save>\n");
}

async function handleSkillSlashCommand(
  args: readonly string[],
  context: Pick<
    SlashCommandContext,
    "stdout" | "stderr" | "skillSnapshot" | "getActiveSkillNames" | "setActiveSkillNames"
  >
): Promise<void> {
  const [command, ...rest] = args;

  if (!command || command === "list") {
    context.stdout.write(formatSkillList(context.skillSnapshot));
    const active = context.getActiveSkillNames();
    if (active.length > 0) {
      context.stdout.write(`[skills active] ${active.join(", ")}\n`);
    }
    return;
  }

  if (command === "use") {
    const name = rest[0];
    if (!name) {
      context.stderr.write("Usage: /skill use <name>\n");
      return;
    }
    const exists = context.skillSnapshot.skills.some((skill) => skill.name === name);
    if (!exists) {
      context.stderr.write(`Skill not found: ${name}\n`);
      return;
    }
    const next = [...new Set([...context.getActiveSkillNames(), name])];
    context.setActiveSkillNames(next);
    context.stdout.write(`[skill] enabled ${name}\n`);
    return;
  }

  if (command === "clear") {
    context.setActiveSkillNames([]);
    context.stdout.write("[skill] cleared\n");
    return;
  }

  context.stderr.write("Usage: /skill <list|use|clear>\n");
}

async function requestPermissionFromPrompt(
  request: PermissionRequest,
  prompt: PromptReader,
  stdout: WritableLike
): Promise<PermissionDecision> {
  stdout.write(
    `[permission] ${request.toolName} wants to run with input ${JSON.stringify(request.input)}\n`
  );
  const answer = (await prompt("allow or deny? " ))?.trim().toLowerCase();
  if (answer === "allow" || answer === "a" || answer === "yes" || answer === "y") {
    return { kind: "allow" };
  }
  return { kind: "deny", reason: `${request.toolName} denied by user` };
}

type RunAgentTurnOptions = {
  prompt: string;
  initialMessages: readonly Message[];
  sessionId: string | undefined;
  cwd: string;
  env: CliEnvironment;
  permissionMode: PermissionMode;
  stdout: WritableLike;
  stderr: WritableLike;
  dependencies: CliDependencies;
  tokenUsage?: { inputTokens: number; outputTokens: number };
  costUsd?: number;
  tools?: readonly ToolDefinition[];
  abortSignal?: AbortSignal;
  hookSnapshot?: HookSnapshot;
  skillSnapshot?: SkillSnapshot;
  skillNames?: readonly string[];
  requestPermission?: (request: PermissionRequest) => Promise<PermissionDecision> | PermissionDecision;
  profile?: ProfileRecorder;
};

type AgentTurnResult = {
  exitCode: number;
  sessionId: string;
};

async function runAgentTurn(options: RunAgentTurnOptions): Promise<AgentTurnResult> {
  let client: ModelClient;
  const modelName = options.env.MYAGENT_MODEL ?? DEFAULT_MODEL;
  const profile = options.profile ?? createProfileRecorder({ runId: `agent_${Date.now()}` });
  const profileStore = createProfileStore(options.cwd);
  const pricing = pricingFromEnv(options.env);
  const bootstrap = initializeBootstrapState({
    sessionId: options.sessionId,
    cwd: options.cwd,
    model: modelName,
    permissionMode: options.permissionMode,
    tokenUsage: options.tokenUsage,
    costUsd: options.costUsd
  });
  const sessionStore = createSessionStore(options.cwd, options.dependencies.sessionRootDir);
  const createModelClient =
    options.dependencies.createModelClient ??
    ((inputEnv: CliEnvironment) => createAnthropicModelClientFromEnv(inputEnv));
  const hookSnapshot =
    options.hookSnapshot ??
    (await profile.time("hooks.load", () => loadHookSnapshot(options.cwd, options.dependencies.hookConfigPath)));

  try {
    client = await profile.time("model.client.create", () => createModelClient(options.env), { model: modelName });
  } catch (error) {
    options.stderr.write(`${formatModelError(error)}\n`);
    await profileStore.save(profile.finish("failed")).catch(() => undefined);
    return { exitCode: 1, sessionId: bootstrap.sessionId };
  }

  if (options.sessionId === undefined) {
    await profile.time("session.create", () => sessionStore.create(bootstrap));
  }
  options.stdout.write(`[session] ${bootstrap.sessionId}\n`);

  const userMessage: Message = { role: "user", content: options.prompt };
  await profile.time("session.append_user", () =>
    sessionStore.append(bootstrap.sessionId, { type: "user_message", message: userMessage }, getBootstrapState())
  );
  const memoryContext = await profile.time("memory.recall", () =>
    createMemoryStore(
      options.cwd,
      options.dependencies.memoryRootDir
    )
      .formatContext(options.prompt)
      .catch((error) => {
        options.stderr.write(
          `[memory] recall failed: ${error instanceof Error ? error.message : String(error)}\n`
        );
        return "";
      })
  );
  const skillSnapshot =
    options.skillSnapshot ??
    (await profile.time("skills.scan", () => scanSkillSnapshot(options.cwd, options.dependencies.skillRootDir)));
  const skillContext = await profile.time("skills.load", () => loadSkills(skillSnapshot, options.skillNames ?? []))
    .then(formatSkillContext)
    .catch((error) => {
      options.stderr.write(
        `[skill] load failed: ${error instanceof Error ? error.message : String(error)}\n`
      );
      return "";
    });

  try {
    const tools = await profile.time("tools.load", () =>
      Promise.resolve(options.tools ?? createProjectToolRegistryWithMcp(options.cwd, options.dependencies.mcpConfigPath))
    );
    for await (const event of query({
      model: client,
      initialMessages: [...options.initialMessages, userMessage],
      tools,
      toolContext: {
        cwd: options.cwd,
        artifactDir: join(options.dependencies.artifactRootDir ?? join(options.cwd, ".myagent", "artifacts"), bootstrap.sessionId),
        toolResultBudgetChars: options.dependencies.toolResultBudgetChars ?? DEFAULT_TOOL_RESULT_BUDGET_CHARS,
        profile,
        requestPermission: options.requestPermission,
        hookSnapshot,
        taskStore: createTaskStore(options.cwd, options.dependencies.taskRootDir),
        maxSubAgentDepth: 1,
        recordForkTrace: (trace) => appendForkTrace(options.cwd, bootstrap.sessionId, trace)
      },
      permissionMode: options.permissionMode,
      abortSignal: options.abortSignal,
      system: buildAgentSystemPrompt(memoryContext, skillContext),
      modelName,
      maxTokens: DEFAULT_MAX_TOKENS,
      maxTurns: 8,
      finalizeBeforeMaxTurns: true,
      profile
    })) {
      if (event.type === "assistant_message") {
        if (event.usage) {
          const costDelta = estimateUsageCostUsd(event.usage, pricing);
          updateBootstrapState((state) => ({
            ...state,
            tokenUsage: addTokenUsage(state.tokenUsage, event.usage),
            costUsd: state.costUsd + costDelta
          }));
          profile.addMetric("model.input_tokens", event.usage.inputTokens ?? 0, "tokens", {
            requestId: event.requestId
          });
          profile.addMetric("model.output_tokens", event.usage.outputTokens ?? 0, "tokens", {
            requestId: event.requestId
          });
          profile.addMetric("model.cost_usd", costDelta, "usd", {
            requestId: event.requestId,
            estimated: true
          });
        }
        await sessionStore.append(
          bootstrap.sessionId,
          {
            type: "assistant_message",
            message: event.message,
            usage: event.usage,
            stopReason: event.stopReason,
            requestId: event.requestId
          },
          getBootstrapState()
        );
        const text = assistantText(event.message).trim();
        if (text) {
          options.stdout.write(`${text}\n`);
        }
      }

      if (event.type === "tool_use") {
        await sessionStore.append(
          bootstrap.sessionId,
          { type: "tool_use", toolUse: event.toolUse },
          getBootstrapState()
        );
        options.stdout.write(`\n[tool] ${event.toolUse.name} ${JSON.stringify(event.toolUse.input)}\n`);
      }

      if (event.type === "tool_result") {
        await sessionStore.append(
          bootstrap.sessionId,
          { type: "tool_result", result: event.result },
          getBootstrapState()
        );
      }

      if (event.type === "terminal_state" && event.state.status !== "completed") {
        await sessionStore.append(
          bootstrap.sessionId,
          { type: "terminal_state", state: event.state },
          getBootstrapState()
        );
        const detail = event.state.error ?? event.state.reason;
        options.stderr.write(`Agent stopped: ${event.state.status}${detail ? ` (${detail})` : ""}\n`);
        return { exitCode: 1, sessionId: bootstrap.sessionId };
      }

      if (event.type === "terminal_state") {
        await sessionStore.append(
          bootstrap.sessionId,
          { type: "terminal_state", state: event.state },
          getBootstrapState()
        );
      }
    }

    const finalState = getBootstrapState();
    profile.addMetric("session.input_tokens", finalState.tokenUsage.inputTokens, "tokens");
    profile.addMetric("session.output_tokens", finalState.tokenUsage.outputTokens, "tokens");
    profile.addMetric("session.cost_usd", finalState.costUsd, "usd", { estimated: true });
    await profileStore.save(profile.finish("completed")).catch(() => undefined);
    return { exitCode: 0, sessionId: bootstrap.sessionId };
  } catch (error) {
    options.stderr.write(`${formatModelError(error)}\n`);
    await profileStore.save(profile.finish("failed")).catch(() => undefined);
    return { exitCode: 1, sessionId: bootstrap.sessionId };
  }
}

async function runChat(
  args: readonly string[],
  stdout: WritableLike,
  stderr: WritableLike,
  dependencies: CliDependencies
): Promise<number> {
  const prompt = args.join(" ").trim();
  if (!prompt) {
    stderr.write("Missing prompt. Usage: myagent chat <prompt>\n");
    return 1;
  }

  let client: ModelClient;
  const env = dependencies.env ?? loadEnvironment(dependencies.cwd ?? process.cwd(), process.env);
  const createModelClient =
    dependencies.createModelClient ?? ((inputEnv) => createAnthropicModelClientFromEnv(inputEnv));

  try {
    client = createModelClient(env);
  } catch (error) {
    stderr.write(`${formatModelError(error)}\n`);
    return 1;
  }

  try {
    for await (const event of streamTextWithFallback(client, {
      messages: [{ role: "user", content: prompt }],
      model: env.MYAGENT_MODEL ?? DEFAULT_MODEL,
      maxTokens: DEFAULT_MAX_TOKENS
    })) {
      writeChatEvent(event, stdout);
    }
    stdout.write("\n");
    return 0;
  } catch (error) {
    stderr.write(`${formatModelError(error)}\n`);
    return 1;
  }
}

function writeChatEvent(event: ModelStreamEvent, stdout: WritableLike): void {
  if (event.type === "text_delta") {
    stdout.write(event.text);
  }
}

function formatModelError(error: unknown): string {
  if (error instanceof ModelError) {
    return `Model error (${error.kind}): ${error.message}`;
  }

  return error instanceof Error ? error.message : String(error);
}

export function loadEnvironment(
  cwd: string,
  baseEnv: NodeJS.ProcessEnv = process.env
): CliEnvironment {
  return {
    ...readDotEnv(join(cwd, ".env")),
    ...baseEnv
  };
}

function readDotEnv(path: string): CliEnvironment {
  if (!existsSync(path)) {
    return {};
  }

  const env: CliEnvironment = {};
  const content = readFileSync(path, "utf8");

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) {
      continue;
    }

    const key = line.slice(0, equalsIndex).trim();
    const value = unwrapEnvValue(line.slice(equalsIndex + 1).trim());

    if (
      key === "ANTHROPIC_API_KEY" ||
      key === "ANTHROPIC_BASE_URL" ||
      key === "MYAGENT_MODEL" ||
      key === "MYAGENT_INPUT_USD_PER_MTOK" ||
      key === "MYAGENT_OUTPUT_USD_PER_MTOK"
    ) {
      env[key] = value;
      continue;
    }

    if (key === "MYAGENT_PERMISSION_MODE" && isPermissionMode(value)) {
      env[key] = value;
    }
  }

  return env;
}

function unwrapEnvValue(value: string): string {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

type ParsedAgentArgs =
  | {
      ok: true;
      prompt: string;
      permissionMode?: PermissionMode;
      skillNames: string[];
    }
  | {
      ok: false;
      error: string;
    };

function parseAgentArgs(args: readonly string[]): ParsedAgentArgs {
  const promptParts: string[] = [];
  let permissionMode: PermissionMode | undefined;
  const skillNames: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--permission-mode") {
      const value = args[index + 1];
      if (!value) {
        return { ok: false, error: "Missing value for --permission-mode" };
      }
      if (!isPermissionMode(value)) {
        return {
          ok: false,
          error: `Invalid permission mode: ${value}. Expected plan, default, or bypassPermissions.`
        };
      }
      permissionMode = value;
      index += 1;
      continue;
    }

    if (arg === "--skill") {
      const value = args[index + 1];
      if (!value) {
        return { ok: false, error: "Missing value for --skill" };
      }
      skillNames.push(value);
      index += 1;
      continue;
    }

    promptParts.push(arg ?? "");
  }

  return {
    ok: true,
    prompt: promptParts.join(" ").trim(),
    permissionMode,
    skillNames
  };
}

function isPermissionMode(value: string): value is PermissionMode {
  return value === "plan" || value === "default" || value === "bypassPermissions";
}

function pricingFromEnv(env: CliEnvironment): CostRates | undefined {
  const inputUsdPerMillionTokens = parseOptionalNumber(env.MYAGENT_INPUT_USD_PER_MTOK);
  const outputUsdPerMillionTokens = parseOptionalNumber(env.MYAGENT_OUTPUT_USD_PER_MTOK);
  if (inputUsdPerMillionTokens === undefined && outputUsdPerMillionTokens === undefined) {
    return undefined;
  }
  return {
    inputUsdPerMillionTokens,
    outputUsdPerMillionTokens
  };
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function buildAgentSystemPrompt(memoryContext: string, skillContext: string): string {
  return [READ_ONLY_AGENT_SYSTEM_PROMPT, memoryContext.trim(), skillContext.trim()]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

const READ_ONLY_AGENT_SYSTEM_PROMPT = `You are myagent Week 18, a safety-first coding agent.
You can inspect and modify the local project with these tools:
- Read: read one UTF-8 project file by path.
- Glob: find project files by glob pattern.
- Grep: search project text files by regular expression.
- Bash: run only whitelisted read-only commands: pwd, ls, cat, grep, rg, find, git status, git diff, git log.
- Edit: replace an exact unique oldString in a previously-read file.
- Write: create a new file or overwrite a previously-read existing file.
- Agent: delegate work to a sub-agent. Use explore for read-only code search and verifier for background checks.
- MCP tools: external tools named mcp__serverName__toolName, loaded after built-in tools.

Use tools whenever the user asks about local files, code, TODOs, or project contents.
Do not claim to have inspected files unless you used a tool.
Before Edit or Write, always Read the target file unless creating a brand-new file.
Prefer Edit for small changes.
Large tool results may be saved as artifacts; use the artifact path when you need full output later.
Long-term memory may be provided in the system prompt. Treat it as user/project preference, not as current code truth.
Active skills may be provided in the system prompt. Treat them as task-specific instructions, not executable code.
MCP tool annotations are hints only. Do not treat MCP tools as safe merely because a server says they are safe.
Sub-agents reuse the same query loop and cannot self-approve dangerous writes. Explore and verifier sub-agents are read-only.
Do not save code patterns, git history, or facts that can be re-derived from reading the repository as memory.
Do not request non-whitelisted Bash commands or unconfigured MCP tools.`;

async function appendForkTrace(cwd: string, sessionId: string, trace: ForkTrace): Promise<void> {
  const dir = join(cwd, ".myagent", "fork-traces");
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, `${sessionId}.jsonl`), `${JSON.stringify(trace)}\n`, "utf8");
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";

if (import.meta.url === entrypoint) {
  runCli()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${formatModelError(error)}\n`);
      process.exitCode = 1;
    });
}
