import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

import {
  assistantText,
  buildTool,
  collectQuery,
  createForkTrace,
  createSpawnExecutor,
  startManagedTask,
  type CommandExecutor,
  type JsonObjectSchema,
  type ToolCallResult,
  type ToolContext,
  type ToolDefinition
} from "@mini-claude-code/core";
import { z } from "zod";

export * from "./mcp.js";

const SKIPPED_DIRS = new Set([".git", "node_modules", "dist", "coverage", ".myagent"]);
const BLOCKED_FILES = new Set([".env"]);
const DEFAULT_GREP_HEAD_LIMIT = 50;
const MAX_READ_CHARS = 200_000;
const MAX_BASH_OUTPUT_CHARS = 80_000;
const DEFAULT_BASH_TIMEOUT_MS = 10_000;
const MAX_BASH_TIMEOUT_MS = 30_000;

export type FileState = {
  path: string;
  mtimeMs: number;
  size: number;
  hash: string;
  content: string;
};

export type FileStateStore = Map<string, FileState>;

export function createFileStateStore(): FileStateStore {
  return new Map();
}

const ReadInputSchema = z
  .object({
    path: z.string().trim().min(1)
  })
  .strict();

const GlobInputSchema = z
  .object({
    pattern: z.string().trim().min(1),
    path: z.string().trim().min(1).optional()
  })
  .strict();

const GrepInputSchema = z
  .object({
    pattern: z.string().trim().min(1),
    path: z.string().trim().min(1).optional(),
    include: z.string().trim().min(1).optional(),
    headLimit: z.number().finite().positive().optional()
  })
  .strict();

const BashInputSchema = z
  .object({
    command: z.string().trim().min(1),
    timeoutMs: z.number().finite().positive().optional()
  })
  .strict();

const EditInputSchema = z
  .object({
    path: z.string().trim().min(1),
    oldString: z.string().min(1),
    newString: z.string()
  })
  .strict();

const WriteInputSchema = z
  .object({
    path: z.string().trim().min(1),
    content: z.string()
  })
  .strict();

const AgentInputSchema = z
  .object({
    description: z.string().trim().min(1),
    prompt: z.string().trim().min(1),
    subagent_type: z.enum(["general", "explore", "verifier"]).optional(),
    model: z.string().trim().min(1).optional(),
    run_in_background: z.boolean().optional()
  })
  .strict();

const READ_INPUT_JSON_SCHEMA: JsonObjectSchema = {
  type: "object",
  properties: {
    path: { type: "string", description: "Path to a file, relative to the project root." }
  },
  required: ["path"],
  additionalProperties: false
};

const GLOB_INPUT_JSON_SCHEMA: JsonObjectSchema = {
  type: "object",
  properties: {
    pattern: { type: "string", description: "Glob pattern such as **/*.ts or *.md." },
    path: {
      type: "string",
      description: "Optional directory to search from, relative to the project root."
    }
  },
  required: ["pattern"],
  additionalProperties: false
};

const GREP_INPUT_JSON_SCHEMA: JsonObjectSchema = {
  type: "object",
  properties: {
    pattern: { type: "string", description: "JavaScript regular expression to search for." },
    path: {
      type: "string",
      description: "Optional directory or file to search from, relative to the project root."
    },
    include: {
      type: "string",
      description: "Optional glob filter such as **/*.ts."
    },
    headLimit: {
      type: "number",
      description: "Maximum number of matching lines to return."
    }
  },
  required: ["pattern"],
  additionalProperties: false
};

const BASH_INPUT_JSON_SCHEMA: JsonObjectSchema = {
  type: "object",
  properties: {
    command: {
      type: "string",
      description:
        "Read-only shell command. Allowed commands: pwd, ls, cat, grep, rg, find, git status, git diff, git log."
    },
    timeoutMs: {
      type: "number",
      description: "Optional timeout in milliseconds. Maximum 30000."
    }
  },
  required: ["command"],
  additionalProperties: false
};

const EDIT_INPUT_JSON_SCHEMA: JsonObjectSchema = {
  type: "object",
  properties: {
    path: { type: "string", description: "Path to a previously-read file." },
    oldString: {
      type: "string",
      description: "Exact unique text to replace. Must match the current file content."
    },
    newString: { type: "string", description: "Replacement text." }
  },
  required: ["path", "oldString", "newString"],
  additionalProperties: false
};

const WRITE_INPUT_JSON_SCHEMA: JsonObjectSchema = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description:
        "Path to create, or path to a previously-read existing file that should be overwritten."
    },
    content: { type: "string", description: "Complete UTF-8 file content to write." }
  },
  required: ["path", "content"],
  additionalProperties: false
};

const AGENT_INPUT_JSON_SCHEMA: JsonObjectSchema = {
  type: "object",
  properties: {
    description: {
      type: "string",
      description: "Short task description for the sub-agent."
    },
    prompt: {
      type: "string",
      description: "Detailed instructions for the sub-agent."
    },
    subagent_type: {
      type: "string",
      enum: ["general", "explore", "verifier"],
      description: "Built-in sub-agent behavior. explore is read-only; verifier defaults to background."
    },
    model: {
      type: "string",
      description: "Optional model name override. Uses the same provider client."
    },
    run_in_background: {
      type: "boolean",
      description: "When true, start a local_agent task and return its task id."
    }
  },
  required: ["description", "prompt"],
  additionalProperties: false
};

export function createReadOnlyToolRegistry(): ToolDefinition[] {
  const fileStates = createFileStateStore();
  return [createReadTool(fileStates), createGlobTool(), createGrepTool()];
}

export function createProjectToolRegistry(): ToolDefinition[] {
  const fileStates = createFileStateStore();
  return [
    createReadTool(fileStates),
    createGlobTool(),
    createGrepTool(),
    createBashTool(),
    createEditTool(fileStates),
    createWriteTool(fileStates),
    createAgentTool()
  ];
}

export async function createProjectToolRegistryWithMcp(
  cwd: string,
  mcpConfigPath?: string
): Promise<ToolDefinition[]> {
  const { createMcpToolRegistry } = await import("./mcp.js");
  return [...createProjectToolRegistry(), ...(await createMcpToolRegistry(cwd, mcpConfigPath))];
}

export function createReadTool(fileStates = createFileStateStore()): ToolDefinition {
  return buildTool({
    name: "Read",
    description:
      "Read a UTF-8 text file inside the current project. Returns content with line numbers. Secrets such as .env are blocked.",
    inputSchema: ReadInputSchema,
    inputJsonSchema: READ_INPUT_JSON_SCHEMA,
    maxResultSizeChars: MAX_READ_CHARS + 10_000,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async call(input, context) {
      const state = await readFileState(context.cwd, input.path);
      fileStates.set(state.path, state);
      const clipped =
        state.content.length > MAX_READ_CHARS
          ? `${state.content.slice(0, MAX_READ_CHARS)}\n[Read output clipped at ${MAX_READ_CHARS} chars]`
          : state.content;

      return ok(numberLines(clipped));
    }
  });
}

export function createGlobTool(): ToolDefinition {
  return buildTool({
    name: "Glob",
    description:
      "Find files by glob pattern inside the current project. Use this before Read when you need to discover paths.",
    inputSchema: GlobInputSchema,
    inputJsonSchema: GLOB_INPUT_JSON_SCHEMA,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async call(input, context) {
      const searchPath = input.path ?? ".";
      const absolutePath = resolveProjectPath(context.cwd, searchPath);
      ensureInsideProject(absolutePath, context.cwd);

      const matcher = globToRegExp(normalizeSlashes(input.pattern));
      const files = await listProjectFiles(absolutePath, context.cwd);
      const matches = files.filter((file) => matcher.test(file)).sort();

      return ok(matches.length > 0 ? matches.join("\n") : "No files matched.");
    }
  });
}

export function createGrepTool(): ToolDefinition {
  return buildTool({
    name: "Grep",
    description:
      "Search text files inside the current project using a JavaScript regular expression. Returns file:line:content matches.",
    inputSchema: GrepInputSchema,
    inputJsonSchema: GREP_INPUT_JSON_SCHEMA,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    validateInput(input) {
      try {
        new RegExp(input.pattern);
        return null;
      } catch (error) {
        return `pattern must be a valid JavaScript regular expression: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
    },
    async call(input, context) {
      const searchPath = input.path ?? ".";
      const include = input.include;
      const headLimit = Math.floor(input.headLimit ?? DEFAULT_GREP_HEAD_LIMIT);
      const absolutePath = resolveProjectPath(context.cwd, searchPath);
      ensureInsideProject(absolutePath, context.cwd);

      const regexp = new RegExp(input.pattern);
      const includeMatcher = include ? globToRegExp(normalizeSlashes(include)) : null;
      const files = await filesFromPath(absolutePath, context.cwd);
      const matches: string[] = [];

      for (const file of files.sort()) {
        if (includeMatcher && !includeMatcher.test(file)) {
          continue;
        }

        const absoluteFile = resolveProjectPath(context.cwd, file);
        const content = await readFile(absoluteFile, "utf8").catch(() => "");
        const lines = content.split(/\r?\n/);

        for (let index = 0; index < lines.length; index += 1) {
          if (!regexp.test(lines[index] ?? "")) {
            continue;
          }

          matches.push(`${file}:${index + 1}:${lines[index]}`);
          if (matches.length >= headLimit) {
            return ok(matches.join("\n"));
          }
        }
      }

      return ok(matches.length > 0 ? matches.join("\n") : "No matches found.");
    }
  });
}

export function createBashTool(): ToolDefinition {
  return buildTool({
    name: "Bash",
    description:
      "Run a read-only whitelisted command in the project. Allowed: pwd, ls, cat, grep, rg, find, git status, git diff, git log. Rejects redirects, pipes, command chaining, and write-like commands.",
    inputSchema: BashInputSchema,
    inputJsonSchema: BASH_INPUT_JSON_SCHEMA,
    maxResultSizeChars: MAX_BASH_OUTPUT_CHARS + 4_000,
    isReadOnly(input, context) {
      return parseSafeBashCommand(input.command, context.cwd).ok;
    },
    isConcurrencySafe(input, context) {
      return parseSafeBashCommand(input.command, context.cwd).ok;
    },
    cancelSiblingToolsOnError(input, context) {
      return parseSafeBashCommand(input.command, context.cwd).ok;
    },
    validateInput(input, context) {
      const parsed = parseSafeBashCommand(input.command, context.cwd);
      if (!parsed.ok) {
        return parsed.error;
      }

      if (input.timeoutMs !== undefined && input.timeoutMs > MAX_BASH_TIMEOUT_MS) {
        return `timeoutMs must be <= ${MAX_BASH_TIMEOUT_MS}`;
      }

      return null;
    },
    async call(input, context) {
      const parsed = parseSafeBashCommand(input.command, context.cwd);
      if (!parsed.ok) {
        throw new Error(parsed.error);
      }

      const timeoutMs = Math.floor(
        Math.min(input.timeoutMs ?? DEFAULT_BASH_TIMEOUT_MS, MAX_BASH_TIMEOUT_MS)
      );
      const result =
        parsed.kind === "builtin"
          ? await runBuiltinCommand(parsed, context.cwd)
          : await runSpawnedCommand(
              parsed,
              context.cwd,
              timeoutMs,
              context.abortSignal,
              context.executor ?? createSpawnExecutor()
            );

      return ok(formatBashResult(parsed.displayCommand, result));
    }
  });
}

export function createEditTool(fileStates = createFileStateStore()): ToolDefinition {
  return buildTool({
    name: "Edit",
    description:
      "Safely edit a previously-read UTF-8 file using an exact unique oldString/newString replacement. Fails if the file was not read or has changed since the last Read.",
    inputSchema: EditInputSchema,
    inputJsonSchema: EDIT_INPUT_JSON_SCHEMA,
    maxResultSizeChars: 40_000,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    validateInput(input, context) {
      return validateWritableProjectPath(context.cwd, input.path);
    },
    async call(input, context) {
      const absolutePath = resolveProjectPath(context.cwd, input.path);
      const previous = await assertFreshReadState(context.cwd, input.path, fileStates, "Edit");
      const occurrences = countOccurrences(previous.content, input.oldString);

      if (occurrences === 0) {
        throw new Error("oldString was not found in the latest read content");
      }

      if (occurrences > 1) {
        throw new Error("oldString must be unique; found multiple matches");
      }

      const nextContent = previous.content.replace(input.oldString, input.newString);
      const diff = createReplacementDiff(previous.path, input.oldString, input.newString);
      await writeFile(absolutePath, nextContent, "utf8");
      const nextState = await readFileState(context.cwd, input.path);
      fileStates.set(nextState.path, nextState);

      return ok(`Edited ${previous.path}\n${diff}`);
    }
  });
}

export function createWriteTool(fileStates = createFileStateStore()): ToolDefinition {
  return buildTool({
    name: "Write",
    description:
      "Safely create a new UTF-8 file or overwrite a previously-read file. Existing files fail if they changed since the last Read.",
    inputSchema: WriteInputSchema,
    inputJsonSchema: WRITE_INPUT_JSON_SCHEMA,
    maxResultSizeChars: 40_000,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    validateInput(input, context) {
      return validateWritableProjectPath(context.cwd, input.path);
    },
    async call(input, context) {
      const absolutePath = resolveProjectPath(context.cwd, input.path);
      ensureParentDirectoryExists(absolutePath);

      const exists = existsSync(absolutePath);
      const previous = exists
        ? await assertFreshReadState(context.cwd, input.path, fileStates, "Write")
        : null;
      const normalizedPath = previous?.path ?? normalizeSlashes(relative(context.cwd, absolutePath));
      const diff = previous
        ? createWholeFileDiff(normalizedPath, previous.content, input.content)
        : createNewFileDiff(normalizedPath, input.content);

      await writeFile(absolutePath, input.content, "utf8");
      const nextState = await readFileState(context.cwd, input.path);
      fileStates.set(nextState.path, nextState);

      return ok(`${exists ? "Wrote" : "Created"} ${normalizedPath}\n${diff}`);
    }
  });
}

export function createAgentTool(): ToolDefinition {
  return buildTool({
    name: "Agent",
    description:
      "Run a sub-agent using the same query loop. Use explore for read-only code search, general for delegated analysis, and verifier for background checks.",
    inputSchema: AgentInputSchema,
    inputJsonSchema: AGENT_INPUT_JSON_SCHEMA,
    maxResultSizeChars: 60_000,
    isReadOnly(input) {
      const type = input.subagent_type ?? "general";
      return type === "explore" || type === "verifier";
    },
    isConcurrencySafe: () => false,
    validateInput(input, context) {
      if (!context.model) {
        return "Agent tool requires a model client in ToolContext";
      }
      if (!context.tools || context.tools.length === 0) {
        return "Agent tool requires the parent tool array in ToolContext";
      }
      const depth = context.subAgentDepth ?? 0;
      const maxDepth = context.maxSubAgentDepth ?? 1;
      if (depth >= maxDepth) {
        return `Agent recursion limit reached at depth ${depth}`;
      }
      const shouldRunInBackground = input.run_in_background ?? input.subagent_type === "verifier";
      if (shouldRunInBackground && !context.taskStore) {
        return "Background Agent requires a task store in ToolContext";
      }
      return null;
    },
    async call(input, context) {
      const shouldRunInBackground = input.run_in_background ?? input.subagent_type === "verifier";
      if (shouldRunInBackground) {
        return runBackgroundSubAgent(input, context);
      }
      const result = await runSynchronousSubAgent(input, context);
      return ok(formatSubAgentResult(result));
    }
  });
}

type AgentInput = z.infer<typeof AgentInputSchema>;

type SubAgentRunResult = {
  finalText: string;
  terminalStatus: string;
  traceId: string;
  prefixHash: string;
  toolHash: string;
  systemPromptHash: string;
  cacheMissSources: readonly string[];
};

async function runSynchronousSubAgent(
  input: AgentInput,
  context: ToolContext,
  signal?: AbortSignal,
  onEvent?: (line: string) => Promise<void>
): Promise<SubAgentRunResult> {
  if (!context.model || !context.tools) {
    throw new Error("Agent tool requires model and tools in ToolContext");
  }

  const subagentType = input.subagent_type ?? "general";
  const modelName = input.model ?? context.modelName ?? "unknown-model";
  const directive = buildSubAgentDirective(input);
  const prefixMessages = [...(context.parentMessages ?? [])];
  const trace = createForkTrace({
    parentDepth: context.subAgentDepth ?? 0,
    subagentType,
    model: modelName,
    systemPrompt: context.system,
    tools: context.tools,
    prefixMessages,
    directive
  });
  await context.recordForkTrace?.(trace);
  await onEvent?.(`[fork] ${trace.id} prefix=${trace.prefixHash} tools=${trace.toolHash}\n`);

  const events = await collectQuery({
    model: context.model,
    initialMessages: [
      ...prefixMessages,
      {
        role: "user",
        content: directive
      }
    ],
    tools: context.tools,
    toolContext: {
      ...context,
      abortSignal: signal ?? context.abortSignal,
      subAgentDepth: (context.subAgentDepth ?? 0) + 1,
      parentMessages: prefixMessages,
      tools: context.tools
    },
    system: context.system,
    modelName,
    maxTokens: context.maxTokens,
    maxTurns: 6,
    permissionMode: subAgentPermissionMode(subagentType, context),
    abortSignal: signal ?? context.abortSignal
  });

  for (const event of events) {
    if (event.type === "assistant_message") {
      const text = assistantText(event.message).trim();
      if (text) {
        await onEvent?.(`[assistant] ${text}\n`);
      }
    }
    if (event.type === "tool_use") {
      await onEvent?.(`[tool] ${event.toolUse.name} ${JSON.stringify(event.toolUse.input)}\n`);
    }
    if (event.type === "tool_result") {
      const detail = event.result.error ? ` error=${event.result.error}` : "";
      await onEvent?.(`[tool_result] ${event.result.status}${detail}\n`);
    }
  }

  const finalAssistant = [...events].reverse().find((event) => event.type === "assistant_message");
  const terminal = [...events].reverse().find((event) => event.type === "terminal_state");

  return {
    finalText: finalAssistant?.type === "assistant_message" ? assistantText(finalAssistant.message).trim() : "",
    terminalStatus: terminal?.type === "terminal_state" ? terminal.state.status : "missing_terminal_state",
    traceId: trace.id,
    prefixHash: trace.prefixHash,
    toolHash: trace.toolHash,
    systemPromptHash: trace.systemPromptHash,
    cacheMissSources: trace.cacheMissSources
  };
}

async function runBackgroundSubAgent(input: AgentInput, context: ToolContext): Promise<ToolCallResult> {
  if (!context.taskStore) {
    throw new Error("Background Agent requires a task store in ToolContext");
  }
  const task = await startManagedTask(
    context.taskStore,
    {
      type: "local_agent",
      description: `sub-agent: ${input.description}`,
      cwd: context.cwd,
      prompt: input.prompt
    },
    async (_task, controls) => {
      const result = await runSynchronousSubAgent(input, context, controls.signal, controls.appendOutput);
      await controls.appendOutput(formatSubAgentResult(result));
      return {
        exitCode: result.terminalStatus === "completed" ? 0 : 1,
        error: result.terminalStatus === "completed" ? undefined : `sub-agent ended with ${result.terminalStatus}`
      };
    }
  );

  return ok(
    [
      `Started background sub-agent task ${task.task.id}`,
      `description: ${task.task.description}`,
      `output: ${task.task.outputFile}`
    ].join("\n")
  );
}

function buildSubAgentDirective(input: AgentInput): string {
  const subagentType = input.subagent_type ?? "general";
  const rules = [
    `Sub-agent type: ${subagentType}`,
    `Description: ${input.description}`,
    "",
    input.prompt,
    "",
    "Return a concise final answer for the parent agent."
  ];

  if (subagentType === "explore") {
    rules.push("Use only read-only tools. Do not modify files.");
  }
  if (subagentType === "verifier") {
    rules.push("Prefer read-only checks. Report pass/fail evidence clearly.");
  }

  return rules.join("\n");
}

function subAgentPermissionMode(subagentType: string, context: ToolContext): "plan" | "default" {
  if (subagentType === "explore" || subagentType === "verifier") {
    return "plan";
  }
  return context.requestPermission ? "default" : "default";
}

function formatSubAgentResult(result: SubAgentRunResult): string {
  const lines = [
    `[sub-agent] terminal_state=${result.terminalStatus}`,
    `[fork] trace=${result.traceId}`,
    `[fork] system=${result.systemPromptHash}`,
    `[fork] tools=${result.toolHash}`,
    `[fork] prefix=${result.prefixHash}`
  ];
  if (result.cacheMissSources.length > 0) {
    lines.push(`[fork] cache_miss=${result.cacheMissSources.join(",")}`);
  }
  lines.push(result.finalText || "[sub-agent] no assistant text");
  return lines.join("\n");
}

function ok(content: string): ToolCallResult {
  return {
    status: "success",
    content
  };
}

export async function readFileState(cwd: string, target: string): Promise<FileState> {
  const absolutePath = resolveProjectPath(cwd, target);
  ensureReadableFile(absolutePath, cwd);

  const content = await readFile(absolutePath, "utf8");
  const info = await stat(absolutePath);
  return {
    path: normalizeSlashes(relative(cwd, absolutePath)),
    mtimeMs: info.mtimeMs,
    size: info.size,
    hash: hashToolOutput(content),
    content
  };
}

async function assertFreshReadState(
  cwd: string,
  target: string,
  fileStates: FileStateStore,
  toolName: "Edit" | "Write"
): Promise<FileState> {
  const absolutePath = resolveProjectPath(cwd, target);
  ensureWritableFilePath(absolutePath, cwd);

  const normalizedPath = normalizeSlashes(relative(cwd, absolutePath));
  const previous = fileStates.get(normalizedPath);
  if (!previous) {
    throw new Error(`${toolName} requires a prior Read of ${normalizedPath}`);
  }

  const current = await readFileState(cwd, normalizedPath);
  if (
    current.mtimeMs !== previous.mtimeMs ||
    current.size !== previous.size ||
    current.hash !== previous.hash
  ) {
    throw new Error(`${normalizedPath} changed since the last Read; run Read again before ${toolName}`);
  }

  return previous;
}

function validateWritableProjectPath(cwd: string, target: string): string | null {
  try {
    const absolutePath = resolveProjectPath(cwd, target);
    ensureWritableFilePath(absolutePath, cwd);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function ensureWritableFilePath(absolutePath: string, cwd: string): void {
  ensureInsideProject(absolutePath, cwd);
  if (isBlockedPath(absolutePath, cwd) && !isAllowedMemoryPath(absolutePath, cwd)) {
    throw new Error("Writing this path is blocked by the safety policy");
  }
}

function ensureParentDirectoryExists(absolutePath: string): void {
  if (!existsSync(dirname(absolutePath))) {
    throw new Error("Parent directory does not exist");
  }
}

function countOccurrences(content: string, needle: string): number {
  let count = 0;
  let position = 0;
  while (position < content.length) {
    const next = content.indexOf(needle, position);
    if (next === -1) {
      return count;
    }
    count += 1;
    position = next + needle.length;
  }
  return count;
}

function createReplacementDiff(path: string, oldString: string, newString: string): string {
  return [
    `--- ${path}`,
    `+++ ${path}`,
    "@@",
    ...prefixDiffLines("-", oldString),
    ...prefixDiffLines("+", newString)
  ].join("\n");
}

function createNewFileDiff(path: string, content: string): string {
  return [`--- /dev/null`, `+++ ${path}`, "@@", ...prefixDiffLines("+", content)].join("\n");
}

function createWholeFileDiff(path: string, before: string, after: string): string {
  return [
    `--- ${path}`,
    `+++ ${path}`,
    "@@",
    ...prefixDiffLines("-", before, 80),
    ...prefixDiffLines("+", after, 80)
  ].join("\n");
}

function prefixDiffLines(prefix: "+" | "-", content: string, maxLines = 60): string[] {
  const lines = content.split(/\r?\n/);
  const clipped = lines.slice(0, maxLines).map((line) => `${prefix}${line}`);
  if (lines.length > maxLines) {
    clipped.push(`${prefix}[diff clipped after ${maxLines} lines]`);
  }
  return clipped;
}

function resolveProjectPath(cwd: string, target: string): string {
  return resolve(cwd, target);
}

function ensureInsideProject(absolutePath: string, cwd: string): void {
  const relativePath = normalizeSlashes(relative(cwd, absolutePath));
  if (relativePath === ".." || relativePath.startsWith("../") || relativePath.startsWith("..\\")) {
    throw new Error("Path is outside the project root");
  }
}

function ensureReadableFile(absolutePath: string, cwd: string): void {
  ensureInsideProject(absolutePath, cwd);
  if (isBlockedPath(absolutePath, cwd) && !isAllowedMemoryPath(absolutePath, cwd)) {
    throw new Error("Reading this path is blocked by the read-only safety policy");
  }
  if (!existsSync(absolutePath)) {
    throw new Error("File does not exist");
  }
}

async function filesFromPath(absolutePath: string, cwd: string): Promise<string[]> {
  const info = await stat(absolutePath);
  if (info.isFile()) {
    if (isBlockedPath(absolutePath, cwd) && !isAllowedMemoryPath(absolutePath, cwd)) {
      return [];
    }
    return [normalizeSlashes(relative(cwd, absolutePath))];
  }

  return listProjectFiles(absolutePath, cwd);
}

async function listProjectFiles(root: string, cwd: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const absolutePath = resolve(root, entry.name);
    if (isBlockedPath(absolutePath, cwd) && !isAllowedMemorySearchPath(absolutePath, cwd)) {
      continue;
    }

    if (entry.isDirectory()) {
      files.push(...(await listProjectFiles(absolutePath, cwd)));
      continue;
    }

    if (entry.isFile()) {
      files.push(normalizeSlashes(relative(cwd, absolutePath)));
    }
  }

  return files;
}

function isBlockedPath(absolutePath: string, cwd: string): boolean {
  const relativePath = normalizeSlashes(relative(cwd, absolutePath));
  const parts = relativePath.split("/");
  return parts.some((part) => SKIPPED_DIRS.has(part)) || BLOCKED_FILES.has(basename(absolutePath));
}

function isAllowedMemoryPath(absolutePath: string, cwd: string): boolean {
  const relativePath = normalizeSlashes(relative(cwd, absolutePath));
  const parts = relativePath.split("/");
  return parts[0] === ".myagent" && parts[1] === "projects" && parts[3] === "memory";
}

function isAllowedMemorySearchPath(absolutePath: string, cwd: string): boolean {
  const relativePath = normalizeSlashes(relative(cwd, absolutePath));
  const parts = relativePath.split("/");
  if (parts[0] !== ".myagent") {
    return false;
  }
  if (parts.length === 1) {
    return true;
  }
  if (parts[1] !== "projects") {
    return false;
  }
  if (parts.length <= 3) {
    return true;
  }
  return parts[3] === "memory";
}

function normalizeSlashes(path: string): string {
  return path.replace(/\\/g, "/");
}

function numberLines(content: string): string {
  return content
    .split(/\r?\n/)
    .map((line, index) => `${String(index + 1).padStart(6, " ")}\t${line}`)
    .join("\n");
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];

    if (char === "*" && next === "*" && pattern[index + 2] === "/") {
      source += "(?:.*/)?";
      index += 2;
      continue;
    }

    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
      continue;
    }

    if (char === "*") {
      source += "[^/]*";
      continue;
    }

    if (char === "?") {
      source += "[^/]";
      continue;
    }

    source += escapeRegExp(char ?? "");
  }

  return new RegExp(`${source}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

type SafeBashCommand =
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

type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

function parseSafeBashCommand(command: string, cwd: string): SafeBashCommand {
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

  if (executable === "rm" || executable === "mv") {
    return { ok: false, error: `${executable} is not allowed in the Week 4 Bash whitelist` };
  }

  const pathError = validateBashPathArguments(executable, args, cwd);
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

    if (subcommand === "commit") {
      return { ok: false, error: "git commit is not allowed in the Week 4 Bash whitelist" };
    }

    return { ok: false, error: "Only git status, git diff, and git log are allowed" };
  }

  return { ok: false, error: `Command is not in the Week 4 Bash whitelist: ${rawExecutable}` };
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
      if (current.length > 0) {
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

  if (current.length > 0) {
    tokens.push(current);
  }

  return { ok: true, tokens };
}

function validateBashPathArguments(command: string, args: string[], cwd: string): string | null {
  for (const arg of args) {
    if (arg === ".") {
      continue;
    }

    if (arg.includes("\0")) {
      return "Bash command rejected: null bytes are not allowed";
    }

    if (arg === ".env" || normalizeSlashes(arg).split("/").includes(".env")) {
      return "Bash command rejected: .env is blocked";
    }

    if (arg.startsWith("..") || normalizeSlashes(arg).includes("/../") || isAbsolute(arg)) {
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
    return "pwd does not accept arguments in the Week 4 Bash whitelist";
  }

  return null;
}

async function runBuiltinCommand(command: Extract<SafeBashCommand, { kind: "builtin" }>, cwd: string): Promise<CommandResult> {
  if (command.command === "pwd") {
    return { stdout: cwd, stderr: "", exitCode: 0 };
  }

  if (command.command === "ls") {
    const target = firstPathArg(command.args) ?? ".";
    const absolutePath = resolveProjectPath(cwd, target);
    ensureInsideProject(absolutePath, cwd);
    if (isBlockedPath(absolutePath, cwd) && !isAllowedMemoryPath(absolutePath, cwd)) {
      throw new Error("ls target is blocked by the safety policy");
    }

    const entries = await readdir(absolutePath, { withFileTypes: true });
    const stdout = entries
      .filter((entry) => {
        const entryPath = resolve(absolutePath, entry.name);
        return !isBlockedPath(entryPath, cwd) || isAllowedMemorySearchPath(entryPath, cwd);
      })
      .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
      .sort()
      .join("\n");
    return { stdout, stderr: "", exitCode: 0 };
  }

  if (command.command === "cat") {
    const paths = command.args.filter((arg) => !arg.startsWith("-"));
    const chunks: string[] = [];
    for (const path of paths) {
      const state = await readFileState(cwd, path);
      chunks.push(state.content);
    }
    return { stdout: chunks.join("\n"), stderr: "", exitCode: 0 };
  }

  const target = firstPathArg(command.args) ?? ".";
  const absolutePath = resolveProjectPath(cwd, target);
  ensureInsideProject(absolutePath, cwd);
  const files = await listProjectFiles(absolutePath, cwd);
  return { stdout: files.sort().join("\n"), stderr: "", exitCode: 0 };
}

function firstPathArg(args: string[]): string | undefined {
  return args.find((arg) => !arg.startsWith("-"));
}

async function runSpawnedCommand(
  command: Extract<SafeBashCommand, { kind: "spawn" }>,
  cwd: string,
  timeoutMs: number,
  abortSignal: AbortSignal | undefined,
  executor: CommandExecutor
): Promise<CommandResult> {
  try {
    const { stdout, stderr, exitCode } = await executor.run({
      command: command.executable,
      args: command.args,
      cwd,
      shell: false,
      windowsHide: true,
      timeoutMs,
      abortSignal,
      outputSink: { kind: "capture", maxBytes: MAX_BASH_OUTPUT_CHARS }
    });
    return { stdout, stderr, exitCode };
  } catch (error) {
    // Preserve the previous error vocabulary so existing tests / users
    // see the same messages: "Bash command aborted" / "... timed out".
    if (error instanceof Error) {
      if (error.message === "Command aborted") {
        throw new Error("Bash command aborted");
      }
      if (error.message.startsWith("Command timed out after ")) {
        throw new Error(`Bash command timed out after ${timeoutMs}ms`);
      }
    }
    throw error;
  }
}


function formatBashResult(command: string, result: CommandResult): string {
  const parts = [`$ ${command}`];
  if (result.stdout.trim().length > 0) {
    parts.push(result.stdout.trimEnd());
  }
  if (result.stderr.trim().length > 0) {
    parts.push("[stderr]", result.stderr.trimEnd());
  }
  parts.push(`[exit ${result.exitCode ?? "unknown"}]`);
  return parts.join("\n");
}

export function hashToolOutput(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
