import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildTool,
  executeToolUse,
  type PermissionMode,
  type ToolDefinition,
  type ToolUse
} from "../src/index.js";

const inputJsonSchema = {
  type: "object",
  properties: {
    value: { type: "string" }
  },
  required: ["value"],
  additionalProperties: false
} as const;

const InputSchema = z
  .object({
    value: z.string().min(1)
  })
  .strict();

function testTool(readOnly: boolean): ToolDefinition {
  return buildTool({
    name: readOnly ? "ReadThing" : "WriteThing",
    description: "A fixture tool.",
    inputSchema: InputSchema,
    inputJsonSchema,
    isReadOnly: () => readOnly,
    isConcurrencySafe: () => readOnly,
    call(input) {
      return {
        status: "success",
        content: `ok:${input.value}`
      };
    }
  });
}

function toolUse(name: string, input: Record<string, unknown> = { value: "fixture" }): ToolUse {
  return {
    id: `toolu_${name}`,
    name,
    input
  };
}

async function run(name: string, tools: ToolDefinition[], permissionMode: PermissionMode) {
  return executeToolUse(toolUse(name), new Map(tools.map((tool) => [tool.name, tool])), {
    cwd: process.cwd(),
    permissionMode
  });
}

describe("tool execution pipeline", () => {
  it("allows read-only tools in every permission mode", async () => {
    const tools = [testTool(true)];

    await expect(run("ReadThing", tools, "plan")).resolves.toMatchObject({ status: "success" });
    await expect(run("ReadThing", tools, "default")).resolves.toMatchObject({ status: "success" });
    await expect(run("ReadThing", tools, "bypassPermissions")).resolves.toMatchObject({
      status: "success"
    });
  });

  it("denies non-read-only tools in plan and default modes", async () => {
    const tools = [testTool(false)];

    await expect(run("WriteThing", tools, "plan")).resolves.toMatchObject({
      status: "error",
      error: expect.stringContaining("plan mode")
    });
    await expect(run("WriteThing", tools, "default")).resolves.toMatchObject({
      status: "error",
      error: expect.stringContaining("Permission required")
    });
  });

  it("allows non-read-only tools in bypassPermissions mode", async () => {
    await expect(run("WriteThing", [testTool(false)], "bypassPermissions")).resolves.toMatchObject({
      status: "success",
      content: "ok:fixture"
    });
  });

  it("rejects invalid input before calling the tool", async () => {
    let calls = 0;
    const tool = buildTool({
      name: "StrictTool",
      description: "A strict fixture tool.",
      inputSchema: InputSchema,
      inputJsonSchema,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      call() {
        calls += 1;
        return { status: "success", content: "unexpected" };
      }
    });

    const result = await executeToolUse(
      toolUse("StrictTool", { value: "" }),
      new Map([[tool.name, tool]]),
      { cwd: process.cwd() }
    );

    expect(result.status).toBe("error");
    expect(result.error).toContain("Invalid tool input");
    expect(calls).toBe(0);
  });

  it("rejects semantic validation failures before calling the tool", async () => {
    let calls = 0;
    const tool = buildTool({
      name: "SemanticTool",
      description: "A semantic fixture tool.",
      inputSchema: InputSchema,
      inputJsonSchema,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      validateInput: () => "semantic failure",
      call() {
        calls += 1;
        return { status: "success", content: "unexpected" };
      }
    });

    const result = await executeToolUse(toolUse("SemanticTool"), new Map([[tool.name, tool]]), {
      cwd: process.cwd()
    });

    expect(result.status).toBe("error");
    expect(result.error).toBe("semantic failure");
    expect(calls).toBe(0);
  });

  it("returns a classified error for unknown or aborted tool calls", async () => {
    const unknown = await executeToolUse(toolUse("MissingTool"), new Map(), { cwd: process.cwd() });
    expect(unknown).toMatchObject({
      status: "error",
      error: "Unknown tool: MissingTool"
    });

    const controller = new AbortController();
    controller.abort();
    const aborted = await executeToolUse(toolUse("ReadThing"), new Map([[testTool(true).name, testTool(true)]]), {
      cwd: process.cwd(),
      abortSignal: controller.signal
    });

    expect(aborted).toMatchObject({
      status: "error",
      error: "Tool execution aborted before start"
    });
  });
});
