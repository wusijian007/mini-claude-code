import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executeToolUse, type PermissionMode, type ToolDefinition } from "@mini-claude-code/core";
import { describe, expect, it } from "vitest";

import { createProjectToolRegistry } from "../../src/index.js";

function fixtureProject(): string {
  const cwd = mkdtempSync(join(tmpdir(), "myagent-sec-traversal-"));
  mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, "src", "inside.ts"), "export const inside = 1;\n", "utf8");
  return cwd;
}

async function runTool(
  tools: ToolDefinition[],
  cwd: string,
  name: string,
  input: Record<string, unknown>,
  permissionMode: PermissionMode = "bypassPermissions"
) {
  return executeToolUse(
    { id: `toolu_${name}_traversal`, name, input },
    new Map(tools.map((tool) => [tool.name, tool])),
    { cwd, permissionMode }
  );
}

describe("security: file-tool path traversal", () => {
  const tools = createProjectToolRegistry();

  it.each([
    ["Read", { path: "../outside.txt" }],
    ["Read", { path: "src/../../outside.txt" }],
    ["Glob", { pattern: "*.ts", path: "../outside" }],
    ["Edit", { path: "../outside.txt", oldString: "x", newString: "y" }],
    ["Write", { path: "../outside.txt", content: "leak" }]
  ])("%s rejects parent-traversal path %j", async (toolName, input) => {
    const cwd = fixtureProject();
    const result = await runTool(tools, cwd, toolName, input);
    expect(result.status).toBe("error");
    expect(result.error?.toLowerCase()).toMatch(/outside|invalid|not allowed/);
  });

  it("Grep rejects an absolute path outside the project", async () => {
    const cwd = fixtureProject();
    const absolute = process.platform === "win32" ? "C:\\Windows" : "/etc";
    const result = await runTool(tools, cwd, "Grep", {
      pattern: "secret",
      path: absolute
    });
    expect(result.status).toBe("error");
    expect(result.error?.toLowerCase()).toMatch(/outside|invalid|not allowed/);
  });
});
