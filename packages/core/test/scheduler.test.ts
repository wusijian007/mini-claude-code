import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  FakeModel,
  buildTool,
  collectQuery,
  executeToolBatch,
  partitionToolCalls,
  query,
  type ToolDefinition,
  type ToolUse
} from "../src/index.js";

const InputSchema = z
  .object({
    id: z.string(),
    delayMs: z.number().optional(),
    fail: z.boolean().optional()
  })
  .strict();

const inputJsonSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    delayMs: { type: "number" },
    fail: { type: "boolean" }
  },
  required: ["id"],
  additionalProperties: false
} as const;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    signal?.addEventListener("abort", () => resolve(), { once: true });
  });
}

function delayedTool(options: {
  name: string;
  concurrencySafe: boolean;
  cancelSiblings?: boolean;
  onStart?: () => void;
  onEnd?: () => void;
}): ToolDefinition {
  return buildTool({
    name: options.name,
    description: `${options.name} fixture tool.`,
    inputSchema: InputSchema,
    inputJsonSchema,
    isReadOnly: () => options.concurrencySafe,
    isConcurrencySafe: () => options.concurrencySafe,
    cancelSiblingToolsOnError: () => options.cancelSiblings ?? false,
    async call(input, context) {
      options.onStart?.();
      try {
        if (input.id === "wait-abort") {
          await waitForAbort(context.abortSignal);
          throw new Error("aborted by signal");
        }

        await delay(input.delayMs ?? 0);
        if (input.fail) {
          throw new Error(`${options.name} failed`);
        }
        return {
          status: "success",
          content: input.id
        };
      } finally {
        options.onEnd?.();
      }
    }
  });
}

function toolUse(id: string, name = "Read", delayMs = 0, fail = false): ToolUse {
  return {
    id: `toolu_${id}`,
    name,
    input: { id, delayMs, fail }
  };
}

describe("tool scheduler", () => {
  it("partitions concurrency-safe calls around exclusive writes", () => {
    const read = delayedTool({ name: "Read", concurrencySafe: true });
    const edit = delayedTool({ name: "Edit", concurrencySafe: false });
    const toolsByName = new Map([
      [read.name, read],
      [edit.name, edit]
    ]);

    expect(
      partitionToolCalls(
        [toolUse("a", "Read"), toolUse("b", "Edit"), toolUse("c", "Read")],
        toolsByName,
        { cwd: process.cwd() }
      )
    ).toEqual([
      { kind: "parallel", toolUses: [toolUse("a", "Read")] },
      { kind: "serial", toolUses: [toolUse("b", "Edit")] },
      { kind: "parallel", toolUses: [toolUse("c", "Read")] }
    ]);
  });

  it("runs five concurrent Read calls and preserves submitted result order", async () => {
    let active = 0;
    let maxActive = 0;
    const read = delayedTool({
      name: "Read",
      concurrencySafe: true,
      onStart() {
        active += 1;
        maxActive = Math.max(maxActive, active);
      },
      onEnd() {
        active -= 1;
      }
    });

    const events = await collectQuery({
      model: new FakeModel([
        { type: "tool_use", toolUse: toolUse("first", "Read", 50) },
        { type: "tool_use", toolUse: toolUse("second", "Read", 5) },
        { type: "tool_use", toolUse: toolUse("third", "Read", 20) },
        { type: "tool_use", toolUse: toolUse("fourth", "Read", 10) },
        { type: "tool_use", toolUse: toolUse("fifth", "Read", 1) },
        { type: "turn_break" },
        { type: "assistant_message", content: "done" }
      ]),
      initialMessages: [{ role: "user", content: "read many" }],
      tools: [read],
      toolContext: { cwd: process.cwd() }
    });

    const resultContents = events
      .filter((event) => event.type === "tool_result")
      .map((event) => event.result.content);

    expect(maxActive).toBeGreaterThan(1);
    expect(resultContents).toEqual(["first", "second", "third", "fourth", "fifth"]);
  });

  it("honors bounded concurrency", async () => {
    let active = 0;
    let maxActive = 0;
    const read = delayedTool({
      name: "Read",
      concurrencySafe: true,
      onStart() {
        active += 1;
        maxActive = Math.max(maxActive, active);
      },
      onEnd() {
        active -= 1;
      }
    });

    const batch = {
      kind: "parallel" as const,
      toolUses: [
        toolUse("one", "Read", 20),
        toolUse("two", "Read", 20),
        toolUse("three", "Read", 20),
        toolUse("four", "Read", 20)
      ]
    };

    const results = await executeToolBatch({
      batch,
      toolsByName: new Map([[read.name, read]]),
      context: { cwd: process.cwd() },
      maxConcurrency: 2
    });

    expect(results.map((result) => result.content)).toEqual(["one", "two", "three", "four"]);
    expect(maxActive).toBe(2);
  });

  it("cascades Bash errors to sibling tools in the same batch", async () => {
    const bash = delayedTool({ name: "Bash", concurrencySafe: true, cancelSiblings: true });
    const read = delayedTool({ name: "Read", concurrencySafe: true });

    const results = await executeToolBatch({
      batch: {
        kind: "parallel",
        toolUses: [toolUse("wait-abort", "Read"), toolUse("bad", "Bash", 5, true)]
      },
      toolsByName: new Map([
        [bash.name, bash],
        [read.name, read]
      ]),
      context: { cwd: process.cwd() },
      maxConcurrency: 2
    });

    expect(results[0]).toMatchObject({
      status: "error",
      error: expect.stringContaining("aborted by signal")
    });
    expect(results[1]).toMatchObject({
      status: "error",
      error: expect.stringContaining("Bash failed")
    });
  });

  it("isolates ordinary read errors from sibling tools", async () => {
    const read = delayedTool({ name: "Read", concurrencySafe: true });

    const results = await executeToolBatch({
      batch: {
        kind: "parallel",
        toolUses: [toolUse("bad", "Read", 1, true), toolUse("good", "Read", 10)]
      },
      toolsByName: new Map([[read.name, read]]),
      context: { cwd: process.cwd() },
      maxConcurrency: 2
    });

    expect(results[0]).toMatchObject({ status: "error" });
    expect(results[1]).toMatchObject({ status: "success", content: "good" });
  });

  it("propagates query-level abort into running tools", async () => {
    const controller = new AbortController();
    const read = delayedTool({ name: "Read", concurrencySafe: true });
    const events = [];

    for await (const event of query({
      model: new FakeModel([{ type: "tool_use", toolUse: toolUse("wait-abort", "Read") }]),
      initialMessages: [{ role: "user", content: "read slowly" }],
      tools: [read],
      toolContext: { cwd: process.cwd() },
      abortSignal: controller.signal
    })) {
      events.push(event);
      if (event.type === "tool_use") {
        controller.abort();
      }
    }

    expect(events.at(-1)).toEqual({
      type: "terminal_state",
      state: { status: "aborted", reason: "abort signal received" }
    });
    expect(events.some((event) => event.type === "tool_result")).toBe(true);
  });
});
