import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import {
  compactSessionRecord,
  createBootstrapState,
  createSessionStore,
  estimateMessagesTokens,
  replayMessagesFromSession,
  summarizeSession
} from "../src/index.js";

describe("session transcript store", () => {
  it("persists and replays user, assistant, tool_use, and tool_result events", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "myagent-session-"));
    const rootDir = join(cwd, ".myagent", "sessions");
    const bootstrap = createBootstrapState({
      sessionId: "sess_fixture",
      cwd,
      model: "test-model",
      permissionMode: "plan"
    });
    const store = createSessionStore(cwd, rootDir);

    await store.create(bootstrap);
    await store.append(bootstrap.sessionId, {
      type: "user_message",
      message: { role: "user", content: "Read package.json" }
    });
    await store.append(bootstrap.sessionId, {
      type: "assistant_message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "I will inspect it." },
          {
            type: "tool_use",
            toolUse: {
              id: "toolu_read",
              name: "Read",
              input: { path: "package.json" }
            }
          }
        ]
      }
    });
    await store.append(bootstrap.sessionId, {
      type: "tool_use",
      toolUse: {
        id: "toolu_read",
        name: "Read",
        input: { path: "package.json" }
      }
    });
    await store.append(bootstrap.sessionId, {
      type: "tool_result",
      result: {
        toolUseId: "toolu_read",
        status: "success",
        content: "package content"
      }
    });

    const record = await store.load(bootstrap.sessionId);
    const raw = await readFile(store.pathFor(bootstrap.sessionId), "utf8");

    expect(JSON.parse(raw)).toMatchObject({ sessionId: "sess_fixture", version: 1 });
    expect(record.bootstrap.cwd).not.toContain("\\");
    expect(record.events.map((event) => event.type)).toEqual([
      "user_message",
      "assistant_message",
      "tool_use",
      "tool_result"
    ]);
    expect(replayMessagesFromSession(record).map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool"
    ]);
    expect(summarizeSession(record)).toContain("tool_use: Read");
  });

  it("rejects unsafe session ids", () => {
    const cwd = mkdtempSync(join(tmpdir(), "myagent-session-"));
    const store = createSessionStore(cwd);

    expect(() => store.pathFor("../secret")).toThrow(/Invalid session id/);
  });

  it("compacts transcript events and records before/after token estimates", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "myagent-session-"));
    const bootstrap = createBootstrapState({
      sessionId: "sess_compact",
      cwd,
      model: "test-model",
      permissionMode: "plan"
    });
    const store = createSessionStore(cwd);
    await store.create(bootstrap);
    await store.append(bootstrap.sessionId, {
      type: "user_message",
      message: { role: "user", content: "first" }
    });
    await store.append(bootstrap.sessionId, {
      type: "assistant_message",
      message: { role: "assistant", content: "middle ".repeat(2_000) }
    });
    await store.append(bootstrap.sessionId, {
      type: "user_message",
      message: { role: "user", content: "latest" }
    });

    const record = await store.load(bootstrap.sessionId);
    const beforeTokens = estimateMessagesTokens(replayMessagesFromSession(record));
    const compacted = await compactSessionRecord(record, {
      targetTokens: 20,
      keepFirstMessages: 1,
      keepLastMessages: 1,
      maxMessageChars: 120
    });

    expect(compacted.events.at(-1)).toMatchObject({ type: "compact" });
    expect(estimateMessagesTokens(replayMessagesFromSession(compacted))).toBeLessThan(beforeTokens);
    expect(summarizeSession(compacted)).toContain("compact:");
  });

  it("loads pre-M1.5a sessions whose tokenUsage is missing cache fields", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "myagent-session-legacy-"));
    const sessionRootDir = join(cwd, ".myagent", "sessions");
    mkdirSync(sessionRootDir, { recursive: true });
    const legacy = {
      version: 1,
      sessionId: "sess_legacy_fixture",
      createdAt: new Date(1_700_000_000_000).toISOString(),
      updatedAt: new Date(1_700_000_000_000).toISOString(),
      bootstrap: {
        sessionId: "sess_legacy_fixture",
        cwd: cwd.replace(/\\/g, "/"),
        model: "claude-old",
        costUsd: 0.5,
        tokenUsage: { inputTokens: 100, outputTokens: 50 },
        permissionMode: "default"
      },
      events: []
    };
    writeFileSync(
      join(sessionRootDir, "sess_legacy_fixture.json"),
      `${JSON.stringify(legacy, null, 2)}\n`,
      "utf8"
    );

    const store = createSessionStore(cwd, sessionRootDir);
    const loaded = await store.load("sess_legacy_fixture");
    expect(loaded.bootstrap.tokenUsage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0
    });
  });
});
