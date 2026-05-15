import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import {
  connectRemoteClient,
  createRemoteAgentServer,
  type RemoteClient,
  type RemoteServerMessage
} from "../../src/index.js";

const TOKEN = "ownership-test-token";

async function startServer(runPrompt?: Parameters<typeof createRemoteAgentServer>[0]["runPrompt"]) {
  const cwd = mkdtempSync(join(tmpdir(), "myagent-sec-owner-"));
  return createRemoteAgentServer({
    cwd,
    port: 0,
    authToken: TOKEN,
    runPrompt:
      runPrompt ??
      (async (input, sink) => {
        sink.writeStdout(`[agent] ${input.prompt}\n`);
        return { sessionId: input.agentSessionId ?? "sess_owner_test", exitCode: 0 };
      })
  });
}

async function nextOfType(
  client: RemoteClient,
  type: RemoteServerMessage["type"]
): Promise<RemoteServerMessage> {
  const messages = await client.readUntil((m) => m.type === type);
  return messages[messages.length - 1];
}

describe("security: remote session ownership", () => {
  it("assigns owner to the first connection and follower to the second", async () => {
    const server = await startServer();
    try {
      const a = await connectRemoteClient({ port: server.port, authToken: TOKEN });
      const aRole = await nextOfType(a, "role");
      expect(aRole).toEqual({ type: "role", role: "owner" });

      const b = await connectRemoteClient({ port: server.port, authToken: TOKEN });
      const bRole = await nextOfType(b, "role");
      expect(bRole).toEqual({ type: "role", role: "follower" });

      a.close();
      b.close();
    } finally {
      await server.close();
    }
  });

  it("rejects a follower's user_message but accepts the owner's", async () => {
    const server = await startServer();
    try {
      const owner = await connectRemoteClient({ port: server.port, authToken: TOKEN });
      await nextOfType(owner, "role");
      const follower = await connectRemoteClient({ port: server.port, authToken: TOKEN });
      await nextOfType(follower, "role");

      follower.send({ type: "user_message", id: "f1", prompt: "i should be blocked" });
      const err = await nextOfType(follower, "error");
      expect(err).toMatchObject({
        type: "error",
        message: expect.stringContaining("read-only follower")
      });

      owner.send({ type: "user_message", id: "o1", prompt: "owner drives" });
      const ack = await nextOfType(owner, "ack");
      expect(ack).toMatchObject({ type: "ack", id: "o1", duplicate: false });

      owner.close();
      follower.close();
    } finally {
      await server.close();
    }
  });

  it("rejects a follower's permission_decision", async () => {
    const server = await startServer();
    try {
      const owner = await connectRemoteClient({ port: server.port, authToken: TOKEN });
      await nextOfType(owner, "role");
      const follower = await connectRemoteClient({ port: server.port, authToken: TOKEN });
      await nextOfType(follower, "role");

      follower.send({
        type: "permission_decision",
        id: "fp1",
        permissionRequestId: "perm_whatever",
        decision: { kind: "allow" }
      });
      const err = await nextOfType(follower, "error");
      expect(err).toMatchObject({
        type: "error",
        message: expect.stringContaining("read-only follower")
      });

      owner.close();
      follower.close();
    } finally {
      await server.close();
    }
  });

  it("broadcasts the owner's turn stream to a connected follower", async () => {
    const server = await startServer(async (input, sink) => {
      sink.writeStdout(`STREAMED:${input.prompt}\n`);
      return { sessionId: "sess_broadcast", exitCode: 0 };
    });
    try {
      const owner = await connectRemoteClient({ port: server.port, authToken: TOKEN });
      await nextOfType(owner, "role");
      const follower = await connectRemoteClient({ port: server.port, authToken: TOKEN });
      await nextOfType(follower, "role");

      owner.send({ type: "user_message", id: "b1", prompt: "hello-world" });

      // The follower — which submitted nothing — must still observe the
      // owner's stdout and the terminal state via the broadcast fan-out.
      const followerMsgs = await follower.readUntil((m) => m.type === "terminal_state");
      const stdout = followerMsgs
        .filter((m): m is Extract<RemoteServerMessage, { type: "agent_stdout" }> => m.type === "agent_stdout")
        .map((m) => m.chunk)
        .join("");
      expect(stdout).toContain("STREAMED:hello-world");
      const terminal = followerMsgs.find((m) => m.type === "terminal_state");
      expect(terminal).toMatchObject({ type: "terminal_state", exitCode: 0 });

      owner.close();
      follower.close();
    } finally {
      await server.close();
    }
  });

  it("promotes the next NEW connection to owner after the owner disconnects", async () => {
    const server = await startServer();
    try {
      const first = await connectRemoteClient({ port: server.port, authToken: TOKEN });
      expect(await nextOfType(first, "role")).toEqual({ type: "role", role: "owner" });
      first.close();
      // Give the server a tick to process the close + release ownership.
      await new Promise((resolve) => setTimeout(resolve, 50));

      const second = await connectRemoteClient({ port: server.port, authToken: TOKEN });
      expect(await nextOfType(second, "role")).toEqual({ type: "role", role: "owner" });
      second.close();
    } finally {
      await server.close();
    }
  });

  it("keeps an existing follower a follower even after the owner leaves (no auto-promotion)", async () => {
    const server = await startServer();
    try {
      const owner = await connectRemoteClient({ port: server.port, authToken: TOKEN });
      await nextOfType(owner, "role");
      const follower = await connectRemoteClient({ port: server.port, authToken: TOKEN });
      expect(await nextOfType(follower, "role")).toEqual({ type: "role", role: "follower" });

      owner.close();
      await new Promise((resolve) => setTimeout(resolve, 50));

      // The follower was NOT auto-promoted; its user_message is still
      // rejected. (A new connection would claim ownership instead.)
      follower.send({ type: "user_message", id: "still-follower", prompt: "am i owner now?" });
      const err = await nextOfType(follower, "error");
      expect(err).toMatchObject({
        type: "error",
        message: expect.stringContaining("read-only follower")
      });

      follower.close();
    } finally {
      await server.close();
    }
  });
});
