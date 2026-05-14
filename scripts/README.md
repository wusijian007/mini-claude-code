# scripts/

One-off diagnostic and verification scripts that don't fit inside the
test suite — usually because they talk to a real Anthropic endpoint and
cost tokens, or they exist to debug a specific proxy/gateway quirk.

These scripts are deliberately kept outside `packages/*/test/` so they
don't run under `npm test`. Run them manually with `node scripts/<name>.mjs`.

## Current scripts

| Script | Purpose |
|---|---|
| [verify-prompt-cache.mjs](verify-prompt-cache.mjs) | Issues three back-to-back non-streaming requests with `cache_control: ephemeral` and reports whether `cache_creation_input_tokens` / `cache_read_input_tokens` flip as expected. Useful for distinguishing "myagent isn't sending cache_control" from "the configured endpoint silently ignores cache_control." |

## Gateway quirks discovered

If you're using a non-official Anthropic-compatible proxy and `myagent
usage <sessionId>` is reporting all zeros, suspect one of these (both
observed on `claude.proai.love` during M1.5b verification):

1. **Streaming usage returns zeros.** Some proxies report
   `input_tokens: 0`, `output_tokens: 0`, etc. in `message_start` /
   `message_delta` even though the non-streaming endpoint returns real
   numbers for the same request. myagent uses streaming exclusively in
   the agent loop, so it will display zeros in `myagent usage` on such
   proxies. `verify-prompt-cache.mjs` uses non-streaming on purpose to
   sidestep this and reveal real numbers.

2. **`cache_control` is silently dropped.** A proxy may accept the
   marker (no error response) but not pass it through to Anthropic, so
   `cache_creation_input_tokens` / `cache_read_input_tokens` stay zero
   on every call regardless of payload size or repetition.
   `verify-prompt-cache.mjs` prints a `[probe] WARNING …` line in this
   case.

myagent's request-side caching plumbing is correct against Anthropic's
official `api.anthropic.com` endpoint. If a proxy zeros things out, the
agent will still work — there will just be no cost savings and no
visibility into cache hits.
