import {
  compactMessages,
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
  type ModelUsage
} from "./model.js";
import { executeToolBatch, partitionToolCalls } from "./scheduler.js";
import { toModelToolDefinition } from "./tool.js";
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
  system?: string;
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

type CollectModelTurnWithRetryOptions = {
  model: ModelClient;
  messages: readonly Message[];
  modelName: string;
  maxTokens: number;
  system?: string;
  signal?: AbortSignal;
  tools: readonly ModelToolDefinition[];
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
        tools: options.tools
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
