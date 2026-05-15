import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createSessionStore,
  createTaskStore,
  FakeModel,
  ModelError,
  runLocalBashTask,
  type ModelClient,
  type SessionEvent
} from "@mini-claude-code/core";

import { loadEnvironment, runCli } from "../src/index.js";

function captureWriter() {
  const chunks: string[] = [];
  return {
    writer: {
      write(chunk: string) {
        chunks.push(chunk);
      }
    },
    text: () => chunks.join("")
  };
}

function systemToText(system: string | ReadonlyArray<{ type: "text"; text: string }> | undefined): string {
  if (system === undefined) return "";
  if (typeof system === "string") return system;
  return system.map((block) => block.text).join("\n\n");
}

describe("myagent cli", () => {
  it("prints version without starting agent runtime", async () => {
    const stdout = captureWriter();
    const stderr = captureWriter();

    const exitCode = await runCli(["--version"], stdout.writer, stderr.writer);

    expect(exitCode).toBe(0);
    expect(stdout.text()).toBe("0.0.0\n");
    expect(stderr.text()).toBe("");
  });

  it("prints help for the week 18 command surface", async () => {
    const stdout = captureWriter();
    const stderr = captureWriter();

    const exitCode = await runCli(["--help"], stdout.writer, stderr.writer);

    expect(exitCode).toBe(0);
    expect(stdout.text()).toContain("Usage:");
    expect(stdout.text()).toContain("chat <prompt>");
    expect(stdout.text()).toContain("agent [--permission-mode");
    expect(stdout.text()).toContain("Week 18 scope");
    expect(stdout.text()).toContain("tui");
    expect(stdout.text()).toContain("memory save");
    expect(stdout.text()).toContain("skill list");
    expect(stdout.text()).toContain("command hooks");
    expect(stdout.text()).toContain("mcp <list|tools>");
    expect(stdout.text()).toContain("mcp__server__tool");
    expect(stdout.text()).toContain("week12 audit");
    expect(stdout.text()).toContain("week18 finalize");
    expect(stdout.text()).toContain("profile <startup|list|show>");
    expect(stdout.text()).toContain("task <start-bash|list|read|kill|notify>");
    expect(stdout.text()).toContain("remote <serve|sessions|client>");
    expect(stdout.text()).toContain("Agent sub-agents");
    expect(stdout.text()).toContain("fork traces");
    expect(stdout.text()).toContain("remote serve starts");
    expect(stdout.text()).toContain("UUIDs for dedupe");
    expect(stdout.text()).toContain("profile startup records");
    expect(stdout.text()).toContain("week18 finalize runs");
    expect(stdout.text()).toContain("resume <sessionId>");
    expect(stdout.text()).toContain("compact <sessionId>");
    expect(stdout.text()).toContain("--permission-mode");
    expect(stdout.text()).toContain("Edit and Write require");
    expect(stderr.text()).toBe("");
  });

  it("returns a clear error when chat has no API key", async () => {
    const stdout = captureWriter();
    const stderr = captureWriter();

    const exitCode = await runCli(["chat", "hello"], stdout.writer, stderr.writer, {
      env: {},
      createModelClient: () => {
        throw new ModelError("auth_error", "ANTHROPIC_API_KEY is required");
      }
    });

    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("Model error (auth_error)");
  });

  it("streams chat output from an injected model client", async () => {
    const stdout = captureWriter();
    const stderr = captureWriter();

    const exitCode = await runCli(["chat", "hello"], stdout.writer, stderr.writer, {
      env: {},
      createModelClient: () =>
        new FakeModel([
          { type: "text_delta", text: "Hello" },
          { type: "text_delta", text: "!" }
        ])
    });

    expect(exitCode).toBe(0);
    expect(stdout.text()).toBe("Hello!\n");
    expect(stderr.text()).toBe("");
  });

  it("loads Anthropic settings from .env when process env is absent", () => {
    const cwd = mkdtempSync(join(tmpdir(), "myagent-env-"));
    writeFileSync(
      join(cwd, ".env"),
      "ANTHROPIC_API_KEY=test-key-from-env-file\nANTHROPIC_BASE_URL=https://example.test/v1\nMYAGENT_MODEL=test-model\nMYAGENT_PERMISSION_MODE=plan\nMYAGENT_INPUT_USD_PER_MTOK=3\nMYAGENT_OUTPUT_USD_PER_MTOK=15\n",
      "utf8"
    );

    expect(loadEnvironment(cwd, {})).toEqual({
      ANTHROPIC_API_KEY: "test-key-from-env-file",
      ANTHROPIC_BASE_URL: "https://example.test/v1",
      MYAGENT_MODEL: "test-model",
      MYAGENT_PERMISSION_MODE: "plan",
      MYAGENT_INPUT_USD_PER_MTOK: "3",
      MYAGENT_OUTPUT_USD_PER_MTOK: "15"
    });
  });

  it("saves long-term memory and injects recalled memory into the next agent turn", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "myagent-cli-memory-"));
    const saveStdout = captureWriter();
    const saveStderr = captureWriter();

    const saveExitCode = await runCli(
      ["memory", "save", "project", "测试必须用真实", "DB，不用", "mock"],
      saveStdout.writer,
      saveStderr.writer,
      { cwd, env: {} }
    );

    expect(saveExitCode).toBe(0);
    expect(saveStdout.text()).toContain("[memory] saved project/");
    expect(saveStderr.text()).toBe("");

    const systems: string[] = [];
    const model: ModelClient = {
      async create() {
        return {
          message: { role: "assistant", content: "ok" },
          requestId: "req_memory"
        };
      },
      async *stream(request) {
        systems.push(systemToText(request.system));
        yield {
          type: "assistant_message",
          message: {
            role: "assistant",
            content: "I will use the real DB in tests."
          },
          requestId: "req_memory"
        };
      }
    };
    const agentStdout = captureWriter();
    const agentStderr = captureWriter();

    const agentExitCode = await runCli(["agent", "write", "a", "test"], agentStdout.writer, agentStderr.writer, {
      cwd,
      env: {},
      createModelClient: () => model
    });

    expect(agentExitCode).toBe(0);
    expect(systems[0]).toContain("Long-term memory recall");
    expect(systems[0]).toContain("测试必须用真实 DB，不用 mock");
    expect(agentStdout.text()).toContain("real DB");
    expect(agentStderr.text()).toBe("");
  });

  it("rejects memory that should be re-derived from the repository", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "myagent-cli-memory-reject-"));
    const stdout = captureWriter();
    const stderr = captureWriter();

    const exitCode = await runCli(
      ["memory", "save", "project", "Use function buildTool() from packages/core/src/tool.ts"],
      stdout.writer,
      stderr.writer,
      { cwd, env: {} }
    );

    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("[memory] rejected");
  });

  it("loads an explicit skill into the agent system prompt", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "myagent-cli-skill-"));
    const skillDir = join(cwd, ".myagent", "skills", "test-style");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "name: test-style",
        "description: Project test style",
        "source: project",
        "---",
        "",
        "When writing tests, prefer real DB integration fixtures over mocks."
      ].join("\n"),
      "utf8"
    );
    const systems: string[] = [];
    const stdout = captureWriter();
    const stderr = captureWriter();

    const exitCode = await runCli(["agent", "--skill", "test-style", "write", "a", "test"], stdout.writer, stderr.writer, {
      cwd,
      env: {},
      createModelClient: () =>
        ({
          async create() {
            return {
              message: { role: "assistant", content: "ok" },
              requestId: "req_skill"
            };
          },
          async *stream(request) {
            systems.push(systemToText(request.system));
            yield {
              type: "assistant_message",
              message: { role: "assistant", content: "Use real DB integration fixtures." },
              requestId: "req_skill"
            };
          }
        }) satisfies ModelClient
    });

    expect(exitCode).toBe(0);
    expect(systems[0]).toContain("Active skills");
    expect(systems[0]).toContain("real DB integration fixtures");
    expect(stdout.text()).toContain("real DB");
    expect(stderr.text()).toBe("");
  });

  it("lists skills from SKILL.md frontmatter without loading the body", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "myagent-cli-skill-list-"));
    const skillDir = join(cwd, ".myagent", "skills", "test-style");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: test-style\ndescription: Project test style\n---\n\nSECRET BODY SHOULD NOT LIST\n",
      "utf8"
    );
    const stdout = captureWriter();
    const stderr = captureWriter();

    const exitCode = await runCli(["skill", "list"], stdout.writer, stderr.writer, { cwd, env: {} });

    expect(exitCode).toBe(0);
    expect(stdout.text()).toContain("test-style - Project test style");
    expect(stdout.text()).not.toContain("SECRET BODY");
    expect(stderr.text()).toBe("");
  });

  it("runs the read-only agent loop with an injected model client", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "myagent-cli-agent-"));
    writeFileSync(join(cwd, "README.md"), "# CLI fixture\n", "utf8");
    const stdout = captureWriter();
    const stderr = captureWriter();

    const exitCode = await runCli(["agent", "summarize", "README.md"], stdout.writer, stderr.writer, {
      cwd,
      env: {},
      createModelClient: () =>
        new FakeModel([
          {
            type: "assistant_message",
            content: "I will read README.md."
          },
          {
            type: "tool_use",
            toolUse: {
              id: "toolu_read_cli",
              name: "Read",
              input: { path: "README.md" }
            }
          },
          { type: "turn_break" },
          {
            type: "assistant_message",
            content: "README.md contains a CLI fixture heading."
          }
        ])
    });

    expect(exitCode).toBe(0);
    expect(stdout.text()).toContain("[session]");
    expect(stdout.text()).toContain("[tool] Read");
    expect(stdout.text()).toContain("README.md contains a CLI fixture heading.");
    expect(stderr.text()).toBe("");
  });

  it("uses the v1.1 final answer turn instead of stopping cold at max_turns", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "myagent-cli-final-turn-"));
    writeFileSync(join(cwd, "README.md"), "# Final turn fixture\n", "utf8");
    const stdout = captureWriter();
    const stderr = captureWriter();
    let calls = 0;
    const model = {
      async create() {
        return {
          message: { role: "assistant" as const, content: "unused" },
          requestId: "req_unused"
        };
      },
      async *stream(request) {
        calls += 1;
        if ((request.tools?.length ?? 0) === 0) {
          yield {
            type: "assistant_message" as const,
            message: {
              role: "assistant" as const,
              content: "Final v1.1 summary from gathered information."
            },
            requestId: "req_final"
          };
          return;
        }

        yield {
          type: "tool_use" as const,
          toolUse: {
            id: `toolu_read_${calls}`,
            name: "Read",
            input: { path: "README.md" }
          },
          requestId: `req_${calls}`
        };
      }
    } satisfies ModelClient;

    const exitCode = await runCli(["agent", "summarize", "broadly"], stdout.writer, stderr.writer, {
      cwd,
      env: {},
      createModelClient: () => model
    });

    expect(exitCode).toBe(0);
    expect(stdout.text()).toContain("Final v1.1 summary");
    expect(stderr.text()).not.toContain("max_turns");
    expect(calls).toBe(8);
  });

  it("runs the week 4 agent loop to fix a fixture bug in bypassPermissions mode", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "myagent-cli-edit-"));
    writeFileSync(
      join(cwd, "bug.ts"),
      "export function add(a: number, b: number) {\n  return a - b;\n}\n",
      "utf8"
    );
    const stdout = captureWriter();
    const stderr = captureWriter();

    const exitCode = await runCli(
      ["agent", "--permission-mode", "bypassPermissions", "fix", "bug.ts"],
      stdout.writer,
      stderr.writer,
      {
        cwd,
        env: {},
        createModelClient: () =>
          new FakeModel([
            {
              type: "assistant_message",
              content: "I will inspect bug.ts."
            },
            {
              type: "tool_use",
              toolUse: {
                id: "toolu_read_bug",
                name: "Read",
                input: { path: "bug.ts" }
              }
            },
            { type: "turn_break" },
            {
              type: "assistant_message",
              content: "I found the subtraction bug."
            },
            {
              type: "tool_use",
              toolUse: {
                id: "toolu_edit_bug",
                name: "Edit",
                input: {
                  path: "bug.ts",
                  oldString: "return a - b;",
                  newString: "return a + b;"
                }
              }
            },
            { type: "turn_break" },
            {
              type: "assistant_message",
              content: "Fixed bug.ts."
            }
          ])
      }
    );

    expect(exitCode).toBe(0);
    expect(stdout.text()).toContain("[session]");
    expect(stdout.text()).toContain("[tool] Read");
    expect(stdout.text()).toContain("[tool] Edit");
    expect(readFileSync(join(cwd, "bug.ts"), "utf8")).toContain("return a + b;");
    expect(stderr.text()).toBe("");
  });

  it("persists agent transcripts and resumes them by session id", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "myagent-cli-session-"));
    const sessionRootDir = join(cwd, ".myagent", "sessions");
    writeFileSync(join(cwd, "README.md"), "# Session fixture\n", "utf8");
    const stdout = captureWriter();
    const stderr = captureWriter();

    const exitCode = await runCli(["agent", "summarize", "README.md"], stdout.writer, stderr.writer, {
      cwd,
      sessionRootDir,
      env: {},
      createModelClient: () =>
        new FakeModel([
          {
            type: "assistant_message",
            content: "I will read README.md."
          },
          {
            type: "tool_use",
            toolUse: {
              id: "toolu_read_session",
              name: "Read",
              input: { path: "README.md" }
            }
          },
          { type: "turn_break" },
          {
            type: "assistant_message",
            content: "README.md contains a session fixture."
          }
        ])
    });

    expect(exitCode).toBe(0);
    expect(stderr.text()).toBe("");
    const [sessionFile] = readdirSync(sessionRootDir);
    expect(sessionFile).toMatch(/^sess_.*\.json$/);
    const sessionId = sessionFile.replace(/\.json$/, "");
    const record = JSON.parse(readFileSync(join(sessionRootDir, sessionFile), "utf8")) as {
      events: Array<{ type: string }>;
      bootstrap: { cwd: string };
    };
    expect(record.bootstrap.cwd).not.toContain("\\");
    expect(record.events.map((event) => event.type)).toEqual([
      "user_message",
      "assistant_message",
      "tool_use",
      "tool_result",
      "assistant_message",
      "terminal_state"
    ]);

    const resumeStdout = captureWriter();
    const resumeStderr = captureWriter();
    const resumeExitCode = await runCli(["resume", sessionId], resumeStdout.writer, resumeStderr.writer, {
      cwd,
      sessionRootDir,
      env: {}
    });

    expect(resumeExitCode).toBe(0);
    expect(resumeStdout.text()).toContain(`[session] ${sessionId}`);
    expect(resumeStdout.text()).toContain("assistant: README.md contains a session fixture.");
    expect(resumeStderr.text()).toBe("");
  });

  it("runs headless compact on a saved session", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "myagent-cli-compact-"));
    const sessionRootDir = join(cwd, ".myagent", "sessions");
    const stdout = captureWriter();
    const stderr = captureWriter();

    const exitCode = await runCli(["agent", "remember", "a", "long", "thing"], stdout.writer, stderr.writer, {
      cwd,
      sessionRootDir,
      env: {},
      createModelClient: () =>
        new FakeModel([
          {
            type: "assistant_message",
            content: "long ".repeat(3_000)
          }
        ])
    });

    expect(exitCode).toBe(0);
    const [sessionFile] = readdirSync(sessionRootDir);
    const sessionId = sessionFile.replace(/\.json$/, "");
    const compactStdout = captureWriter();
    const compactStderr = captureWriter();

    const compactExitCode = await runCli(
      ["compact", sessionId],
      compactStdout.writer,
      compactStderr.writer,
      { cwd, sessionRootDir, env: {} }
    );

    expect(compactExitCode).toBe(0);
    expect(compactStdout.text()).toContain(`Compacted ${sessionId}`);
    expect(compactStderr.text()).toBe("");
    const record = JSON.parse(readFileSync(join(sessionRootDir, sessionFile), "utf8")) as {
      events: Array<{ type: string }>;
    };
    expect(record.events.at(-1)?.type).toBe("compact");
  });

  it("sends the agent's system prompt as a structured block with cache_control", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "myagent-cli-cache-system-"));
    let capturedSystem: unknown;
    const stdout = captureWriter();
    const stderr = captureWriter();

    const exitCode = await runCli(["agent", "summarize", "fixture"], stdout.writer, stderr.writer, {
      cwd,
      env: {},
      createModelClient: () =>
        ({
          async create() {
            return {
              message: { role: "assistant", content: "ok" },
              requestId: "req_cache"
            };
          },
          async *stream(request) {
            capturedSystem = request.system;
            yield {
              type: "assistant_message",
              message: { role: "assistant", content: "fixture summary" },
              requestId: "req_cache"
            };
          }
        }) satisfies ModelClient
    });

    expect(exitCode).toBe(0);
    expect(stderr.text()).toBe("");
    expect(Array.isArray(capturedSystem)).toBe(true);
    const systemBlocks = capturedSystem as Array<{
      type: string;
      text: string;
      cache_control?: { type: string };
    }>;
    expect(systemBlocks).toHaveLength(1);
    expect(systemBlocks[0]?.type).toBe("text");
    expect(systemBlocks[0]?.text).toContain("safety-first coding agent");
    expect(systemBlocks[0]?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("prints per-turn token + cost breakdown via myagent usage", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "myagent-cli-usage-"));
    const sessionRootDir = join(cwd, ".myagent", "sessions");
    const store = createSessionStore(cwd, sessionRootDir);
    const fixture = await store.create({
      sessionId: "sess_usage_fixture",
      cwd,
      model: "claude-test",
      permissionMode: "default",
      costUsd: 0
    });
    const events: SessionEvent[] = [
      {
        type: "user_message",
        message: { role: "user", content: "hi" },
        at: new Date(1_700_000_000_000).toISOString()
      },
      {
        type: "assistant_message",
        message: { role: "assistant", content: "first reply" },
        usage: {
          inputTokens: 1_000,
          outputTokens: 200,
          cacheCreationInputTokens: 500,
          cacheReadInputTokens: 0
        },
        requestId: "req_first_abcdef",
        at: new Date(1_700_000_001_000).toISOString()
      },
      {
        type: "user_message",
        message: { role: "user", content: "again" },
        at: new Date(1_700_000_002_000).toISOString()
      },
      {
        type: "assistant_message",
        message: { role: "assistant", content: "second reply" },
        usage: {
          inputTokens: 300,
          outputTokens: 100,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 500
        },
        requestId: "req_second_xyz",
        at: new Date(1_700_000_003_000).toISOString()
      }
    ];
    await store.save({ ...fixture, events: [...fixture.events, ...events] });

    const stdout = captureWriter();
    const stderr = captureWriter();
    const exit = await runCli(
      ["usage", fixture.sessionId],
      stdout.writer,
      stderr.writer,
      {
        cwd,
        sessionRootDir,
        env: {
          MYAGENT_INPUT_USD_PER_MTOK: "3",
          MYAGENT_OUTPUT_USD_PER_MTOK: "15",
          MYAGENT_CACHE_WRITE_USD_PER_MTOK: "3.75",
          MYAGENT_CACHE_READ_USD_PER_MTOK: "0.3"
        }
      }
    );

    expect(exit).toBe(0);
    expect(stderr.text()).toBe("");
    const out = stdout.text();
    expect(out).toContain(`[usage] ${fixture.sessionId}`);
    expect(out).toContain("model: claude-test");
    expect(out).toContain("turns: 2");
    expect(out).toContain("req_first_abcd"); // truncated to 14 chars
    expect(out).toContain("req_second_xyz");
    // First turn cost: 1000/1e6 * 3 + 200/1e6 * 15 + 500/1e6 * 3.75 = 0.003 + 0.003 + 0.001875 ≈ 0.0079
    expect(out).toMatch(/\$0\.0079/);
    // Second turn cost: 300/1e6 * 3 + 100/1e6 * 15 + 500/1e6 * 0.3 = 0.0009 + 0.0015 + 0.00015 ≈ 0.0026
    expect(out).toMatch(/\$0\.0026/);
    // Totals row
    expect(out).toMatch(/total[\s\S]*1300[\s\S]*300[\s\S]*500[\s\S]*500/);
  });

  it("reports a clear error when myagent usage is given a missing session id", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "myagent-cli-usage-missing-"));
    const stdout = captureWriter();
    const stderr = captureWriter();
    const exit = await runCli(
      ["usage", "sess_does_not_exist"],
      stdout.writer,
      stderr.writer,
      { cwd, sessionRootDir: join(cwd, ".myagent", "sessions"), env: {} }
    );
    expect(exit).toBe(1);
    expect(stderr.text()).toContain("Could not load session sess_does_not_exist");
  });

  it("archives dropped messages and lists them via resume --show-compactions", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "myagent-cli-compact-archive-"));
    const sessionRootDir = join(cwd, ".myagent", "sessions");
    const artifactRootDir = join(cwd, ".myagent", "artifacts");
    const store = createSessionStore(cwd, sessionRootDir);

    const fixture = await store.create({
      sessionId: "sess_archive_fixture",
      cwd,
      model: "test-model",
      permissionMode: "default",
      costUsd: 0,
      tokenUsage: { inputTokens: 0, outputTokens: 0 }
    });
    // Append enough events that compactMessages will drop the middle slice
    // (the snipped total must exceed the 8000-token default target).
    const filler: SessionEvent[] = [];
    for (let i = 0; i < 20; i += 1) {
      filler.push({
        type: "user_message",
        message: { role: "user", content: `request ${i}` },
        at: new Date(Date.parse(fixture.createdAt) + i * 2_000).toISOString()
      });
      filler.push({
        type: "assistant_message",
        message: { role: "assistant", content: "x".repeat(3_000) },
        at: new Date(Date.parse(fixture.createdAt) + i * 2_000 + 1_000).toISOString()
      });
    }
    await store.save({ ...fixture, events: [...fixture.events, ...filler] });

    const compactStdout = captureWriter();
    const compactStderr = captureWriter();
    const compactExit = await runCli(
      ["compact", fixture.sessionId],
      compactStdout.writer,
      compactStderr.writer,
      { cwd, sessionRootDir, artifactRootDir, env: {} }
    );
    expect(compactExit).toBe(0);
    expect(compactStdout.text()).toContain("Archived dropped messages to");
    expect(compactStderr.text()).toBe("");

    const compactionsDir = join(artifactRootDir, fixture.sessionId, "compactions");
    const archiveFiles = readdirSync(compactionsDir);
    expect(archiveFiles).toHaveLength(1);
    expect(archiveFiles[0]).toMatch(/\.json$/);

    const archive = JSON.parse(readFileSync(join(compactionsDir, archiveFiles[0]), "utf8")) as {
      version: number;
      sessionId: string;
      at: string;
      omitted: Array<{ role: string; content: unknown }>;
    };
    expect(archive.version).toBe(1);
    expect(archive.sessionId).toBe(fixture.sessionId);
    expect(archive.omitted.length).toBeGreaterThan(0);
    // Sanity: round-trip preserves the original unsnipped content.
    const assistantOmissions = archive.omitted.filter((m) => m.role === "assistant");
    expect(assistantOmissions.length).toBeGreaterThan(0);
    expect(typeof assistantOmissions[0]?.content === "string"
      ? assistantOmissions[0].content
      : "").not.toContain("[snip:");

    const inspectStdout = captureWriter();
    const inspectStderr = captureWriter();
    const inspectExit = await runCli(
      ["resume", fixture.sessionId, "--show-compactions"],
      inspectStdout.writer,
      inspectStderr.writer,
      { cwd, sessionRootDir, env: {} }
    );
    expect(inspectExit).toBe(0);
    expect(inspectStdout.text()).toContain("[compactions] 1");
    expect(inspectStdout.text()).toContain(archiveFiles[0]);
    expect(inspectStderr.text()).toBe("");
  });

  it("runs the week 12 offline usage audit and writes transcripts", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "myagent-cli-week12-"));
    const stdout = captureWriter();
    const stderr = captureWriter();

    const exitCode = await runCli(["week12", "audit"], stdout.writer, stderr.writer, {
      cwd,
      env: {}
    });

    expect(exitCode).toBe(0);
    expect(stdout.text()).toContain("[week12] audit passed");
    expect(stdout.text()).toContain("read-only-analysis: passed");
    expect(stdout.text()).toContain("small-edit: passed");
    expect(stdout.text()).toContain("run-check: passed");
    expect(stderr.text()).toBe("");
    const [runDir] = readdirSync(join(cwd, ".myagent", "week12", "runs"));
    const root = join(cwd, ".myagent", "week12", "runs", runDir);
    const transcriptNames = readdirSync(join(root, "transcripts")).sort();
    expect(transcriptNames).toEqual([
      "read-only-analysis.json",
      "run-check.json",
      "small-edit.json"
    ]);
    expect(readFileSync(join(root, "fixture-project", "src", "math.ts"), "utf8")).toContain("return a + b;");
    expect(readFileSync(join(root, "BACKLOG.md"), "utf8")).toContain("## must_fix");
    expect(readFileSync(join(root, "RETROSPECTIVE.md"), "utf8")).toContain("Week 12 Retrospective");
  });

  it("records a Week 17 startup profile", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "myagent-cli-profile-"));
    const stdout = captureWriter();
    const stderr = captureWriter();

    const exitCode = await runCli(["profile", "startup"], stdout.writer, stderr.writer, {
      cwd,
      env: {}
    });

    expect(exitCode).toBe(0);
    expect(stdout.text()).toContain("[profile] startup_");
    expect(stdout.text()).toContain("fast_path.version");
    expect(stdout.text()).toContain("fast_path.help");
    expect(stderr.text()).toBe("");
    const profileRoot = join(cwd, ".myagent", "profiles");
    expect(readdirSync(profileRoot).some((name) => name.startsWith("startup_"))).toBe(true);
  });

  it("runs the Week 18 final smoke suite and writes portfolio docs", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "myagent-cli-week18-"));
    const stdout = captureWriter();
    const stderr = captureWriter();

    const exitCode = await runCli(["week18", "finalize"], stdout.writer, stderr.writer, {
      cwd,
      env: {}
    });

    expect(exitCode).toBe(0);
    expect(stdout.text()).toContain("[week18] final passed");
    expect(stdout.text()).toContain("read-only-analysis: passed");
    expect(stdout.text()).toContain("small-edit: passed");
    expect(stdout.text()).toContain("memory: passed");
    expect(stdout.text()).toContain("hook: passed");
    expect(stdout.text()).toContain("mcp: passed");
    expect(stdout.text()).toContain("sub-agent: passed");
    expect(stderr.text()).toBe("");
    const [runDir] = readdirSync(join(cwd, ".myagent", "week18", "runs"));
    const root = join(cwd, ".myagent", "week18", "runs", runDir);
    expect(readFileSync(join(root, "README.md"), "utf8")).toContain("Mini Claude Code");
    expect(readFileSync(join(root, "ARCHITECTURE.md"), "utf8")).toContain("flowchart");
    expect(readFileSync(join(root, "FINAL_REVIEW.md"), "utf8")).toContain("Phase C");
    expect(readFileSync(join(root, "BACKLOG.md"), "utf8")).toContain("## v1.1");
  });

  it("starts, reads, lists, and notifies a Week 13 task", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "myagent-cli-task-"));
    const taskRootDir = join(cwd, ".myagent", "tasks");
    const stdout = captureWriter();
    const stderr = captureWriter();

    const startExitCode = await runCli(["task", "start-bash", "pwd"], stdout.writer, stderr.writer, {
      cwd,
      taskRootDir,
      env: {},
      async startTaskWorker(taskId, options) {
        await runLocalBashTask(createTaskStore(options.cwd, options.taskRootDir), taskId);
      }
    });

    expect(startExitCode).toBe(0);
    expect(stderr.text()).toBe("");
    expect(stdout.text()).toContain("[task] started task_");
    const taskId = stdout.text().match(/task_[A-Za-z0-9_-]+/)?.[0];
    expect(taskId).toBeTruthy();

    const readStdout = captureWriter();
    const readStderr = captureWriter();
    const readExitCode = await runCli(["task", "read", taskId ?? ""], readStdout.writer, readStderr.writer, {
      cwd,
      taskRootDir,
      env: {}
    });
    expect(readExitCode).toBe(0);
    expect(readStdout.text()).toContain(`${taskId} completed`);
    expect(readStdout.text()).toContain("$ pwd");
    expect(readStderr.text()).toBe("");

    const listStdout = captureWriter();
    const listStderr = captureWriter();
    const listExitCode = await runCli(["task", "list"], listStdout.writer, listStderr.writer, {
      cwd,
      taskRootDir,
      env: {}
    });
    expect(listExitCode).toBe(0);
    expect(listStdout.text()).toContain(`${taskId} completed`);
    expect(listStderr.text()).toBe("");

    const notifyStdout = captureWriter();
    const notifyStderr = captureWriter();
    const firstNotifyExitCode = await runCli(["task", "notify"], notifyStdout.writer, notifyStderr.writer, {
      cwd,
      taskRootDir,
      env: {}
    });
    const secondNotifyStdout = captureWriter();
    const secondNotifyExitCode = await runCli(["task", "notify"], secondNotifyStdout.writer, notifyStderr.writer, {
      cwd,
      taskRootDir,
      env: {}
    });

    expect(firstNotifyExitCode).toBe(0);
    expect(secondNotifyExitCode).toBe(0);
    expect(notifyStdout.text()).toContain(`[task notification] ${taskId} completed`);
    expect(secondNotifyStdout.text()).toContain("[task] no notifications");
    expect(notifyStderr.text()).toBe("");
  });

  it("lists Week 16 remote sessions without starting the model", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "myagent-cli-remote-"));
    const stdout = captureWriter();
    const stderr = captureWriter();

    const exitCode = await runCli(["remote", "sessions"], stdout.writer, stderr.writer, {
      cwd,
      env: {}
    });

    expect(exitCode).toBe(0);
    expect(stdout.text()).toContain("[remote] no sessions");
    expect(stderr.text()).toBe("");
  });

  it("rejects invalid permission modes before starting the model", async () => {
    const stdout = captureWriter();
    const stderr = captureWriter();

    const exitCode = await runCli(
      ["agent", "--permission-mode", "danger", "summarize", "README.md"],
      stdout.writer,
      stderr.writer,
      {
        env: {},
        createModelClient: () =>
          new FakeModel([{ type: "assistant_message", content: "should not run" }])
      }
    );

    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("Invalid permission mode");
  });

  it("runs ten interactive TUI turns and exits cleanly", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "myagent-cli-tui-"));
    const sessionRootDir = join(cwd, ".myagent", "sessions");
    const stdout = captureWriter();
    const stderr = captureWriter();
    const answers = [...Array.from({ length: 10 }, (_, index) => `turn ${index + 1}`), "/exit"];
    const script = Array.from({ length: 10 }, (_, index) => [
      { type: "assistant_message" as const, content: `reply ${index + 1}` },
      { type: "turn_break" as const }
    ]).flat();
    const model = new FakeModel(script);

    const exitCode = await runCli(["tui"], stdout.writer, stderr.writer, {
      cwd,
      sessionRootDir,
      env: {},
      prompt: scriptedPrompt(answers),
      createModelClient: () => model
    });

    expect(exitCode).toBe(0);
    expect(stdout.text()).toContain("myagent interactive Week 18");
    expect(stdout.text()).toContain("reply 1");
    expect(stdout.text()).toContain("reply 10");
    expect(stdout.text()).toContain("bye");
    expect(stderr.text()).toBe("");
  });

  it("lets the TUI permission prompt allow or deny writes", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "myagent-cli-permission-"));
    const sessionRootDir = join(cwd, ".myagent", "sessions");
    const stdout = captureWriter();
    const stderr = captureWriter();
    const model = new FakeModel([
      {
        type: "tool_use",
        toolUse: {
          id: "toolu_write_denied",
          name: "Write",
          input: { path: "note.txt", content: "denied\n" }
        }
      },
      { type: "turn_break" },
      { type: "assistant_message", content: "denied done" },
      { type: "turn_break" },
      {
        type: "tool_use",
        toolUse: {
          id: "toolu_write_allowed",
          name: "Write",
          input: { path: "note.txt", content: "allowed\n" }
        }
      },
      { type: "turn_break" },
      { type: "assistant_message", content: "allowed done" },
      { type: "turn_break" }
    ]);

    const exitCode = await runCli(["tui"], stdout.writer, stderr.writer, {
      cwd,
      sessionRootDir,
      env: {},
      prompt: scriptedPrompt(["create file", "deny", "create file again", "allow", "/exit"]),
      createModelClient: () => model
    });

    expect(exitCode).toBe(0);
    expect(stdout.text()).toContain("[permission] Write");
    expect(readFileSync(join(cwd, "note.txt"), "utf8")).toBe("allowed\n");
    expect(stderr.text()).toBe("");
  });

  it("supports /memory save and /memory list in the TUI", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "myagent-cli-tui-memory-"));
    const stdout = captureWriter();
    const stderr = captureWriter();

    const exitCode = await runCli(["tui"], stdout.writer, stderr.writer, {
      cwd,
      env: {},
      prompt: scriptedPrompt([
        "/memory save feedback Prefer explicit milestones",
        "/memory list",
        "/exit"
      ])
    });

    expect(exitCode).toBe(0);
    expect(stdout.text()).toContain("[memory] saved feedback/");
    expect(stdout.text()).toContain("Prefer explicit milestones");
    expect(stderr.text()).toBe("");
  });

  it("supports /compact and continues the active TUI session", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "myagent-cli-tui-compact-"));
    const sessionRootDir = join(cwd, ".myagent", "sessions");
    const stdout = captureWriter();
    const stderr = captureWriter();
    const model = new FakeModel([
      { type: "assistant_message", content: "long ".repeat(3_000) },
      { type: "turn_break" },
      { type: "assistant_message", content: "continued after compact" },
      { type: "turn_break" }
    ]);

    const exitCode = await runCli(["tui"], stdout.writer, stderr.writer, {
      cwd,
      sessionRootDir,
      env: {},
      prompt: scriptedPrompt(["remember this", "/compact", "continue", "/exit"]),
      createModelClient: () => model
    });

    expect(exitCode).toBe(0);
    expect(stdout.text()).toContain("[compact]");
    expect(stdout.text()).toContain("continued after compact");
    const [sessionFile] = readdirSync(sessionRootDir);
    const record = JSON.parse(readFileSync(join(sessionRootDir, sessionFile), "utf8")) as {
      events: Array<{ type: string }>;
    };
    expect(record.events.some((event) => event.type === "compact")).toBe(true);
    expect(stderr.text()).toBe("");
  });
});

function scriptedPrompt(answers: string[]) {
  return async () => {
    return answers.shift() ?? null;
  };
}
