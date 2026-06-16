#!/usr/bin/env node
/**
 * Active gate hook (PreToolUse on Write / Edit).
 *
 * Scans the content the agent is about to write for obvious secret
 * shapes -- OpenAI / Anthropic style keys, AWS access keys, GitHub PATs,
 * and unencrypted private keys. On match, exits 2 to BLOCK the write
 * (myagent treats exit code 2 as "this tool call is denied"); the
 * matched pattern name is written to stderr so it surfaces in the agent
 * loop's error context.
 *
 * Conservative by design -- patterns are chosen to be very unlikely in
 * real source. Extend `PATTERNS` below for your repo's threat model
 * (e.g. internal API URLs, customer ids).
 *
 * Install (.myagent/hooks.json):
 * {
 *   "hooks": [
 *     {
 *       "name": "block-secret-write",
 *       "event": "PreToolUse",
 *       "command": "node examples/hooks/block-secret-write.cjs",
 *       "tools": ["Write", "Edit"]
 *     }
 *   ]
 * }
 */

const PATTERNS = [
  { name: "OpenAI / Anthropic API key", regex: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: "AWS secret access key", regex: /aws_secret_access_key\s*[:=]\s*['"]?[A-Za-z0-9/+]{30,}/i },
  { name: "GitHub personal access token", regex: /\bghp_[A-Za-z0-9]{30,}\b/ },
  { name: "GitHub fine-grained PAT", regex: /\bgithub_pat_[A-Za-z0-9_]{50,}\b/ },
  { name: "Unencrypted private key", regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ }
];

let raw = "";
process.stdin.on("data", (chunk) => {
  raw += chunk;
});
process.stdin.on("end", () => {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    process.stderr.write(`[block-secret-write] malformed payload: ${error && error.message}\n`);
    process.exit(0); // do not block on internal hook errors
  }

  const input = (payload.toolUse && payload.toolUse.input) || {};
  // Cover both Write (input.content) and Edit (input.newString).
  const candidate = [input.content, input.newString].filter((v) => typeof v === "string").join("\n");
  if (!candidate) {
    process.exit(0);
  }

  for (const { name, regex } of PATTERNS) {
    if (regex.test(candidate)) {
      process.stderr.write(
        `[block-secret-write] refused: matched "${name}" -- write a placeholder or .env reference instead.\n`
      );
      process.exit(2);
    }
  }
  process.exit(0);
});
