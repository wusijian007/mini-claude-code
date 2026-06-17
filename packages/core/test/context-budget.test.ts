import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ModelError,
  buildTool,
  compactMessages,
  compactMessagesTiered,
  compactMessagesWithSummary,
  collectQuery,
  estimateMessagesTokens,
  executeToolUse,
  tokenBudgetFromUsage,
  type Message,
  type ModelClient,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamEvent
} from "../src/index.js";

describe("context budget helpers", () => {
  it("prefers API usage over local token estimates", () => {
    const messages: Message[] = [{ role: "user", content: "x".repeat(10_000) }];

    expect(tokenBudgetFromUsage({ inputTokens: 10, outputTokens: 2 }, messages)).toEqual({
      estimatedTokens: 12,
      source: "api_usage"
    });
    expect(tokenBudgetFromUsage(undefined, messages)).toMatchObject({
      source: "estimate"
    });
  });

  it("snips and compacts old messages while keeping recent context", () => {
    const messages: Message[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: "middle ".repeat(2_000) },
      { role: "user", content: "latest" }
    ];

    const compacted = compactMessages(messages, {
      targetTokens: 20,
      keepFirstMessages: 1,
      keepLastMessages: 1,
      maxMessageChars: 120
    });

    expect(compacted.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(String(compacted[1]?.content)).toContain("context compacted");
    expect(estimateMessagesTokens(compacted)).toBeLessThan(estimateMessagesTokens(messages));
  });
});

describe("tiered compaction (M3.2a)", () => {
  // A realistic agent transcript: root task, a stale Read whose tool_result
  // is the token whale, then a recent exchange.
  function transcript(): Message[] {
    return [
      { role: "user", content: "find and summarize the math helper" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I'll read the file." },
          { type: "tool_use", toolUse: { id: "tu_read", name: "Read", input: { path: "src/math.ts" } } }
        ]
      },
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            result: {
              toolUseId: "tu_read",
              status: "success",
              content: "L".repeat(8_000),
              artifactPath: ".myagent/artifacts/sess/x.txt"
            }
          }
        ]
      },
      { role: "assistant", content: "It defines add()." },
      { role: "user", content: "now what does subtract do?" }
    ];
  }

  it("pointer-izes the stale tool_result whale while keeping root + recent verbatim", () => {
    const messages = transcript();
    const before = estimateMessagesTokens(messages);
    const out = compactMessagesTiered(messages, {
      targetTokens: 200,
      rootMessages: 1,
      recentWindowMessages: 2,
      pointerizeOverChars: 600
    });

    // Root task untouched.
    expect(out[0].content).toBe("find and summarize the math helper");
    // The stale tool_result is now a compact pointer naming the tool + input + size + artifact.
    const toolMsg = out[2];
    const block = Array.isArray(toolMsg.content) ? toolMsg.content[0] : undefined;
    const pointer = block && block.type === "tool_result" ? block.result.content : "";
    expect(pointer).toContain("[archived Read(src/math.ts) result:");
    expect(pointer).toContain("8000 chars omitted");
    expect(pointer).toContain(".myagent/artifacts/sess/x.txt");
    // Pairing preserved: the tool_use id still has its tool_result.
    expect(block && block.type === "tool_result" ? block.result.toolUseId : "").toBe("tu_read");
    // Recent window kept verbatim.
    expect(out[out.length - 1].content).toBe("now what does subtract do?");
    // Big token reduction.
    expect(estimateMessagesTokens(out)).toBeLessThan(before / 2);
  });

  it("returns the transcript untouched when already under target (cache-preserving)", () => {
    const small: Message[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" }
    ];
    const out = compactMessagesTiered(small, { targetTokens: 10_000 });
    expect(out).toEqual(small);
  });

  it("archives the original (unshrunk) stale slice exactly once", () => {
    const messages = transcript();
    const archived: Message[][] = [];
    compactMessagesTiered(messages, {
      targetTokens: 200,
      rootMessages: 1,
      recentWindowMessages: 2,
      archiveSink: (slice) => archived.push([...slice]),
      pointerizeOverChars: 600
    });
    expect(archived).toHaveLength(1);
    // The archived copy retains the FULL original tool_result content.
    const archivedTool = archived[0].find((m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result"));
    const archivedBlock = archivedTool && Array.isArray(archivedTool.content)
      ? archivedTool.content.find((b) => b.type === "tool_result")
      : undefined;
    expect(archivedBlock && archivedBlock.type === "tool_result" ? archivedBlock.result.content.length : 0).toBe(8_000);
  });
});

describe("semantic compaction (M3.2c)", () => {
  // A transcript whose stale middle includes a tool_use/tool_result pair, so we
  // can assert the summarize-and-drop path never orphans the pairing.
  function transcript(): Message[] {
    return [
      { role: "user", content: "find and summarize the math helper" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I'll read the file." },
          { type: "tool_use", toolUse: { id: "tu_read", name: "Read", input: { path: "src/math.ts" } } }
        ]
      },
      {
        role: "tool",
        content: [
          { type: "tool_result", result: { toolUseId: "tu_read", status: "success", content: "L".repeat(8_000) } }
        ]
      },
      { role: "assistant", content: "It defines add()." },
      { role: "user", content: "now what does subtract do?" },
      { role: "assistant", content: "subtract() returns a - b." }
    ];
  }

  it("replaces the stale region with a single LLM recap, keeping root + recent verbatim", async () => {
    const messages = transcript();
    const before = estimateMessagesTokens(messages);
    const dropped: Message[][] = [];
    const out = await compactMessagesWithSummary(messages, {
      targetTokens: 200,
      rootMessages: 1,
      recentWindowMessages: 2,
      summarizer: async (slice) => {
        dropped.push([...slice]);
        return "RECAP: read src/math.ts; it defines add().";
      }
    });

    // Root task + recent window kept verbatim.
    expect(out[0].content).toBe("find and summarize the math helper");
    expect(out[out.length - 1].content).toBe("subtract() returns a - b.");
    expect(out[out.length - 2].content).toBe("now what does subtract do?");
    // The stale middle collapsed into ONE recap message.
    const recap = out[1];
    expect(recap.role).toBe("assistant");
    expect(String(recap.content)).toContain("RECAP: read src/math.ts");
    expect(String(recap.content)).toContain("summary of");
    // The summarizer saw the dropped slice once, and it included the whale.
    expect(dropped).toHaveLength(1);
    expect(dropped[0].some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result"))).toBe(true);
    // Real token reduction.
    expect(estimateMessagesTokens(out)).toBeLessThan(before / 2);
  });

  it("snaps the recent-window start past a leading tool_result so no tool_use is orphaned", async () => {
    // recentWindowMessages=3 would start the window at the tool_result (index 2),
    // orphaning tu_read; the boundary must snap earlier to include the assistant.
    const messages = transcript();
    const out = await compactMessagesWithSummary(messages, {
      targetTokens: 50,
      rootMessages: 1,
      recentWindowMessages: 3,
      summarizer: async () => "RECAP"
    });

    // Every tool_result kept in the output must still have its tool_use present.
    const toolUseIds = new Set<string>();
    const toolResultIds: string[] = [];
    for (const message of out) {
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (block.type === "tool_use") toolUseIds.add(block.toolUse.id);
        if (block.type === "tool_result") toolResultIds.push(block.result.toolUseId);
      }
    }
    for (const id of toolResultIds) {
      expect(toolUseIds.has(id)).toBe(true);
    }
  });

  it("returns the transcript untouched when already under target (cache-preserving)", async () => {
    const small: Message[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" }
    ];
    let called = false;
    const out = await compactMessagesWithSummary(small, {
      targetTokens: 10_000,
      summarizer: async () => {
        called = true;
        return "unused";
      }
    });
    expect(out).toEqual(small);
    expect(called).toBe(false);
  });
});

describe("tool result budget", () => {
  it("stores oversized tool results as artifacts and returns only a preview", async () => {
    const artifactDir = mkdtempSync(join(tmpdir(), "myagent-artifacts-"));
    const tool = buildTool({
      name: "Huge",
      description: "Huge output fixture.",
      inputSchema: z.object({}).strict(),
      inputJsonSchema: { type: "object", additionalProperties: false },
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      call: () => ({ status: "success", content: "A".repeat(5_000) })
    });

    const result = await executeToolUse(
      { id: "toolu_huge", name: "Huge", input: {} },
      new Map([[tool.name, tool]]),
      {
        cwd: process.cwd(),
        artifactDir,
        toolResultBudgetChars: 100
      }
    );

    expect(result.status).toBe("success");
    expect(result.content.length).toBeLessThan(300);
    expect(result.content).toContain("Full output saved");
    expect(result.artifactPath).toBeTruthy();
    expect(readFileSync(result.artifactPath ?? "", "utf8")).toHaveLength(5_000);
  });
});

describe("query recoverable retry", () => {
  it("withholds prompt-too-long once, compacts, and retries before yielding events", async () => {
    let calls = 0;
    let retryMessageCount = 0;
    const model: ModelClient = {
      async create(_request: ModelRequest): Promise<ModelResponse> {
        throw new Error("not used");
      },
      async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
        calls += 1;
        if (calls === 1) {
          throw new ModelError("prompt_too_long", "prompt too long");
        }
        retryMessageCount = request.messages.length;
        yield {
          type: "assistant_message",
          message: { role: "assistant", content: "Recovered after compact." }
        };
      }
    };

    const events = await collectQuery({
      model,
      initialMessages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "middle ".repeat(2_000) },
        { role: "user", content: "latest" }
      ],
      tools: [],
      toolContext: { cwd: process.cwd() },
      contextBudgetTokens: 100
    });

    expect(calls).toBe(2);
    expect(retryMessageCount).toBe(3);
    expect(events.map((event) => event.type)).toEqual(["assistant_message", "terminal_state"]);
    expect(events[0]).toMatchObject({
      type: "assistant_message",
      message: { content: "Recovered after compact." }
    });
  });

  it("exposes a recoverable error only after the retry circuit is exhausted", async () => {
    let calls = 0;
    const model: ModelClient = {
      async create(_request: ModelRequest): Promise<ModelResponse> {
        throw new Error("not used");
      },
      async *stream(_request: ModelRequest): AsyncIterable<ModelStreamEvent> {
        calls += 1;
        throw new ModelError("stream_error", "stream failed");
      }
    };

    const events = await collectQuery({
      model,
      initialMessages: [{ role: "user", content: "hello" }],
      tools: [],
      toolContext: { cwd: process.cwd() },
      retryLimits: { stream_error: 1 }
    });

    expect(calls).toBe(2);
    expect(events).toEqual([
      {
        type: "terminal_state",
        state: { status: "error", error: "stream failed" }
      }
    ]);
  });
});
