import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { normalizePath } from "./state.js";
import type {
  HookCommand,
  HookEventName,
  HookRunPayload,
  HookRunResult,
  HookSnapshot,
  HookWarning,
  ToolResult,
  ToolUse
} from "./types.js";

const DEFAULT_HOOK_TIMEOUT_MS = 10_000;
const MAX_HOOK_OUTPUT_CHARS = 40_000;

type RawHookConfig = {
  hooks?: Array<{
    name?: unknown;
    event?: unknown;
    command?: unknown;
    tools?: unknown;
    timeoutMs?: unknown;
  }>;
};

export async function loadHookSnapshot(cwd: string, configPath?: string): Promise<HookSnapshot> {
  const resolvedPath = normalizePath(resolve(configPath ?? join(cwd, ".myagent", "hooks.json")));
  if (!existsSync(resolvedPath)) {
    return freezeHookSnapshot({
      configPath: resolvedPath,
      loadedAt: new Date().toISOString(),
      hooks: []
    });
  }

  const parsed = JSON.parse(await readFile(resolvedPath, "utf8")) as RawHookConfig;
  const hooks = (parsed.hooks ?? []).map(normalizeHookCommand).filter((hook): hook is HookCommand => hook !== null);
  return freezeHookSnapshot({
    configPath: resolvedPath,
    loadedAt: new Date().toISOString(),
    hooks
  });
}

export async function runToolHooks(
  snapshot: HookSnapshot | undefined,
  payload: HookRunPayload
): Promise<HookRunResult> {
  const hooks = matchingHooks(snapshot, payload.event, payload.toolUse);
  const warnings: HookWarning[] = [];

  for (const hook of hooks) {
    const result = await runCommandHook(hook, payload);
    if (result.exitCode === 0) {
      continue;
    }

    const message = hookOutputMessage(result.stdout, result.stderr, result.exitCode);
    if (result.exitCode === 2) {
      return {
        status: "blocked",
        hookName: hook.name,
        reason: message,
        warnings
      };
    }

    warnings.push({
      hookName: hook.name,
      event: hook.event,
      message
    });
  }

  return {
    status: "passed",
    warnings
  };
}

export function appendHookWarnings(result: ToolResult, warnings: readonly HookWarning[]): ToolResult {
  if (warnings.length === 0) {
    return result;
  }

  const formatted = warnings
    .map((warning) => `[hook warning:${warning.event}:${warning.hookName}] ${warning.message}`)
    .join("\n");
  return {
    ...result,
    content: result.content ? `${result.content}\n${formatted}` : formatted
  };
}

function normalizeHookCommand(raw: NonNullable<RawHookConfig["hooks"]>[number]): HookCommand | null {
  if (typeof raw.name !== "string" || typeof raw.event !== "string" || typeof raw.command !== "string") {
    return null;
  }

  if (!isHookEventName(raw.event) || raw.command.trim().length === 0) {
    return null;
  }

  const tools =
    Array.isArray(raw.tools) && raw.tools.every((tool): tool is string => typeof tool === "string")
      ? Object.freeze([...raw.tools])
      : undefined;
  const timeoutMs =
    typeof raw.timeoutMs === "number" && Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0
      ? Math.floor(raw.timeoutMs)
      : undefined;

  return Object.freeze({
    name: raw.name,
    event: raw.event,
    command: raw.command,
    tools,
    timeoutMs
  });
}

function isHookEventName(value: string): value is HookEventName {
  return value === "PreToolUse" || value === "PostToolUse";
}

function matchingHooks(
  snapshot: HookSnapshot | undefined,
  event: HookEventName,
  toolUse: ToolUse
): readonly HookCommand[] {
  return (snapshot?.hooks ?? []).filter((hook) => {
    if (hook.event !== event) {
      return false;
    }
    return !hook.tools || hook.tools.includes(toolUse.name);
  });
}

function runCommandHook(
  hook: HookCommand,
  payload: HookRunPayload
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(hook.command, {
      cwd: payload.cwd,
      shell: true,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill();
      finish({
        exitCode: 124,
        stdout,
        stderr: `${stderr}\nHook timed out after ${hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS}ms`
      });
    }, hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS);

    const finish = (result: { exitCode: number | null; stdout: string; stderr: string }) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolvePromise(result);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = capOutput(stdout + chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = capOutput(stderr + chunk.toString("utf8"));
    });
    child.on("error", (error) => {
      finish({ exitCode: 1, stdout, stderr: error.message });
    });
    child.on("close", (exitCode) => {
      finish({ exitCode, stdout, stderr });
    });
    child.stdin.end(`${JSON.stringify(toHookStdin(hook, payload))}\n`);
  });
}

function toHookStdin(hook: HookCommand, payload: HookRunPayload): Record<string, unknown> {
  return {
    event: payload.event,
    hookName: hook.name,
    cwd: payload.cwd,
    toolUse: payload.toolUse,
    result: payload.result,
    at: new Date().toISOString()
  };
}

function hookOutputMessage(stdout: string, stderr: string, exitCode: number | null): string {
  const parts = [`exit ${exitCode ?? "unknown"}`];
  if (stdout.trim()) {
    parts.push(stdout.trim());
  }
  if (stderr.trim()) {
    parts.push(stderr.trim());
  }
  return parts.join(": ");
}

function capOutput(value: string): string {
  if (value.length <= MAX_HOOK_OUTPUT_CHARS) {
    return value;
  }
  return `${value.slice(0, MAX_HOOK_OUTPUT_CHARS)}\n[hook output clipped at ${MAX_HOOK_OUTPUT_CHARS} chars]`;
}

function freezeHookSnapshot(snapshot: HookSnapshot): HookSnapshot {
  return Object.freeze({
    ...snapshot,
    hooks: Object.freeze([...snapshot.hooks])
  });
}
