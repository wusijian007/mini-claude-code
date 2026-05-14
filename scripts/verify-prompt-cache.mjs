// Verify Anthropic prompt caching against the configured endpoint.
//
// Reads ANTHROPIC_API_KEY + ANTHROPIC_BASE_URL from .env (mirroring the
// CLI's loader so it works under any wrapper that also sets these vars in
// process.env), applies the same /v1-stripping normalization the CLI does,
// and issues three back-to-back non-streaming requests with identical
// system content and a `cache_control: ephemeral` marker. The expected
// pattern when the endpoint actually supports prompt caching is:
//
//   call 1: cache_creation_input_tokens > 0,  cache_read_input_tokens = 0
//   call 2: cache_creation_input_tokens = 0,  cache_read_input_tokens > 0
//   call 3: same as call 2
//
// Why non-streaming: at least one popular proxy (claude.proai.love at the
// time of writing) returns zeroed usage in streaming responses but real
// numbers in non-streaming. Caching works the same way at the model end,
// but with streaming we'd see all zeros even on a successful hit. Use
// this script (non-streaming) to verify the cache itself; rely on
// `myagent usage <sessionId>` for the agent loop's per-turn breakdown
// once you have a backend that returns usage in streaming events.
//
// Usage:
//   node scripts/verify-prompt-cache.mjs
import Anthropic from "@anthropic-ai/sdk";

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const envPath = join(here, "..", ".env");
const envVars = {};
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    envVars[m[1]] = value;
  }
}

const apiKey = envVars.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY;
const rawBaseURL = envVars.ANTHROPIC_BASE_URL ?? process.env.ANTHROPIC_BASE_URL;

// Mirror packages/core/src/anthropic.ts normalizeAnthropicBaseURL — strip a
// trailing /v1 so the SDK doesn't double it.
function normalize(baseURL) {
  if (!baseURL) return undefined;
  const trimmed = baseURL.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed.slice(0, -"/v1".length) : trimmed;
}
const baseURL = normalize(rawBaseURL);

if (!apiKey) {
  console.error("[probe] ANTHROPIC_API_KEY missing (checked .env and process.env)");
  process.exit(1);
}
console.log("[probe] baseURL =", baseURL || "(SDK default)");

const client = new Anthropic({ apiKey, baseURL });

// Pad the system prompt past Anthropic's minimum cache write threshold
// (1024 tokens for Sonnet/Opus; 2048 for Haiku). ~22k chars of repeated
// filler is reliably above that.
const filler = Array.from({ length: 60 })
  .map(
    (_, i) =>
      `Paragraph ${i + 1}: This is filler context describing operational policy for the agent. ` +
      `The agent should remain concise, deferential, and grounded. It must not hallucinate. ` +
      `It should prefer to ask clarifying questions when input is ambiguous. ` +
      `It should always report uncertainty rather than fabricate. ` +
      `It should keep responses under fifty words unless otherwise requested.`
  )
  .join(" ");

const request = {
  model: envVars.MYAGENT_MODEL ?? "claude-sonnet-4-6",
  max_tokens: 60,
  system: [
    {
      type: "text",
      text: `You are a concise assistant. ${filler}`,
      cache_control: { type: "ephemeral" }
    }
  ],
  messages: [{ role: "user", content: "Say hi in 4 words." }]
};

async function callOnce(label) {
  const startedAt = Date.now();
  const response = await client.messages.create(request);
  const elapsedMs = Date.now() - startedAt;
  const usage = response.usage ?? {};
  console.log(
    `[${label}] ${elapsedMs}ms  ` +
      `in=${usage.input_tokens ?? "?"} ` +
      `out=${usage.output_tokens ?? "?"} ` +
      `cache_w=${usage.cache_creation_input_tokens ?? 0} ` +
      `cache_r=${usage.cache_read_input_tokens ?? 0}`
  );
  return usage;
}

try {
  console.log("[probe] system prompt length:", request.system[0].text.length, "chars");
  const usage1 = await callOnce("call 1");
  const usage2 = await callOnce("call 2");
  const usage3 = await callOnce("call 3");

  const cacheHit =
    (usage2.cache_read_input_tokens ?? 0) > 0 ||
    (usage3.cache_read_input_tokens ?? 0) > 0;
  const cacheWrite = (usage1.cache_creation_input_tokens ?? 0) > 0;

  console.log("");
  if (cacheWrite && cacheHit) {
    console.log("[probe] OK — prompt caching is working: call 1 wrote, calls 2-3 read.");
  } else if (cacheHit && !cacheWrite) {
    console.log("[probe] OK — calls 2-3 hit a pre-existing cache entry.");
  } else {
    console.log(
      "[probe] WARNING — no cache_creation or cache_read tokens observed on any call. " +
        "The endpoint is silently ignoring cache_control. Anthropic's official endpoint " +
        "supports prompt caching; some proxies do not pass the markers through."
    );
  }
} catch (error) {
  console.error("[probe] FAILED");
  console.error("  name:    ", error?.constructor?.name);
  console.error("  message: ", error?.message);
  console.error("  status:  ", error?.status);
  console.error("  cause:   ", error?.cause?.message ?? error?.cause);
  process.exit(1);
}
