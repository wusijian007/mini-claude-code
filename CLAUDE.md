# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Mini Claude Code — a safety-first learning re-implementation of a Claude Code-style coding agent. The execution roadmap is implemented through Week 18; treat this as a v1 learning build, not a production replacement. The detailed roadmap lives in `build-your-own-claude-code-roadmap.md` and `build-your-own-claude-code-execution-roadmap.md`.

## Commands

This is a Node 20+ TypeScript monorepo using npm workspaces and project references. The shell is Windows PowerShell — use `npm.cmd` (not `npm`) so the project's scripts resolve.

- Install: `npm.cmd ci`
- Build (composite project refs): `npm.cmd run build` — equivalent to `tsc -b`
- Typecheck only: `npm.cmd run typecheck`
- Run all tests: `npm.cmd test` — Vitest, includes `packages/**/*.test.ts`
- Run a single test file: `npx.cmd vitest run packages/core/test/query.test.ts`
- Run tests matching a name: `npx.cmd vitest run -t "partition tool calls"`
- Watch a test: `npx.cmd vitest packages/core/test/query.test.ts`
- Dev CLI (no build, via tsx): `npm.cmd run dev -- <args>`
- Built CLI: `npm.cmd run myagent -- <args>` (requires `build` first)

The CLI binary entry is `packages/cli/dist/index.js` (exposed as `myagent`). The full subcommand surface is documented by `myagent --help` — notable: `chat`, `agent`, `tui`, `memory`, `skill`, `mcp`, `task`, `remote`, `profile`, `resume`, `compact`, `week12 audit`, `week18 finalize`.

### Environment

- `ANTHROPIC_API_KEY` — required for real model calls (`chat`, `agent`, `tui`). Read from process env or a local `.env` (parsed by `loadEnvironment` in `packages/cli/src/index.ts`; only an allow-listed set of keys is honored).
- `ANTHROPIC_BASE_URL`, `MYAGENT_MODEL`, `MYAGENT_PERMISSION_MODE`, `MYAGENT_INPUT_USD_PER_MTOK`, `MYAGENT_OUTPUT_USD_PER_MTOK`, `MYAGENT_CACHE_WRITE_USD_PER_MTOK`, `MYAGENT_CACHE_READ_USD_PER_MTOK` — optional overrides. Prompt caching is wired on outbound requests: the agent's system prompt is sent as a single `SystemTextBlock` with `cache_control: ephemeral`, and the tool list's last entry carries a matching marker so the whole tool block is cached. `cacheCreationInputTokens` / `cacheReadInputTokens` flow back through `ModelUsage` → `TokenUsage` → session record → `myagent usage <sessionId>` per-turn breakdown.
- Offline tests use `FakeModel` and do not need an API key.
- Runtime state (sessions, artifacts, profiles, tasks, fork traces, memory) is written under `.myagent/` in the cwd; gitignored.

## Architecture

### Package layout (workspaces)

- `packages/core` — agent runtime: the query loop, model client, scheduler, tool framework, sessions/state/transcript, hooks, skills, memory, profile, remote server, tasks, watchdog, fork-trace. All exports flow through `packages/core/src/index.ts`.
- `packages/tools` — concrete tool implementations (`Read`, `Glob`, `Grep`, `Bash`, `Edit`, `Write`, `Agent`) and MCP tool loader. Built on `buildTool` from core.
- `packages/cli` — `myagent` CLI: argument parsing, the TUI, slash commands, and the per-turn wiring that assembles model client + tools + session + permission prompt + profile recorder.
- `packages/ui` — minimal UI helpers (placeholder; richer rendering is a future-week item).

TS path alias `@mini-claude-code/core` points at `packages/core/src/index.ts` in both `tsconfig.base.json` and `vitest.config.ts`, so tests resolve the source directly without needing a build.

### The query loop (the center of the system)

`query()` in `packages/core/src/query.ts` is the agent's run loop. Per turn it:

1. Sends `messages` + tool schemas to the `ModelClient` (Anthropic by default; tests use `FakeModel`).
2. Receives assistant content; if it contains `tool_use` blocks, they're split into batches by `partitionToolCalls` (read-only tools run in parallel up to `maxToolConcurrency`; anything else serializes).
3. `executeToolBatch` runs each tool through the permission chain, hooks (`PreToolUse`/`PostToolUse`), abort signal, and result-size budget; results become `tool_result` blocks in the next user turn.
4. Yields `LoopEvent`s (`assistant_message`, `tool_use`, `tool_result`, `terminal_state`) so the CLI can stream them.
5. Has `finalizeBeforeMaxTurns: true` — reserves the last allowed turn for a tool-free final answer (the v1.1 improvement called out in the README).
6. Recovers from `prompt_too_long`, `max_output`, and `stream_error` once each via `compactMessages` / retry.

The CLI's `runAgentTurn` (in `packages/cli/src/index.ts`) is the canonical example of wiring this up: it builds the `ToolContext` (cwd, artifact dir, `requestPermission`, `hookSnapshot`, `taskStore`, `recordForkTrace`), records profile checkpoints, persists every event to a `sessionStore`, and updates bootstrap token/cost state.

### Safety model

Read these before editing tool or permission code — invariants here are load-bearing:

- Tools fail **closed** by default. Each tool declares `isReadOnly` and a permission check.
- `plan` mode permits only read-only tools.
- `default` mode requires approval (via the `requestPermission` callback) for non-read-only tools when an approval channel exists; without one, they're denied.
- Headless `Edit` and `Write` require `--permission-mode bypassPermissions`.
- `Bash` is whitelist-only (`pwd`, `ls`, `cat`, `grep`, `rg`, `find`, `git status`, `git diff`, `git log`) and explicitly rejects redirects, pipes, command chaining, subshells, absolute paths, parent traversal, and `.env` reads.
- `Edit`/`Write` use a `FileStateStore` for read-before-write enforcement, diff preview, and staleness checks — never bypass this by writing without a prior `Read`.
- Sub-agents (`Agent` tool: `explore`, `verifier`) reuse the same query loop and cannot self-approve dangerous writes; `explore` and `verifier` are read-only. `maxSubAgentDepth` is enforced through `ToolContext`.
- MCP tool annotations are hints only — never trust an MCP server's self-declared safety.

When adding a tool, register it through `buildTool` in `packages/tools/src/index.ts` and wire it into `createProjectToolRegistry` / `createReadOnlyToolRegistry`. The same registry is shared by the CLI and by sub-agents; MCP tools are appended via `createProjectToolRegistryWithMcp` (config: `.myagent/mcp.json`).

### State, sessions, and artifacts

- `createSessionStore(cwd)` persists each turn's transcript under `.myagent/sessions/`. `replayMessagesFromSession` reconstructs `Message[]` for `resume` / TUI continuation. `compactSessionRecord` is the headless simple-snip compaction used by `myagent compact` and the TUI `/compact`; it accepts an optional async `archiver` that receives the dropped (unsnipped) messages and returns a path stamped onto the resulting `compact` event as `archivePath`. The CLI wires this to `.myagent/artifacts/<sessionId>/compactions/<at>.json` so compactions are reversible / inspectable via `myagent resume <id> --show-compactions`.
- Long tool outputs over the configured budget (`toolResultBudgetChars`, default 8192) are spilled to `.myagent/artifacts/<sessionId>/`; the model gets a pointer.
- Bootstrap state (current `sessionId`, model, permission mode, token usage, cost) is held in `state.ts` via `initializeBootstrapState` / `getBootstrapState` / `updateBootstrapState`. The CLI updates token + cost after each `assistant_message`.
- Hooks load as a frozen `HookSnapshot` from `.myagent/hooks.json` once per turn — they don't re-read disk mid-loop.
- Memory: `createMemoryStore` reads from `.myagent/projects/<project>/memory`. Memory is treated as user/project preference, not as authoritative code truth (see `READ_ONLY_AGENT_SYSTEM_PROMPT` in `packages/cli/src/index.ts`). Skills are scanned from `SKILL.md` frontmatter via `scanSkillSnapshot`.
- Background tasks (`myagent task start-bash`) spawn a detached `task worker <id>` child process; state machine lives in `packages/core/src/task.ts` and persists to `.myagent/tasks/`.
- Remote control (`myagent remote serve`) starts a local-only WebSocket endpoint backed by `createRemoteAgentServer`; metadata in `.myagent/remote/`. The server requires a bearer token on every upgrade — `ensureRemoteAuthToken` generates a 256-bit token in `.myagent/remote/auth.json` on first launch (file mode 0o600 best-effort; Windows degrades) and reuses it across restarts. Missing or wrong `Authorization: Bearer <token>` returns HTTP 401 pre-upgrade; the comparison uses `crypto.timingSafeEqual`.

### What's intentionally missing

No cloud control plane, OAuth, real OS/container sandbox, or browser UI. The point is a small, testable architecture that makes the main Claude Code patterns concrete — keep new code in that spirit and prefer extending the existing primitives over building parallel ones.
