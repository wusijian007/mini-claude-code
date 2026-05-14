import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executeToolUse, loadHookSnapshot } from "@mini-claude-code/core";
import { describe, expect, it } from "vitest";

import { createProjectToolRegistry } from "../../src/index.js";

function fixtureProject(): string {
  const cwd = mkdtempSync(join(tmpdir(), "myagent-sec-prehook-"));
  return cwd;
}

function quote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function writeBlockingPreHook(cwd: string): void {
  const script = join(cwd, "block-pre.cjs");
  writeFileSync(
    script,
    [
      "process.stdin.resume();",
      "process.stdin.on('end', () => {",
      "  console.error('preuse blocked');",
      "  process.exit(2);",
      "});"
    ].join("\n"),
    "utf8"
  );
  mkdirSync(join(cwd, ".myagent"), { recursive: true });
  writeFileSync(
    join(cwd, ".myagent", "hooks.json"),
    JSON.stringify({
      hooks: [
        {
          name: "deny-writes",
          event: "PreToolUse",
          command: `${quote(process.execPath)} ${quote(script)}`,
          tools: ["Write"]
        }
      ]
    }),
    "utf8"
  );
}

describe("security: PreToolUse hook end-to-end", () => {
  it("blocks Write before it touches disk on exit code 2", async () => {
    const cwd = fixtureProject();
    writeBlockingPreHook(cwd);
    const hookSnapshot = await loadHookSnapshot(cwd);
    const tools = createProjectToolRegistry();
    const targetRel = "src/new.ts";
    const targetAbs = join(cwd, targetRel);

    const result = await executeToolUse(
      {
        id: "toolu_write_prehook",
        name: "Write",
        input: { path: targetRel, content: "export const x = 1;\n" }
      },
      new Map(tools.map((tool) => [tool.name, tool])),
      { cwd, permissionMode: "bypassPermissions", hookSnapshot }
    );

    expect(result.status).toBe("error");
    expect(result.error).toContain("Blocked by PreToolUse hook deny-writes");
    expect(result.error).toContain("preuse blocked");
    expect(existsSync(targetAbs)).toBe(false);
  });

  it("allows tools outside the hook's tool filter through", async () => {
    const cwd = fixtureProject();
    mkdirSync(join(cwd, "src"));
    writeFileSync(join(cwd, "src", "existing.ts"), "ok\n", "utf8");
    writeBlockingPreHook(cwd);
    const hookSnapshot = await loadHookSnapshot(cwd);
    const tools = createProjectToolRegistry();

    const result = await executeToolUse(
      { id: "toolu_read_prehook", name: "Read", input: { path: "src/existing.ts" } },
      new Map(tools.map((tool) => [tool.name, tool])),
      { cwd, permissionMode: "default", hookSnapshot }
    );

    expect(result.status).toBe("success");
  });
});
