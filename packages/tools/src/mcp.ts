import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult, Tool as McpSdkTool } from "@modelcontextprotocol/sdk/types.js";
import {
  buildTool,
  type JsonObjectSchema,
  type ToolCallResult,
  type ToolDefinition
} from "@mini-claude-code/core";
import { z } from "zod";

export type McpServerConfig =
  | {
      type?: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
    }
  | {
      type: "streamableHttp" | "http";
      url: string;
      headers?: Record<string, string>;
    };

export type McpConfig = {
  servers: Record<string, McpServerConfig>;
};

type RawMcpConfig = {
  servers?: Record<string, unknown>;
  mcpServers?: Record<string, unknown>;
};

const MCP_INPUT_SCHEMA = z.record(z.string(), z.unknown());
const EMPTY_OBJECT_SCHEMA: JsonObjectSchema = {
  type: "object",
  properties: {},
  additionalProperties: true
};

export async function loadMcpConfig(cwd: string, configPath?: string): Promise<McpConfig> {
  const resolvedPath = resolve(configPath ?? resolve(cwd, ".myagent", "mcp.json"));
  if (!existsSync(resolvedPath)) {
    return { servers: {} };
  }

  const parsed = JSON.parse(await readFile(resolvedPath, "utf8")) as RawMcpConfig;
  const rawServers = parsed.servers ?? parsed.mcpServers ?? {};
  const servers: Record<string, McpServerConfig> = {};
  for (const [name, rawConfig] of Object.entries(rawServers)) {
    const normalizedName = normalizeMcpName(name);
    const config = normalizeServerConfig(rawConfig);
    if (!normalizedName || !config) {
      continue;
    }
    servers[normalizedName] = config;
  }
  return { servers };
}

export async function createMcpToolRegistry(
  cwd: string,
  configPath?: string
): Promise<ToolDefinition[]> {
  return mcpToolsFromConfig(await loadMcpConfig(cwd, configPath), cwd);
}

export async function mcpToolsFromConfig(config: McpConfig, cwd: string): Promise<ToolDefinition[]> {
  const tools: ToolDefinition[] = [];
  for (const [serverName, serverConfig] of Object.entries(config.servers).sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    const serverTools = await listServerTools(serverName, serverConfig, cwd).catch(() => []);
    tools.push(...serverTools);
  }
  return tools.sort((left, right) => left.name.localeCompare(right.name));
}

export function createMcpToolDefinition(
  serverName: string,
  serverConfig: McpServerConfig,
  sdkTool: McpSdkTool,
  cwd: string
): ToolDefinition {
  const internalToolName = `mcp__${normalizeMcpName(serverName) ?? "server"}__${normalizeMcpName(sdkTool.name) ?? "tool"}`;
  const inputJsonSchema = normalizeInputSchema(sdkTool.inputSchema);
  return buildTool({
    name: internalToolName,
    description: [
      sdkTool.description ?? `MCP tool ${sdkTool.name} from server ${serverName}.`,
      "MCP annotations are treated as hints only; myagent still applies its own permission policy."
    ].join("\n"),
    inputSchema: MCP_INPUT_SCHEMA,
    inputJsonSchema,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    async call(input) {
      return withMcpClient(serverName, serverConfig, cwd, async (client) => {
        const result = await client.callTool({
          name: sdkTool.name,
          arguments: input
        });
        return callToolResultToToolCallResult(result);
      });
    }
  });
}

async function listServerTools(
  serverName: string,
  serverConfig: McpServerConfig,
  cwd: string
): Promise<ToolDefinition[]> {
  return withMcpClient(serverName, serverConfig, cwd, async (client) => {
    const result = await client.listTools();
    return result.tools.map((tool) => createMcpToolDefinition(serverName, serverConfig, tool, cwd));
  });
}

async function withMcpClient<T>(
  serverName: string,
  serverConfig: McpServerConfig,
  cwd: string,
  callback: (client: Client) => Promise<T>
): Promise<T> {
  const client = new Client({
    name: `myagent-${serverName}`,
    version: "0.0.0"
  });
  const transport = createTransport(serverConfig, cwd);

  try {
    await client.connect(transport);
    return await callback(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

function createTransport(serverConfig: McpServerConfig, cwd: string) {
  if (isHttpMcpServerConfig(serverConfig)) {
    return new StreamableHTTPClientTransport(new URL(serverConfig.url), {
      requestInit: serverConfig.headers ? { headers: serverConfig.headers } : undefined
    });
  }

  return new StdioClientTransport({
    command: serverConfig.command,
    args: serverConfig.args ?? [],
    env: serverConfig.env,
    cwd: serverConfig.cwd ? resolve(cwd, serverConfig.cwd) : cwd,
    stderr: "pipe"
  });
}

function isHttpMcpServerConfig(
  serverConfig: McpServerConfig
): serverConfig is Extract<McpServerConfig, { type: "streamableHttp" | "http" }> {
  return serverConfig.type === "streamableHttp" || serverConfig.type === "http";
}

function normalizeServerConfig(raw: unknown): McpServerConfig | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const config = raw as Record<string, unknown>;
  const type = typeof config.type === "string" ? config.type : undefined;
  if (type === "streamableHttp" || type === "http") {
    if (typeof config.url !== "string") {
      return null;
    }
    return {
      type,
      url: config.url,
      headers: normalizeStringRecord(config.headers)
    };
  }

  if (type !== undefined && type !== "stdio") {
    return null;
  }

  if (typeof config.command !== "string") {
    return null;
  }

  const args = Array.isArray(config.args)
    ? config.args.filter((arg): arg is string => typeof arg === "string")
    : undefined;
  const env = normalizeStringRecord(config.env);
  const configCwd = typeof config.cwd === "string" ? config.cwd : undefined;
  return {
    type: "stdio",
    command: config.command,
    args,
    env,
    cwd: configCwd
  };
}

function normalizeStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeInputSchema(schema: unknown): JsonObjectSchema {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return EMPTY_OBJECT_SCHEMA;
  }

  const maybeSchema = schema as Record<string, unknown>;
  if (maybeSchema.type !== "object") {
    return EMPTY_OBJECT_SCHEMA;
  }

  return {
    ...maybeSchema,
    type: "object"
  } as JsonObjectSchema;
}

function callToolResultToToolCallResult(result: Awaited<CallToolResult | ReturnType<Client["callTool"]>>): ToolCallResult {
  const content = formatMcpCallContent(result);
  if ("isError" in result && result.isError) {
    return {
      status: "error",
      content,
      error: content || "MCP tool returned isError"
    };
  }

  return {
    status: "success",
    content
  };
}

function formatMcpCallContent(result: Awaited<CallToolResult | ReturnType<Client["callTool"]>>): string {
  if ("toolResult" in result) {
    return stringifyUnknown(result.toolResult);
  }

  const parts: string[] = [];
  for (const block of result.content ?? []) {
    if (block.type === "text") {
      parts.push(block.text);
      continue;
    }
    if (block.type === "resource") {
      if ("text" in block.resource) {
        parts.push(`[resource:${block.resource.uri}]\n${block.resource.text}`);
      } else {
        parts.push(`[resource:${block.resource.uri}] ${block.resource.mimeType ?? "blob"}`);
      }
      continue;
    }
    parts.push(stringifyUnknown(block));
  }
  if (result.structuredContent) {
    parts.push(`[structured]\n${stringifyUnknown(result.structuredContent)}`);
  }
  return parts.join("\n");
}

function stringifyUnknown(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function normalizeMcpName(name: string): string | null {
  const normalized = name.trim().replace(/[^A-Za-z0-9_-]/g, "_");
  return normalized.length > 0 ? normalized : null;
}
