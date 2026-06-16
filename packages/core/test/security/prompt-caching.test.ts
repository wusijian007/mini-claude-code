import { describe, expect, it } from "vitest";
import {
  toAnthropicMessages,
  toAnthropicTools,
  toModelUsage,
  type Message,
  type ModelToolDefinition
} from "../../src/index.js";

function lastBlockOf(content: unknown): Record<string, unknown> {
  if (!Array.isArray(content)) {
    throw new Error("expected a block array (cache_control requires block form)");
  }
  return content[content.length - 1] as Record<string, unknown>;
}

function makeTool(name: string): ModelToolDefinition {
  return {
    name,
    description: `${name} fixture`,
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  };
}

describe("security: prompt caching wiring", () => {
  it("toAnthropicTools marks the last tool with cache_control ephemeral", () => {
    const { tools } = toAnthropicTools([makeTool("Read"), makeTool("Glob"), makeTool("Edit")]);
    expect(tools).toBeDefined();
    expect(tools).toHaveLength(3);
    // First two are plain.
    expect(tools![0]).not.toHaveProperty("cache_control");
    expect(tools![1]).not.toHaveProperty("cache_control");
    // Last one carries the cache breakpoint.
    expect(tools![2]).toMatchObject({
      name: "Edit",
      cache_control: { type: "ephemeral" }
    });
  });

  it("toAnthropicTools handles a single-tool list (the only tool is the cache breakpoint)", () => {
    const { tools } = toAnthropicTools([makeTool("Read")]);
    expect(tools).toHaveLength(1);
    expect(tools![0]).toMatchObject({
      name: "Read",
      cache_control: { type: "ephemeral" }
    });
  });

  it("toAnthropicTools returns no tools object for an empty list (no spurious cache marker)", () => {
    expect(toAnthropicTools([])).toEqual({});
    expect(toAnthropicTools(undefined)).toEqual({});
  });

  it("toModelUsage extracts cache_creation_input_tokens and cache_read_input_tokens", () => {
    const usage = toModelUsage({
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 200
    });
    expect(usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationInputTokens: 100,
      cacheReadInputTokens: 200
    });
  });

  it("toModelUsage leaves cache fields undefined when the SDK omits them (non-cached turns)", () => {
    const usage = toModelUsage({ input_tokens: 10, output_tokens: 5 });
    expect(usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationInputTokens: undefined,
      cacheReadInputTokens: undefined
    });
  });

  it("toModelUsage returns undefined when the SDK provides no usage block", () => {
    expect(toModelUsage(undefined)).toBeUndefined();
  });

  // ---- M3.1a: message-prefix cache breakpoint ----

  const convo: Message[] = [
    { role: "user", content: "first" },
    { role: "assistant", content: [{ type: "text", text: "reply" }] },
    { role: "user", content: "latest" }
  ];

  it("toAnthropicMessages adds NO cache_control by default (back-compat / chat path)", () => {
    const out = toAnthropicMessages(convo);
    // Last message keeps its plain string content, no breakpoint anywhere.
    expect(out[out.length - 1].content).toBe("latest");
    for (const m of out) {
      if (Array.isArray(m.content)) {
        for (const block of m.content) {
          expect(block).not.toHaveProperty("cache_control");
        }
      }
    }
  });

  it("cacheLastMessage marks the last block of the LAST message only", () => {
    const out = toAnthropicMessages(convo, { cacheLastMessage: true });
    // The trailing string message is normalized to a text block carrying the marker.
    const lastBlock = lastBlockOf(out[out.length - 1].content);
    expect(lastBlock).toMatchObject({
      type: "text",
      text: "latest",
      cache_control: { type: "ephemeral" }
    });
    // Earlier messages are untouched.
    expect(out[0].content).toBe("first");
    const midBlock = lastBlockOf(out[1].content);
    expect(midBlock).not.toHaveProperty("cache_control");
  });

  it("cacheLastMessage attaches to the last block when the last message is already block-form", () => {
    const blocky: Message[] = [
      { role: "user", content: "q" },
      {
        role: "tool",
        content: [
          { type: "tool_result", result: { toolUseId: "t1", status: "success", content: "ok" } }
        ]
      }
    ];
    const out = toAnthropicMessages(blocky, { cacheLastMessage: true });
    const lastBlock = lastBlockOf(out[out.length - 1].content);
    expect(lastBlock.type).toBe("tool_result");
    expect(lastBlock.cache_control).toEqual({ type: "ephemeral" });
  });

  it("cacheLastMessage is a no-op on an empty message list", () => {
    expect(toAnthropicMessages([], { cacheLastMessage: true })).toEqual([]);
  });
});
