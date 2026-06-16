#!/usr/bin/env node
/**
 * Tool-integration hook (PostToolUse on Write / Edit).
 *
 * After the agent writes or edits a TypeScript / JavaScript file, runs
 * the project's local prettier on it. Prettier is detected via
 * `require.resolve("prettier")` -- if it isn't installed in this
 * project, the hook emits a soft warning (exit 1, non-blocking) and
 * leaves the file alone, so the agent doesn't get punished for a
 * tooling absence.
 *
 * The agent receives any formatting changes on the NEXT read of the
 * file (FileStateStore staleness check kicks in and forces a re-read
 * before the next Edit).
 *
 * Install (.myagent/hooks.json):
 * {
 *   "hooks": [
 *     {
 *       "name": "format-on-write",
 *       "event": "PostToolUse",
 *       "command": "node examples/hooks/format-on-write.cjs",
 *       "tools": ["Write", "Edit"]
 *     }
 *   ]
 * }
 */

const fs = require("node:fs");
const path = require("node:path");

const FORMAT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"]);

let raw = "";
process.stdin.on("data", (chunk) => {
  raw += chunk;
});
process.stdin.on("end", async () => {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    process.stderr.write(`[format-on-write] malformed payload: ${error && error.message}\n`);
    process.exit(0);
  }

  const input = (payload.toolUse && payload.toolUse.input) || {};
  const targetRel = input.path;
  if (typeof targetRel !== "string" || targetRel.length === 0) {
    process.exit(0);
  }
  const ext = path.extname(targetRel).toLowerCase();
  if (!FORMAT_EXTENSIONS.has(ext)) {
    process.exit(0);
  }
  const targetAbs = path.resolve(payload.cwd, targetRel);
  if (!fs.existsSync(targetAbs)) {
    process.exit(0);
  }

  // Resolve prettier relative to the project (the agent's cwd), not this
  // script's location -- the agent might be running against any project.
  let prettier;
  try {
    const prettierPath = require.resolve("prettier", { paths: [payload.cwd] });
    prettier = require(prettierPath);
  } catch (_error) {
    process.stderr.write(
      "[format-on-write] prettier not installed in this project; skipping. " +
        "Run `npm install --save-dev prettier` to enable.\n"
    );
    process.exit(1); // non-blocking warning
  }

  try {
    const source = fs.readFileSync(targetAbs, "utf8");
    const options = await (prettier.resolveConfig ? prettier.resolveConfig(targetAbs) : Promise.resolve(null));
    const formatted = await prettier.format(source, {
      ...(options || {}),
      filepath: targetAbs
    });
    if (formatted !== source) {
      fs.writeFileSync(targetAbs, formatted, "utf8");
      process.stdout.write(`[format-on-write] formatted ${targetRel}\n`);
    }
  } catch (error) {
    process.stderr.write(`[format-on-write] prettier failed on ${targetRel}: ${error && error.message}\n`);
    process.exit(1); // non-blocking warning -- don't fail the tool result over a syntax error in the file
  }
  process.exit(0);
});
