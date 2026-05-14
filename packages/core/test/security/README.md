# Security invariants — test catalog

This directory is the single index for myagent's load-bearing security
invariants. Each row below names an invariant, what *should* happen when
it is violated, and the test that pins it. **Read this before changing
anything in the permission chain, tool registry, hooks pipeline, or
scheduler partitioning.** Any new invariant added to the codebase
should land with a corresponding row here.

Tests live in two trees because of the package boundary
(`@mini-claude-code/core` cannot depend on `@mini-claude-code/tools`):

- Core-only invariants (scheduler, hook framework, state) → this
  directory.
- Tool-level invariants (Bash parser, file-path checks, end-to-end
  hook block) → `packages/tools/test/security/`.

## Catalog

### Permission modes

| Invariant | Test |
|---|---|
| `plan` mode allows read-only tools | `packages/core/test/tool-pipeline.test.ts` |
| `plan` mode denies write-side tools (Edit, Write) | `packages/core/test/tool-pipeline.test.ts` |
| `default` mode denies write tools without an approval channel | `packages/core/test/tool-pipeline.test.ts` |
| `bypassPermissions` mode allows write tools | `packages/tools/test/week4-tools.test.ts` |

### Bash whitelist (parser-level rejections)

| Invariant | Test |
|---|---|
| `;` / `\|` / `&` / `>` / `<` / `$(…)` / backtick all rejected | `packages/tools/test/security/bash-parser-rejections.test.ts` |
| `rm`, `mv`, and other write-like commands rejected | `packages/tools/test/security/bash-parser-rejections.test.ts` + `week4-tools.test.ts` |
| `git commit` / other non-whitelisted subcommands rejected | `packages/tools/test/security/bash-parser-rejections.test.ts` + `week4-tools.test.ts` |
| Path args containing `..`, mid-path `/../`, or absolute paths rejected | `packages/tools/test/security/bash-parser-rejections.test.ts` |
| Null bytes in any arg rejected | `packages/tools/test/security/bash-parser-rejections.test.ts` |
| `cat .env` (and `.env` anywhere in a path arg) rejected | `packages/tools/test/security/bash-parser-rejections.test.ts` + `week4-tools.test.ts` |

### File tools — path scope

| Invariant | Test |
|---|---|
| Read/Glob/Edit/Write reject `..` traversal that escapes cwd | `packages/tools/test/security/path-traversal.test.ts` |
| Grep rejects an absolute path outside the project | `packages/tools/test/security/path-traversal.test.ts` |
| `SessionStore.pathFor` rejects `..` in session ids | `packages/core/test/session.test.ts` |

### File state (read-before-write + staleness)

| Invariant | Test |
|---|---|
| Edit fails if file was never Read first | `packages/tools/test/week4-tools.test.ts` |
| Write fails if existing file was never Read first | `packages/tools/test/week4-tools.test.ts` |
| Edit/Write fail if the on-disk file changed since last Read | `packages/tools/test/week4-tools.test.ts` |

### Hooks pipeline

| Invariant | Test |
|---|---|
| `runToolHooks` returns `blocked` on PreToolUse exit code 2 | `packages/core/test/hooks.test.ts` |
| `runToolHooks` returns `blocked` on PostToolUse exit code 2 | `packages/core/test/hooks.test.ts` |
| Non-zero non-blocking exit becomes a soft warning, not block | `packages/core/test/hooks.test.ts` |
| Hook snapshot is frozen — config edits after load don't apply | `packages/core/test/hooks.test.ts` |
| **End-to-end:** PreToolUse exit-2 stops `executeToolUse` before disk write | `packages/tools/test/security/hook-preuse-blocks-tool.test.ts` |
| **End-to-end:** PostToolUse exit-2 surfaces as tool error after Edit | `packages/tools/test/week4-tools.test.ts` |
| Hook tool filter — non-listed tool passes through | `packages/tools/test/security/hook-preuse-blocks-tool.test.ts` |

### Scheduler concurrency

| Invariant | Test |
|---|---|
| `partitionToolCalls` keeps writes in their own serial batches | `packages/core/test/security/scheduler-write-serialization.test.ts` + `scheduler.test.ts` |
| `executeToolBatch` never overlaps two non-concurrency-safe tools | `packages/core/test/security/scheduler-write-serialization.test.ts` |
| Sibling read tools cancel when a Bash sibling errors with cancel-on-error | `packages/core/test/scheduler.test.ts` |

### TaskStore concurrency

| Invariant | Test |
|---|---|
| Concurrent `patch` calls on the same task serialize in-process (load→save is atomic per task) | `packages/core/test/task.test.ts` (kill-while-running test, deterministic under the per-task lock in `createTaskStore`) |
| Windows transient `EBUSY`/`EPERM`/`EACCES` on the records rename retry up to 6× with linear backoff before throwing | covered indirectly by the same kill test; the helper is `renameWithRetry` in `task.ts` |

### Sub-agents

| Invariant | Test |
|---|---|
| `maxSubAgentDepth=1` blocks nested Agent recursion | `packages/tools/test/agent-tools.test.ts` |
| `explore` sub-agent cannot self-approve writes (plan mode forced) | `packages/tools/test/agent-tools.test.ts` |
| `verifier` runs as a `local_agent` background task | `packages/tools/test/agent-tools.test.ts` |

### Cross-platform test hygiene

| Invariant | Test |
|---|---|
| No test file embeds a Windows drive-letter, `/home/<user>/`, or `/Users/<user>/` literal — use `process.cwd()` / `os.tmpdir()` / `node:path` instead | `packages/core/test/security/test-file-hygiene.test.ts` |

## Adding a new invariant

1. Write the negative test in the package that owns the surface
   (`packages/core/test/security/` for scheduler/hooks/state,
   `packages/tools/test/security/` for tools).
2. Add a row to the table above.
3. If the invariant is a *behavior* rather than a single function, add
   both a unit test (call the function directly) and an end-to-end
   test (drive it through `executeToolUse` or the query loop).
