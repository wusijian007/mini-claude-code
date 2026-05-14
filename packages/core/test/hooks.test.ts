import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import {
  loadHookSnapshot,
  runToolHooks,
  type ToolUse
} from "../src/index.js";

describe("command hooks", () => {
  it("runs command hooks with JSON stdin and blocks on exit code 2", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "myagent-hooks-"));
    const hookPath = writeHookScript(
      cwd,
      "block-edit.cjs",
      [
        "let input = '';",
        "process.stdin.on('data', chunk => input += chunk);",
        "process.stdin.on('end', () => {",
        "  const payload = JSON.parse(input);",
        "  if (payload.event === 'PostToolUse' && payload.toolUse.name === 'Edit') {",
        "    console.error('lint failed');",
        "    process.exit(2);",
        "  }",
        "  process.exit(0);",
        "});"
      ].join("\n")
    );
    writeHookConfig(cwd, [
      {
        name: "lint-after-edit",
        event: "PostToolUse",
        command: nodeCommand(hookPath),
        tools: ["Edit"]
      }
    ]);

    const snapshot = await loadHookSnapshot(cwd);
    const result = await runToolHooks(snapshot, {
      event: "PostToolUse",
      cwd,
      toolUse: toolUse("Edit"),
      result: {
        toolUseId: "toolu_Edit",
        status: "success",
        content: "Edited file"
      }
    });

    expect(result).toMatchObject({
      status: "blocked",
      hookName: "lint-after-edit"
    });
    expect(result.status === "blocked" ? result.reason : "").toContain("lint failed");
  });

  it("keeps a frozen snapshot even when hook config changes", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "myagent-hook-snapshot-"));
    const blockPath = writeHookScript(cwd, "block.cjs", "process.stdin.resume(); process.stdin.on('end', () => process.exit(2));");
    writeHookConfig(cwd, [
      {
        name: "frozen-block",
        event: "PreToolUse",
        command: nodeCommand(blockPath),
        tools: ["Write"]
      }
    ]);
    const snapshot = await loadHookSnapshot(cwd);

    writeHookConfig(cwd, []);

    await expect(runToolHooks(snapshot, { event: "PreToolUse", cwd, toolUse: toolUse("Write") }))
      .resolves.toMatchObject({ status: "blocked" });
    await expect(runToolHooks(await loadHookSnapshot(cwd), { event: "PreToolUse", cwd, toolUse: toolUse("Write") }))
      .resolves.toMatchObject({ status: "passed" });
  });

  it("treats non-zero non-blocking exits as warnings", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "myagent-hook-warning-"));
    const warnPath = writeHookScript(
      cwd,
      "warn.cjs",
      "process.stdin.resume(); process.stdin.on('end', () => { console.log('soft warning'); process.exit(1); });"
    );
    writeHookConfig(cwd, [
      {
        name: "soft-check",
        event: "PreToolUse",
        command: nodeCommand(warnPath)
      }
    ]);

    await expect(runToolHooks(await loadHookSnapshot(cwd), { event: "PreToolUse", cwd, toolUse: toolUse("Read") }))
      .resolves.toMatchObject({
        status: "passed",
        warnings: [
          {
            hookName: "soft-check",
            message: expect.stringContaining("soft warning")
          }
        ]
      });
  });
});

function writeHookScript(cwd: string, name: string, content: string): string {
  const dir = join(cwd, "hooks");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, content, "utf8");
  return path;
}

function writeHookConfig(cwd: string, hooks: unknown[]): void {
  mkdirSync(join(cwd, ".myagent"), { recursive: true });
  writeFileSync(join(cwd, ".myagent", "hooks.json"), `${JSON.stringify({ hooks }, null, 2)}\n`, "utf8");
}

function nodeCommand(scriptPath: string): string {
  return `${quote(process.execPath)} ${quote(scriptPath)}`;
}

function quote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function toolUse(name: string): ToolUse {
  return {
    id: `toolu_${name}`,
    name,
    input: {}
  };
}
