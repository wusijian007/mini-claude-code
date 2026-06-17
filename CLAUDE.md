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

The CLI binary entry is `packages/cli/dist/index.js` (exposed as `myagent`). The full subcommand surface is documented by `myagent --help` — notable: `chat`, `agent`, `tui`, `memory`, `skill`, `mcp`, `task`, `remote`, `profile`, `usage`, `resume`, `compact`, `week12 audit`, `week18 finalize`, `eval run`.

`myagent eval run` is the offline fixture-based agent regression suite ([packages/cli/src/eval.ts](packages/cli/src/eval.ts)): 9 inline `EvalTask`s drive the real `query()` loop with deterministic `FakeModel` scripts (read-only analysis, safe edit, read-only Bash, plan-mode-blocks-Write permission enforcement, explore sub-agent, proactive-compaction crossing the soft limit, self-correction edit→verify-fail→fix→verify-pass via a scripted mock executor, a turn-boundary background-task inbox drain, and a Finalize Critic reject→revise→approve via a separate scripted critic model). Token/cost numbers are deterministic because `FakeModelStep`'s `assistant_message` accepts an optional scripted `usage`; the suite reports pass/turns/in/out/cache/cost per task plus totals under `.myagent/evals/runs/<runId>/`. It is also a CI gate via `packages/cli/test/eval.test.ts` (asserts all pass + pins the metric fingerprint) — a behavior regression in the agent loop flips it red.

### Environment

- `ANTHROPIC_API_KEY` — required for real model calls (`chat`, `agent`, `tui`). Read from process env or a local `.env` (parsed by `loadEnvironment` in `packages/cli/src/index.ts`; only an allow-listed set of keys is honored).
- `ANTHROPIC_BASE_URL`, `MYAGENT_MODEL`, `MYAGENT_PERMISSION_MODE`, `MYAGENT_INPUT_USD_PER_MTOK`, `MYAGENT_OUTPUT_USD_PER_MTOK`, `MYAGENT_CACHE_WRITE_USD_PER_MTOK`, `MYAGENT_CACHE_READ_USD_PER_MTOK`, `MYAGENT_IDLE_TIMEOUT_MS` — optional overrides. `MYAGENT_IDLE_TIMEOUT_MS` (default 90000) bumps the stream watchdog when a gateway routes through an extended-thinking model whose thinking phases can pause for minutes between events. Prompt caching is wired on outbound requests at three breakpoints (Anthropic allows 4): the agent's system prompt is a single `SystemTextBlock` with `cache_control: ephemeral`; the tool list's last entry carries a matching marker; and the agent loop sets `ModelRequest.cacheConversation` so `toAnthropicMessages` marks the **last block of the last message** — the conversation prefix — as a rolling breakpoint that the next (strict-extension) turn hits incrementally. The plain `chat` path leaves `cacheConversation` off. `cacheCreationInputTokens` / `cacheReadInputTokens` flow back through `ModelUsage` → `TokenUsage` → session record → `myagent usage <sessionId>`, which renders a per-turn breakdown plus a `cache hit ratio` (`cache_read / (cache_read + input)`); `myagent eval run` reports the same ratio on its deterministic fixture.
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
4. Yields `LoopEvent`s (`assistant_message`, `tool_use`, `tool_result`, `terminal_state`, plus `compaction` / `verification` / `critic` / `background_tasks`) so the CLI can stream them.
5. Has `finalizeBeforeMaxTurns: true` — reserves the last allowed turn for a tool-free final answer (the v1.1 improvement called out in the README).
6. Recovers from `prompt_too_long`, `max_output`, and `stream_error` once each via `compactMessages` / retry (the reactive safety net).
7. Proactively compacts at the turn boundary (M3.2b): when the running transcript estimate crosses `proactiveCompactionSoftLimitRatio` (default 75%) of `contextBudgetTokens`, it runs `compactMessagesTiered` down to the target ratio (50%) before the next request and yields a `compaction` LoopEvent. `compactMessagesTiered` ([context.ts](packages/core/src/context.ts)) is the deterministic "smart" compactor: it shrinks stale messages in place — pointer-izing large `tool_result` blocks (the token whales; they stay re-readable / archived) and snipping long text — keeping the root task and recent window verbatim, so tool_use/tool_result pairing is never broken. Compaction is an amortized cache-reset (it invalidates the rolling message-prefix breakpoint once; see `docs/v3-kernel-roadmap.md` §1), marked by a `query.cache_prefix_reset` profile event.
8. Definition-of-Done gate chain (M3.3 + M3.5, §4): when the model stops calling tools, the loop does NOT complete immediately — it runs a chain of `DoneGate`s in order, and the first that fails injects a reflective user turn + continues the loop, bounded by ONE shared bounce budget (`maxDoneBounces`); exceeding it ends with a `verification_failed` terminal state instead of a silent `completed`. Two gates exist, cheap-first:
   - **Gate 1 — structural verify** (M3.3): with `QueryOptions.verify = { command, args, when, maxBounces }` set (CLI: `myagent agent --verify "<command>"`), runs the command via `ToolContext.executor` (the M2.1 seam — NOT the whitelisted Bash tool, so arbitrary `npm test` / `tsc --noEmit` is allowed). Exit 0 passes; non-zero injects `reflectiveVerifyFailure` (edit→test→fix). Yields a `verification` LoopEvent.
   - **Gate 2 — Finalize Critic** (M3.5): with `QueryOptions.critic = { model?, modelName?, maxBounces?, instructions? }` set (CLI: `myagent agent --critic [--critic-instructions "<text>"]`), a read-only model call (no tools given → read-only by construction; core can't import the Agent tool, so a tool-less critic call is the layer-safe realization of "read-only verifier") judges whether the final answer satisfies the root task. It runs in its own child context (a single synthesized message of root task + final answer). `APPROVE` passes; `REJECT: <reason>` injects `reflectiveCriticRejection` (a semantic revise loop — catches answer-doesn't-match-task / hallucinated paths that an exit code can't). Yields a `critic` LoopEvent.

   Gate order is verify-then-critic (fail-fast: don't spend a model call if it doesn't even compile). With no gates configured this is the plain completion (zero behavior change). Determinism: verify injects a mock `CommandExecutor` (eval `self-correction` scripts `[1, 0]`); critic injects a separate scripted `FakeModel` verdict stream (eval `finalize-critic` scripts `[REJECT, APPROVE]`).
9. Turn-boundary background-task inbox (M3.4, §3): with `QueryOptions.drainBackgroundTasks` on (CLI agent path sets it) and a `ToolContext.startedBackgroundTaskIds` Set present, the loop drains THIS-run background tasks (`local_agent` tasks the Agent tool started, which register their id into that Set) that have reached a terminal state — injecting a synthetic observation (state + bounded output tail) into the conversation at the turn boundary, so the model is pushed the result instead of polling. Strictly scoped to the run's own task ids (leftover/CLI-started tasks are never drained) and deduped via the store's `notifiedAt`. Injection is append-only, so it's gentler on the cache prefix than compaction (only loses cache after the injection point). Yields a `background_tasks` LoopEvent.

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
- Hooks load as a frozen `HookSnapshot` from `.myagent/hooks.json` once per turn — they don't re-read disk mid-loop. Three ready-to-copy starter hooks live at [examples/hooks/](examples/hooks/): a passive auditor (`audit-log-tool-use.cjs`, PostToolUse, never blocks), an active secret-scan gate (`block-secret-write.cjs`, PreToolUse on Write/Edit, exits 2 to block), and a prettier integration (`format-on-write.cjs`, PostToolUse, soft-warns if prettier isn't installed). Each script's header includes the `hooks.json` snippet to wire it in.
- Memory: `createMemoryStore` reads from `.myagent/projects/<project>/memory`. Memory is treated as user/project preference, not as authoritative code truth (see `READ_ONLY_AGENT_SYSTEM_PROMPT` in `packages/cli/src/index.ts`). Skills are scanned from `SKILL.md` frontmatter via `scanSkillSnapshot`.
- Background tasks (`myagent task start-bash`) spawn a detached `task worker <id>` child process; state machine lives in `packages/core/src/task.ts` and persists to `.myagent/tasks/`.
- External-command execution (Bash tool's `git`/`rg`/`grep` paths + task worker's spawn path) all route through a `CommandExecutor` interface ([packages/core/src/executor.ts](packages/core/src/executor.ts)). `ToolContext.executor` lets tests inject mocks; the default `createSpawnExecutor()` wraps `child_process.spawn` and is the only place future sandbox runtimes (Docker, etc.) need to plug in. Bash builtins (pwd/ls/cat/find), hooks (different `shell: true` + exit-code-2 semantics), and the detached `task worker` self-spawn deliberately bypass the seam.
- Remote control (`myagent remote serve`) starts a local-only WebSocket endpoint backed by `createRemoteAgentServer`; metadata in `.myagent/remote/`. The server requires a bearer token on every upgrade — `ensureRemoteAuthToken` generates a 256-bit token in `.myagent/remote/auth.json` on first launch (file mode 0o600 best-effort; Windows degrades) and reuses it across restarts. Missing or wrong `Authorization: Bearer <token>` returns HTTP 401 pre-upgrade; the comparison uses `crypto.timingSafeEqual`. The first authenticated connection is the `owner` (may drive turns / answer permission prompts); later connections are read-only `follower`s that receive the broadcast turn stream but whose `user_message`/`permission_decision` are rejected. The server emits a `role` message right after `ready`. Owner disconnect releases the slot to the next NEW connection (no follower auto-promotion). `myagent remote client [--url ws://host:port] [--token <t>] [--prompt "<p>"] [--session <id>]` is the reference client: connects, streams stdout/stderr, and forwards permission prompts to the local TTY (token falls back to the local `.myagent/remote/auth.json` when `--token` is omitted).

### What's intentionally missing

No cloud control plane, OAuth, real OS/container sandbox, or browser UI. The point is a small, testable architecture that makes the main Claude Code patterns concrete — keep new code in that spirit and prefer extending the existing primitives over building parallel ones.
