import { mkdtempSync, readFileSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  connectRemoteClient,
  createRemoteAgentServer,
  ensureRemoteAuthToken
} from "../../src/index.js";

type ProbeOptions = {
  authHeader?: string;
};

function probeUpgrade(port: number, options: ProbeOptions = {}): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const socket = new Socket();
    let received = "";
    socket.on("data", (chunk) => {
      received += chunk.toString("utf8");
    });
    socket.on("close", () => resolvePromise(received));
    socket.on("error", reject);
    socket.connect(port, "127.0.0.1", () => {
      const headers = [
        "GET / HTTP/1.1",
        `Host: 127.0.0.1:${port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version: 13"
      ];
      if (options.authHeader !== undefined) {
        headers.push(`Authorization: ${options.authHeader}`);
      }
      headers.push("", "");
      socket.write(headers.join("\r\n"));
    });
  });
}

async function neverPrompt(): Promise<never> {
  throw new Error("runPrompt should not be invoked when handshake fails");
}

describe("security: remote WebSocket auth", () => {
  it("rejects an upgrade with no Authorization header (HTTP 401)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "myagent-sec-remote-auth-"));
    const server = await createRemoteAgentServer({
      cwd,
      port: 0,
      authToken: "secret-token-aaaa",
      runPrompt: neverPrompt
    });
    try {
      const response = await probeUpgrade(server.port);
      expect(response.startsWith("HTTP/1.1 401")).toBe(true);
      expect(response).toContain("WWW-Authenticate: Bearer");
    } finally {
      await server.close();
    }
  });

  it("rejects an upgrade with a wrong Bearer token", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "myagent-sec-remote-auth-wrong-"));
    const server = await createRemoteAgentServer({
      cwd,
      port: 0,
      authToken: "secret-token-aaaa",
      runPrompt: neverPrompt
    });
    try {
      const response = await probeUpgrade(server.port, { authHeader: "Bearer secret-token-bbbb" });
      expect(response.startsWith("HTTP/1.1 401")).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("rejects a non-Bearer scheme", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "myagent-sec-remote-auth-scheme-"));
    const server = await createRemoteAgentServer({
      cwd,
      port: 0,
      authToken: "secret-token-aaaa",
      runPrompt: neverPrompt
    });
    try {
      const response = await probeUpgrade(server.port, { authHeader: "Basic c2VjcmV0LXRva2VuLWFhYWE=" });
      expect(response.startsWith("HTTP/1.1 401")).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("accepts an upgrade with the correct Bearer token and reaches the ready frame", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "myagent-sec-remote-auth-ok-"));
    const server = await createRemoteAgentServer({
      cwd,
      port: 0,
      authToken: "secret-token-aaaa",
      runPrompt: neverPrompt
    });
    try {
      const client = await connectRemoteClient({
        port: server.port,
        authToken: "secret-token-aaaa"
      });
      const ready = await client.nextMessage();
      expect(ready).toEqual({ type: "ready", protocolVersion: 1 });
      client.close();
    } finally {
      await server.close();
    }
  });

  it("generates a fresh token on first call and reuses it on the second", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "myagent-sec-remote-auth-persist-"));
    const first = await ensureRemoteAuthToken(cwd);
    expect(first.created).toBe(true);
    expect(first.token.length).toBeGreaterThanOrEqual(32);
    expect(first.path.endsWith("auth.json")).toBe(true);

    const second = await ensureRemoteAuthToken(cwd);
    expect(second.created).toBe(false);
    expect(second.token).toBe(first.token);
    expect(second.path).toBe(first.path);

    const fileContent = JSON.parse(readFileSync(first.path, "utf8"));
    expect(fileContent).toMatchObject({
      version: 1,
      token: first.token
    });
    expect(typeof fileContent.createdAt).toBe("string");
  });

  it("auth file is not required for `remote sessions` metadata reads", async () => {
    // The CLI's `remote sessions` subcommand uses createRemoteSessionStore.list()
    // directly off the filesystem, which never calls ensureRemoteAuthToken — so
    // this test asserts the metadata API does not need or touch auth.json.
    const cwd = mkdtempSync(join(tmpdir(), "myagent-sec-remote-auth-meta-"));
    const { createRemoteSessionStore } = await import("../../src/remote.js");
    const store = createRemoteSessionStore(cwd);
    await expect(store.list()).resolves.toEqual([]);
  });
});
