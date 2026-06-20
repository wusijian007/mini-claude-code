import {
  collapseMessagesView,
  compactMessages,
  compactMessagesTiered,
  compactMessagesWithSummary,
  estimateAnchoredTokens,
  estimateMessagesTokens,
  microcompactToolResults,
  runCompactionPipeline,
  snipStaleToolScaffolding,
  type CompactionStage,
  type MessageSummarizer,
  type UsageAnchor
} from "./context.js";
import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL,
  messageContentToText,
  ModelError,
  type ModelClient,
  type ModelErrorKind,
  type ModelStreamEvent,
  type ModelUsage,
  type SystemTextBlock
} from "./model.js";
import { executeToolBatch, partitionToolCalls } from "./scheduler.js";
import { smartPreview, toModelToolDefinition, writeToolResultArtifact } from "./tool.js";
import { createSpawnExecutor } from "./executor.js";
import { isTerminalTaskState, type TaskRecord, type TaskStore } from "./task.js";
import type { ProfileRecorder } from "./profile.js";
import type {
  LoopEvent,
  Message,
  MessageContent,
  ModelToolDefinition,
  PermissionMode,
  ToolContext,
  ToolDefinition,
  ToolResult,
  ToolUse
} from "./types.js";

export type QueryOptions = {
  model: ModelClient;
  initialMessages: readonly Message[];
  tools: readonly ToolDefinition[];
  toolContext: ToolContext;
  system?: string | readonly SystemTextBlock[];
  modelName?: string;
  maxTokens?: number;
  maxTurns?: number;
  permissionMode?: PermissionMode;
  abortSignal?: AbortSignal;
  contextBudgetTokens?: number;
  retryLimits?: Partial<Record<RecoverableModelErrorKind, number>>;
  maxToolConcurrency?: number;
  profile?: ProfileRecorder;
  finalizeBeforeMaxTurns?: boolean;
  finalResponsePrompt?: string;
  /**
   * M3.2b — proactive compaction. When the running transcript estimate
   * crosses `proactiveCompactionSoftLimitRatio * contextBudgetTokens` at a
   * turn boundary, compact (tiered) down to
   * `proactiveCompactionTargetRatio * contextBudgetTokens` BEFORE the next
   * request — instead of waiting for the API to reject an oversized prompt.
   * Compacting well below the soft limit maximizes turns-between-compactions
   * (each compaction is one cache miss; see docs/v3-kernel-roadmap.md §1).
   * Set the soft-limit ratio to 0 to disable (reactive path still applies).
   */
  proactiveCompactionSoftLimitRatio?: number;
  proactiveCompactionTargetRatio?: number;
  /**
   * M3.2c — opt-in semantic compaction. When set, proactive compaction
   * REPLACES the stale region with a single LLM-written recap (via
   * `compactMessagesWithSummary`) instead of the default deterministic
   * pointer-ization. Non-deterministic + costs a model call, so it is purely
   * opt-in (CLI `--semantic-compaction`); tests inject a scripted fake. The
   * deterministic default path is untouched when this is absent.
   */
  compactionSummarizer?: MessageSummarizer;
  /**
   * M4.3 (L3) — cache-warmth clock for the microcompact stage. Returns "now" in
   * ms; the loop treats the prefix cache as COLD when more than
   * `microcompactColdMs` (default 5 min ≈ the Anthropic cache TTL) has elapsed
   * since the last model call, and HOT otherwise. Injectable so offline tests
   * can drive both paths deterministically. Defaults to `Date.now`.
   */
  now?: () => number;
  microcompactColdMs?: number;
  /**
   * M4.4 (L4) — opt-in context collapse. When enabled and the anchored estimate
   * crosses `collapseSoftLimitRatio` (default 90%, above the cascade's 75%), the
   * loop switches to a REVERSIBLE collapsed VIEW: it sends
   * `collapseMessagesView(messages)` while keeping the canonical `messages`
   * intact, and SUPPRESSES the destructive cascade (incl. the L5 semantic
   * recap). Sticky once triggered. Default off → zero behavior change.
   */
  contextCollapse?: boolean;
  collapseSoftLimitRatio?: number;
  /**
   * M4.5 (L5) — circuit breaker for the semantic auto-compact. After this many
   * CONSECUTIVE summarizer failures the L5 path is disabled for the rest of the
   * run (the loop falls back to deterministic compaction), so a flapping
   * summarizer can never spin forever. Default 3.
   */
  maxL5Failures?: number;
  /**
   * M3.3 — structural verification gate. When set, the agent loop does not
   * complete the moment the model stops calling tools: it first runs
   * `command args` via `toolContext.executor` (NOT the whitelisted Bash
   * tool). Exit 0 -> the run completes. Non-zero -> the failure is injected
   * as a reflective user turn and the loop continues (an edit->test->fix
   * cycle), bounded by `maxBounces` (default 2); exceeding it ends the run
   * with a `verification_failed` terminal state instead of a silent
   * "completed". `when` defaults to "on_terminal".
   */
  verify?: VerifyConfig;
  /**
   * M3.5 — Finalize Critic gate. When set, the completion path runs a
   * read-only "critic" model call (no tools given -> read-only by
   * construction) that judges whether the final answer actually satisfies the
   * root task. APPROVE -> the run completes; REJECT -> the critique is injected
   * as a reflective user turn and the loop continues a revise cycle. This is
   * the SECOND gate in the Definition-of-Done chain: structural `verify` runs
   * first (cheap, exit-code), then the critic (one model call). The chain
   * shares one bounce budget; exceeding it ends with `verification_failed`.
   */
  critic?: CriticConfig;
  /**
   * M3.4 — turn-boundary task inbox. When true and `toolContext.taskStore` +
   * `toolContext.startedBackgroundTaskIds` are present, the loop drains
   * THIS-run background tasks that have reached a terminal state into a
   * synthetic observation message at each turn boundary (push instead of the
   * model having to poll). Only tasks the run itself started are drained.
   */
  drainBackgroundTasks?: boolean;
};

export type VerifyConfig = {
  command: string;
  args?: readonly string[];
  when?: "on_terminal";
  maxBounces?: number;
};

export type CriticConfig = {
  /** Shared with verify's budget at the chain level; see `maxDoneBounces`. */
  maxBounces?: number;
  /** Model the critic call uses. Defaults to the query's own model. */
  model?: ModelClient;
  /** Model name for the critic call. Defaults to the query's modelName. */
  modelName?: string;
  /** Max tokens for the critic's verdict. Defaults to 512. */
  maxTokens?: number;
  /** Extra review criteria appended to the critic's system prompt. */
  instructions?: string;
};

/**
 * One link in the Definition-of-Done chain (M3.5). The completion path runs
 * gates in order; the first that does not pass injects a reflective user turn
 * and the loop continues. `check` returns a normalized result so the loop can
 * emit observability, inject the reflection, and bound bounces uniformly across
 * structural verify and the semantic critic.
 */
type DoneGate = {
  name: string;
  check(args: { messages: readonly Message[]; turn: number; bounce: number }): Promise<DoneGateCheck>;
};

type DoneGateCheck = {
  /** Observability event yielded regardless of pass/fail. */
  event: LoopEvent;
  passed: boolean;
  /** Reflective user-turn content injected on failure (not a raw dump). */
  reflection: string;
  /** Profile mark name + data recorded on a failure bounce. */
  profileMark: string;
  profileData: Record<string, unknown>;
  /** Terminal `verification_failed` reason/detail when the budget is exhausted. */
  terminalReason: string;
  terminalError?: string;
};

const CRITIC_SYSTEM_PROMPT =
  "You are a meticulous reviewer acting as the final gate before an answer is delivered. " +
  "You did not do the work; your only job is to judge whether the assistant's final answer " +
  "correctly and completely satisfies the task. Be strict about unmet requirements, unsupported " +
  "claims, hallucinated file paths or APIs, and answers that merely describe intent rather than " +
  "completed work. Do not nitpick style. Reply with exactly `APPROVE`, or `REJECT: <one-line reason>`.";

const DEFAULT_MAX_TURNS = 10;
const DEFAULT_CONTEXT_BUDGET_TOKENS = 24_000;
// M4.1 (L1) — request-time spill defaults. The threshold matches the execution
// budget default, so when no tool/CLI budget is set (e.g. the eval harness) L1
// is effectively dormant; the CLI sets a real budget that activates it.
const DEFAULT_SPILL_THRESHOLD_CHARS = 120_000;
const DEFAULT_SPILL_PREVIEW_CHARS = 2_048;
// M4.3 (L3) — treat the prefix cache as cold after ~5 min (the Anthropic cache
// TTL); keep the 3 newest tool results verbatim when microcompacting.
const DEFAULT_MICROCOMPACT_COLD_MS = 300_000;
const DEFAULT_KEEP_RECENT_TOOL_RESULTS = 3;
// M4.4 (L4) — collapse triggers above the cascade (90% vs the 75% soft limit)
// and keeps a slightly larger recent window in the reversible view.
const DEFAULT_COLLAPSE_SOFT_LIMIT_RATIO = 0.9;
const DEFAULT_COLLAPSE_RECENT_WINDOW = 8;
// M4.5 (L5) — open the auto-compact circuit after 3 consecutive failures; carry
// up to 5 recently touched files into the post-compact recovery note.
const DEFAULT_MAX_L5_FAILURES = 3;
const POST_COMPACT_RECOVERY_MAX_FILES = 5;
const DEFAULT_FINAL_RESPONSE_PROMPT =
  "You are at the final allowed agent turn. Do not call any tools. Provide the best concise final answer from the information already gathered. If something remains unverified, say so briefly instead of continuing to search.";
const DEFAULT_RETRY_LIMITS: Record<RecoverableModelErrorKind, number> = {
  prompt_too_long: 1,
  max_output: 1,
  stream_error: 1
};

export type RecoverableModelErrorKind = Extract<
  ModelErrorKind,
  "prompt_too_long" | "max_output" | "stream_error"
>;

export async function* query(options: QueryOptions): AsyncIterable<LoopEvent> {
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  const messages: Message[] = [...options.initialMessages];
  const toolsByName = new Map(options.tools.map((tool) => [tool.name, tool]));
  const modelTools = options.tools.map(toModelToolDefinition);
  const retryCounts: Record<RecoverableModelErrorKind, number> = {
    prompt_too_long: 0,
    max_output: 0,
    stream_error: 0
  };
  const retryLimits: Record<RecoverableModelErrorKind, number> = {
    ...DEFAULT_RETRY_LIMITS,
    ...options.retryLimits
  };
  const modelName = options.modelName ?? DEFAULT_MODEL;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const contextBudgetTokens = options.contextBudgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS;
  const proactiveSoftLimitRatio = options.proactiveCompactionSoftLimitRatio ?? 0.75;
  const proactiveTargetRatio = options.proactiveCompactionTargetRatio ?? 0.5;
  const proactiveSoftLimit = Math.floor(contextBudgetTokens * proactiveSoftLimitRatio);
  const proactiveTarget = Math.floor(contextBudgetTokens * proactiveTargetRatio);
  // M3.5 — Definition-of-Done chain shares ONE bounce budget across gates so a
  // task that flaps between gates can't loop forever. The budget is the max of
  // any configured gate's maxBounces (default 2); with only verify configured
  // this equals the old verify.maxBounces, preserving M3.3 behavior exactly.
  const maxDoneBounces = Math.max(
    options.verify ? options.verify.maxBounces ?? 2 : 0,
    options.critic ? options.critic.maxBounces ?? 2 : 0
  );
  let gateBounces = 0;
  // M4.0 — usage anchor for the compaction trigger: the exact server-side
  // prompt-token count of the last request + the strict-extension prefix length
  // it covered. A compaction invalidates it (the prefix is rewritten).
  let lastAnchor: UsageAnchor | undefined;
  // M4.3 — cache-warmth clock: elapsed time since the last model call decides
  // the microcompact path (cold rewrite vs hot defer).
  const now = options.now ?? (() => Date.now());
  const microcompactColdMs = options.microcompactColdMs ?? DEFAULT_MICROCOMPACT_COLD_MS;
  let lastModelCallAt: number | undefined;
  // M4.4 — context collapse: once the reversible-view mode is on it stays on
  // (sticky); the canonical `messages` is never mutated while collapsed.
  const collapseSoftLimit = Math.floor(
    contextBudgetTokens * (options.collapseSoftLimitRatio ?? DEFAULT_COLLAPSE_SOFT_LIMIT_RATIO)
  );
  let collapseActive = false;
  // M4.5 — L5 circuit breaker + post-compact recovery state.
  const maxL5Failures = options.maxL5Failures ?? DEFAULT_MAX_L5_FAILURES;
  let l5Failures = 0;
  let l5Disabled = false;
  let recentFiles: string[] = [];
  const toolContext: ToolContext = {
    ...options.toolContext,
    permissionMode: options.permissionMode ?? options.toolContext.permissionMode,
    abortSignal: options.abortSignal ?? options.toolContext.abortSignal,
    model: options.toolContext.model ?? options.model,
    modelName: options.toolContext.modelName ?? modelName,
    maxTokens: options.toolContext.maxTokens ?? maxTokens,
    system: options.toolContext.system ?? options.system,
    tools: options.toolContext.tools ?? options.tools,
    profile: options.toolContext.profile ?? options.profile
  };

  // M3.5 — assemble the Definition-of-Done gate chain. Order matters: the cheap
  // deterministic structural verify runs first (fail-fast on a non-compiling
  // answer), the expensive semantic critic second.
  const doneGates: DoneGate[] = [];
  if (options.verify && (options.verify.when ?? "on_terminal") === "on_terminal") {
    doneGates.push(createVerifyGate(options.verify, toolContext));
  }
  if (options.critic) {
    doneGates.push(
      createCriticGate(options.critic, options.model, modelName, maxTokens)
    );
  }

  if (options.abortSignal?.aborted) {
    yield {
      type: "terminal_state",
      state: { status: "aborted", reason: "aborted before query start" }
    };
    return;
  }

  try {
    for (let turn = 0; turn < maxTurns; turn += 1) {
      const shouldForceFinalResponse = Boolean(options.finalizeBeforeMaxTurns && turn === maxTurns - 1);
      // M4.4 — when collapsed, SEND the reversible view; the canonical
      // `messages` stays intact (never spliced over while collapsed).
      const baseMessages = collapseActive
        ? collapseMessagesView(messages, { recentWindowMessages: DEFAULT_COLLAPSE_RECENT_WINDOW })
        : messages;
      const requestMessages = shouldForceFinalResponse
        ? [
            ...baseMessages,
            {
              role: "user",
              content: options.finalResponsePrompt ?? DEFAULT_FINAL_RESPONSE_PROMPT
            } satisfies Message
          ]
        : baseMessages;
      const requestTools = shouldForceFinalResponse ? [] : modelTools;
      if (shouldForceFinalResponse) {
        options.profile?.mark("query.final_response_turn", { maxTurns });
      }

      if (options.abortSignal?.aborted) {
        yield {
          type: "terminal_state",
          state: { status: "aborted", reason: "abort signal received" }
        };
        return;
      }

      const retryResult = await collectModelTurnWithRetry({
        model: options.model,
        messages: requestMessages,
        modelName,
        maxTokens,
        system: options.system,
        signal: options.abortSignal,
        tools: requestTools,
        cacheConversation: true,
        contextBudgetTokens: options.contextBudgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS,
        retryCounts,
        retryLimits,
        profile: options.profile
      });
      // M4.4 — in collapse mode the sent request is the VIEW, not the canonical
      // history; never splice it back (that would destroy the canonical
      // messages and the reversibility). When not collapsed this is the normal
      // retry-compaction write-back.
      if (!collapseActive) {
        messages.splice(0, messages.length, ...retryResult.messages);
      }

      // M4.0 — re-anchor the budget on the request we just sent: `usage` gives
      // its EXACT prompt-token count, and `messages.length` (post-retry-splice,
      // pre-response-push) is the prefix that count covers. (Skipped while
      // collapsed: the anchor indexes canonical messages, but the view was sent;
      // collapse is sticky so the anchor is not consulted then anyway.)
      const sentMessageCount = messages.length;
      lastModelCallAt = now();
      const turnUsage = retryResult.turn.usage;
      if (turnUsage) {
        lastAnchor = {
          promptTokens:
            (turnUsage.inputTokens ?? 0) +
            (turnUsage.cacheReadInputTokens ?? 0) +
            (turnUsage.cacheCreationInputTokens ?? 0),
          messageCount: sentMessageCount
        };
      }

      const responseMessage = retryResult.turn.message;
      messages.push(responseMessage);
      yield {
        type: "assistant_message",
        message: responseMessage,
        usage: retryResult.turn.usage,
        stopReason: retryResult.turn.stopReason,
        requestId: retryResult.turn.requestId
      };

      const toolUses = extractToolUses(responseMessage);
      // M4.5 — remember files touched by Read/Edit/Write so the post-compact
      // recovery note can remind the model what it was working on.
      recentFiles = trackRecentFiles(recentFiles, toolUses, POST_COMPACT_RECOVERY_MAX_FILES);
      if (toolUses.length === 0) {
        // M3.5 — Definition-of-Done gate chain. The model stopping tool calls
        // is "I think I'm done", a natural gate, not "done". Each configured
        // gate must pass; the first that fails injects a reflective user turn
        // and the loop continues (edit -> test/critique -> fix), bounded by a
        // shared bounce budget. With no gates this is the plain completion.
        if (doneGates.length > 0) {
          let gateFailed = false;
          for (const gate of doneGates) {
            const check = await gate.check({ messages, turn, bounce: gateBounces });
            yield check.event;
            if (check.passed) {
              continue;
            }
            // Fail-fast: a gate rejected. Give up if the budget is spent or we
            // are on the last allowed turn; otherwise inject and revise.
            gateFailed = true;
            if (gateBounces >= maxDoneBounces || turn >= maxTurns - 1) {
              yield {
                type: "terminal_state",
                state: {
                  status: "verification_failed",
                  reason: check.terminalReason,
                  error: check.terminalError
                }
              };
              return;
            }
            gateBounces += 1;
            options.profile?.mark(check.profileMark, check.profileData);
            messages.push({ role: "user", content: check.reflection });
            break;
          }
          if (gateFailed) {
            continue;
          }
        }

        yield {
          type: "terminal_state",
          state: { status: "completed" }
        };
        return;
      }

      if (shouldForceFinalResponse) {
        options.profile?.mark("query.final_response_requested_tools", {
          maxTurns,
          toolUseCount: toolUses.length
        });
        yield {
          type: "terminal_state",
          state: {
            status: "max_turns",
            reason: `query turn limit ${maxTurns} reached; final response still requested tools`
          }
        };
        return;
      }

      const results: ToolResult[] = [];
      const turnToolContext: ToolContext = {
        ...toolContext,
        parentMessages: [...retryResult.messages],
        system: options.system,
        model: options.model,
        modelName,
        maxTokens,
        tools: options.tools,
        profile: options.profile
      };
      const batches = partitionToolCalls(toolUses, toolsByName, turnToolContext);
      for (const batch of batches) {
        for (const toolUse of batch.toolUses) {
          yield {
            type: "tool_use",
            toolUse
          };
        }

        const batchResults = await executeToolBatch({
          batch,
          toolsByName,
          context: turnToolContext,
          maxConcurrency: options.maxToolConcurrency
        });
        results.push(...batchResults);

        for (const result of batchResults) {
          yield {
            type: "tool_result",
            result
          };
        }

        if (options.abortSignal?.aborted) {
          yield {
            type: "terminal_state",
            state: { status: "aborted", reason: "abort signal received" }
          };
          return;
        }
      }

      messages.push({
        role: "tool",
        content: results.map((result) => ({ type: "tool_result", result }))
      });

      // M4.0 — pre-flight compaction cascade at the turn boundary. The trigger
      // hangs on the usage ANCHOR (exact prefix + estimated delta), not a raw
      // chars/4 guess. When over the soft limit, runCompactionPipeline runs its
      // stages cheapest-first and short-circuits at the target. (Layers L1-L5
      // land in M4.1-M4.5; the M4.0 spine keeps the existing single stage —
      // semantic when a summarizer is injected, else tiered — so this is a
      // structural refactor with zero behavior change.)
      const anchoredTokens = estimateAnchoredTokens(messages, lastAnchor);
      if (options.contextCollapse && (collapseActive || anchoredTokens >= collapseSoftLimit)) {
        // M4.4 (L4) — context collapse takes precedence over the destructive
        // cascade and SUPPRESSES it (incl. the L5 semantic recap): switch to the
        // reversible view (sent at assembly), keeping canonical messages intact.
        if (!collapseActive) {
          collapseActive = true;
          const beforeTokens = estimateMessagesTokens(messages);
          const afterTokens = estimateMessagesTokens(
            collapseMessagesView(messages, { recentWindowMessages: DEFAULT_COLLAPSE_RECENT_WINDOW })
          );
          options.profile?.mark("query.collapse_active", { turn, beforeTokens, afterTokens });
          yield { type: "compaction", reason: "collapse", beforeTokens, afterTokens, turn };
        }
      } else if (proactiveSoftLimitRatio > 0 && anchoredTokens > proactiveSoftLimit) {
          const beforeTokens = estimateMessagesTokens(messages);
          // M4.1 (L1) — the cheapest stage: spill any oversized, not-yet-spilled
          // tool_result to disk and keep only a head+tail preview (non-destructive,
          // Read restores). Runs first; if it frees enough the deeper layers are
          // short-circuited.
          const spillStage = createSpillStage({
            artifactDir: toolContext.artifactDir,
            thresholdChars: toolContext.toolResultBudgetChars ?? DEFAULT_SPILL_THRESHOLD_CHARS,
            previewChars: toolContext.toolResultPreviewChars ?? DEFAULT_SPILL_PREVIEW_CHARS
          });
          // M4.2 (L2) — drop stale tool scaffolding (snip stale tool_result
          // content). Cheaper than the reclaim stage; leaves prose for L5.
          const snipStage: CompactionStage = {
            name: "snip",
            run: (msgs) => snipStaleToolScaffolding(msgs)
          };
          // M4.3 (L3) — microcompact, cache-state-driven. COLD (TTL elapsed
          // since the last call, so the prefix is already gone): clear all but
          // the newest N tool results — free. HOT (prefix still warm): defer,
          // to avoid wasting the warm cache (no cache_edits available through
          // the gateway; see docs/v4-compaction-pipeline-roadmap.md M4.3). Both
          // paths make zero extra API calls.
          const cacheWarmth: "cold" | "hot" =
            lastModelCallAt !== undefined && now() - lastModelCallAt > microcompactColdMs ? "cold" : "hot";
          const microcompactStage: CompactionStage = {
            name: "microcompact",
            run: (msgs) =>
              cacheWarmth === "cold"
                ? microcompactToolResults(msgs, { keepRecentToolResults: DEFAULT_KEEP_RECENT_TOOL_RESULTS })
                : msgs
          };
          // M4.5 (L5) — the semantic auto-compact, guarded by a circuit breaker:
          // a summarizer failure does NOT crash the run; it is caught, counted,
          // and falls back to deterministic compaction for that turn. After
          // `maxL5Failures` consecutive failures the L5 path is disabled for the
          // rest of the run (a flapping summarizer can never spin forever — the
          // ~250K-call-a-day class of incident).
          const reclaimStage: CompactionStage =
            options.compactionSummarizer && !l5Disabled
              ? {
                  name: "auto_compact",
                  run: async (msgs) => {
                    try {
                      const out = await compactMessagesWithSummary(msgs, {
                        targetTokens: proactiveTarget,
                        summarizer: options.compactionSummarizer!
                      });
                      l5Failures = 0;
                      return out;
                    } catch (error) {
                      l5Failures += 1;
                      options.profile?.mark("query.l5_failure", {
                        turn,
                        failures: l5Failures,
                        error: error instanceof Error ? error.message : String(error)
                      });
                      if (l5Failures >= maxL5Failures) {
                        l5Disabled = true;
                        options.profile?.mark("query.l5_circuit_open", { turn });
                      }
                      return compactMessagesTiered(msgs, { targetTokens: proactiveTarget });
                    }
                  }
                }
              : {
                  name: "tiered",
                  run: (msgs) => compactMessagesTiered(msgs, { targetTokens: proactiveTarget })
                };
          const stages: CompactionStage[] = [spillStage, snipStage, microcompactStage, reclaimStage];
          if (cacheWarmth === "cold") {
            options.profile?.mark("query.microcompact_cold", { turn });
          }
          const result = await runCompactionPipeline(messages, {
            stages,
            isUnderTarget: (msgs) => estimateMessagesTokens(msgs) <= proactiveTarget
          });
          const afterTokens = estimateMessagesTokens(result.messages);
          if (afterTokens < beforeTokens) {
            messages.splice(0, messages.length, ...result.messages);
            // A compaction is the one event that invalidates the rolling
            // message-prefix cache (M3.1a) AND the usage anchor (M4.0): the
            // prefix is rewritten, so the next turn must re-anchor from scratch.
            lastAnchor = undefined;
            options.profile?.mark("query.cache_prefix_reset", {
              turn,
              beforeTokens,
              afterTokens,
              reason: options.compactionSummarizer
                ? "proactive_compaction_semantic"
                : "proactive_compaction"
            });
            yield {
              type: "compaction",
              reason: "proactive",
              beforeTokens,
              afterTokens,
              turn
            };
            // M4.5 (L5) — post-compact recovery. The semantic recap REPLACES the
            // stale region, so the model can forget which files it just touched.
            // Re-inject a recent-files note (append-only, cache-friendly) only
            // when the auto_compact stage actually ran (the deterministic layers
            // keep re-readable pointers, so they need no recovery).
            if (result.ranStages.includes("auto_compact") && recentFiles.length > 0) {
              options.profile?.mark("query.post_compact_recovery", {
                turn,
                fileCount: recentFiles.length,
                latest: recentFiles[recentFiles.length - 1]
              });
              messages.push({
                role: "user",
                content: formatPostCompactRecovery(recentFiles)
              });
            }
          }
      }

      // M3.4 — turn-boundary task inbox. Drain this-run background tasks that
      // have reached a terminal state into a synthetic observation message, so
      // the model is told (push) instead of having to poll. Append-only, so the
      // cached prefix below the injection point survives (gentler than §1
      // compaction's rewrite).
      if (options.drainBackgroundTasks && toolContext.taskStore && toolContext.startedBackgroundTaskIds) {
        const drained = await drainBackgroundTasks(
          toolContext.taskStore,
          toolContext.startedBackgroundTaskIds
        );
        if (drained.length > 0) {
          messages.push({
            role: "user",
            content: formatBackgroundTaskInbox(drained)
          });
          yield {
            type: "background_tasks",
            drained: drained.map((d) => ({ id: d.task.id, state: d.task.state, description: d.task.description })),
            turn
          };
        }
      }
    }

    yield {
      type: "terminal_state",
      state: { status: "max_turns", reason: `query turn limit ${maxTurns} reached` }
    };
  } catch (error) {
    yield {
      type: "terminal_state",
      state: {
        status: "error",
        error: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

export async function collectQuery(options: QueryOptions): Promise<LoopEvent[]> {
  const events: LoopEvent[] = [];
  for await (const event of query(options)) {
    events.push(event);
  }
  return events;
}

export function extractToolUses(message: Message): ToolUse[] {
  if (typeof message.content === "string") {
    return [];
  }

  return message.content
    .filter((block) => block.type === "tool_use")
    .map((block) => block.toolUse);
}

export type CollectedModelTurn = {
  message: Message;
  usage?: ModelUsage;
  stopReason?: string | null;
  requestId?: string;
};

export async function collectModelTurn(events: AsyncIterable<ModelStreamEvent>): Promise<Message> {
  return (await collectModelTurnWithMetadata(events)).message;
}

function combineVerifyOutput(stdout: string, stderr: string): string {
  return [stdout.trim(), stderr.trim()].filter((part) => part.length > 0).join("\n").trim();
}

const BACKGROUND_TASK_OUTPUT_TAIL_CHARS = 1_200;

type DrainedTask = { task: TaskRecord; outputTail: string };

/**
 * Drains the run's own background tasks that have reached a terminal state and
 * haven't been reported yet. Scoped strictly to `startedIds` (this-run tasks),
 * and deduped via the store's `notifiedAt` marking so each task is surfaced
 * exactly once. Returns each drained task with a bounded tail of its output.
 */
async function drainBackgroundTasks(
  store: TaskStore,
  startedIds: ReadonlySet<string>
): Promise<DrainedTask[]> {
  const drained: DrainedTask[] = [];
  for (const id of startedIds) {
    let record: TaskRecord;
    try {
      record = await store.load(id);
    } catch {
      continue; // task record vanished — skip
    }
    if (!isTerminalTaskState(record.state) || record.notifiedAt) {
      continue;
    }
    const marked = await store.patch(id, (current) => ({ ...current, notifiedAt: nowIsoLocal() }));
    const output = await store.readOutput(id, { maxBytes: BACKGROUND_TASK_OUTPUT_TAIL_CHARS }).catch(() => ({
      content: ""
    }));
    drained.push({ task: marked, outputTail: tailString(output.content, BACKGROUND_TASK_OUTPUT_TAIL_CHARS) });
  }
  return drained;
}

function formatBackgroundTaskInbox(drained: readonly DrainedTask[]): string {
  const lines = ["[background tasks finished — results below]"];
  for (const { task, outputTail } of drained) {
    lines.push("", `- ${task.id} (${task.description}): ${task.state}`);
    if (outputTail.trim().length > 0) {
      lines.push("  output:", outputTail.trim());
    }
  }
  return lines.join("\n");
}

function tailString(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `[...${value.length - maxChars} earlier chars omitted]\n${value.slice(-maxChars)}`;
}

function nowIsoLocal(): string {
  return new Date().toISOString();
}

/**
 * Builds the reflective user turn injected when a verification command fails.
 * Phrased to point the model at locating + fixing the failure (not a raw dump)
 * and to signal that another verify pass will follow.
 */
function reflectiveVerifyFailure(
  command: string,
  exitCode: number | null,
  stdout: string,
  stderr: string
): string {
  const output = combineVerifyOutput(stdout, stderr) || "(no output captured)";
  return [
    `Verification failed: \`${command}\` exited with code ${exitCode ?? "null"}.`,
    "",
    "Output:",
    output,
    "",
    "Locate the cause and fix it. I will re-run the same verification after your next changes."
  ].join("\n");
}

/**
 * M4.1 (L1) — the cheapest compaction stage: spill oversized, not-yet-spilled
 * `tool_result` blocks to disk and keep only a head+tail preview + pointer
 * (non-destructive; `Read` restores). Skips results already backed by an
 * artifact (their preview is already small) and those under the threshold.
 * When no `artifactDir` is available it clips head+tail inline (lossy, rare).
 */
/**
 * M4.5 — track the most-recently touched files (Read/Edit/Write) for the
 * post-compact recovery note, most-recent last, deduped, capped at `maxFiles`.
 */
function trackRecentFiles(
  current: readonly string[],
  toolUses: readonly ToolUse[],
  maxFiles: number
): string[] {
  const result = [...current];
  for (const toolUse of toolUses) {
    if (
      (toolUse.name === "Read" || toolUse.name === "Edit" || toolUse.name === "Write") &&
      typeof toolUse.input.path === "string" &&
      toolUse.input.path.length > 0
    ) {
      const path = toolUse.input.path;
      const existing = result.indexOf(path);
      if (existing !== -1) {
        result.splice(existing, 1);
      }
      result.push(path);
    }
  }
  return result.slice(-maxFiles);
}

/** M4.5 — the post-compact recovery note re-injected after a semantic auto-compact. */
export function formatPostCompactRecovery(files: readonly string[]): string {
  return [
    `[post-compact recovery] Recently touched files (still on disk): ${files.join(", ")}.`,
    "Their full contents were summarized out of the context above — re-read any you still need with the Read tool before relying on them."
  ].join("\n");
}

export function createSpillStage(opts: {
  artifactDir?: string;
  thresholdChars: number;
  previewChars: number;
}): CompactionStage {
  const keep = Math.min(opts.previewChars, opts.thresholdChars);
  return {
    name: "spill",
    async run(messages) {
      const out: Message[] = [];
      for (const message of messages) {
        if (!Array.isArray(message.content)) {
          out.push(message);
          continue;
        }
        let changed = false;
        const blocks: typeof message.content = [];
        for (const block of message.content) {
          if (
            block.type === "tool_result" &&
            !block.result.artifactPath &&
            block.result.content.length > opts.thresholdChars
          ) {
            changed = true;
            const preview = smartPreview(block.result.content, keep);
            if (opts.artifactDir) {
              const artifactPath = await writeToolResultArtifact(
                opts.artifactDir,
                block.result.toolUseId,
                block.result.content
              );
              blocks.push({
                ...block,
                result: {
                  ...block.result,
                  artifactPath,
                  content: `${preview}\n[spilled ${block.result.content.length} chars -> ${artifactPath}; use Read to restore]`
                }
              });
            } else {
              blocks.push({
                ...block,
                result: {
                  ...block.result,
                  content: `${preview}\n[clipped ${block.result.content.length} chars]`
                }
              });
            }
          } else {
            blocks.push(block);
          }
        }
        out.push(changed ? { ...message, content: blocks } : message);
      }
      return out;
    }
  };
}

/**
 * Gate 1 of the Definition-of-Done chain: structural verification. Runs the
 * configured command via the executor seam (NOT the whitelisted Bash tool) and
 * passes on exit 0. This is the M3.3 behavior, now packaged as a `DoneGate`.
 */
function createVerifyGate(verify: VerifyConfig, toolContext: ToolContext): DoneGate {
  const args = verify.args ?? [];
  const displayCommand = [verify.command, ...args].join(" ").trim();
  return {
    name: "verify",
    async check({ turn, bounce }) {
      const executor = toolContext.executor ?? createSpawnExecutor();
      const result = await executor
        .run({
          command: verify.command,
          args,
          cwd: toolContext.cwd,
          timeoutMs: 120_000,
          outputSink: { kind: "capture", maxBytes: 4_000 }
        })
        .catch((error: unknown) => ({
          exitCode: null as number | null,
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          timedOut: false
        }));
      const passed = result.exitCode === 0;
      return {
        event: {
          type: "verification",
          passed,
          exitCode: result.exitCode,
          command: displayCommand,
          bounce,
          turn
        },
        passed,
        reflection: reflectiveVerifyFailure(displayCommand, result.exitCode, result.stdout, result.stderr),
        profileMark: "query.verify_bounce",
        profileData: { turn, bounce: bounce + 1, exitCode: result.exitCode },
        terminalReason: `verification command "${displayCommand}" failed after ${bounce} fix attempt(s)`,
        terminalError: combineVerifyOutput(result.stdout, result.stderr)
      };
    }
  };
}

/**
 * Gate 2 of the Definition-of-Done chain: the Finalize Critic. A read-only
 * model call (no tools given -> read-only by construction; core cannot import
 * the Agent tool, so this tool-less call is the layer-safe realization of the
 * "read-only verifier" idea) that judges whether the final answer satisfies the
 * root task. It runs in its own child context (a single synthesized message),
 * so it does not pollute the parent prefix until the reflective turn is
 * appended on rejection.
 */
function createCriticGate(
  critic: CriticConfig,
  fallbackModel: ModelClient,
  fallbackModelName: string,
  _fallbackMaxTokens: number
): DoneGate {
  return {
    name: "critic",
    async check({ messages, turn, bounce }) {
      const verdict = await runCritic({
        model: critic.model ?? fallbackModel,
        modelName: critic.modelName ?? fallbackModelName,
        maxTokens: critic.maxTokens ?? 512,
        task: firstUserText(messages),
        answer: lastAssistantText(messages),
        instructions: critic.instructions
      });
      return {
        event: {
          type: "critic",
          passed: verdict.approved,
          reason: verdict.reason,
          bounce,
          turn
        },
        passed: verdict.approved,
        reflection: reflectiveCriticRejection(verdict.reason),
        profileMark: "query.critic_bounce",
        profileData: { turn, bounce: bounce + 1 },
        terminalReason: `finalize critic rejected the answer after ${bounce} revision(s): ${verdict.reason}`,
        terminalError: verdict.reason
      };
    }
  };
}

type RunCriticOptions = {
  model: ModelClient;
  modelName: string;
  maxTokens: number;
  task: string;
  answer: string;
  instructions?: string;
};

async function runCritic(options: RunCriticOptions): Promise<{ approved: boolean; reason: string }> {
  const system = options.instructions
    ? `${CRITIC_SYSTEM_PROMPT}\n\nAdditional review criteria:\n${options.instructions}`
    : CRITIC_SYSTEM_PROMPT;
  const userContent = [
    "Task given to the assistant:",
    options.task || "(no task captured)",
    "",
    "The assistant's final answer:",
    options.answer || "(empty answer)",
    "",
    "Does the final answer correctly and completely satisfy the task?",
    "Reply with exactly `APPROVE`, or `REJECT: <one-line reason>`."
  ].join("\n");
  const message = await collectModelTurn(
    options.model.stream({
      messages: [{ role: "user", content: userContent }],
      model: options.modelName,
      maxTokens: options.maxTokens,
      system,
      tools: []
    })
  );
  return parseCriticVerdict(messageContentToText(message.content));
}

/**
 * Parses the critic's verdict. A clear `REJECT` (anywhere) fails the gate; the
 * one-line reason is the rest of that line. Anything else is treated as
 * approval — the shared bounce budget caps the loop, so failing toward approval
 * on an ambiguous verdict avoids wasting revisions on a confused critic.
 */
function parseCriticVerdict(text: string): { approved: boolean; reason: string } {
  const trimmed = text.trim();
  const rejectMatch = /\bREJECT\b\s*:?\s*(.*)/i.exec(trimmed);
  if (rejectMatch) {
    return { approved: false, reason: rejectMatch[1].trim() || "no reason given" };
  }
  return { approved: true, reason: trimmed.split("\n", 1)[0]?.trim() || "approved" };
}

function reflectiveCriticRejection(reason: string): string {
  return [
    `A review of your final answer did not pass: ${reason || "the answer does not fully satisfy the task."}`,
    "",
    "Address the issue and produce a corrected final answer. I will review it again."
  ].join("\n");
}

function firstUserText(messages: readonly Message[]): string {
  const first = messages.find((message) => message.role === "user");
  return first ? messageContentToText(first.content) : "";
}

function lastAssistantText(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "assistant") {
      return messageContentToText(messages[i].content);
    }
  }
  return "";
}

const COMPACTION_SUMMARY_PROMPT =
  "You are compacting a long agent transcript to fit a context budget. Summarize the earlier " +
  "turns below into a concise recap that preserves: the goal, key decisions, files/commands " +
  "touched, important findings, and anything still needed to continue the task. Be factual and " +
  "dense; omit pleasantries and do not invent details.";

/**
 * M3.2c — builds a model-backed {@link MessageSummarizer} for semantic
 * compaction. The CLI's `--semantic-compaction` flag wires this to the agent's
 * own model client, so no extra credentials are needed. Kept in core so the
 * model-call shape lives next to the loop that consumes it.
 */
export function createModelCompactionSummarizer(
  model: ModelClient,
  modelName: string,
  options: { maxTokens?: number } = {}
): MessageSummarizer {
  const maxTokens = options.maxTokens ?? 1024;
  return async (dropped) => {
    const transcript = dropped
      .map((message) => `${message.role.toUpperCase()}: ${messageContentToText(message.content)}`)
      .join("\n\n");
    const message = await collectModelTurn(
      model.stream({
        messages: [{ role: "user", content: `${COMPACTION_SUMMARY_PROMPT}\n\n---\n${transcript}` }],
        model: modelName,
        maxTokens,
        tools: []
      })
    );
    return messageContentToText(message.content).trim();
  };
}

type CollectModelTurnWithRetryOptions = {
  model: ModelClient;
  messages: readonly Message[];
  modelName: string;
  maxTokens: number;
  system?: string | readonly SystemTextBlock[];
  signal?: AbortSignal;
  tools: readonly ModelToolDefinition[];
  cacheConversation?: boolean;
  contextBudgetTokens: number;
  retryCounts: Record<RecoverableModelErrorKind, number>;
  retryLimits: Record<RecoverableModelErrorKind, number>;
  profile?: ProfileRecorder;
};

async function collectModelTurnWithRetry(
  options: CollectModelTurnWithRetryOptions
): Promise<{ turn: CollectedModelTurn; messages: Message[] }> {
  let messages = [...options.messages];

  while (true) {
    try {
      const stream = options.model.stream({
        messages,
        model: options.modelName,
        maxTokens: options.maxTokens,
        system: options.system,
        signal: options.signal,
        tools: options.tools,
        cacheConversation: options.cacheConversation
      });
      const turn = options.profile
        ? await options.profile.time("model.turn", () => collectModelTurnWithMetadata(stream, options.profile), {
            model: options.modelName,
            maxTokens: options.maxTokens
          })
        : await collectModelTurnWithMetadata(stream);

      if (isMaxOutputTurn(turn) && canRetry("max_output", options.retryCounts, options.retryLimits)) {
        options.retryCounts.max_output += 1;
        messages = compactForRetry(messages, options.contextBudgetTokens);
        continue;
      }

      if (isMaxOutputTurn(turn)) {
        throw new ModelError("max_output", "Model stopped because max output limit was reached");
      }

      return { turn, messages };
    } catch (error) {
      const kind = recoverableModelErrorKind(error);
      if (!kind || !canRetry(kind, options.retryCounts, options.retryLimits)) {
        throw error;
      }

      options.retryCounts[kind] += 1;
      messages = kind === "stream_error" ? messages : compactForRetry(messages, options.contextBudgetTokens);
    }
  }
}

function compactForRetry(messages: readonly Message[], contextBudgetTokens: number): Message[] {
  const estimatedTokens = estimateMessagesTokens(messages);
  const targetTokens =
    estimatedTokens > contextBudgetTokens
      ? Math.max(1_000, Math.floor(contextBudgetTokens * 0.7))
      : Math.max(1_000, Math.floor(estimatedTokens * 0.7));
  return compactMessages(messages, { targetTokens });
}

function isMaxOutputTurn(turn: CollectedModelTurn): boolean {
  return turn.stopReason === "max_tokens" || turn.stopReason === "max_output";
}

function recoverableModelErrorKind(error: unknown): RecoverableModelErrorKind | null {
  if (!(error instanceof ModelError)) {
    return null;
  }

  if (error.kind === "prompt_too_long" || error.kind === "max_output" || error.kind === "stream_error") {
    return error.kind;
  }

  return null;
}

function canRetry(
  kind: RecoverableModelErrorKind,
  retryCounts: Readonly<Record<RecoverableModelErrorKind, number>>,
  retryLimits: Readonly<Record<RecoverableModelErrorKind, number>>
): boolean {
  return retryCounts[kind] < retryLimits[kind];
}

async function collectModelTurnWithMetadata(
  events: AsyncIterable<ModelStreamEvent>,
  profile?: ProfileRecorder
): Promise<CollectedModelTurn> {
  let text = "";
  let sawStreamDelta = false;
  let sawFirstEvent = false;
  let sawFirstTextDelta = false;
  let fallbackContent: MessageContent | undefined;
  let usage: ModelUsage | undefined;
  let stopReason: string | null | undefined;
  let requestId: string | undefined;
  const toolUses: ToolUse[] = [];

  for await (const event of events) {
    if (!sawFirstEvent) {
      sawFirstEvent = true;
      profile?.mark("model.first_event", { eventType: event.type });
    }
    requestId = event.requestId ?? requestId;

    if (event.type === "text_delta") {
      if (!sawFirstTextDelta) {
        sawFirstTextDelta = true;
        profile?.mark("model.first_token");
      }
      sawStreamDelta = true;
      text += event.text;
      continue;
    }

    if (event.type === "tool_use") {
      toolUses.push(event.toolUse);
      continue;
    }

    usage = event.usage ?? usage;
    stopReason = event.stopReason ?? stopReason;
    if (!sawStreamDelta && toolUses.length === 0) {
      fallbackContent = event.message.content;
    }
  }

  if (!sawStreamDelta && toolUses.length === 0 && fallbackContent !== undefined) {
    return {
      message: {
        role: "assistant",
        content: fallbackContent
      },
      usage,
      stopReason,
      requestId
    };
  }

  const content: Exclude<MessageContent, string> = [];
  if (text.length > 0) {
    content.push({ type: "text", text });
  }
  for (const toolUse of toolUses) {
    content.push({ type: "tool_use", toolUse });
  }

  return {
    message: {
      role: "assistant",
      content: content.length === 1 && content[0]?.type === "text" ? content[0].text : content
    },
    usage,
    stopReason,
    requestId
  };
}

export function assistantText(message: Message): string {
  return messageContentToText(message.content);
}
