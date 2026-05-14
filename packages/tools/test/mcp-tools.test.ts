import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  collectQuery,
  executeToolUse,
  FakeModel,
  hashToolDefinitions,
  type ToolDefinition
} from "@mini-claude-code/core";
import { describe, expect, it } from "vitest";
import {
  createMcpToolRegistry,
  createProjectToolRegistry,
  createProjectToolRegistryWithMcp,
  loadMcpConfig
} from "../src/index.js";

const require = createRequire(import.meta.url);

describe("MCP tools", () => {
  it("loads stdio MCP tools and wraps them as internal tools", async () => {
    const cwd = fixtureProject();
    const serverPath = writeStdioMcpServer(cwd);
    writeMcpConfig(cwd, {
      local: {
        type: "stdio",
        command: process.execPath,
        args: [serverPath]
      }
    });

    const tools = await createMcpToolRegistry(cwd);
    const names = tools.map((tool) => tool.name);

    expect(names).toEqual(["mcp__local__alpha", "mcp__local__ping"]);
    const result = await runTool(tools, cwd, "mcp__local__ping", {}, "bypassPermissions");
    expect(result.status).toBe("success");
    expect(result.content).toContain("pong from mcp");
  });

  it("allows the agent loop to call an MCP tool and receive a tool_result", async () => {
    const cwd = fixtureProject();
    const serverPath = writeStdioMcpServer(cwd);
    writeMcpConfig(cwd, {
      local: {
        type: "stdio",
        command: process.execPath,
        args: [serverPath]
      }
    });
    const tools = await createProjectToolRegistryWithMcp(cwd);

    const events = await collectQuery({
      model: new FakeModel([
        {
          type: "tool_use",
          toolUse: {
            id: "toolu_mcp_ping",
            name: "mcp__local__ping",
            input: {}
          }
        },
        { type: "turn_break" },
        {
          type: "assistant_message",
          content: "MCP returned pong."
        }
      ]),
      initialMessages: [{ role: "user", content: "call mcp ping" }],
      tools,
      toolContext: { cwd },
      permissionMode: "bypassPermissions"
    });

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool_result",
          result: expect.objectContaining({
            status: "success",
            content: expect.stringContaining("pong from mcp")
          })
        })
      ])
    );
  });

  it("keeps built-in tools before sorted MCP tools even as servers change", async () => {
    const cwd = fixtureProject();
    const serverPath = writeStdioMcpServer(cwd);
    const builtInNames = createProjectToolRegistry().map((tool) => tool.name);
    writeMcpConfig(cwd, {
      zed: {
        type: "stdio",
        command: process.execPath,
        args: [serverPath]
      },
      local: {
        type: "stdio",
        command: process.execPath,
        args: [serverPath]
      }
    });

    const withMcp = await createProjectToolRegistryWithMcp(cwd);
    expect(withMcp.slice(0, builtInNames.length).map((tool) => tool.name)).toEqual(builtInNames);
    expect(hashToolDefinitions(withMcp.slice(0, builtInNames.length))).toBe(
      hashToolDefinitions(createProjectToolRegistry())
    );
    expect(withMcp.slice(builtInNames.length).map((tool) => tool.name)).toEqual([
      "mcp__local__alpha",
      "mcp__local__ping",
      "mcp__zed__alpha",
      "mcp__zed__ping"
    ]);

    writeMcpConfig(cwd, {});
    const withoutMcp = await createProjectToolRegistryWithMcp(cwd);
    expect(withoutMcp.map((tool) => tool.name)).toEqual(builtInNames);
  });

  it("parses streamable HTTP MCP server config without treating annotations as trust", async () => {
    const cwd = fixtureProject();
    writeMcpConfig(cwd, {
      remote: {
        type: "streamableHttp",
        url: "http://127.0.0.1:9999/mcp",
        headers: { "X-Test": "ok" }
      }
    });

    await expect(loadMcpConfig(cwd)).resolves.toMatchObject({
      servers: {
        remote: {
          type: "streamableHttp",
          url: "http://127.0.0.1:9999/mcp",
          headers: { "X-Test": "ok" }
        }
      }
    });
  });
});

async function runTool(
  tools: ToolDefinition[],
  cwd: string,
  name: string,
  input: Record<string, unknown>,
  permissionMode: "plan" | "default" | "bypassPermissions" = "default"
) {
  return executeToolUse(
    {
      id: `toolu_${name}`,
      name,
      input
    },
    new Map(tools.map((tool) => [tool.name, tool])),
    { cwd, permissionMode }
  );
}

function fixtureProject(): string {
  const cwd = mkdtempSync(join(tmpdir(), "myagent-mcp-"));
  mkdirSync(join(cwd, ".myagent"), { recursive: true });
  return cwd;
}

function writeMcpConfig(cwd: string, servers: Record<string, unknown>): void {
  writeFileSync(join(cwd, ".myagent", "mcp.json"), `${JSON.stringify({ servers }, null, 2)}\n`, "utf8");
}

function writeStdioMcpServer(cwd: string): string {
  const serverPath = join(cwd, "mcp-fixture-server.mjs");
  const mcpServerUrl = pathToFileURL(require.resolve("@modelcontextprotocol/sdk/server/mcp.js")).href;
  const stdioUrl = pathToFileURL(require.resolve("@modelcontextprotocol/sdk/server/stdio.js")).href;
  writeFileSync(
    serverPath,
    [
      `import { McpServer } from ${JSON.stringify(mcpServerUrl)};`,
      `import { StdioServerTransport } from ${JSON.stringify(stdioUrl)};`,
      "const server = new McpServer({ name: 'fixture', version: '1.0.0' });",
      "server.registerTool('ping', { description: 'Return pong', annotations: { readOnlyHint: true } }, async () => ({ content: [{ type: 'text', text: 'pong from mcp' }] }));",
      "server.registerTool('alpha', { description: 'Alphabetical order check' }, async () => ({ content: [{ type: 'text', text: 'alpha' }] }));",
      "await server.connect(new StdioServerTransport());"
    ].join("\n"),
    "utf8"
  );
  return serverPath;
}
