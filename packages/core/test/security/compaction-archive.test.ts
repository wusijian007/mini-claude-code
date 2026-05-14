import { describe, expect, it } from "vitest";
import {
  compactMessages,
  compactSessionRecord,
  type Message,
  type SessionEvent,
  type SessionRecord
} from "../../src/index.js";

function makeRecord(messages: readonly Message[]): SessionRecord {
  const events: SessionEvent[] = messages.map((message, index) => {
    const at = new Date(1_700_000_000_000 + index * 1_000).toISOString();
    if (message.role === "user") {
      return { type: "user_message", message, at };
    }
    return { type: "assistant_message", message, at };
  });
  return {
    version: 1,
    sessionId: "sess_archive_test",
    createdAt: events[0]?.at ?? new Date().toISOString(),
    updatedAt: events.at(-1)?.at ?? new Date().toISOString(),
    bootstrap: {
      sessionId: "sess_archive_test",
      cwd: process.cwd().replace(/\\/g, "/"),
      model: "test-model",
      costUsd: 0,
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
      permissionMode: "default"
    },
    events
  };
}

describe("security: compaction archive plumbing", () => {
  it("compactMessages invokes archiveSink with the dropped slice", () => {
    const messages: Message[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: "X".repeat(2_000) },
      { role: "user", content: "middle" },
      { role: "assistant", content: "Y".repeat(2_000) },
      { role: "user", content: "latest" }
    ];

    const captured: Message[][] = [];
    const compacted = compactMessages(messages, {
      targetTokens: 20,
      keepFirstMessages: 1,
      keepLastMessages: 1,
      maxMessageChars: 120,
      archiveSink: (omitted) => {
        captured.push([...omitted]);
      }
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]).toHaveLength(3);
    expect(captured[0]).toEqual(messages.slice(1, 4));
    // archiveSink receives the *original* (unsnipped) messages.
    expect(String(captured[0]?.[1]?.content)).toBe("middle");
    // The compacted result is still snipped + the omission notice.
    expect(String(compacted[1]?.content)).toContain("context compacted");
  });

  it("compactMessages skips archiveSink when nothing is dropped", () => {
    const messages: Message[] = [
      { role: "user", content: "short" },
      { role: "assistant", content: "also short" }
    ];

    let called = 0;
    compactMessages(messages, {
      targetTokens: 10_000,
      keepFirstMessages: 1,
      keepLastMessages: 1,
      archiveSink: () => {
        called += 1;
      }
    });

    expect(called).toBe(0);
  });

  it("compactSessionRecord with archiver records archivePath on the compact event", async () => {
    const record = makeRecord([
      { role: "user", content: "first" },
      { role: "assistant", content: "Z".repeat(5_000) },
      { role: "user", content: "second" },
      { role: "assistant", content: "W".repeat(5_000) },
      { role: "user", content: "latest" }
    ]);

    const receivedAts: string[] = [];
    const compacted = await compactSessionRecord(record, {
      targetTokens: 20,
      keepFirstMessages: 1,
      keepLastMessages: 1,
      maxMessageChars: 120,
      archiver: async (omitted, at) => {
        receivedAts.push(at);
        expect(omitted.length).toBeGreaterThan(0);
        return `/tmp/archive-${at.replace(/[:.]/g, "-")}.json`;
      }
    });

    const compactEvent = compacted.events.find((event): event is Extract<SessionEvent, { type: "compact" }> =>
      event.type === "compact"
    );
    expect(compactEvent).toBeDefined();
    expect(compactEvent?.archivePath).toBe(`/tmp/archive-${receivedAts[0]?.replace(/[:.]/g, "-")}.json`);
    expect(compactEvent?.at).toBe(receivedAts[0]);
  });

  it("compactSessionRecord without archiver leaves archivePath absent (back-compat)", async () => {
    const record = makeRecord([
      { role: "user", content: "first" },
      { role: "assistant", content: "X".repeat(5_000) },
      { role: "user", content: "second" },
      { role: "assistant", content: "Y".repeat(5_000) },
      { role: "user", content: "latest" }
    ]);

    const compacted = await compactSessionRecord(record, {
      targetTokens: 20,
      keepFirstMessages: 1,
      keepLastMessages: 1,
      maxMessageChars: 120
    });

    const compactEvent = compacted.events.find((event): event is Extract<SessionEvent, { type: "compact" }> =>
      event.type === "compact"
    );
    expect(compactEvent).toBeDefined();
    expect(compactEvent?.archivePath).toBeUndefined();
  });

  it("archiver returning undefined leaves archivePath unset (best-effort persistence failure)", async () => {
    const record = makeRecord([
      { role: "user", content: "first" },
      { role: "assistant", content: "X".repeat(5_000) },
      { role: "user", content: "second" },
      { role: "assistant", content: "Y".repeat(5_000) },
      { role: "user", content: "latest" }
    ]);

    const compacted = await compactSessionRecord(record, {
      targetTokens: 20,
      keepFirstMessages: 1,
      keepLastMessages: 1,
      maxMessageChars: 120,
      archiver: async () => undefined
    });
    const compactEvent = compacted.events.find((event): event is Extract<SessionEvent, { type: "compact" }> =>
      event.type === "compact"
    );
    expect(compactEvent?.archivePath).toBeUndefined();
  });
});
