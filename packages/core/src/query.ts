import {
  compactMessages,
  compactMessagesTiered,
  estimateMessagesTokens
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
import { toModelToolDefinition } from "./tool.js";
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

const DEFAULT_MAX_TURNS = 10;
const DEFAULT_CONTEXT_BUDGET_TOKENS = 24_000;
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
  let verifyBounces = 0;
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
      const requestMessages = shouldForceFinalResponse
        ? [
            ...messages,
            {
              role: "user",
              content: options.finalResponsePrompt ?? DEFAULT_FINAL_RESPONSE_PROMPT
            } satisfies Message
          ]
        : messages;
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
      messages.splice(0, messages.length, ...retryResult.messages);

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
      if (toolUses.length === 0) {
        // M3.3 — structural verification gate. The model thinks it's done;
        // before completing, run the configured verify command. On failure,
        // inject the failure as a reflective user turn and keep looping
        // (edit -> test -> fix), bounded by maxBounces.
        if (options.verify && (options.verify.when ?? "on_terminal") === "on_terminal") {
          const maxBounces = options.verify.maxBounces ?? 2;
          const args = options.verify.args ?? [];
          const displayCommand = [options.verify.command, ...args].join(" ").trim();
          const executor = toolContext.executor ?? createSpawnExecutor();
          const result = await executor
            .run({
              command: options.verify.command,
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
          yield {
            type: "verification",
            passed,
            exitCode: result.exitCode,
            command: displayCommand,
            bounce: verifyBounces,
            turn
          };

          if (passed) {
            yield { type: "terminal_state", state: { status: "completed" } };
            return;
          }

          if (verifyBounces >= maxBounces || turn >= maxTurns - 1) {
            yield {
              type: "terminal_state",
              state: {
                status: "verification_failed",
                reason: `verification command "${displayCommand}" failed after ${verifyBounces} fix attempt(s)`,
                error: combineVerifyOutput(result.stdout, result.stderr)
              }
            };
            return;
          }

          verifyBounces += 1;
          options.profile?.mark("query.verify_bounce", {
            turn,
            bounce: verifyBounces,
            exitCode: result.exitCode
          });
          messages.push({
            role: "user",
            content: reflectiveVerifyFailure(displayCommand, result.exitCode, result.stdout, result.stderr)
          });
          continue;
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

      // M3.2b — proactive compaction at the turn boundary. Compacting here
      // (before the next request) avoids paying for an oversized request that
      // the API rejects, and lets us compact aggressively (down to the target
      // ratio) so this doesn't re-trigger next turn.
      if (proactiveSoftLimitRatio > 0) {
        const beforeTokens = estimateMessagesTokens(messages);
        if (beforeTokens > proactiveSoftLimit) {
          const compacted = compactMessagesTiered(messages, { targetTokens: proactiveTarget });
          const afterTokens = estimateMessagesTokens(compacted);
          if (afterTokens < beforeTokens) {
            messages.splice(0, messages.length, ...compacted);
            // M3.1c — within a single run, the ONLY event that invalidates the
            // rolling message-prefix cache (M3.1a) is a compaction: it rewrites
            // stale messages, so the next request's prefix diverges from the
            // cached one. A normal turn merely appends and keeps hitting the
            // cache. (Per-turn fork-trace would mislabel every appended turn as
            // a prefix miss, since fork.ts hashes the whole list — so we mark
            // only the real reset event here.)
            options.profile?.mark("query.cache_prefix_reset", {
              turn,
              beforeTokens,
              afterTokens,
              reason: "proactive_compaction"
            });
            yield {
              type: "compaction",
              reason: "proactive",
              beforeTokens,
              afterTokens,
              turn
            };
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
