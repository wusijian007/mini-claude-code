import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import {
  connectRemoteClient,
  createRemoteAgentServer,
  formatRemoteSessionList,
  type RemoteServerMessage
} from "../src/index.js";

describe("remote websocket direct connect", () => {
  it("streams a remote prompt, dedupes write ids, and resumes metadata", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "myagent-remote-"));
    let runCount = 0;
    const server = await createRemoteAgentServer({
      cwd,
      port: 0,
      authToken: "test-token",
      async runPrompt(input, sink) {
        runCount += 1;
        sink.writeStdout(`[agent] ${input.prompt}\n`);
        return {
          sessionId: input.agentSessionId ?? "sess_remote_agent",
          exitCode: 0
        };
      }
    });

    try {
      const client = await connectRemoteClient({ port: server.port, authToken: "test-token" });
      expect(await client.nextMessage()).toEqual({ type: "ready", protocolVersion: 1 });

      client.send({ type: "user_message", id: "write_1", prompt: "hello remote" });
      const messages = await client.readUntil(
        (message) => message.type === "session_metadata" && message.session.state === "completed"
      );
      const ack = messages.find(isAck);
      const stdout = messages.filter(isStdout).map((message) => message.chunk).join("");
      const terminal = messages.find((message) => message.type === "terminal_state");

      expect(ack).toMatchObject({ id: "write_1", duplicate: false });
      expect(stdout).toContain("[agent] hello remote");
      expect(terminal).toMatchObject({ exitCode: 0, agentSessionId: "sess_remote_agent" });
      expect(runCount).toBe(1);
      const sessionId = ack?.sessionId ?? "";

      client.send({ type: "user_message", id: "write_1", sessionId, prompt: "hello remote again" });
      const duplicateMessages = await client.readUntil((message) => message.type === "session_metadata");
      expect(duplicateMessages.find(isAck)).toMatchObject({ id: "write_1", duplicate: true });
      expect(runCount).toBe(1);
      client.close();

      const resumed = await connectRemoteClient({ port: server.port, authToken: "test-token" });
      expect(await resumed.nextMessage()).toEqual({ type: "ready", protocolVersion: 1 });
      resumed.send({ type: "resume", id: "resume_1", sessionId });
      const resumeMessages = await resumed.readUntil((message) => message.type === "session_metadata");
      const metadata = resumeMessages.find((message) => message.type === "session_metadata");
      expect(metadata).toMatchObject({
        session: {
          sessionId,
          agentSessionId: "sess_remote_agent",
          state: "completed",
          writeIds: ["write_1"]
        }
      });
      resumed.close();
    } finally {
      await server.close();
    }
  });

  it("round-trips permission requests through the remote client", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "myagent-remote-permission-"));
    const server = await createRemoteAgentServer({
      cwd,
      port: 0,
      authToken: "test-token",
      async runPrompt(_input, sink) {
        const decision = await sink.requestPermission({
          toolName: "Write",
          input: { path: "note.txt" },
          reason: "Write requires a remote client decision"
        });
        sink.writeStdout(`permission=${decision.kind}\n`);
        return { sessionId: "sess_remote_permission", exitCode: decision.kind === "allow" ? 0 : 1 };
      }
    });

    try {
      const client = await connectRemoteClient({ port: server.port, authToken: "test-token" });
      expect(await client.nextMessage()).toEqual({ type: "ready", protocolVersion: 1 });
      client.send({ type: "user_message", id: "write_permission", prompt: "create note" });
      const permissionMessages = await client.readUntil((message) => message.type === "permission_request");
      const request = permissionMessages.find((message) => message.type === "permission_request");
      expect(request).toMatchObject({
        type: "permission_request",
        id: "write_permission",
        request: { toolName: "Write" }
      });

      client.send({
        type: "permission_decision",
        id: "decision_1",
        permissionRequestId: request?.permissionRequestId ?? "",
        decision: { kind: "allow", reason: "approved by test client" }
      });
      const messages = await client.readUntil((message) => message.type === "terminal_state");
      const stdout = messages.filter(isStdout).map((message) => message.chunk).join("");
      expect(stdout).toContain("permission=allow");
      expect(messages.find((message) => message.type === "terminal_state")).toMatchObject({
        exitCode: 0,
        agentSessionId: "sess_remote_permission"
      });
      client.close();
    } finally {
      await server.close();
    }
  });

  it("formats persisted remote sessions for CLI listing", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "myagent-remote-list-"));
    const server = await createRemoteAgentServer({
      cwd,
      port: 0,
      authToken: "test-token",
      async runPrompt() {
        return { sessionId: "sess_unused", exitCode: 0 };
      }
    });

    try {
      const session = await server.store.create({ cwd, agentSessionId: "sess_listed" });
      const list = formatRemoteSessionList(await server.store.list());
      expect(list).toContain(session.sessionId);
      expect(list).toContain("agent=sess_listed");
    } finally {
      await server.close();
    }
  });
});

function isAck(message: RemoteServerMessage): message is Extract<RemoteServerMessage, { type: "ack" }> {
  return message.type === "ack";
}

function isStdout(
  message: RemoteServerMessage
): message is Extract<RemoteServerMessage, { type: "agent_stdout" }> {
  return message.type === "agent_stdout";
}
