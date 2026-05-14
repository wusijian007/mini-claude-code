import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executeToolUse, type PermissionMode, type ToolDefinition } from "@mini-claude-code/core";
import { describe, expect, it } from "vitest";

import { createProjectToolRegistry } from "../../src/index.js";

function fixtureProject(): string {
  const cwd = mkdtempSync(join(tmpdir(), "myagent-sec-bash-"));
  mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, "src", "a.ts"), "export const a = 1;\n", "utf8");
  writeFileSync(join(cwd, ".env"), "SECRET=1\n", "utf8");
  return cwd;
}

async function runBash(
  tools: ToolDefinition[],
  cwd: string,
  command: string,
  permissionMode: PermissionMode = "bypassPermissions"
) {
  return executeToolUse(
    { id: "toolu_bash_sec", name: "Bash", input: { command } },
    new Map(tools.map((tool) => [tool.name, tool])),
    { cwd, permissionMode }
  );
}

describe("security: Bash parser rejections", () => {
  const tools = createProjectToolRegistry();

  it.each([
    ["semicolon chaining", "ls; rm -rf .", "redirects, pipes, command chaining"],
    ["pipe", "ls | grep secret", "redirects, pipes, command chaining"],
    ["ampersand", "ls & echo done", "redirects, pipes, command chaining"],
    ["stdout redirect", "ls > out.txt", "redirects, pipes, command chaining"],
    ["stdin redirect", "cat < src/a.ts", "redirects, pipes, command chaining"],
    ["subshell", "echo $(whoami)", "redirects, pipes, command chaining"],
    ["backtick substitution", "echo `whoami`", "redirects, pipes, command chaining"]
  ])("rejects %s", async (_label, command, expectedFragment) => {
    const cwd = fixtureProject();
    const result = await runBash(tools, cwd, command);
    expect(result.status).toBe("error");
    expect(result.error).toContain(expectedFragment);
  });

  it.each([
    ["relative parent traversal", "cat ../etc/passwd"],
    ["mid-path parent traversal", "cat src/../../../etc/passwd"],
    ["POSIX absolute path", "cat /etc/passwd"]
  ])("rejects %s as outside the project", async (_label, command) => {
    const cwd = fixtureProject();
    const result = await runBash(tools, cwd, command);
    expect(result.status).toBe("error");
    expect(result.error).toContain("outside the project");
  });

  it("rejects null bytes in arguments", async () => {
    const cwd = fixtureProject();
    // Build the null byte at runtime so the source file stays plain UTF-8
    // (a literal U+0000 in source would trip git's binary detection).
    const command = `cat src/a.ts${String.fromCharCode(0)}.env`;
    const result = await runBash(tools, cwd, command);
    expect(result.status).toBe("error");
    expect(result.error).toContain("null bytes");
  });

  it("rejects .env reads through cat", async () => {
    const cwd = fixtureProject();
    const result = await runBash(tools, cwd, "cat .env");
    expect(result.status).toBe("error");
    expect(result.error).toContain(".env");
  });

  it.each([
    ["rm", "rm src/a.ts"],
    ["mv", "mv src/a.ts src/b.ts"]
  ])("rejects disallowed write-like command: %s", async (executable, command) => {
    const cwd = fixtureProject();
    const result = await runBash(tools, cwd, command);
    expect(result.status).toBe("error");
    expect(result.error).toContain(executable);
  });

  it("rejects git subcommands outside the read-only whitelist", async () => {
    const cwd = fixtureProject();
    const result = await runBash(tools, cwd, "git commit -m x");
    expect(result.status).toBe("error");
    expect(result.error).toContain("git commit");
  });
});
