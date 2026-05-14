import { describe, expect, it } from "vitest";
import {
  toAnthropicTools,
  toModelUsage,
  type ModelToolDefinition
} from "../../src/index.js";

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
});
