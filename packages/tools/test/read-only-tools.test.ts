import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { createMemoryStore } from "@mini-claude-code/core";
import { createReadOnlyToolRegistry } from "../src/index.js";

function fixtureProject(): string {
  const cwd = mkdtempSync(join(tmpdir(), "myagent-tools-"));
  mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, "README.md"), "# Fixture\n\nHello project\n", "utf8");
  writeFileSync(join(cwd, "src", "index.ts"), "// TODO: wire agent\nexport const value = 1;\n", "utf8");
  writeFileSync(join(cwd, ".env"), "ANTHROPIC_API_KEY=secret\n", "utf8");
  return cwd;
}

describe("read-only tools", () => {
  it("reads project files with line numbers", async () => {
    const cwd = fixtureProject();
    const read = createReadOnlyToolRegistry().find((tool) => tool.name === "Read");

    const result = await read?.call({ path: "README.md" }, { cwd });

    expect(result?.status).toBe("success");
    expect(result?.content).toContain("1\t# Fixture");
  });

  it("finds files with Glob while skipping .env", async () => {
    const cwd = fixtureProject();
    const glob = createReadOnlyToolRegistry().find((tool) => tool.name === "Glob");

    const result = await glob?.call({ pattern: "**/*" }, { cwd });

    expect(result?.content).toContain("README.md");
    expect(result?.content).toContain("src/index.ts");
    expect(result?.content).not.toContain(".env");
  });

  it("searches file content with Grep", async () => {
    const cwd = fixtureProject();
    const grep = createReadOnlyToolRegistry().find((tool) => tool.name === "Grep");

    const result = await grep?.call({ pattern: "TODO", include: "**/*.ts" }, { cwd });

    expect(result?.status).toBe("success");
    expect(result?.content).toContain("src/index.ts:1:// TODO: wire agent");
  });

  it("discovers editable memory files with Glob and Grep while keeping other .myagent files hidden", async () => {
    const cwd = fixtureProject();
    const store = createMemoryStore(cwd);
    const saved = await store.save({
      taxonomy: "project",
      content: "Use real DB for tests"
    });
    expect(saved.ok).toBe(true);

    mkdirSync(join(cwd, ".myagent", "sessions"), { recursive: true });
    writeFileSync(join(cwd, ".myagent", "sessions", "sess_hidden.json"), "hidden", "utf8");
    const tools = createReadOnlyToolRegistry();
    const glob = tools.find((tool) => tool.name === "Glob");
    const grep = tools.find((tool) => tool.name === "Grep");

    const globResult = await glob?.call({ pattern: ".myagent/projects/*/memory/**/*.md" }, { cwd });
    const grepResult = await grep?.call({
      pattern: "real DB",
      path: `.myagent/projects/${store.projectSlug}/memory`
    }, { cwd });

    expect(globResult?.content).toContain("/memory/project/");
    expect(globResult?.content).not.toContain("sessions");
    expect(grepResult?.content).toContain("Use real DB for tests");
  });

  it("blocks direct reads of .env", async () => {
    const cwd = fixtureProject();
    const read = createReadOnlyToolRegistry().find((tool) => tool.name === "Read");

    await expect(read?.call({ path: ".env" }, { cwd })).rejects.toThrow(/blocked/);
  });
});
