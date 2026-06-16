#!/usr/bin/env node
/**
 * Passive auditor hook (PostToolUse).
 *
 * Appends one JSONL line per completed tool call to .myagent/hook-audit.jsonl
 * so you can grep / replay agent activity later. Always exits 0 -- it never
 * blocks or warns.
 *
 * Install (.myagent/hooks.json):
 * {
 *   "hooks": [
 *     {
 *       "name": "audit-log",
 *       "event": "PostToolUse",
 *       "command": "node examples/hooks/audit-log-tool-use.cjs"
 *     }
 *   ]
 * }
 *
 * Notes
 * - Path is relative to the project root (the hook is spawned with cwd=cwd).
 * - To restrict which tools get logged, add a `tools: ["Write", "Edit"]`
 *   filter on the hook config.
 * - Output file is gitignored as part of .myagent/.
 */

const fs = require("node:fs");
const path = require("node:path");

let raw = "";
process.stdin.on("data", (chunk) => {
  raw += chunk;
});
process.stdin.on("end", () => {
  try {
    const payload = JSON.parse(raw);
    const line = JSON.stringify({
      at: payload.at,
      tool: payload.toolUse && payload.toolUse.name,
      input: payload.toolUse && payload.toolUse.input,
      status: payload.result && payload.result.status
    });
    const dir = path.join(payload.cwd, ".myagent");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "hook-audit.jsonl"), line + "\n", "utf8");
  } catch (error) {
    // A failing auditor must never block a tool call. Drop the line.
    process.stderr.write(`[audit-log] skipped: ${error && error.message}\n`);
  }
  process.exit(0);
});
