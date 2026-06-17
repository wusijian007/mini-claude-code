import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import {
  collectTaskNotifications,
  createTaskScheduler,
  createTaskStore,
  isTerminalTaskState,
  markTaskKilled,
  normalizePath,
  parseReadOnlyBashCommand,
  runLocalBashTask,
  startManagedTask
} from "../src/index.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("task state machine", () => {
  it("runs a background read-only Bash task, persists output, and completes", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "myagent-task-bash-"));
    const store = createTaskStore(cwd);
    const task = await store.create({
      type: "local_bash",
      description: "print cwd",
      command: "pwd",
      cwd
    });

    const completed = await runLocalBashTask(store, task.id);
    const output = await store.readOutput(task.id);
    const restartedStore = createTaskStore(cwd);
    const restartedOutput = await restartedStore.readOutput(task.id);

    expect(completed).toMatchObject({ state: "completed", exitCode: 0 });
    expect(isTerminalTaskState(completed.state)).toBe(true);
    expect(output.content).toContain("$ pwd");
    expect(output.content).toContain(normalizePath(cwd));
    expect(restartedOutput.content).toBe(output.content);
    expect(await readFile(task.outputFile, "utf8")).toBe(output.content);
  });

  it("supports incremental output reads by byte offset", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "myagent-task-output-"));
    const store = createTaskStore(cwd);
    const task = await store.create({
      type: "local_bash",
      description: "incremental fixture",
      command: "pwd",
      cwd
    });

    await store.appendOutput(task.id, "first\n");
    const first = await store.readOutput(task.id);
    await store.appendOutput(task.id, "second\n");
    const second = await store.readOutput(task.id, { offset: first.nextOffset });

    expect(first.content).toBe("first\n");
    expect(second.content).toBe("second\n");
    expect(second.offset).toBe(first.nextOffset);
  });

  it("kills an in-process background task and records killed state", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "myagent-task-kill-"));
    const store = createTaskStore(cwd);
    const managed = await startManagedTask(
      store,
      {
        type: "local_bash",
        description: "wait until killed",
        command: "pwd",
        cwd
      },
      async (_task, controls) => {
        await controls.appendOutput("started\n");
        while (!controls.signal.aborted) {
          await delay(5);
        }
        await controls.appendOutput("observed abort\n");
      }
    );

    await delay(10);
    const killed = await managed.kill("test kill");
    const done = await managed.done;
    const output = await store.readOutput(managed.task.id);

    expect(killed.state).toBe("killed");
    expect(done.state).toBe("killed");
    expect(output.content).toContain("started");
  });

  it("emits terminal task notifications exactly once", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "myagent-task-notify-"));
    const store = createTaskStore(cwd);
    const task = await store.create({
      type: "local_bash",
      description: "notify once",
      command: "pwd",
      cwd
    });
    await runLocalBashTask(store, task.id);

    const first = await collectTaskNotifications(store);
    const second = await collectTaskNotifications(store);

    expect(first.map((item) => item.id)).toEqual([task.id]);
    expect(second).toEqual([]);
  });

  it("rejects non-read-only Bash for local_bash tasks", () => {
    expect(parseReadOnlyBashCommand("cat .env", process.cwd())).toMatchObject({
      ok: false,
      error: expect.stringContaining(".env")
    });
    expect(parseReadOnlyBashCommand("rm file.txt", process.cwd())).toMatchObject({
      ok: false
    });
    expect(parseReadOnlyBashCommand("git status", process.cwd())).toMatchObject({
      ok: true,
      kind: "spawn"
    });
  });
});

describe("task scheduler — concurrency cap (M3.6)", () => {
  function agentInput(description: string, cwd: string) {
    return { type: "local_agent" as const, description, cwd };
  }

  // A runner that signals when it actually starts (strictly after the scheduler
  // patches the task "running") and blocks until `finish()` — so the test can
  // synchronize on real state transitions instead of arbitrary timers.
  function controllableRunner() {
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let finishRun!: () => void;
    const runner = async () => {
      signalStarted();
      await new Promise<void>((resolve) => {
        finishRun = resolve;
      });
    };
    return { runner, started, finish: () => finishRun() };
  }

  it("caps running tasks at maxConcurrent and queues the rest as pending", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "myagent-sched-cap-"));
    const store = createTaskStore(cwd);
    const scheduler = createTaskScheduler({ store, maxConcurrent: 2 });

    const r1 = controllableRunner();
    const r2 = controllableRunner();
    const r3 = controllableRunner();
    const m1 = await scheduler.start(agentInput("t1", cwd), r1.runner);
    const m2 = await scheduler.start(agentInput("t2", cwd), r2.runner);
    const m3 = await scheduler.start(agentInput("t3", cwd), r3.runner);

    // The first two are admitted (their runners start); the third is queued.
    await Promise.all([r1.started, r2.started]);
    expect(scheduler.runningCount()).toBe(2);
    expect(scheduler.pendingCount()).toBe(1);
    expect((await store.load(m1.task.id)).state).toBe("running");
    expect((await store.load(m3.task.id)).state).toBe("pending");

    // Free the first slot; the queued task must get admitted and start.
    r1.finish();
    await m1.done;
    await r3.started;
    expect((await store.load(m1.task.id)).state).toBe("completed");
    expect((await store.load(m3.task.id)).state).toBe("running");
    expect(scheduler.runningCount()).toBe(2);
    expect(scheduler.pendingCount()).toBe(0);

    r2.finish();
    r3.finish();
    await Promise.all([m2.done, m3.done]);
  });

  it("kills a queued task without ever running it", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "myagent-sched-cancel-"));
    const store = createTaskStore(cwd);
    const scheduler = createTaskScheduler({ store, maxConcurrent: 1 });

    const r1 = controllableRunner();
    const m1 = await scheduler.start(agentInput("t1", cwd), r1.runner);
    let t2Ran = false;
    const m2 = await scheduler.start(agentInput("t2", cwd), async () => {
      t2Ran = true;
    });

    await r1.started; // m1 running, m2 queued behind it
    expect((await store.load(m2.task.id)).state).toBe("pending");

    const killed = await m2.kill("cancel queued");
    expect(killed.state).toBe("killed");

    // Free the slot; m2 must NOT run because it was cancelled while queued.
    r1.finish();
    await m1.done;
    await m2.done;
    expect(t2Ran).toBe(false);
    expect((await store.load(m2.task.id)).state).toBe("killed");
  });

  it("is unbounded (no cap) when maxConcurrent is 0 — the default", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "myagent-sched-unbounded-"));
    const store = createTaskStore(cwd);
    const scheduler = createTaskScheduler({ store });
    expect(scheduler.maxConcurrent).toBe(0);

    const runners = ["a", "b", "c", "d"].map(() => controllableRunner());
    const starts = await Promise.all(
      runners.map((r, i) => scheduler.start(agentInput(`t${i}`, cwd), r.runner))
    );

    // All four start immediately (no cap).
    await Promise.all(runners.map((r) => r.started));
    const states = await Promise.all(starts.map((m) => store.load(m.task.id).then((r) => r.state)));
    expect(states.every((s) => s === "running")).toBe(true);
    expect(scheduler.runningCount()).toBe(4);

    runners.forEach((r) => r.finish());
    await Promise.all(starts.map((m) => m.done));
  });
});

describe("graceful kill (M3.6)", () => {
  async function seedRunningWorker(cwd: string) {
    const store = createTaskStore(cwd);
    const task = await store.create({ type: "local_bash", description: "worker", command: "pwd", cwd });
    const foreignPid = process.pid + 1; // pretend it's a detached out-of-process worker
    await store.patch(task.id, (r) => ({ ...r, state: "running", pid: foreignPid }));
    return { store, taskId: task.id, foreignPid };
  }

  it("escalates SIGTERM -> SIGKILL when the worker ignores SIGTERM", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "myagent-kill-escalate-"));
    const { store, taskId, foreignPid } = await seedRunningWorker(cwd);

    const signals: Array<NodeJS.Signals | 0> = [];
    let alive = true; // ignores SIGTERM; only SIGKILL stops it
    const signalProcess = (pid: number, signal: NodeJS.Signals | 0): boolean => {
      expect(pid).toBe(foreignPid);
      signals.push(signal);
      if (signal === "SIGKILL") {
        alive = false;
        return true;
      }
      return alive;
    };

    const killed = await markTaskKilled(store, taskId, "force", { graceMs: 1, signalProcess });

    expect(killed.state).toBe("killed");
    expect(signals[0]).toBe("SIGTERM");
    expect(signals).toContain("SIGKILL");
  });

  it("does not escalate to SIGKILL when SIGTERM is honored", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "myagent-kill-graceful-"));
    const { store, taskId } = await seedRunningWorker(cwd);

    const signals: Array<NodeJS.Signals | 0> = [];
    let alive = true;
    const signalProcess = (_pid: number, signal: NodeJS.Signals | 0): boolean => {
      signals.push(signal);
      if (signal === "SIGTERM") {
        alive = false; // honored: the process exits
        return true;
      }
      return alive;
    };

    const killed = await markTaskKilled(store, taskId, "graceful", { graceMs: 1, signalProcess });

    expect(killed.state).toBe("killed");
    expect(signals).toContain("SIGTERM");
    expect(signals).not.toContain("SIGKILL");
  });

  it("does not signal a task whose pid is this process — in-process tasks abort cooperatively", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "myagent-kill-inproc-"));
    const store = createTaskStore(cwd);
    const task = await store.create({ type: "local_agent", description: "in-process", cwd });
    await store.patch(task.id, (r) => ({ ...r, state: "running", pid: process.pid }));

    const signals: Array<NodeJS.Signals | 0> = [];
    const signalProcess = (_pid: number, signal: NodeJS.Signals | 0): boolean => {
      signals.push(signal);
      return false;
    };

    const killed = await markTaskKilled(store, task.id, "stop", { signalProcess });

    expect(killed.state).toBe("killed");
    // pid === process.pid -> never signaled (would kill the agent itself).
    expect(signals).toEqual([]);
  });
});
