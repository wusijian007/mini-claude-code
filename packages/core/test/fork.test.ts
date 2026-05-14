import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildTool,
  compareForkTraces,
  createForkTrace,
  hashMessages,
  hashToolDefinitions,
  type ToolDefinition
} from "../src/index.js";

function fixtureTool(name: string): ToolDefinition {
  return buildTool({
    name,
    description: `${name} fixture`,
    inputSchema: z.object({}).strict(),
    inputJsonSchema: {
      type: "object",
      additionalProperties: false
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    call() {
      return { status: "success", content: name };
    }
  });
}

describe("fork trace hashing", () => {
  it("hashes message prefixes and tool definitions deterministically", () => {
    const messages = [{ role: "user" as const, content: "hello" }];
    const tools = [fixtureTool("Read"), fixtureTool("Agent")];

    expect(hashMessages(messages)).toBe(hashMessages([{ content: "hello", role: "user" }]));
    expect(hashToolDefinitions(tools)).toBe(hashToolDefinitions([fixtureTool("Read"), fixtureTool("Agent")]));
  });

  it("explains cache miss sources between fork traces", () => {
    const base = createForkTrace({
      parentDepth: 0,
      subagentType: "general",
      model: "test-model",
      systemPrompt: "system",
      tools: [fixtureTool("Read")],
      prefixMessages: [{ role: "user", content: "same prefix" }],
      directive: "child one"
    });
    const next = createForkTrace({
      parentDepth: 0,
      subagentType: "general",
      model: "other-model",
      systemPrompt: "changed system",
      tools: [fixtureTool("Read"), fixtureTool("Agent")],
      prefixMessages: [{ role: "user", content: "same prefix" }],
      directive: "child two",
      previous: base
    });

    expect(next.cacheMissSources).toEqual(["system_prompt", "tools", "child_directive", "model"]);
    expect(compareForkTraces(base, next)).toEqual(next.cacheMissSources);
  });
});
