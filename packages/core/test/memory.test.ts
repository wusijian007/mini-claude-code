import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import {
  createMemoryStore,
  formatMemoryContext,
  memoryRejectionReason,
  projectSlugForPath
} from "../src/index.js";

describe("memory store", () => {
  it("saves editable taxonomy memory and generates an index", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "myagent-memory-"));
    const store = createMemoryStore(cwd);

    const result = await store.save({
      taxonomy: "project",
      content: "测试必须用真实 DB，不用 mock",
      source: "test",
      now: new Date("2026-05-13T00:00:00.000Z")
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(store.rootDir).toContain(`.myagent/projects/${projectSlugForPath(cwd)}/memory`);
    expect(readFileSync(store.indexPath(), "utf8")).toContain("测试必须用真实 DB");
    expect(readFileSync(store.pathFor(result.entry), "utf8")).toContain("taxonomy: project");
  });

  it("loads manual edits from memory files on the next read", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "myagent-memory-edit-"));
    const store = createMemoryStore(cwd);
    const result = await store.save({
      taxonomy: "user",
      content: "Prefer concise answers",
      now: new Date("2026-05-13T00:00:00.000Z")
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const file = store.pathFor(result.entry);
    const raw = readFileSync(file, "utf8");
    writeFileSync(file, raw.replace("Prefer concise answers", "Prefer detailed acceptance criteria"), "utf8");

    await expect(store.load()).resolves.toMatchObject([
      {
        taxonomy: "user",
        content: "Prefer detailed acceptance criteria"
      }
    ]);
  });

  it("loads CRLF frontmatter from manually edited memory files", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "myagent-memory-crlf-"));
    const store = createMemoryStore(cwd);
    const result = await store.save({
      taxonomy: "feedback",
      content: "Prefer acceptance criteria",
      now: new Date("2026-05-13T00:00:00.000Z")
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const file = store.pathFor(result.entry);
    const raw = readFileSync(file, "utf8");
    writeFileSync(
      file,
      raw.replace(/\n/g, "\r\n").replace("Prefer acceptance criteria", "Prefer CRLF memory files"),
      "utf8"
    );

    const entries = await store.load();
    expect(entries[0]).toMatchObject({
      taxonomy: "feedback",
      content: "Prefer CRLF memory files"
    });
    expect(entries[0]?.content).not.toContain("taxonomy:");
  });

  it("recalls relevant memory and warns when it is stale", async () => {
    const staleEntry = {
      id: "mem_old",
      taxonomy: "project" as const,
      content: "测试必须用真实 DB，不用 mock",
      createdAt: "2026-05-10T00:00:00.000Z",
      updatedAt: "2026-05-10T00:00:00.000Z",
      path: "project/mem_old.md"
    };

    const context = formatMemoryContext([staleEntry], new Date("2026-05-13T00:00:00.000Z"));

    expect(context).toContain("测试必须用真实 DB");
    expect(context).toContain("stale: older than 1 day");
  });

  it("rejects code patterns, git history, and re-derivable codebase facts", () => {
    expect(memoryRejectionReason("Use function buildTool() from packages/core/src/tool.ts")).toContain(
      "codebase facts"
    );
    expect(memoryRejectionReason("Latest git commit fixed the parser")).toContain("git history");
    expect(memoryRejectionReason("```ts\nconst value = 1;\n```")).toContain("code patterns");
    expect(memoryRejectionReason("Do not run git commit automatically")).toBeNull();
    expect(memoryRejectionReason("测试必须用真实 DB，不用 mock")).toBeNull();
  });
});
