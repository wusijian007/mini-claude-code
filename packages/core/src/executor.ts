import { spawn, type StdioOptions } from "node:child_process";

/**
 * The single seam for executing external commands from myagent. Every
 * tool or task that needs to spawn a non-myagent process routes through
 * here, so a future sandbox runtime (Docker, Firecracker, WSL, ...) can
 * be dropped in without touching the call sites.
 *
 * Two call sites use this seam today (M2.1):
 *   - the Bash tool's `runSpawnedCommand` (git/rg/grep, in-memory capture)
 *   - the task worker's `runSpawnedReadOnlyCommand` (same commands,
 *     output piped directly to a task output file descriptor)
 *
 * Three things deliberately stay off this seam:
 *   - the Bash tool's *builtin* commands (pwd/ls/cat/find) — pure JS,
 *     no process involved
 *   - the hooks runner (`shell: true`, exit-code-2 blocking semantics
 *     are hook-pipeline specific; conflating with the executor would
 *     muddle the contract)
 *   - the CLI's `startDetachedTaskWorker` (spawns myagent's own binary
 *     to run a background task worker — process control flow, not
 *     external command execution)
 */
export type CommandExecutor = {
  run(input: ExecutorRunInput): Promise<ExecutorRunResult>;
};

export type ExecutorRunInput = {
  command: string;
  args: readonly string[];
  cwd: string;
  shell?: boolean;
  windowsHide?: boolean;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  /**
   * How to handle stdout/stderr.
   *
   * - `{ kind: "capture", maxBytes }`: collect into the result's
   *   `stdout`/`stderr` strings, truncating mid-stream if the cap is
   *   reached. Default `maxBytes` is `Infinity`.
   * - `{ kind: "fd", fd }`: pipe both stdout and stderr directly to the
   *   given OS file descriptor (avoids buffering large output in memory;
   *   used by the task worker so a long-running command can stream
   *   gigabytes without blowing the process heap).
   *
   * Default is `{ kind: "capture" }`.
   */
  outputSink?:
    | { kind: "capture"; maxBytes?: number }
    | { kind: "fd"; fd: number };
  /**
   * Optional payload to write to stdin before closing it. The default
   * executor opens a stdin pipe only when this is set.
   */
  stdinPayload?: string;
  /**
   * Called once with the OS pid as soon as the process is launched.
   * Used by the task worker to record the pid on the task record before
   * awaiting the result.
   */
  onPid?: (pid: number) => void;
};

export type ExecutorRunResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

/**
 * The default executor: a thin wrapper around `child_process.spawn`.
 *
 * Returning a single, well-typed result Promise (instead of a
 * ChildProcess-like object) is what makes tests easy — a mock executor
 * is just `{ run: async () => ({ stdout, stderr, exitCode, timedOut }) }`.
 */
export function createSpawnExecutor(): CommandExecutor {
  return {
    run(input: ExecutorRunInput): Promise<ExecutorRunResult> {
      return new Promise<ExecutorRunResult>((resolvePromise, reject) => {
        const sink = input.outputSink ?? { kind: "capture" as const };
        const stdio: StdioOptions =
          sink.kind === "fd"
            ? [input.stdinPayload !== undefined ? "pipe" : "ignore", sink.fd, sink.fd]
            : [input.stdinPayload !== undefined ? "pipe" : "ignore", "pipe", "pipe"];

        const child = spawn(input.command, [...input.args], {
          cwd: input.cwd,
          shell: input.shell ?? false,
          windowsHide: input.windowsHide ?? true,
          env: input.env,
          stdio
        });

        if (child.pid !== undefined) {
          input.onPid?.(child.pid);
        }

        let stdout = "";
        let stderr = "";
        let settled = false;
        let timedOut = false;
        const maxBytes = sink.kind === "capture" ? sink.maxBytes ?? Infinity : 0;

        const cleanup = () => {
          if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
          input.abortSignal?.removeEventListener("abort", onAbort);
        };

        const finishOk = (exitCode: number | null) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolvePromise({ exitCode, stdout, stderr, timedOut });
        };

        const finishErr = (error: Error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        };

        const onAbort = () => {
          child.kill();
          finishErr(new Error("Command aborted"));
        };

        const timeoutHandle =
          input.timeoutMs !== undefined
            ? setTimeout(() => {
                timedOut = true;
                child.kill();
                finishErr(new Error(`Command timed out after ${input.timeoutMs}ms`));
              }, input.timeoutMs)
            : undefined;

        if (input.abortSignal?.aborted) {
          onAbort();
          return;
        }
        input.abortSignal?.addEventListener("abort", onAbort, { once: true });

        if (sink.kind === "capture") {
          child.stdout?.on("data", (chunk: Buffer) => {
            stdout = capString(stdout + chunk.toString("utf8"), maxBytes);
          });
          child.stderr?.on("data", (chunk: Buffer) => {
            stderr = capString(stderr + chunk.toString("utf8"), maxBytes);
          });
        }
        child.on("error", finishErr);
        child.on("close", finishOk);

        if (input.stdinPayload !== undefined && child.stdin) {
          child.stdin.end(input.stdinPayload);
        }
      });
    }
  };
}

function capString(value: string, maxBytes: number): string {
  if (maxBytes === Infinity || value.length <= maxBytes) {
    return value;
  }
  return `${value.slice(0, maxBytes)}\n[output clipped at ${maxBytes} chars]`;
}
