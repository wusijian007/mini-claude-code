import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import {
  createSpawnExecutor,
  createTaskStore,
  runLocalBashTask,
  type CommandExecutor,
  type ExecutorRunInput
} from "../../src/index.js";

function recordingExecutor(result: {
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
}): { executor: CommandExecutor; calls: ExecutorRunInput[] } {
  const calls: ExecutorRunInput[] = [];
  const executor: CommandExecutor = {
    async run(input) {
      calls.push(input);
      return {
        exitCode: result.exitCode ?? 0,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        timedOut: result.timedOut ?? false
      };
    }
  };
  return { executor, calls };
}

describe("security: command executor seam", () => {
  it("createSpawnExecutor runs a real process and captures stdout (smoke)", async () => {
    const executor = createSpawnExecutor();
    const result = await executor.run({
      command: process.execPath,
      args: ["-e", "console.log('hello-from-executor')"],
      cwd: process.cwd(),
      shell: false,
      outputSink: { kind: "capture" }
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello-from-executor");
    expect(result.timedOut).toBe(false);
  });

  it("createSpawnExecutor honors abortSignal and rejects with 'Command aborted'", async () => {
    const executor = createSpawnExecutor();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const promise = executor.run({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      shell: false,
      abortSignal: controller.signal
    });
    await expect(promise).rejects.toThrow(/Command aborted/);
  });

  it("createSpawnExecutor enforces timeoutMs and sets timedOut on the error path", async () => {
    const executor = createSpawnExecutor();
    const promise = executor.run({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      shell: false,
      timeoutMs: 20
    });
    await expect(promise).rejects.toThrow(/timed out/);
  });

  it("task worker routes its spawned commands through the injected executor", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "myagent-sec-executor-task-"));
    const store = createTaskStore(cwd);
    const task = await store.create({
      type: "local_bash",
      description: "executor smoke",
      cwd,
      command: "git status"
    });

    const { executor, calls } = recordingExecutor({ exitCode: 0 });
    const finished = await runLocalBashTask(store, task.id, executor);

    expect(finished.state).toBe("completed");
    expect(finished.exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: "git",
      args: ["status"],
      shell: false,
      windowsHide: true
    });
    // cwd is normalized (forward slashes) by the task store before the
    // executor receives it; compare normalized forms.
    expect(calls[0]?.cwd.replace(/\\/g, "/")).toBe(cwd.replace(/\\/g, "/"));
    // The task worker pipes stdout/stderr directly to the task output
    // file, not to in-memory capture — verify the executor was told so.
    expect(calls[0]?.outputSink?.kind).toBe("fd");
  });

  it("task worker surfaces a non-zero exit from the injected executor as state=failed", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "myagent-sec-executor-task-fail-"));
    const store = createTaskStore(cwd);
    const task = await store.create({
      type: "local_bash",
      description: "executor failure path",
      cwd,
      command: "git status"
    });

    const { executor } = recordingExecutor({ exitCode: 2, stderr: "fatal: simulated" });
    const finished = await runLocalBashTask(store, task.id, executor);

    expect(finished.state).toBe("failed");
    expect(finished.exitCode).toBe(2);
  });

  it("task worker's onPid callback records the pid on the task record", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "myagent-sec-executor-pid-"));
    const store = createTaskStore(cwd);
    const task = await store.create({
      type: "local_bash",
      description: "pid recording",
      cwd,
      command: "git status"
    });

    // Custom executor that fires onPid before resolving.
    const executor: CommandExecutor = {
      async run(input) {
        input.onPid?.(424242);
        // Give the patch a tick to settle before resolving.
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
      }
    };

    const finished = await runLocalBashTask(store, task.id, executor);
    expect(finished.pid).toBe(424242);
  });

  it("Bash tool builtins (pwd/ls/cat/find) do not call the executor — they stay in-process", async () => {
    // This test is a *negative* assertion: if anything routes Bash
    // builtins through the executor seam in the future, the calls
    // array would grow and we'd want a deliberate decision about it.
    const cwd = mkdtempSync(join(tmpdir(), "myagent-sec-executor-builtin-"));
    writeFileSync(join(cwd, "fixture.txt"), "fixture content\n", "utf8");

    const { executeToolUse } = await import("../../src/index.js");
    const { createProjectToolRegistry } = await import("../../../tools/src/index.js");
    const tools = createProjectToolRegistry();
    const { executor, calls } = recordingExecutor({ exitCode: 0 });

    const result = await executeToolUse(
      {
        id: "toolu_bash_builtin",
        name: "Bash",
        input: { command: "pwd" }
      },
      new Map(tools.map((tool) => [tool.name, tool])),
      { cwd, permissionMode: "bypassPermissions", executor }
    );

    expect(result.status).toBe("success");
    // pwd is a builtin, not a spawn — the executor must NOT see it.
    expect(calls).toHaveLength(0);
    // Sanity: the result still shows the temp dir's tail name, as before.
    const tailSegment = cwd.split(/[\\/]/).pop() ?? "";
    expect(result.status === "success" ? result.content : "").toContain(tailSegment);

    // Verify that a Bash spawn target (like rg) WOULD route through:
    const grepResult = await executeToolUse(
      {
        id: "toolu_bash_spawn",
        name: "Bash",
        input: { command: "rg fixture" }
      },
      new Map(tools.map((tool) => [tool.name, tool])),
      { cwd, permissionMode: "bypassPermissions", executor }
    );
    expect(grepResult.status).toBe("success");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("rg");
    expect(calls[0]?.args).toEqual(["fixture"]);
  });
});
