# Hook examples

Three ready-to-copy hook scripts demonstrating the three useful shapes:

| File | Event | Effect |
|---|---|---|
| [audit-log-tool-use.cjs](audit-log-tool-use.cjs) | `PostToolUse` | Appends a JSONL line per tool call to `.myagent/hook-audit.jsonl`. Never blocks. |
| [block-secret-write.cjs](block-secret-write.cjs) | `PreToolUse` on `Write` / `Edit` | Scans the content the agent is about to write for obvious secret shapes (OpenAI/Anthropic keys, AWS, GitHub PATs, private keys). Exits **2** to **block** on match. |
| [format-on-write.cjs](format-on-write.cjs) | `PostToolUse` on `Write` / `Edit` | Runs the project's local prettier on the touched file. Soft warning if prettier isn't installed. |

These are **starting points**, not turnkey production hooks. Copy a file
into your project, edit the patterns / paths / filters, and wire it into
`.myagent/hooks.json`.

## Hook contract recap

The runtime spawns each hook with `shell: true` and the agent's cwd as
the working directory. The hook receives a single JSON payload on stdin:

```jsonc
{
  "event": "PreToolUse" | "PostToolUse",
  "hookName": "name from hooks.json",
  "cwd": "/abs/project/path",
  "toolUse": { "id": "toolu_...", "name": "Write", "input": { /* ... */ } },
  "result": { /* PostToolUse only: toolUseId, status, content?, error? */ },
  "at": "2026-05-15T..."
}
```

Exit code semantics:

| Exit code | Effect |
|---|---|
| `0` | Pass. Tool call proceeds (Pre) or result is delivered to the model (Post). |
| `2` | **Block.** The tool call is aborted (Pre) or its result is replaced with an error (Post). The hook's stderr surfaces in the error message. |
| `1` or `3-255` | Non-blocking warning. The tool call still proceeds; the hook's output is attached to the result that the model sees. |
| `124` | Reserved for "hook timed out after N ms" — the framework sets this. |

The runtime caps stdout/stderr at 10 KB; longer output is truncated.
Default hook timeout is 10 s, overridable per-hook with `timeoutMs`.

## Installing one

Add to `.myagent/hooks.json` (create it if it doesn't exist):

```json
{
  "hooks": [
    {
      "name": "audit-log",
      "event": "PostToolUse",
      "command": "node examples/hooks/audit-log-tool-use.cjs"
    },
    {
      "name": "block-secret-write",
      "event": "PreToolUse",
      "command": "node examples/hooks/block-secret-write.cjs",
      "tools": ["Write", "Edit"]
    },
    {
      "name": "format-on-write",
      "event": "PostToolUse",
      "command": "node examples/hooks/format-on-write.cjs",
      "tools": ["Write", "Edit"],
      "timeoutMs": 30000
    }
  ]
}
```

Hooks are loaded once per turn into a frozen `HookSnapshot`, so edits
to this file mid-turn don't take effect until the next user message.

## Verifying a hook fires

Easiest way: write a file with the agent and watch the side effect.

```powershell
# install the audit hook (see snippet above), then:
npm.cmd run myagent -- agent --permission-mode bypassPermissions "create a tiny HELLO.md saying hi"
cat .myagent\hook-audit.jsonl
```

You should see a JSONL line whose `tool` is `Write` and `status` is
`success`. Delete `HELLO.md` afterwards.

For `block-secret-write`, ask the agent to write a file containing
`sk-abcdefghijklmnopqrstuvwxyz1234567890` and watch the tool result
come back as an error mentioning `block-secret-write`.

## Notes / pitfalls

- **Path is relative to the agent's cwd**, not this `examples/`
  directory. Adjust the `command` if you copy the script elsewhere.
- **`shell: true` semantics differ by platform** — `node script.cjs` is
  the safest cross-platform invocation (no shell-specific quoting).
- **`.cjs` extension** is intentional. The hook scripts must work
  whether the surrounding project uses ESM or CommonJS.
- **A failing hook should never block.** Catch parse errors and exit 0;
  only exit 2 for the actual condition you mean to enforce. The
  example scripts demonstrate this discipline.
- **Hook stdout/stderr is visible to the agent** (attached to the tool
  result via warnings). Don't leak secrets or full file contents into
  hook output unless you mean to.
