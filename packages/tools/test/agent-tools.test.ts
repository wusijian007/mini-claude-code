import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  collectQuery,
  createTaskStore,
  executeToolUse,
  FakeModel,
  type ForkTrace
} from "@mini-claude-code/core";
import { describe, expect, it } from "vitest";
import { createProjectToolRegistry } from "../src/index.js";

function fixtureProject(): string {
  const cwd = mkdtempSync(join(tmpdir(), "myagent-agent-tool-"));
  mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, "src", "target.ts"), "export const target = 1;\n", "utf8");
  return cwd;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Agent tool", () => {
  it("runs a synchronous explore sub-agent through the same query loop", async () => {
    const cwd = fixtureProject();
    const tools = createProjectToolRegistry();
    const traces: ForkTrace[] = [];

    const events = await collectQuery({
      model: new FakeModel([
        {
          type: "tool_use",
          toolUse: {
            id: "toolu_agent",
            name: "Agent",
            input: {
              description: "find target",
              prompt: "Find target.ts",
              subagent_type: "explore"
            }
          }
        },
        { type: "turn_break" },
        {
          type: "tool_use",
          toolUse: {
            id: "toolu_child_read",
            name: "Read",
            input: { path: "src/target.ts" }
          }
        },
        { type: "turn_break" },
        {
          type: "assistant_message",
          content: "src/target.ts exports target."
        },
        { type: "turn_break" },
        {
          type: "assistant_message",
          content: "The sub-agent found src/target.ts."
        }
      ]),
      initialMessages: [{ role: "user", content: "delegate exploration" }],
      tools,
      toolContext: {
        cwd,
        recordForkTrace(trace) {
          traces.push(trace);
        }
      },
      permissionMode: "plan"
    });

    const agentResult = events.find(
      (event) => event.type === "tool_result" && event.result.toolUseId === "toolu_agent"
    );

    expect(agentResult).toMatchObject({
      type: "tool_result",
      result: {
        status: "success",
        content: expect.stringContaining("src/target.ts exports target")
      }
    });
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({
      subagentType: "explore",
      parentDepth: 0
    });
  });

  it("starts a verifier sub-agent as a local_agent background task", async () => {
    const cwd = fixtureProject();
    const taskStore = createTaskStore(cwd);
    const tools = createProjectToolRegistry();
    const agentTool = tools.find((tool) => tool.name === "Agent");
    expect(agentTool).toBeDefined();

    const result = await executeToolUse(
      {
        id: "toolu_background_agent",
        name: "Agent",
        input: {
          description: "verify target",
          prompt: "Verify target.ts",
          subagent_type: "verifier"
        }
      },
      new Map(tools.map((tool) => [tool.name, tool])),
      {
        cwd,
        model: new FakeModel([{ type: "assistant_message", content: "verification passed" }]),
        tools,
        taskStore,
        system: "parent system",
        parentMessages: [{ role: "user", content: "parent prompt" }]
      }
    );

    expect(result.status).toBe("success");
    expect(result.content).toContain("Started background sub-agent task");

    for (let index = 0; index < 20; index += 1) {
      const tasks = await taskStore.list();
      if (tasks[0]?.state === "completed") {
        break;
      }
      await delay(10);
    }

    const [task] = await taskStore.list();
    expect(task).toMatchObject({
      type: "local_agent",
      state: "completed"
    });
    const output = await taskStore.readOutput(task.id);
    expect(output.content).toContain("verification passed");
  });

  it("does not let explore sub-agents self-approve writes", async () => {
    const cwd = fixtureProject();
    const tools = createProjectToolRegistry();

    const events = await collectQuery({
      model: new FakeModel([
        {
          type: "tool_use",
          toolUse: {
            id: "toolu_agent_write",
            name: "Agent",
            input: {
              description: "try write",
              prompt: "Try to write a file",
              subagent_type: "explore"
            }
          }
        },
        { type: "turn_break" },
        {
          type: "tool_use",
          toolUse: {
            id: "toolu_child_write",
            name: "Write",
            input: { path: "src/created.ts", content: "export const bad = true;\n" }
          }
        },
        { type: "turn_break" },
        {
          type: "assistant_message",
          content: "The write was denied."
        },
        { type: "turn_break" },
        {
          type: "assistant_message",
          content: "The child could not write."
        }
      ]),
      initialMessages: [{ role: "user", content: "delegate safely" }],
      tools,
      toolContext: { cwd },
      permissionMode: "plan"
    });

    const agentResult = events.find(
      (event) => event.type === "tool_result" && event.result.toolUseId === "toolu_agent_write"
    );

    expect(agentResult).toMatchObject({
      type: "tool_result",
      result: {
        status: "success",
        content: expect.stringContaining("The write was denied")
      }
    });
    expect(() => readFileSync(join(cwd, "src", "created.ts"), "utf8")).toThrow();
  });

  it("keeps Agent in child tools while enforcing a recursive fork guard", async () => {
    const cwd = fixtureProject();
    const tools = createProjectToolRegistry();
    const result = await executeToolUse(
      {
        id: "toolu_recursive_agent",
        name: "Agent",
        input: {
          description: "recursive",
          prompt: "spawn again"
        }
      },
      new Map(tools.map((tool) => [tool.name, tool])),
      {
        cwd,
        model: new FakeModel([{ type: "assistant_message", content: "unreachable" }]),
        tools,
        subAgentDepth: 1,
        maxSubAgentDepth: 1
      }
    );

    expect(tools.map((tool) => tool.name)).toContain("Agent");
    expect(result).toMatchObject({
      status: "error",
      error: expect.stringContaining("recursion limit")
    });
  });

  it("records stable prefix hashes for two fork children with the same parent prefix", async () => {
    const cwd = fixtureProject();
    const tools = createProjectToolRegistry();
    const traces: ForkTrace[] = [];

    await collectQuery({
      model: new FakeModel([
        {
          type: "tool_use",
          toolUse: {
            id: "toolu_agent_one",
            name: "Agent",
            input: { description: "one", prompt: "First child" }
          }
        },
        {
          type: "tool_use",
          toolUse: {
            id: "toolu_agent_two",
            name: "Agent",
            input: { description: "two", prompt: "Second child" }
          }
        },
        { type: "turn_break" },
        { type: "assistant_message", content: "first child done" },
        { type: "turn_break" },
        { type: "assistant_message", content: "second child done" },
        { type: "turn_break" },
        { type: "assistant_message", content: "parent done" }
      ]),
      initialMessages: [{ role: "user", content: "spawn two children" }],
      tools,
      toolContext: {
        cwd,
        recordForkTrace(trace) {
          traces.push(trace);
        }
      },
      permissionMode: "bypassPermissions"
    });

    expect(traces).toHaveLength(2);
    expect(traces[0]?.prefixHash).toBe(traces[1]?.prefixHash);
    expect(traces[0]?.toolHash).toBe(traces[1]?.toolHash);
    expect(traces[0]?.directiveHash).not.toBe(traces[1]?.directiveHash);
  });
});
