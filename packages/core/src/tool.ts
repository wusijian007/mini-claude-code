import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type {
  HookWarning,
  ModelToolDefinition,
  PermissionMode,
  ToolCallResult,
  ToolContext,
  ToolDefinition,
  ToolResult,
  ToolUse
} from "./types.js";
import { appendHookWarnings, runToolHooks } from "./hooks.js";

const DEFAULT_MAX_RESULT_SIZE_CHARS = 120_000;
const DEFAULT_TOOL_RESULT_PREVIEW_CHARS = 2_048;

/**
 * M4.1 (L1) — a compact head+tail preview of an oversized value. Keeps the
 * first ~70% and last ~30% of `maxChars` with an omitted-count marker between,
 * because both the start (what the output is) and the end (the final line /
 * error / summary) of a large tool output are usually the informative parts —
 * a pure prefix slice throws the tail away. Returns the value unchanged when it
 * already fits.
 */
export function smartPreview(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content;
  }
  const head = Math.max(1, Math.floor(maxChars * 0.7));
  const tail = Math.max(0, maxChars - head);
  const omitted = content.length - head - tail;
  if (tail <= 0) {
    return `${content.slice(0, head)}\n[... ${omitted} chars omitted ...]`;
  }
  return `${content.slice(0, head)}\n[... ${omitted} chars omitted ...]\n${content.slice(-tail)}`;
}

export type BuildToolOptions<TInput extends Record<string, unknown>> = {
  name: string;
  description: string;
  inputSchema: ToolDefinition<TInput>["inputSchema"];
  inputJsonSchema: ToolDefinition<TInput>["inputJsonSchema"];
  maxResultSizeChars?: number;
  isReadOnly?: (input: TInput, context: ToolContext) => boolean;
  isConcurrencySafe?: (input: TInput, context: ToolContext) => boolean;
  cancelSiblingToolsOnError?: (input: TInput, context: ToolContext) => boolean;
  validateInput?: ToolDefinition<TInput>["validateInput"];
  call(input: TInput, context: ToolContext): Promise<ToolCallResult> | ToolCallResult;
};

export function buildTool<TInput extends Record<string, unknown>>(
  options: BuildToolOptions<TInput>
): ToolDefinition<TInput> {
  return {
    name: options.name,
    description: options.description,
    inputSchema: options.inputSchema,
    inputJsonSchema: options.inputJsonSchema,
    maxResultSizeChars: options.maxResultSizeChars,
    isReadOnly: options.isReadOnly ?? (() => false),
    isConcurrencySafe: options.isConcurrencySafe ?? (() => false),
    cancelSiblingToolsOnError: options.cancelSiblingToolsOnError,
    validateInput: options.validateInput,
    call: options.call
  };
}

export function toModelToolDefinition(tool: ToolDefinition): ModelToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputJsonSchema
  };
}

export async function executeToolUse(
  toolUse: ToolUse,
  toolsByName: ReadonlyMap<string, ToolDefinition>,
  context: ToolContext
): Promise<ToolResult> {
  const tool = toolsByName.get(toolUse.name);
  if (!tool) {
    return toolError(toolUse, `Unknown tool: ${toolUse.name}`);
  }

  if (context.abortSignal?.aborted) {
    return toolError(toolUse, "Tool execution aborted before start");
  }

  const parsed = tool.inputSchema.safeParse(toolUse.input);
  if (!parsed.success) {
    return toolError(toolUse, formatZodError(parsed.error.issues));
  }

  const input = parsed.data;
  const semanticError = await tool.validateInput?.(input, context);
  if (semanticError) {
    return toolError(toolUse, semanticError);
  }

  const permissionError = await permissionErrorFor(tool, input, context, context.permissionMode ?? "default");
  if (permissionError) {
    return toolError(toolUse, permissionError);
  }

  const preHookResult = await runToolHooks(context.hookSnapshot, {
    event: "PreToolUse",
    cwd: context.cwd,
    toolUse
  });
  if (preHookResult.status === "blocked") {
    return toolError(toolUse, formatHookBlock(preHookResult.hookName, "PreToolUse", preHookResult.reason));
  }
  const warnings: HookWarning[] = [...preHookResult.warnings];

  try {
    const result = await tool.call(input, context);
    const budgetedResult = await budgetToolResult(
      toolUse,
      result,
      context,
      resolveResultBudget(tool.maxResultSizeChars, context.toolResultBudgetChars)
    );
    const toolResult: ToolResult = {
      toolUseId: toolUse.id,
      ...budgetedResult
    };
    const postHookResult = await runToolHooks(context.hookSnapshot, {
      event: "PostToolUse",
      cwd: context.cwd,
      toolUse,
      result: toolResult
    });
    if (postHookResult.status === "blocked") {
      return toolError(toolUse, formatHookBlock(postHookResult.hookName, "PostToolUse", postHookResult.reason));
    }
    warnings.push(...postHookResult.warnings);
    return appendHookWarnings(toolResult, warnings);
  } catch (error) {
    return toolError(toolUse, error instanceof Error ? error.message : String(error));
  }
}

function formatHookBlock(hookName: string, event: string, reason: string): string {
  return `Blocked by ${event} hook ${hookName}: ${reason}`;
}

function resolveResultBudget(toolBudget: number | undefined, contextBudget: number | undefined): number {
  const budgets = [toolBudget, contextBudget, DEFAULT_MAX_RESULT_SIZE_CHARS].filter(
    (value): value is number => value !== undefined
  );
  return Math.min(...budgets);
}

async function permissionErrorFor(
  tool: ToolDefinition,
  input: Record<string, unknown>,
  context: ToolContext,
  mode: PermissionMode
): Promise<string | null> {
  if (mode === "bypassPermissions") {
    return null;
  }

  if (tool.isReadOnly(input, context)) {
    return null;
  }

  if (mode === "plan") {
    return `Permission denied: ${tool.name} is not read-only, and plan mode only allows read-only tools.`;
  }

  if (context.requestPermission) {
    const reason = `${tool.name} is not read-only`;
    const decision = await context.requestPermission({
      toolName: tool.name,
      input,
      reason
    });
    if (decision.kind === "allow") {
      return null;
    }
    return decision.reason
      ? `Permission denied: ${decision.reason}`
      : `Permission denied: ${tool.name} is not read-only.`;
  }

  return `Permission required: ${tool.name} is not read-only. Interactive approval is not implemented in Week 3.`;
}

async function budgetToolResult(
  toolUse: ToolUse,
  result: ToolCallResult,
  context: ToolContext,
  maxChars: number
): Promise<ToolCallResult & { artifactPath?: string }> {
  if (result.content.length <= maxChars) {
    return result;
  }

  // M4.1 — the preview kept inline is decoupled from the spill threshold: a
  // small head+tail smart preview, not up-to-`maxChars` of pure prefix.
  const previewChars = Math.min(context.toolResultPreviewChars ?? DEFAULT_TOOL_RESULT_PREVIEW_CHARS, maxChars);
  const preview = smartPreview(result.content, previewChars);

  if (context.artifactDir) {
    const artifactPath = await writeToolResultArtifact(context.artifactDir, toolUse.name, result.content);
    return {
      ...result,
      artifactPath,
      content: `${preview}\n[Tool output ${result.content.length} chars exceeded budget. Full output saved to ${artifactPath} — use Read to see all of it]`
    };
  }

  return {
    ...result,
    content: `${preview}\n[Tool output clipped: ${result.content.length} chars, ${previewChars} kept]`
  };
}

export async function writeToolResultArtifact(
  artifactDir: string,
  label: string,
  content: string
): Promise<string> {
  const absoluteDir = resolve(artifactDir);
  await mkdir(absoluteDir, { recursive: true });
  const safeName = label.replace(/[^A-Za-z0-9_-]/g, "_");
  const artifactPath = resolve(absoluteDir, `${Date.now()}-${safeName}-${randomUUID().slice(0, 8)}.txt`);
  await writeFile(artifactPath, content, "utf8");
  return artifactPath.replace(/\\/g, "/");
}

function toolError(toolUse: ToolUse, error: string): ToolResult {
  return {
    toolUseId: toolUse.id,
    status: "error",
    content: "",
    error
  };
}

function formatZodError(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  const details = issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "input";
      return `${path}: ${issue.message}`;
    })
    .join("; ");

  return `Invalid tool input: ${details}`;
}
