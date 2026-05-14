import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildTool,
  executeToolBatch,
  partitionToolCalls,
  type ToolDefinition,
  type ToolUse
} from "../../src/index.js";

const InputSchema = z.object({ id: z.string() }).strict();
const inputJsonSchema = {
  type: "object",
  properties: { id: { type: "string" } },
  required: ["id"],
  additionalProperties: false
} as const;

function makeTool(name: string, concurrencySafe: boolean, hooks?: {
  onStart?: () => void;
  onEnd?: () => void;
}): ToolDefinition {
  return buildTool({
    name,
    description: `${name} fixture`,
    inputSchema: InputSchema,
    inputJsonSchema,
    isReadOnly: () => concurrencySafe,
    isConcurrencySafe: () => concurrencySafe,
    async call(input) {
      hooks?.onStart?.();
      await new Promise((resolve) => setTimeout(resolve, 10));
      hooks?.onEnd?.();
      return { status: "success", content: `done:${input.id}` };
    }
  });
}

function toolUse(id: string, name: string): ToolUse {
  return { id: `toolu_${id}`, name, input: { id } };
}

describe("security: scheduler write serialization", () => {
  it("partitions three Edits as three serial batches of one each", () => {
    const edit = makeTool("Edit", false);
    const toolsByName = new Map([[edit.name, edit]]);

    const batches = partitionToolCalls(
      [toolUse("a", "Edit"), toolUse("b", "Edit"), toolUse("c", "Edit")],
      toolsByName,
      { cwd: process.cwd() }
    );

    expect(batches).toHaveLength(3);
    for (const batch of batches) {
      expect(batch.kind).toBe("serial");
      expect(batch.toolUses).toHaveLength(1);
    }
  });

  it("never groups two write tools in the same parallel batch", () => {
    const read = makeTool("Read", true);
    const edit = makeTool("Edit", false);
    const write = makeTool("Write", false);
    const toolsByName = new Map([
      [read.name, read],
      [edit.name, edit],
      [write.name, write]
    ]);

    const batches = partitionToolCalls(
      [
        toolUse("r1", "Read"),
        toolUse("e1", "Edit"),
        toolUse("w1", "Write"),
        toolUse("r2", "Read"),
        toolUse("e2", "Edit")
      ],
      toolsByName,
      { cwd: process.cwd() }
    );

    for (const batch of batches) {
      if (batch.kind !== "parallel") continue;
      const writers = batch.toolUses.filter((tu) => tu.name === "Edit" || tu.name === "Write");
      expect(writers).toHaveLength(0);
    }
  });

  it("executes two Edit tool_uses sequentially, never overlapping", async () => {
    let active = 0;
    let maxActive = 0;
    const edit = makeTool("Edit", false, {
      onStart: () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
      },
      onEnd: () => {
        active -= 1;
      }
    });
    const toolsByName = new Map([[edit.name, edit]]);
    const uses = [toolUse("a", "Edit"), toolUse("b", "Edit")];
    const batches = partitionToolCalls(uses, toolsByName, { cwd: process.cwd() });

    for (const batch of batches) {
      await executeToolBatch({
        batch,
        toolsByName,
        context: { cwd: process.cwd(), permissionMode: "bypassPermissions" }
      });
    }

    expect(maxActive).toBe(1);
  });
});
