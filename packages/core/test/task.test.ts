import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import {
  collectTaskNotifications,
  createTaskStore,
  isTerminalTaskState,
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
