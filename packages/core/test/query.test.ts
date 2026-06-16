import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FakeModel, buildTool, collectQuery, query, type ModelClient, type ToolDefinition } from "../src/index.js";

const readTool: ToolDefinition = buildTool({
  name: "Read",
  description: "Read fixture files.",
  inputSchema: z
    .object({
      path: z.string().min(1)
    })
    .strict(),
  inputJsonSchema: {
    type: "object",
    properties: {
      path: { type: "string" }
    },
    required: ["path"],
    additionalProperties: false
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  call(input) {
    return {
      status: "success",
      content: `read:${input.path}`
    };
  }
});

describe("query loop", () => {
  it("runs a tool turn and completes after the final assistant message", async () => {
    const events = await collectQuery({
      model: new FakeModel([
        {
          type: "assistant_message",
          content: "I will read the file."
        },
        {
          type: "tool_use",
          toolUse: {
            id: "toolu_read",
            name: "Read",
            input: { path: "README.md" }
          }
        },
        { type: "turn_break" },
        {
          type: "assistant_message",
          content: "The README has been summarized."
        }
      ]),
      initialMessages: [{ role: "user", content: "Summarize README.md" }],
      tools: [readTool],
      toolContext: { cwd: process.cwd() }
    });

    expect(events.map((event) => event.type)).toEqual([
      "assistant_message",
      "tool_use",
      "tool_result",
      "assistant_message",
      "terminal_state"
    ]);
    expect(events.at(-1)).toEqual({
      type: "terminal_state",
      state: { status: "completed" }
    });
  });

  it("returns max_turns when the model keeps requesting tools", async () => {
    const events = [];
    for await (const event of query({
      model: new FakeModel([
        {
          type: "tool_use",
          toolUse: {
            id: "toolu_1",
            name: "Read",
            input: { path: "README.md" }
          }
        },
        { type: "turn_break" },
        {
          type: "tool_use",
          toolUse: {
            id: "toolu_2",
            name: "Read",
            input: { path: "package.json" }
          }
        }
      ]),
      initialMessages: [{ role: "user", content: "Keep reading" }],
      tools: [readTool],
      toolContext: { cwd: process.cwd() },
      maxTurns: 1
    })) {
      events.push(event);
    }

    expect(events.at(-1)).toEqual({
      type: "terminal_state",
      state: { status: "max_turns", reason: "query turn limit 1 reached" }
    });
  });

  it("can reserve the final turn for a text answer before max_turns", async () => {
    let calls = 0;
    const model = {
      async create() {
        throw new Error("not used");
      },
      async *stream(request) {
        calls += 1;
        if (calls === 1) {
          expect(request.tools?.length).toBe(1);
          yield {
            type: "tool_use",
            toolUse: {
              id: "toolu_first",
              name: "Read",
              input: { path: "README.md" }
            }
          };
          return;
        }

        expect(request.tools).toEqual([]);
        expect(request.messages.at(-1)?.content).toContain("final allowed agent turn");
        yield {
          type: "assistant_message",
          message: {
            role: "assistant",
            content: "Final answer from gathered information."
          }
        };
      }
    } satisfies ModelClient;

    const events = await collectQuery({
      model,
      initialMessages: [{ role: "user", content: "Keep reading until the end" }],
      tools: [readTool],
      toolContext: { cwd: process.cwd() },
      maxTurns: 2,
      finalizeBeforeMaxTurns: true
    });

    expect(events.map((event) => event.type)).toEqual([
      "assistant_message",
      "tool_use",
      "tool_result",
      "assistant_message",
      "terminal_state"
    ]);
    expect(events.at(-2)).toMatchObject({
      type: "assistant_message",
      message: { content: "Final answer from gathered information." }
    });
    expect(events.at(-1)).toEqual({
      type: "terminal_state",
      state: { status: "completed" }
    });
  });

  it("sets cacheConversation on every model request (M3.1a)", async () => {
    const flags: Array<boolean | undefined> = [];
    const model = {
      async create() {
        throw new Error("not used");
      },
      async *stream(request) {
        flags.push(request.cacheConversation);
        yield {
          type: "assistant_message",
          message: { role: "assistant", content: "done" }
        };
      }
    } satisfies ModelClient;

    await collectQuery({
      model,
      initialMessages: [{ role: "user", content: "hi" }],
      tools: [readTool],
      toolContext: { cwd: process.cwd() },
      maxTurns: 3
    });

    expect(flags.length).toBeGreaterThan(0);
    expect(flags.every((f) => f === true)).toBe(true);
  });

  it("proactively compacts at the turn boundary when the transcript crosses the soft limit (M3.2b)", async () => {
    const bigReadTool: ToolDefinition = buildTool({
      name: "Read",
      description: "Read returning a large body.",
      inputSchema: z.object({ path: z.string().min(1) }).strict(),
      inputJsonSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false
      },
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      call() {
        // ~2000 tokens of tool_result — the whale that drives compaction.
        return { status: "success", content: "X".repeat(8_000) };
      }
    });

    const events = await collectQuery({
      model: new FakeModel([
        { type: "tool_use", toolUse: { id: "tu1", name: "Read", input: { path: "a.ts" } } },
        { type: "turn_break" },
        { type: "assistant_message", content: "done" }
      ]),
      initialMessages: [{ role: "user", content: "read it" }],
      tools: [bigReadTool],
      toolContext: { cwd: process.cwd() },
      // Tiny budget so one big tool_result crosses the soft limit (750).
      contextBudgetTokens: 1_000,
      maxTurns: 5
    });

    const compaction = events.find((e) => e.type === "compaction");
    expect(compaction).toBeDefined();
    expect(compaction).toMatchObject({ type: "compaction", reason: "proactive" });
    if (compaction?.type === "compaction") {
      expect(compaction.afterTokens).toBeLessThan(compaction.beforeTokens);
    }
    // The run still completes normally after compacting.
    expect(events.at(-1)).toEqual({ type: "terminal_state", state: { status: "completed" } });
  });

  it("does not compact when the transcript stays under the soft limit", async () => {
    const events = await collectQuery({
      model: new FakeModel([
        { type: "tool_use", toolUse: { id: "tu1", name: "Read", input: { path: "a.ts" } } },
        { type: "turn_break" },
        { type: "assistant_message", content: "done" }
      ]),
      initialMessages: [{ role: "user", content: "read it" }],
      tools: [readTool],
      toolContext: { cwd: process.cwd() },
      contextBudgetTokens: 100_000,
      maxTurns: 5
    });
    expect(events.find((e) => e.type === "compaction")).toBeUndefined();
  });

  it("stops before model work when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const events = await collectQuery({
      model: new FakeModel([{ type: "assistant_message", content: "unreachable" }]),
      initialMessages: [{ role: "user", content: "hello" }],
      tools: [readTool],
      toolContext: { cwd: process.cwd() },
      abortSignal: controller.signal
    });

    expect(events).toEqual([
      {
        type: "terminal_state",
        state: { status: "aborted", reason: "aborted before query start" }
      }
    ]);
  });
});
