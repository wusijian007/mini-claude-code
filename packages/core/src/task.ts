import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, open, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import { normalizePath } from "./state.js";

export type TaskState = "pending" | "running" | "completed" | "failed" | "killed";
export type TaskType = "local_bash" | "local_agent";

export type TaskRecord = {
  version: 1;
  id: string;
  type: TaskType;
  state: TaskState;
  description: string;
  cwd: string;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  outputFile: string;
  outputOffset: number;
  command?: string;
  prompt?: string;
  pid?: number;
  exitCode?: number | null;
  error?: string;
  notifiedAt?: string;
};

export type CreateTaskInput = {
  type: TaskType;
  description: string;
  cwd?: string;
  command?: string;
  prompt?: string;
};

export type TaskOutputChunk = {
  task: TaskRecord;
  content: string;
  offset: number;
  nextOffset: number;
  eof: boolean;
};

export type TaskStore = {
  rootDir: string;
  recordsDir: string;
  outputsDir: string;
  create(input: CreateTaskInput): Promise<TaskRecord>;
  load(taskId: string): Promise<TaskRecord>;
  save(record: TaskRecord): Promise<void>;
  list(): Promise<TaskRecord[]>;
  patch(taskId: string, updater: (record: TaskRecord) => TaskRecord): Promise<TaskRecord>;
  appendOutput(taskId: string, chunk: string): Promise<TaskRecord>;
  readOutput(taskId: string, options?: { offset?: number; maxBytes?: number }): Promise<TaskOutputChunk>;
  pathFor(taskId: string): string;
  outputPathFor(taskId: string): string;
};

export type ManagedTask = {
  task: TaskRecord;
  done: Promise<TaskRecord>;
  kill(reason?: string): Promise<TaskRecord>;
};

export type ManagedTaskRunner = (
  task: TaskRecord,
  controls: {
    signal: AbortSignal;
    appendOutput(chunk: string): Promise<void>;
  }
) => Promise<{ exitCode?: number | null; error?: string } | void>;

const DEFAULT_TASK_OUTPUT_READ_BYTES = 64_000;

export function createTaskStore(cwd: string, rootDir?: string): TaskStore {
  const normalizedRoot = normalizePath(resolve(rootDir ?? join(cwd, ".myagent", "tasks")));
  const recordsDir = normalizePath(join(normalizedRoot, "records"));
  const outputsDir = normalizePath(join(normalizedRoot, "outputs"));

  return {
    rootDir: normalizedRoot,
    recordsDir,
    outputsDir,
    async create(input) {
      const now = nowIso();
      const id = createTaskId();
      const record: TaskRecord = {
        version: 1,
        id,
        type: input.type,
        state: "pending",
        description: input.description,
        cwd: normalizePath(resolve(input.cwd ?? cwd)),
        createdAt: now,
        outputFile: this.outputPathFor(id),
        outputOffset: 0,
        command: input.command,
        prompt: input.prompt
      };
      await mkdir(recordsDir, { recursive: true });
      await mkdir(outputsDir, { recursive: true });
      await writeFile(record.outputFile, "", "utf8");
      await this.save(record);
      return record;
    },
    async load(taskId) {
      const raw = await readFile(this.pathFor(taskId), "utf8");
      const parsed = JSON.parse(raw) as TaskRecord;
      return normalizeTaskRecord(parsed);
    },
    async save(record) {
      await mkdir(recordsDir, { recursive: true });
      await mkdir(outputsDir, { recursive: true });
      const path = this.pathFor(record.id);
      const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tempPath, `${JSON.stringify(normalizeTaskRecord(record), null, 2)}\n`, "utf8");
      await rename(tempPath, path);
    },
    async list() {
      const names = await readdir(recordsDir).catch(() => []);
      const records: TaskRecord[] = [];
      for (const name of names.sort()) {
        if (!name.endsWith(".json")) {
          continue;
        }
        records.push(await this.load(name.replace(/\.json$/, "")));
      }
      return records.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    },
    async patch(taskId, updater) {
      const current = await this.load(taskId);
      const next = normalizeTaskRecord(updater(current));
      await this.save(next);
      return this.load(taskId);
    },
    async appendOutput(taskId, chunk) {
      const current = await this.load(taskId);
      await mkdir(outputsDir, { recursive: true });
      await appendFile(current.outputFile, chunk, "utf8");
      const info = await stat(current.outputFile);
      return this.patch(taskId, (record) => ({
        ...record,
        outputOffset: info.size
      }));
    },
    async readOutput(taskId, options = {}) {
      const task = await this.load(taskId);
      const buffer = await readFile(task.outputFile).catch(() => Buffer.alloc(0));
      const offset = Math.max(0, Math.floor(options.offset ?? 0));
      const maxBytes = Math.max(1, Math.floor(options.maxBytes ?? DEFAULT_TASK_OUTPUT_READ_BYTES));
      const end = Math.min(buffer.length, offset + maxBytes);
      const content = buffer.subarray(offset, end).toString("utf8");
      return {
        task,
        content,
        offset,
        nextOffset: end,
        eof: end >= buffer.length
      };
    },
    pathFor(taskId) {
      assertTaskId(taskId);
      return join(recordsDir, `${taskId}.json`);
    },
    outputPathFor(taskId) {
      assertTaskId(taskId);
      return join(outputsDir, `${taskId}.log`);
    }
  };
}

export async function startManagedTask(
  store: TaskStore,
  input: CreateTaskInput,
  runner: ManagedTaskRunner
): Promise<ManagedTask> {
  const task = await store.create(input);
  const controller = new AbortController();
  await store.patch(task.id, (record) => ({
    ...record,
    state: "running",
    startedAt: nowIso(),
    pid: record.type === "local_bash" ? process.pid : record.pid
  }));

  const done = (async () => {
    try {
      const result = await runner(task, {
        signal: controller.signal,
        async appendOutput(chunk) {
          await store.appendOutput(task.id, chunk);
        }
      });
      const current = await store.load(task.id);
      if (current.state === "killed" || controller.signal.aborted) {
        if (current.state !== "killed") {
          return markTaskKilled(store, task.id, "killed");
        }
        return current;
      }
      return await store.patch(task.id, (record) => ({
        ...record,
        state: result?.error ? "failed" : "completed",
        endedAt: nowIso(),
        exitCode: result?.exitCode ?? (result?.error ? 1 : 0),
        error: result?.error
      }));
    } catch (error) {
      const current = await store.load(task.id);
      if (current.state === "killed") {
        return current;
      }
      return await store.patch(task.id, (record) => ({
        ...record,
        state: "failed",
        endedAt: nowIso(),
        exitCode: 1,
        error: error instanceof Error ? error.message : String(error)
      }));
    }
  })();

  return {
    task: await store.load(task.id),
    done,
    async kill(reason = "killed") {
      controller.abort();
      return markTaskKilled(store, task.id, reason);
    }
  };
}

export async function runLocalBashTask(store: TaskStore, taskId: string): Promise<TaskRecord> {
  let task = await store.load(taskId);
  if (task.type !== "local_bash") {
    return markTaskFailed(store, taskId, `Task ${taskId} is not a local_bash task`);
  }
  if (!task.command) {
    return markTaskFailed(store, taskId, "local_bash task is missing command");
  }

  const parsed = parseReadOnlyBashCommand(task.command, task.cwd);
  if (!parsed.ok) {
    return markTaskFailed(store, taskId, parsed.error);
  }

  task = await store.patch(taskId, (record) => ({
    ...record,
    state: "running",
    startedAt: record.startedAt ?? nowIso(),
    pid: process.pid
  }));

  try {
    const exitCode =
      parsed.kind === "builtin"
        ? await runBuiltinReadOnlyCommand(store, task, parsed)
        : await runSpawnedReadOnlyCommand(store, task, parsed);
    const current = await store.load(taskId);
    if (current.state === "killed") {
      return current;
    }
    return await store.patch(taskId, (record) => ({
      ...record,
      state: exitCode === 0 ? "completed" : "failed",
      endedAt: nowIso(),
      exitCode
    }));
  } catch (error) {
    const current = await store.load(taskId);
    if (current.state === "killed") {
      return current;
    }
    return markTaskFailed(store, taskId, error instanceof Error ? error.message : String(error));
  }
}

export async function markTaskKilled(
  store: TaskStore,
  taskId: string,
  reason = "killed"
): Promise<TaskRecord> {
  const current = await store.load(taskId);
  if (current.pid && current.state === "running" && current.pid !== process.pid) {
    try {
      process.kill(current.pid);
    } catch (_error) {
      // The process may already be gone; the persisted terminal state is still useful.
    }
  }

  return store.patch(taskId, (record) => ({
    ...record,
    state: "killed",
    endedAt: record.endedAt ?? nowIso(),
    error: reason
  }));
}

export async function collectTaskNotifications(store: TaskStore): Promise<TaskRecord[]> {
  const notifications: TaskRecord[] = [];
  const tasks = await store.list();
  for (const task of tasks) {
    if (!isTerminalTaskState(task.state) || task.notifiedAt) {
      continue;
    }
    const marked = await store.patch(task.id, (record) => ({
      ...record,
      notifiedAt: nowIso()
    }));
    notifications.push(marked);
  }
  return notifications;
}

export function isTerminalTaskState(state: TaskState): boolean {
  return state === "completed" || state === "failed" || state === "killed";
}

export type ReadOnlyBashCommand =
  | {
      ok: true;
      kind: "builtin";
      command: "pwd" | "ls" | "cat" | "find";
      args: string[];
      displayCommand: string;
    }
  | {
      ok: true;
      kind: "spawn";
      executable: "git" | "rg" | "grep";
      args: string[];
      displayCommand: string;
    }
  | {
      ok: false;
      error: string;
    };

export function parseReadOnlyBashCommand(command: string, cwd: string): ReadOnlyBashCommand {
  if (/[><|&;]/.test(command) || /[\r\n`]/.test(command) || command.includes("$(")) {
    return {
      ok: false,
      error: "Bash command rejected: redirects, pipes, command chaining, subshells, and backticks are not allowed"
    };
  }

  const tokenized = tokenizeCommand(command);
  if (!tokenized.ok) {
    return tokenized;
  }

  const [rawExecutable, ...args] = tokenized.tokens;
  const executable = rawExecutable?.toLowerCase();
  if (!executable) {
    return { ok: false, error: "Bash command is empty" };
  }

  const pathError = validateReadOnlyBashPathArguments(executable, args, cwd);
  if (pathError) {
    return { ok: false, error: pathError };
  }

  if (executable === "pwd" || executable === "ls" || executable === "cat" || executable === "find") {
    return {
      ok: true,
      kind: "builtin",
      command: executable,
      args,
      displayCommand: tokenized.tokens.join(" ")
    };
  }

  if (executable === "rg" || executable === "grep") {
    return {
      ok: true,
      kind: "spawn",
      executable,
      args,
      displayCommand: tokenized.tokens.join(" ")
    };
  }

  if (executable === "git") {
    const subcommand = args[0];
    if (subcommand === "status" || subcommand === "diff" || subcommand === "log") {
      return {
        ok: true,
        kind: "spawn",
        executable: "git",
        args,
        displayCommand: tokenized.tokens.join(" ")
      };
    }
    return { ok: false, error: "Only git status, git diff, and git log are allowed" };
  }

  return { ok: false, error: `Command is not in the read-only Bash whitelist: ${rawExecutable}` };
}

async function markTaskFailed(store: TaskStore, taskId: string, error: string): Promise<TaskRecord> {
  return store.patch(taskId, (record) => ({
    ...record,
    state: "failed",
    endedAt: record.endedAt ?? nowIso(),
    exitCode: record.exitCode ?? 1,
    error
  }));
}

async function runBuiltinReadOnlyCommand(
  store: TaskStore,
  task: TaskRecord,
  command: Extract<ReadOnlyBashCommand, { kind: "builtin" }>
): Promise<number> {
  await store.appendOutput(task.id, `$ ${command.displayCommand}\n`);

  if (command.command === "pwd") {
    await store.appendOutput(task.id, `${task.cwd}\n`);
    return 0;
  }

  if (command.command === "ls") {
    const target = firstPathArg(command.args) ?? ".";
    const absolutePath = resolveProjectPath(task.cwd, target);
    ensureInsideProject(absolutePath, task.cwd);
    if (isBlockedPath(absolutePath, task.cwd)) {
      throw new Error("ls target is blocked by the safety policy");
    }
    const entries = await readdir(absolutePath, { withFileTypes: true });
    const output = entries
      .filter((entry) => !isBlockedPath(resolve(absolutePath, entry.name), task.cwd))
      .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
      .sort()
      .join("\n");
    await store.appendOutput(task.id, output ? `${output}\n` : "");
    return 0;
  }

  if (command.command === "cat") {
    const paths = command.args.filter((arg) => !arg.startsWith("-"));
    for (const path of paths) {
      const absolutePath = resolveProjectPath(task.cwd, path);
      ensureReadableFile(absolutePath, task.cwd);
      await store.appendOutput(task.id, await readFile(absolutePath, "utf8"));
    }
    return 0;
  }

  const target = firstPathArg(command.args) ?? ".";
  const absolutePath = resolveProjectPath(task.cwd, target);
  ensureInsideProject(absolutePath, task.cwd);
  const files = await listProjectFiles(absolutePath, task.cwd);
  await store.appendOutput(task.id, files.length > 0 ? `${files.sort().join("\n")}\n` : "");
  return 0;
}

async function runSpawnedReadOnlyCommand(
  store: TaskStore,
  task: TaskRecord,
  command: Extract<ReadOnlyBashCommand, { kind: "spawn" }>
): Promise<number | null> {
  await store.appendOutput(task.id, `$ ${command.displayCommand}\n`);
  const output = await open(task.outputFile, "a");
  try {
    const child = spawn(command.executable, command.args, {
      cwd: task.cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", output.fd, output.fd]
    });
    await store.patch(task.id, (record) => ({
      ...record,
      pid: child.pid
    }));

    return await new Promise<number | null>((resolvePromise, reject) => {
      child.on("error", reject);
      child.on("close", (exitCode) => resolvePromise(exitCode));
    });
  } finally {
    await output.close();
    const info = await stat(task.outputFile).catch(() => null);
    if (info) {
      await store.patch(task.id, (record) => ({
        ...record,
        outputOffset: info.size
      }));
    }
  }
}

function normalizeTaskRecord(record: TaskRecord): TaskRecord {
  return {
    ...record,
    cwd: normalizePath(resolve(record.cwd)),
    outputFile: normalizePath(resolve(record.outputFile))
  };
}

function assertTaskId(taskId: string): void {
  if (!/^task_[A-Za-z0-9_-]+$/.test(taskId)) {
    throw new Error("Invalid task id");
  }
}

function createTaskId(): string {
  return `task_${compactTimestamp(nowIso())}_${randomUUID().slice(0, 8)}`;
}

function compactTimestamp(iso: string): string {
  return iso.replace(/[-:.TZ]/g, "").slice(0, 14);
}

function nowIso(): string {
  return new Date().toISOString();
}

function tokenizeCommand(command: string): { ok: true; tokens: string[] } | { ok: false; error: string } {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if ((char === "'" || char === "\"") && quote === null) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = null;
      continue;
    }
    if (/\s/.test(char ?? "") && quote === null) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (quote !== null) {
    return { ok: false, error: "Bash command rejected: unmatched quote" };
  }
  if (current) {
    tokens.push(current);
  }
  return { ok: true, tokens };
}

function validateReadOnlyBashPathArguments(command: string, args: string[], cwd: string): string | null {
  for (const arg of args) {
    if (arg === "." || arg.startsWith("-")) {
      continue;
    }
    if (arg.includes("\0")) {
      return "Bash command rejected: null bytes are not allowed";
    }
    if (arg === ".env" || normalizePath(arg).split("/").includes(".env")) {
      return "Bash command rejected: .env is blocked";
    }
    if (arg.startsWith("..") || normalizePath(arg).includes("/../") || isAbsolute(arg)) {
      return "Bash command rejected: paths outside the project are not allowed";
    }
  }

  if (command === "cat") {
    const paths = args.filter((arg) => !arg.startsWith("-"));
    if (paths.length === 0) {
      return "cat requires at least one project file path";
    }
  }

  if (command === "pwd" && args.length > 0) {
    return "pwd does not accept arguments in the read-only Bash whitelist";
  }

  void cwd;
  return null;
}

function resolveProjectPath(cwd: string, target: string): string {
  return resolve(cwd, target);
}

function ensureInsideProject(absolutePath: string, cwd: string): void {
  const relativePath = normalizePath(relative(cwd, absolutePath));
  if (relativePath === ".." || relativePath.startsWith("../") || relativePath.startsWith("..\\")) {
    throw new Error("Path is outside the project root");
  }
}

function ensureReadableFile(absolutePath: string, cwd: string): void {
  ensureInsideProject(absolutePath, cwd);
  if (isBlockedPath(absolutePath, cwd)) {
    throw new Error("Reading this path is blocked by the read-only safety policy");
  }
  if (!existsSync(absolutePath)) {
    throw new Error("File does not exist");
  }
}

async function listProjectFiles(root: string, cwd: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const absolutePath = resolve(root, entry.name);
    if (isBlockedPath(absolutePath, cwd)) {
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...(await listProjectFiles(absolutePath, cwd)));
      continue;
    }
    if (entry.isFile()) {
      files.push(normalizePath(relative(cwd, absolutePath)));
    }
  }

  return files;
}

function firstPathArg(args: string[]): string | undefined {
  return args.find((arg) => !arg.startsWith("-"));
}

function isBlockedPath(absolutePath: string, cwd: string): boolean {
  const relativePath = normalizePath(relative(cwd, absolutePath));
  const parts = relativePath.split("/");
  return parts.some((part) => [".git", "node_modules", "dist", "coverage", ".myagent"].includes(part)) ||
    basename(absolutePath) === ".env";
}
