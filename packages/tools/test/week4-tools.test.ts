import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executeToolUse, loadHookSnapshot, type HookSnapshot, type PermissionMode, type ToolDefinition } from "@mini-claude-code/core";
import { describe, expect, it } from "vitest";
import { createProjectToolRegistry } from "../src/index.js";

function fixtureProject(): string {
  const cwd = mkdtempSync(join(tmpdir(), "myagent-week4-"));
  mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, "src", "bug.ts"), "export function add(a: number, b: number) {\n  return a - b;\n}\n", "utf8");
  writeFileSync(join(cwd, ".env"), "ANTHROPIC_API_KEY=secret\n", "utf8");
  return cwd;
}

async function runTool(
  tools: ToolDefinition[],
  cwd: string,
  name: string,
  input: Record<string, unknown>,
  permissionMode: PermissionMode = "default",
  hookSnapshot?: HookSnapshot
) {
  return executeToolUse(
    {
      id: `toolu_${name}`,
      name,
      input
    },
    new Map(tools.map((tool) => [tool.name, tool])),
    { cwd, permissionMode, hookSnapshot }
  );
}

describe("week 4 safe editing tools", () => {
  it("edits a previously-read file in bypassPermissions mode and returns a diff preview", async () => {
    const cwd = fixtureProject();
    const tools = createProjectToolRegistry();

    await runTool(tools, cwd, "Read", { path: "src/bug.ts" });
    const result = await runTool(
      tools,
      cwd,
      "Edit",
      {
        path: "src/bug.ts",
        oldString: "return a - b;",
        newString: "return a + b;"
      },
      "bypassPermissions"
    );

    expect(result.status).toBe("success");
    expect(result.content).toContain("--- src/bug.ts");
    expect(result.content).toContain("-return a - b;");
    expect(result.content).toContain("+return a + b;");
    expect(readFileSync(join(cwd, "src", "bug.ts"), "utf8")).toContain("return a + b;");
  });

  it("denies Edit in default mode before changing the file", async () => {
    const cwd = fixtureProject();
    const tools = createProjectToolRegistry();

    await runTool(tools, cwd, "Read", { path: "src/bug.ts" });
    const result = await runTool(tools, cwd, "Edit", {
      path: "src/bug.ts",
      oldString: "return a - b;",
      newString: "return a + b;"
    });

    expect(result.status).toBe("error");
    expect(result.error).toContain("Permission required");
    expect(readFileSync(join(cwd, "src", "bug.ts"), "utf8")).toContain("return a - b;");
  });

  it("rejects edits to unread or stale files", async () => {
    const cwd = fixtureProject();
    const tools = createProjectToolRegistry();

    const unread = await runTool(
      tools,
      cwd,
      "Edit",
      {
        path: "src/bug.ts",
        oldString: "return a - b;",
        newString: "return a + b;"
      },
      "bypassPermissions"
    );
    expect(unread.status).toBe("error");
    expect(unread.error).toContain("requires a prior Read");

    await runTool(tools, cwd, "Read", { path: "src/bug.ts" });
    writeFileSync(join(cwd, "src", "bug.ts"), "export const changed = true;\n", "utf8");

    const stale = await runTool(
      tools,
      cwd,
      "Edit",
      {
        path: "src/bug.ts",
        oldString: "return a - b;",
        newString: "return a + b;"
      },
      "bypassPermissions"
    );

    expect(stale.status).toBe("error");
    expect(stale.error).toContain("changed since the last Read");
  });

  it("writes new files and requires a prior Read before overwriting existing files", async () => {
    const cwd = fixtureProject();
    const tools = createProjectToolRegistry();

    const created = await runTool(
      tools,
      cwd,
      "Write",
      { path: "src/new.ts", content: "export const ok = true;\n" },
      "bypassPermissions"
    );
    expect(created.status).toBe("success");
    expect(created.content).toContain("+++ src/new.ts");
    expect(readFileSync(join(cwd, "src", "new.ts"), "utf8")).toContain("ok = true");

    const overwrite = await runTool(
      tools,
      cwd,
      "Write",
      { path: "src/bug.ts", content: "export const overwritten = true;\n" },
      "bypassPermissions"
    );
    expect(overwrite.status).toBe("error");
    expect(overwrite.error).toContain("requires a prior Read");
  });

  it("runs a PostToolUse lint hook after Edit and blocks the result on exit code 2", async () => {
    const cwd = fixtureProject();
    const tools = createProjectToolRegistry();
    const hookScript = join(cwd, "lint-hook.cjs");
    writeFileSync(
      hookScript,
      [
        "let input = '';",
        "process.stdin.on('data', chunk => input += chunk);",
        "process.stdin.on('end', () => {",
        "  const payload = JSON.parse(input);",
        "  if (payload.event === 'PostToolUse' && payload.toolUse.name === 'Edit') {",
        "    console.error('lint failed after edit');",
        "    process.exit(2);",
        "  }",
        "  process.exit(0);",
        "});"
      ].join("\n"),
      "utf8"
    );
    mkdirSync(join(cwd, ".myagent"));
    writeFileSync(
      join(cwd, ".myagent", "hooks.json"),
      JSON.stringify({
        hooks: [
          {
            name: "lint-after-edit",
            event: "PostToolUse",
            command: `${quote(process.execPath)} ${quote(hookScript)}`,
            tools: ["Edit"]
          }
        ]
      }),
      "utf8"
    );
    const hookSnapshot = await loadHookSnapshot(cwd);

    await runTool(tools, cwd, "Read", { path: "src/bug.ts" });
    const result = await runTool(
      tools,
      cwd,
      "Edit",
      {
        path: "src/bug.ts",
        oldString: "return a - b;",
        newString: "return a + b;"
      },
      "bypassPermissions",
      hookSnapshot
    );

    expect(result.status).toBe("error");
    expect(result.error).toContain("Blocked by PostToolUse hook lint-after-edit");
    expect(result.error).toContain("lint failed after edit");
    expect(readFileSync(join(cwd, "src", "bug.ts"), "utf8")).toContain("return a + b;");
  });
});

describe("week 4 read-only Bash tool", () => {
  it("runs whitelisted read-only commands", async () => {
    const cwd = fixtureProject();
    const result = await runTool(createProjectToolRegistry(), cwd, "Bash", { command: "pwd" }, "plan");

    expect(result.status).toBe("success");
    expect(result.content).toContain("$ pwd");
    expect(result.content).toContain(cwd);
  });

  it("rejects dangerous Bash commands and shell syntax", async () => {
    const cwd = fixtureProject();
    const tools = createProjectToolRegistry();

    await expect(runTool(tools, cwd, "Bash", { command: "rm src/bug.ts" }, "bypassPermissions"))
      .resolves.toMatchObject({ status: "error", error: expect.stringContaining("rm") });
    await expect(runTool(tools, cwd, "Bash", { command: "mv src/bug.ts src/x.ts" }, "bypassPermissions"))
      .resolves.toMatchObject({ status: "error", error: expect.stringContaining("mv") });
    await expect(runTool(tools, cwd, "Bash", { command: "git commit -m test" }, "bypassPermissions"))
      .resolves.toMatchObject({ status: "error", error: expect.stringContaining("git commit") });
    await expect(runTool(tools, cwd, "Bash", { command: "cat src/bug.ts > out.txt" }, "bypassPermissions"))
      .resolves.toMatchObject({ status: "error", error: expect.stringContaining("redirects") });
    await expect(runTool(tools, cwd, "Bash", { command: "cat .env" }, "bypassPermissions"))
      .resolves.toMatchObject({ status: "error", error: expect.stringContaining(".env") });
  });
});

function quote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}
