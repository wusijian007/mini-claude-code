import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { compactMessages, estimateMessagesTokens, type CompactOptions } from "./context.js";
import type { ModelUsage } from "./model.js";
import { normalizePath, type BootstrapState } from "./state.js";
import type { Message, TerminalState, ToolResult, ToolUse } from "./types.js";

export type SessionEvent =
  | {
      type: "user_message";
      message: Message;
      at: string;
    }
  | {
      type: "assistant_message";
      message: Message;
      usage?: ModelUsage;
      stopReason?: string | null;
      requestId?: string;
      at: string;
    }
  | {
      type: "tool_use";
      toolUse: ToolUse;
      at: string;
    }
  | {
      type: "tool_result";
      result: ToolResult;
      at: string;
    }
  | {
      type: "terminal_state";
      state: TerminalState;
      at: string;
    }
  | {
      type: "compact";
      beforeTokens: number;
      afterTokens: number;
      beforeEvents: number;
      afterEvents: number;
      at: string;
      /**
       * Absolute path to the JSON archive of the messages that were
       * dropped by this compaction. Absent when the caller did not
       * supply an archiver (e.g. headless `query` retry on
       * prompt_too_long, or older sessions before M1.4).
       */
      archivePath?: string;
    };

export type SessionEventInput =
  | {
      type: "user_message";
      message: Message;
    }
  | {
      type: "assistant_message";
      message: Message;
      usage?: ModelUsage;
      stopReason?: string | null;
      requestId?: string;
    }
  | {
      type: "tool_use";
      toolUse: ToolUse;
    }
  | {
      type: "tool_result";
      result: ToolResult;
    }
  | {
      type: "terminal_state";
      state: TerminalState;
    }
  | {
      type: "compact";
      beforeTokens: number;
      afterTokens: number;
      beforeEvents: number;
      afterEvents: number;
      archivePath?: string;
    };

export type SessionRecord = {
  version: 1;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  bootstrap: BootstrapState;
  events: SessionEvent[];
};

export type SessionStore = {
  rootDir: string;
  create(bootstrap: BootstrapState, initialEvents?: readonly SessionEvent[]): Promise<SessionRecord>;
  load(sessionId: string): Promise<SessionRecord>;
  save(record: SessionRecord): Promise<void>;
  append(
    sessionId: string,
    event: SessionEventInput,
    bootstrap?: BootstrapState
  ): Promise<SessionRecord>;
  pathFor(sessionId: string): string;
};

export function createSessionStore(cwd: string, rootDir?: string): SessionStore {
  const normalizedRoot = normalizePath(resolve(rootDir ?? join(cwd, ".myagent", "sessions")));

  return {
    rootDir: normalizedRoot,
    async create(bootstrap, initialEvents = []) {
      const now = nowIso();
      const record: SessionRecord = {
        version: 1,
        sessionId: bootstrap.sessionId,
        createdAt: now,
        updatedAt: now,
        bootstrap: normalizeBootstrap(bootstrap),
        events: initialEvents.map((event) => ({ ...event }))
      };
      await this.save(record);
      return record;
    },
    async load(sessionId) {
      const raw = await readFile(this.pathFor(sessionId), "utf8");
      const parsed = JSON.parse(raw) as SessionRecord;
      return {
        ...parsed,
        bootstrap: normalizeBootstrap(parsed.bootstrap),
        events: parsed.events ?? []
      };
    },
    async save(record) {
      await mkdir(normalizedRoot, { recursive: true });
      const normalizedRecord: SessionRecord = {
        ...record,
        updatedAt: nowIso(),
        bootstrap: normalizeBootstrap(record.bootstrap)
      };
      await writeFile(this.pathFor(record.sessionId), `${JSON.stringify(normalizedRecord, null, 2)}\n`, "utf8");
    },
    async append(sessionId, event, bootstrap) {
      const record = await this.load(sessionId);
      record.events.push({ ...event, at: nowIso() } as SessionEvent);
      if (bootstrap) {
        record.bootstrap = normalizeBootstrap(bootstrap);
      }
      await this.save(record);
      return this.load(sessionId);
    },
    pathFor(sessionId) {
      if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
        throw new Error("Invalid session id");
      }
      return join(normalizedRoot, `${sessionId}.json`);
    }
  };
}

export function eventNow(event: SessionEventInput): SessionEvent {
  return {
    ...event,
    at: nowIso()
  } as SessionEvent;
}

export function replayMessagesFromSession(record: SessionRecord): Message[] {
  const messages: Message[] = [];

  for (const event of record.events) {
    if (event.type === "user_message" || event.type === "assistant_message") {
      messages.push(event.message);
      continue;
    }

    if (event.type === "tool_result") {
      messages.push({
        role: "tool",
        content: [{ type: "tool_result", result: event.result }]
      });
    }
  }

  return messages;
}

/**
 * Persists the messages a compaction is about to drop. Called with the
 * (unsnipped) omitted slice and the compaction's `at` timestamp. The
 * returned string (typically an absolute path) is recorded on the
 * resulting `compact` event as `archivePath` so callers can recover
 * the original transcript later. Return `undefined` to skip recording
 * a path (e.g. if persistence fails best-effort).
 */
export type SessionCompactionArchiver = (
  omitted: readonly Message[],
  at: string
) => Promise<string | undefined> | string | undefined;

export type CompactSessionRecordOptions = CompactOptions & {
  archiver?: SessionCompactionArchiver;
};

export async function compactSessionRecord(
  record: SessionRecord,
  options: CompactSessionRecordOptions = {}
): Promise<SessionRecord> {
  const beforeMessages = replayMessagesFromSession(record);
  const beforeTokens = estimateMessagesTokens(beforeMessages);
  let omittedCapture: readonly Message[] = [];
  const compactedMessages = compactMessages(beforeMessages, {
    ...options,
    archiveSink: (omitted) => {
      omittedCapture = omitted;
      options.archiveSink?.(omitted);
    }
  });
  const afterTokens = estimateMessagesTokens(compactedMessages);
  const compactedEvents = eventsFromMessages(compactedMessages);
  const terminalState = [...record.events].reverse().find((event) => event.type === "terminal_state");
  const at = nowIso();
  let archivePath: string | undefined;
  if (options.archiver && omittedCapture.length > 0) {
    archivePath = (await options.archiver(omittedCapture, at)) ?? undefined;
  }
  const compactEvent: SessionEvent = {
    type: "compact",
    beforeTokens,
    afterTokens,
    beforeEvents: record.events.length,
    afterEvents: compactedEvents.length + (terminalState ? 2 : 1),
    at,
    archivePath
  };

  return {
    ...record,
    updatedAt: nowIso(),
    events: terminalState ? [...compactedEvents, terminalState, compactEvent] : [...compactedEvents, compactEvent]
  };
}

export function summarizeSession(record: SessionRecord): string {
  const lines = [
    `[session] ${record.sessionId}`,
    `cwd: ${record.bootstrap.cwd}`,
    `model: ${record.bootstrap.model}`,
    `permissionMode: ${record.bootstrap.permissionMode}`,
    `events: ${record.events.length}`
  ];

  for (const event of record.events) {
    if (event.type === "user_message") {
      lines.push(`user: ${messagePreview(event.message)}`);
    }
    if (event.type === "assistant_message") {
      lines.push(`assistant: ${messagePreview(event.message)}`);
    }
    if (event.type === "tool_use") {
      lines.push(`tool_use: ${event.toolUse.name} ${JSON.stringify(event.toolUse.input)}`);
    }
    if (event.type === "tool_result") {
      lines.push(`tool_result: ${event.result.status}`);
    }
    if (event.type === "terminal_state") {
      lines.push(`terminal_state: ${event.state.status}`);
    }
    if (event.type === "compact") {
      lines.push(`compact: ${event.beforeTokens}->${event.afterTokens} estimated tokens`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function eventsFromMessages(messages: readonly Message[]): SessionEvent[] {
  return messages.flatMap((message) => {
    if (message.role === "user") {
      return [eventNow({ type: "user_message", message })];
    }

    if (message.role === "assistant") {
      const events: SessionEvent[] = [eventNow({ type: "assistant_message", message })];
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.type === "tool_use") {
            events.push(eventNow({ type: "tool_use", toolUse: block.toolUse }));
          }
        }
      }
      return events;
    }

    if (Array.isArray(message.content)) {
      return message.content
        .filter((block) => block.type === "tool_result")
        .map((block) => eventNow({ type: "tool_result", result: block.result }));
    }

    return [];
  });
}

function messagePreview(message: Message): string {
  const text =
    typeof message.content === "string"
      ? message.content
      : message.content
          .map((block) => {
            if (block.type === "text") {
              return block.text;
            }
            if (block.type === "tool_use") {
              return `[tool_use:${block.toolUse.name}]`;
            }
            return `[tool_result:${block.result.status}]`;
          })
          .join(" ");
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function normalizeBootstrap(bootstrap: BootstrapState): BootstrapState {
  return {
    ...bootstrap,
    cwd: normalizePath(resolve(bootstrap.cwd))
  };
}

function nowIso(): string {
  return new Date().toISOString();
}
