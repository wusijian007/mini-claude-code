import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import { Socket } from "node:net";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { normalizePath } from "./state.js";
import type { PermissionDecision, PermissionMode, PermissionRequest } from "./types.js";

export const REMOTE_PROTOCOL_VERSION = 1;

const MAX_FRAME_BYTES = 1_000_000;
const DEFAULT_REMOTE_PORT = 8765;
const DEFAULT_REMOTE_HOST = "127.0.0.1";

export type RemoteClientMessage =
  | {
      type: "user_message";
      id: string;
      prompt: string;
      sessionId?: string;
      permissionMode?: PermissionMode;
      skillNames?: readonly string[];
    }
  | {
      type: "resume";
      id: string;
      sessionId: string;
    }
  | {
      type: "permission_decision";
      id: string;
      permissionRequestId: string;
      decision: PermissionDecision;
    }
  | {
      type: "ping";
      id: string;
    };

export type RemoteRole = "owner" | "follower";

export type RemoteServerMessage =
  | {
      type: "ready";
      protocolVersion: 1;
    }
  | {
      type: "role";
      role: RemoteRole;
    }
  | {
      type: "ack";
      id: string;
      sessionId: string;
      duplicate: boolean;
    }
  | {
      type: "agent_stdout";
      id: string;
      chunk: string;
    }
  | {
      type: "agent_stderr";
      id: string;
      chunk: string;
    }
  | {
      type: "permission_request";
      id: string;
      permissionRequestId: string;
      request: PermissionRequest;
    }
  | {
      type: "session_metadata";
      session: RemoteSessionMetadata;
    }
  | {
      type: "terminal_state";
      id: string;
      sessionId: string;
      agentSessionId?: string;
      exitCode: number;
    }
  | {
      type: "pong";
      id: string;
    }
  | {
      type: "error";
      id?: string;
      message: string;
    };

export type RemoteSessionState = "idle" | "running" | "completed" | "failed";

export type RemoteSessionMetadata = {
  version: 1;
  sessionId: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  state: RemoteSessionState;
  writeIds: string[];
  agentSessionId?: string;
  lastRequestId?: string;
  lastExitCode?: number;
  lastError?: string;
};

export type RemoteSessionStore = {
  rootDir: string;
  create(input: { cwd: string; agentSessionId?: string }): Promise<RemoteSessionMetadata>;
  load(sessionId: string): Promise<RemoteSessionMetadata>;
  save(metadata: RemoteSessionMetadata): Promise<void>;
  list(): Promise<RemoteSessionMetadata[]>;
  pathFor(sessionId: string): string;
};

export type RemoteTurnInput = {
  id: string;
  prompt: string;
  remoteSessionId: string;
  agentSessionId?: string;
  permissionMode?: PermissionMode;
  skillNames: readonly string[];
};

export type RemoteTurnSink = {
  signal: AbortSignal;
  send(message: RemoteServerMessage): void;
  writeStdout(chunk: string): void;
  writeStderr(chunk: string): void;
  requestPermission(request: PermissionRequest): Promise<PermissionDecision>;
};

export type RemoteTurnResult = {
  sessionId: string;
  exitCode: number;
};

export type RemoteAgentServerOptions = {
  cwd: string;
  host?: string;
  port?: number;
  rootDir?: string;
  /**
   * Bearer token required on every WebSocket upgrade.
   * Use `ensureRemoteAuthToken(cwd)` to generate and persist one
   * alongside the rest of the remote metadata under `.myagent/remote/`.
   */
  authToken: string;
  runPrompt(input: RemoteTurnInput, sink: RemoteTurnSink): Promise<RemoteTurnResult>;
};

export type RemoteAuthFile = {
  version: 1;
  token: string;
  createdAt: string;
};

export type EnsureRemoteAuthTokenResult = {
  token: string;
  path: string;
  created: boolean;
};

const REMOTE_AUTH_FILE_NAME = "auth.json";

function resolveRemoteAuthPath(cwd: string, rootDir?: string): string {
  const base = rootDir ?? join(cwd, ".myagent", "remote");
  return resolve(base, REMOTE_AUTH_FILE_NAME);
}

/**
 * Read `.myagent/remote/auth.json`, or create it with a fresh 256-bit
 * URL-safe token if it doesn't exist. The file is written with mode 0o600
 * (best-effort: a no-op on Windows). The token is the bearer credential
 * required by the WebSocket upgrade handshake.
 *
 * @param rootDir Defaults to `<cwd>/.myagent/remote`; tests can override.
 */
export async function ensureRemoteAuthToken(
  cwd: string,
  rootDir?: string
): Promise<EnsureRemoteAuthTokenResult> {
  const filePath = resolveRemoteAuthPath(cwd, rootDir);

  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<RemoteAuthFile>;
    if (parsed && typeof parsed.token === "string" && parsed.token.length >= 16) {
      return { token: parsed.token, path: filePath, created: false };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const token = randomBytes(32).toString("base64url");
  const payload: RemoteAuthFile = {
    version: 1,
    token,
    createdAt: nowIso()
  };
  await mkdir(rootDir ?? join(cwd, ".myagent", "remote"), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  await chmod(filePath, 0o600).catch(() => undefined);
  return { token, path: filePath, created: true };
}

function checkAuthHeader(request: IncomingMessage, expectedToken: string): boolean {
  const header = request.headers["authorization"];
  if (typeof header !== "string") {
    return false;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) {
    return false;
  }
  const provided = Buffer.from(match[1] ?? "", "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  if (provided.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(provided, expected);
}

export type RemoteAgentServer = {
  host: string;
  port: number;
  url: string;
  store: RemoteSessionStore;
  close(): Promise<void>;
};

type PendingPermission = {
  requestId: string;
  resolve(decision: PermissionDecision): void;
};

type WebSocketPeer = {
  sendText(text: string): void;
  sendJson(message: RemoteServerMessage | RemoteClientMessage): void;
  close(): void;
  onMessage(handler: (message: string) => void): void;
  onClose(handler: () => void): void;
};

export function createRemoteSessionStore(cwd: string, rootDir?: string): RemoteSessionStore {
  const normalizedRoot = normalizePath(resolve(rootDir ?? join(cwd, ".myagent", "remote", "sessions")));

  return {
    rootDir: normalizedRoot,
    async create(input) {
      const now = nowIso();
      const metadata: RemoteSessionMetadata = {
        version: 1,
        sessionId: createRemoteSessionId(),
        cwd: normalizePath(resolve(input.cwd)),
        createdAt: now,
        updatedAt: now,
        state: "idle",
        writeIds: [],
        agentSessionId: input.agentSessionId
      };
      await this.save(metadata);
      return metadata;
    },
    async load(sessionId) {
      const raw = await readFile(this.pathFor(sessionId), "utf8");
      return normalizeRemoteSession(JSON.parse(raw) as RemoteSessionMetadata);
    },
    async save(metadata) {
      await mkdir(normalizedRoot, { recursive: true });
      const normalized = normalizeRemoteSession({
        ...metadata,
        updatedAt: nowIso()
      });
      await writeFile(this.pathFor(metadata.sessionId), `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    },
    async list() {
      const names = await readdir(normalizedRoot).catch(() => []);
      const sessions: RemoteSessionMetadata[] = [];
      for (const name of names.sort()) {
        if (!name.endsWith(".json")) {
          continue;
        }
        sessions.push(await this.load(name.replace(/\.json$/, "")));
      }
      return sessions.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    },
    pathFor(sessionId) {
      assertRemoteSessionId(sessionId);
      return join(normalizedRoot, `${sessionId}.json`);
    }
  };
}

export async function createRemoteAgentServer(
  options: RemoteAgentServerOptions
): Promise<RemoteAgentServer> {
  const host = options.host ?? DEFAULT_REMOTE_HOST;
  const port = options.port ?? DEFAULT_REMOTE_PORT;
  const store = createRemoteSessionStore(options.cwd, options.rootDir);
  const pendingPermissions = new Map<string, PendingPermission>();
  const runningTurns = new Set<AbortController>();
  const sockets = new Set<Socket>();
  // All live authenticated connections, keyed by connectionId. Used to
  // fan turn output out to followers so they can watch the owner's run.
  const connections = new Map<string, (message: RemoteServerMessage) => void>();
  // The first authenticated connection becomes the owner and is the only
  // one allowed to drive turns / answer permission prompts. When the
  // owner disconnects the slot is released; the next NEW connection
  // claims it (existing followers are not auto-promoted — keeps the
  // ownership transition race-free and predictable).
  let ownerConnectionId: string | undefined;

  const broadcast = (message: RemoteServerMessage) => {
    for (const deliver of connections.values()) {
      deliver(message);
    }
  };

  const httpServer = createServer((_request, response) => {
    response.writeHead(404);
    response.end("myagent remote websocket endpoint\n");
  });

  httpServer.on("connection", (socket) => {
    const tracked = socket as Socket;
    sockets.add(tracked);
    tracked.on("close", () => sockets.delete(tracked));
  });

  httpServer.on("upgrade", (request, socket) => {
    if (!checkAuthHeader(request, options.authToken)) {
      (socket as Socket).end(
        [
          "HTTP/1.1 401 Unauthorized",
          "Content-Type: text/plain",
          "Content-Length: 13",
          "WWW-Authenticate: Bearer realm=\"myagent-remote\"",
          "",
          "Unauthorized\n"
        ].join("\r\n")
      );
      return;
    }
    const peer = acceptWebSocketUpgrade(request, socket as Socket);
    if (!peer) {
      return;
    }

    const controller = new AbortController();
    const connectionId = randomUUID();
    const send = (message: RemoteServerMessage) => peer.sendJson(message);
    connections.set(connectionId, send);
    const isOwner = ownerConnectionId === undefined;
    if (isOwner) {
      ownerConnectionId = connectionId;
    }
    send({ type: "ready", protocolVersion: REMOTE_PROTOCOL_VERSION });
    send({ type: "role", role: isOwner ? "owner" : "follower" });

    peer.onClose(() => {
      controller.abort();
      connections.delete(connectionId);
      if (ownerConnectionId === connectionId) {
        ownerConnectionId = undefined;
      }
      for (const [permissionId, pending] of pendingPermissions) {
        if (pending.requestId.startsWith(`${connectionId}:`)) {
          pendingPermissions.delete(permissionId);
          pending.resolve({ kind: "deny", reason: "remote client disconnected" });
        }
      }
    });

    peer.onMessage((raw) => {
      void handleRemoteMessage(raw, {
        controller,
        connectionId,
        options,
        peer,
        pendingPermissions,
        runningTurns,
        send,
        broadcast,
        isOwner: () => ownerConnectionId === connectionId,
        store
      });
    });
  });

  await new Promise<void>((resolvePromise, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      httpServer.off("error", reject);
      resolvePromise();
    });
  });

  const address = httpServer.address();
  const actualPort = typeof address === "object" && address ? address.port : port;

  return {
    host,
    port: actualPort,
    url: `ws://${host}:${actualPort}`,
    store,
    async close() {
      for (const controller of runningTurns) {
        controller.abort();
      }
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolvePromise, reject) => {
        httpServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolvePromise();
        });
      });
    }
  };
}

export type RemoteClient = {
  send(message: RemoteClientMessage): void;
  close(): void;
  nextMessage(): Promise<RemoteServerMessage>;
  readUntil(predicate: (message: RemoteServerMessage) => boolean): Promise<RemoteServerMessage[]>;
};

export async function connectRemoteClient(input: {
  host?: string;
  port: number;
  path?: string;
  authToken?: string;
}): Promise<RemoteClient> {
  const host = input.host ?? DEFAULT_REMOTE_HOST;
  const path = input.path ?? "/";
  const socket = new Socket();
  await new Promise<void>((resolvePromise, reject) => {
    socket.once("error", reject);
    socket.connect(input.port, host, () => {
      socket.off("error", reject);
      resolvePromise();
    });
  });

  const key = randomBytes(16).toString("base64");
  const headers = [
    `GET ${path} HTTP/1.1`,
    `Host: ${host}:${input.port}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${key}`,
    "Sec-WebSocket-Version: 13"
  ];
  if (input.authToken) {
    headers.push(`Authorization: Bearer ${input.authToken}`);
  }
  headers.push("", "");
  socket.write(headers.join("\r\n"));

  const remainder = await readHttpUpgrade(socket);
  const peer = createWebSocketPeer(socket, { maskOutgoing: true, initialBuffer: remainder });
  const messages: RemoteServerMessage[] = [];
  const waiters: Array<(message: RemoteServerMessage) => void> = [];

  peer.onMessage((raw) => {
    const parsed = JSON.parse(raw) as RemoteServerMessage;
    const waiter = waiters.shift();
    if (waiter) {
      waiter(parsed);
      return;
    }
    messages.push(parsed);
  });

  const nextMessage = async (): Promise<RemoteServerMessage> => {
    const existing = messages.shift();
    if (existing) {
      return existing;
    }
    return new Promise<RemoteServerMessage>((resolvePromise) => waiters.push(resolvePromise));
  };

  return {
    send(message) {
      peer.sendJson(message);
    },
    close() {
      peer.close();
    },
    nextMessage,
    async readUntil(predicate) {
      const collected: RemoteServerMessage[] = [];
      while (true) {
        const message = await nextMessage();
        collected.push(message);
        if (predicate(message)) {
          return collected;
        }
      }
    }
  };
}

export function formatRemoteSessionList(sessions: readonly RemoteSessionMetadata[]): string {
  if (sessions.length === 0) {
    return "[remote] no sessions\n";
  }

  const lines = ["[remote] sessions"];
  for (const session of sessions) {
    const agentSession = session.agentSessionId ? ` agent=${session.agentSessionId}` : "";
    lines.push(
      `${session.sessionId} ${session.state} writes=${session.writeIds.length}${agentSession} updated=${session.updatedAt}`
    );
  }
  return `${lines.join("\n")}\n`;
}

type HandleRemoteMessageContext = {
  controller: AbortController;
  connectionId: string;
  options: RemoteAgentServerOptions;
  peer: WebSocketPeer;
  pendingPermissions: Map<string, PendingPermission>;
  runningTurns: Set<AbortController>;
  send(message: RemoteServerMessage): void;
  broadcast(message: RemoteServerMessage): void;
  isOwner(): boolean;
  store: RemoteSessionStore;
};

async function handleRemoteMessage(
  raw: string,
  context: HandleRemoteMessageContext
): Promise<void> {
  let message: RemoteClientMessage;
  try {
    message = JSON.parse(raw) as RemoteClientMessage;
  } catch (_error) {
    context.send({ type: "error", message: "Invalid JSON remote message" });
    return;
  }

  if (message.type === "ping") {
    context.send({ type: "pong", id: message.id });
    return;
  }

  // Owner-only gate: a read-only follower may watch the stream and read
  // session metadata, but cannot drive turns or answer permission prompts.
  if (
    (message.type === "user_message" || message.type === "permission_decision") &&
    !context.isOwner()
  ) {
    context.send({
      type: "error",
      id: message.id,
      message:
        "read-only follower: only the session owner can submit prompts or answer permission requests"
    });
    return;
  }

  if (message.type === "permission_decision") {
    const pending = context.pendingPermissions.get(message.permissionRequestId);
    if (!pending) {
      context.send({
        type: "error",
        id: message.id,
        message: `Unknown permission request: ${message.permissionRequestId}`
      });
      return;
    }
    context.pendingPermissions.delete(message.permissionRequestId);
    pending.resolve(message.decision);
    return;
  }

  if (message.type === "resume") {
    await handleResume(message, context);
    return;
  }

  if (message.type === "user_message") {
    await handleUserMessage(message, context);
    return;
  }

  context.send({ type: "error", message: "Unknown remote message type" });
}

async function handleResume(
  message: Extract<RemoteClientMessage, { type: "resume" }>,
  context: {
    send(message: RemoteServerMessage): void;
    store: RemoteSessionStore;
  }
): Promise<void> {
  try {
    const metadata = await context.store.load(message.sessionId);
    context.send({
      type: "ack",
      id: message.id,
      sessionId: metadata.sessionId,
      duplicate: false
    });
    context.send({ type: "session_metadata", session: metadata });
  } catch (error) {
    context.send({
      type: "error",
      id: message.id,
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

async function handleUserMessage(
  message: Extract<RemoteClientMessage, { type: "user_message" }>,
  context: {
    controller: AbortController;
    connectionId: string;
    options: RemoteAgentServerOptions;
    pendingPermissions: Map<string, PendingPermission>;
    runningTurns: Set<AbortController>;
    send(message: RemoteServerMessage): void;
    broadcast(message: RemoteServerMessage): void;
    store: RemoteSessionStore;
  }
): Promise<void> {
  if (!message.id || !message.prompt?.trim()) {
    context.send({ type: "error", id: message.id, message: "user_message requires id and prompt" });
    return;
  }

  let metadata: RemoteSessionMetadata;
  try {
    metadata = message.sessionId
      ? await context.store.load(message.sessionId)
      : await context.store.create({ cwd: context.options.cwd });
  } catch (error) {
    context.send({
      type: "error",
      id: message.id,
      message: error instanceof Error ? error.message : String(error)
    });
    return;
  }

  if (metadata.writeIds.includes(message.id)) {
    context.send({ type: "ack", id: message.id, sessionId: metadata.sessionId, duplicate: true });
    context.broadcast({ type: "session_metadata", session: metadata });
    return;
  }

  metadata = {
    ...metadata,
    state: "running",
    writeIds: [...metadata.writeIds, message.id],
    lastRequestId: message.id,
    lastError: undefined
  };
  await context.store.save(metadata);
  context.send({ type: "ack", id: message.id, sessionId: metadata.sessionId, duplicate: false });
  context.broadcast({ type: "session_metadata", session: metadata });

  const turnController = new AbortController();
  context.runningTurns.add(turnController);
  const abortTurn = () => turnController.abort();
  context.controller.signal.addEventListener("abort", abortTurn, { once: true });

  try {
    const result = await context.options.runPrompt(
      {
        id: message.id,
        prompt: message.prompt,
        remoteSessionId: metadata.sessionId,
        agentSessionId: metadata.agentSessionId,
        permissionMode: message.permissionMode,
        skillNames: message.skillNames ?? []
      },
      {
        signal: turnController.signal,
        send: context.broadcast,
        writeStdout(chunk) {
          context.broadcast({ type: "agent_stdout", id: message.id, chunk });
        },
        writeStderr(chunk) {
          context.broadcast({ type: "agent_stderr", id: message.id, chunk });
        },
        requestPermission(request) {
          const permissionRequestId = `perm_${randomUUID()}`;
          context.broadcast({
            type: "permission_request",
            id: message.id,
            permissionRequestId,
            request
          });
          return new Promise<PermissionDecision>((resolvePromise) => {
            context.pendingPermissions.set(permissionRequestId, {
              requestId: `${context.connectionId}:${message.id}`,
              resolve: resolvePromise
            });
          });
        }
      }
    );
    metadata = {
      ...metadata,
      state: result.exitCode === 0 ? "completed" : "failed",
      agentSessionId: result.sessionId,
      lastExitCode: result.exitCode,
      lastError: undefined
    };
    await context.store.save(metadata);
    context.broadcast({
      type: "terminal_state",
      id: message.id,
      sessionId: metadata.sessionId,
      agentSessionId: result.sessionId,
      exitCode: result.exitCode
    });
    context.broadcast({ type: "session_metadata", session: metadata });
  } catch (error) {
    metadata = {
      ...metadata,
      state: "failed",
      lastExitCode: 1,
      lastError: error instanceof Error ? error.message : String(error)
    };
    await context.store.save(metadata);
    context.broadcast({ type: "error", id: message.id, message: metadata.lastError ?? "remote turn failed" });
    context.broadcast({ type: "session_metadata", session: metadata });
  } finally {
    context.controller.signal.removeEventListener("abort", abortTurn);
    context.runningTurns.delete(turnController);
  }
}

function acceptWebSocketUpgrade(request: IncomingMessage, socket: Socket): WebSocketPeer | null {
  const key = request.headers["sec-websocket-key"];
  const upgrade = request.headers.upgrade;
  if (typeof key !== "string" || typeof upgrade !== "string" || upgrade.toLowerCase() !== "websocket") {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return null;
  }

  const accept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      ""
    ].join("\r\n")
  );
  return createWebSocketPeer(socket, { maskOutgoing: false });
}

function createWebSocketPeer(
  socket: Socket,
  options: { maskOutgoing: boolean; initialBuffer?: Buffer }
): WebSocketPeer {
  let buffer = options.initialBuffer ?? Buffer.alloc(0);
  const messageHandlers: Array<(message: string) => void> = [];
  const closeHandlers: Array<() => void> = [];

  const drainBuffer = () => {
    while (true) {
      const parsed = readFrame(buffer);
      if (!parsed) {
        break;
      }
      buffer = buffer.subarray(parsed.bytesRead);
      if (parsed.opcode === 0x8) {
        socket.end();
        break;
      }
      if (parsed.opcode === 0x9) {
        socket.write(encodeFrame(parsed.payload, { opcode: 0xA, mask: options.maskOutgoing }));
        continue;
      }
      if (parsed.opcode !== 0x1) {
        continue;
      }
      const text = parsed.payload.toString("utf8");
      for (const handler of messageHandlers) {
        handler(text);
      }
    }
  };

  socket.on("data", (chunk) => {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    buffer = Buffer.concat([buffer, data]);
    drainBuffer();
  });

  socket.on("close", () => {
    for (const handler of closeHandlers) {
      handler();
    }
  });
  socket.on("error", () => {
    for (const handler of closeHandlers) {
      handler();
    }
  });

  return {
    sendText(text) {
      socket.write(encodeFrame(Buffer.from(text, "utf8"), { opcode: 0x1, mask: options.maskOutgoing }));
    },
    sendJson(message) {
      this.sendText(JSON.stringify(message));
    },
    close() {
      socket.end(encodeFrame(Buffer.alloc(0), { opcode: 0x8, mask: options.maskOutgoing }));
    },
    onMessage(handler) {
      messageHandlers.push(handler);
      drainBuffer();
    },
    onClose(handler) {
      closeHandlers.push(handler);
    }
  };
}

function readFrame(buffer: Buffer):
  | {
      opcode: number;
      payload: Buffer;
      bytesRead: number;
    }
  | null {
  if (buffer.length < 2) {
    return null;
  }

  const first = buffer[0] ?? 0;
  const second = buffer[1] ?? 0;
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < offset + 2) {
      return null;
    }
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) {
      return null;
    }
    const bigLength = buffer.readBigUInt64BE(offset);
    if (bigLength > BigInt(MAX_FRAME_BYTES)) {
      throw new Error("WebSocket frame too large");
    }
    length = Number(bigLength);
    offset += 8;
  }

  if (length > MAX_FRAME_BYTES) {
    throw new Error("WebSocket frame too large");
  }

  const maskLength = masked ? 4 : 0;
  if (buffer.length < offset + maskLength + length) {
    return null;
  }

  const mask = masked ? buffer.subarray(offset, offset + 4) : undefined;
  offset += maskLength;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask) {
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
    }
  }

  return {
    opcode,
    payload,
    bytesRead: offset + length
  };
}

function encodeFrame(payload: Buffer, options: { opcode: number; mask: boolean }): Buffer {
  const length = payload.length;
  const headerLength = length < 126 ? 2 : length <= 0xffff ? 4 : 10;
  const maskLength = options.mask ? 4 : 0;
  const frame = Buffer.alloc(headerLength + maskLength + length);
  frame[0] = 0x80 | options.opcode;

  if (length < 126) {
    frame[1] = (options.mask ? 0x80 : 0) | length;
  } else if (length <= 0xffff) {
    frame[1] = (options.mask ? 0x80 : 0) | 126;
    frame.writeUInt16BE(length, 2);
  } else {
    frame[1] = (options.mask ? 0x80 : 0) | 127;
    frame.writeBigUInt64BE(BigInt(length), 2);
  }

  const payloadOffset = headerLength + maskLength;
  if (options.mask) {
    const mask = randomBytes(4);
    mask.copy(frame, headerLength);
    for (let index = 0; index < payload.length; index += 1) {
      frame[payloadOffset + index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
    }
  } else {
    payload.copy(frame, payloadOffset);
  }

  return frame;
}

async function readHttpUpgrade(socket: Socket): Promise<Buffer> {
  let buffer = Buffer.alloc(0);
  while (!buffer.includes(Buffer.from("\r\n\r\n"))) {
    const chunk = await new Promise<Buffer>((resolvePromise, reject) => {
      const onData = (data: Buffer) => {
        cleanup();
        resolvePromise(data);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        socket.off("data", onData);
        socket.off("error", onError);
      };
      socket.once("data", onData);
      socket.once("error", onError);
    });
    buffer = Buffer.concat([buffer, chunk]);
  }

  const marker = buffer.indexOf(Buffer.from("\r\n\r\n"));
  const header = buffer.subarray(0, marker).toString("utf8");
  if (!header.startsWith("HTTP/1.1 101")) {
    throw new Error(`WebSocket upgrade failed: ${header.split("\r\n")[0] ?? header}`);
  }
  return buffer.subarray(marker + 4);
}

function normalizeRemoteSession(metadata: RemoteSessionMetadata): RemoteSessionMetadata {
  return {
    ...metadata,
    cwd: normalizePath(resolve(metadata.cwd)),
    writeIds: [...new Set(metadata.writeIds ?? [])]
  };
}

function assertRemoteSessionId(sessionId: string): void {
  if (!/^remote_[A-Za-z0-9_-]+$/.test(sessionId)) {
    throw new Error("Invalid remote session id");
  }
}

function createRemoteSessionId(): string {
  return `remote_${compactTimestamp(nowIso())}_${randomUUID().slice(0, 8)}`;
}

function compactTimestamp(iso: string): string {
  return iso.replace(/[-:.TZ]/g, "").slice(0, 14);
}

function nowIso(): string {
  return new Date().toISOString();
}
