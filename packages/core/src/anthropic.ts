import Anthropic from "@anthropic-ai/sdk";
import {
  APIConnectionTimeoutError,
  APIError,
  AuthenticationError,
  RateLimitError
} from "@anthropic-ai/sdk/error";

import {
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL,
  ModelError,
  messageContentToText,
  resolveRequestId,
  type ModelClient,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamEvent,
  type ModelUsage
} from "./model.js";
import type {
  Message,
  MessageContent,
  ModelToolDefinition,
  TextBlock,
  ToolResultBlock,
  ToolUse,
  ToolUseBlock
} from "./types.js";
import { withIdleWatchdog } from "./watchdog.js";

type AnthropicMessageParam = {
  role: "user" | "assistant";
  content: string | Array<Record<string, unknown>>;
};

type AnthropicClientLike = {
  messages: {
    create: (body: any, options?: any) => PromiseLike<unknown>;
  };
};

type AnthropicRequestOptions = {
  signal?: AbortSignal;
  timeout?: number;
};

export type AnthropicModelClientOptions = {
  apiKey?: string;
  baseURL?: string;
  client?: AnthropicClientLike;
  defaultModel?: string;
  defaultMaxTokens?: number;
  idleTimeoutMs?: number;
};

export type EnvironmentLike = {
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_BASE_URL?: string;
  MYAGENT_MODEL?: string;
};

export class AnthropicModelClient implements ModelClient {
  readonly #client: AnthropicClientLike;
  readonly #defaultModel: string;
  readonly #defaultMaxTokens: number;
  readonly #idleTimeoutMs: number;

  constructor(options: AnthropicModelClientOptions = {}) {
    if (!options.client && !options.apiKey) {
      throw new ModelError(
        "auth_error",
        "ANTHROPIC_API_KEY is required to use the Anthropic provider"
      );
    }

    this.#client =
      options.client ??
      new Anthropic({
        apiKey: options.apiKey,
        baseURL: normalizeAnthropicBaseURL(options.baseURL)
      });
    this.#defaultModel = options.defaultModel ?? DEFAULT_MODEL;
    this.#defaultMaxTokens = options.defaultMaxTokens ?? DEFAULT_MAX_TOKENS;
    this.#idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  async create(request: ModelRequest): Promise<ModelResponse> {
    const requestId = resolveRequestId(request);
    try {
      const message = await this.#client.messages.create(
        {
          model: request.model ?? this.#defaultModel,
          max_tokens: request.maxTokens ?? this.#defaultMaxTokens,
          system: request.system,
          messages: toAnthropicMessages(request.messages),
          ...toAnthropicTools(request.tools)
        },
        toAnthropicRequestOptions(request.signal, request.timeoutMs)
      );

      return toModelResponse(message, requestId);
    } catch (error) {
      throw classifyAnthropicError(error, requestId);
    }
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const requestId = resolveRequestId(request);
    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    request.signal?.addEventListener("abort", forwardAbort, { once: true });

    try {
      yield* withIdleWatchdog(this.#streamWithoutWatchdog(request, requestId, controller.signal), {
        idleMs: request.timeoutMs ?? this.#idleTimeoutMs,
        requestId,
        onTimeout: () => controller.abort()
      });
    } catch (error) {
      throw classifyAnthropicError(error, requestId);
    } finally {
      request.signal?.removeEventListener("abort", forwardAbort);
    }
  }

  async *#streamWithoutWatchdog(
    request: ModelRequest,
    requestId: string,
    signal: AbortSignal
  ): AsyncIterable<ModelStreamEvent> {
    const stream = await this.#client.messages.create(
      {
        model: request.model ?? this.#defaultModel,
        max_tokens: request.maxTokens ?? this.#defaultMaxTokens,
        system: request.system,
        messages: toAnthropicMessages(request.messages),
        ...toAnthropicTools(request.tools),
        stream: true
      },
      toAnthropicRequestOptions(signal, request.timeoutMs)
    );

    let text = "";
    let usage: ModelUsage | undefined;
    let stopReason: string | null | undefined;
    const toolInputByIndex = new Map<
      number,
      { id: string; name: string; inputFromStart?: Record<string, unknown>; partialJson: string }
    >();

    for await (const event of stream as AsyncIterable<unknown>) {
      const typed = event as {
        type?: string;
        index?: number;
        content_block?: { type?: string; id?: string; name?: string; input?: unknown };
        delta?: {
          type?: string;
          text?: string;
          stop_reason?: string | null;
          partial_json?: string;
        };
        message?: { usage?: { input_tokens?: number; output_tokens?: number } };
        usage?: { output_tokens?: number };
      };

      if (typed.type === "message_start") {
        usage = toModelUsage(typed.message?.usage);
      }

      if (
        typed.type === "content_block_start" &&
        typed.content_block?.type === "tool_use" &&
        typed.content_block.id &&
        typed.content_block.name &&
        typeof typed.index === "number"
      ) {
        toolInputByIndex.set(typed.index, {
          id: typed.content_block.id,
          name: typed.content_block.name,
          inputFromStart: isRecord(typed.content_block.input) ? typed.content_block.input : undefined,
          partialJson: ""
        });
      }

      if (typed.type === "content_block_delta" && typed.delta?.type === "text_delta") {
        const delta = typed.delta.text ?? "";
        if (delta.length > 0) {
          text += delta;
          yield {
            type: "text_delta",
            text: delta,
            requestId
          };
        }
      }

      if (
        typed.type === "content_block_delta" &&
        typed.delta?.type === "input_json_delta" &&
        typeof typed.index === "number"
      ) {
        const pending = toolInputByIndex.get(typed.index);
        if (pending) {
          pending.partialJson += typed.delta.partial_json ?? "";
        }
      }

      if (typed.type === "content_block_stop" && typeof typed.index === "number") {
        const pending = toolInputByIndex.get(typed.index);
        if (pending) {
          yield {
            type: "tool_use",
            toolUse: {
              id: pending.id,
              name: pending.name,
              input: parseToolInput(pending.partialJson, pending.inputFromStart)
            },
            requestId
          };
          toolInputByIndex.delete(typed.index);
        }
      }

      if (typed.type === "message_delta") {
        stopReason = typed.delta?.stop_reason;
        usage = {
          ...usage,
          outputTokens: typed.usage?.output_tokens ?? usage?.outputTokens
        };
      }
    }

    yield {
      type: "assistant_message",
      message: {
        role: "assistant",
        content: text
      },
      usage,
      stopReason,
      requestId
    };
  }
}

export function createAnthropicModelClientFromEnv(
  env: EnvironmentLike = process.env
): AnthropicModelClient {
  if (!env.ANTHROPIC_API_KEY) {
    throw new ModelError(
      "auth_error",
      "ANTHROPIC_API_KEY is required. Set it before running `myagent chat`."
    );
  }

  return new AnthropicModelClient({
    apiKey: env.ANTHROPIC_API_KEY,
    baseURL: env.ANTHROPIC_BASE_URL,
    defaultModel: env.MYAGENT_MODEL ?? DEFAULT_MODEL
  });
}

export function toAnthropicMessages(messages: readonly Message[]): AnthropicMessageParam[] {
  return messages.map((message) => {
    return {
      role: message.role === "tool" ? "user" : message.role,
      content: toAnthropicContent(message.content)
    };
  });
}

export function classifyAnthropicError(error: unknown, requestId?: string): ModelError {
  if (error instanceof ModelError) {
    return error;
  }

  if (error instanceof AuthenticationError) {
    return new ModelError("auth_error", error.message, {
      requestId,
      status: error.status,
      cause: error
    });
  }

  if (error instanceof RateLimitError) {
    return new ModelError("rate_limit", error.message, {
      requestId,
      status: error.status,
      cause: error
    });
  }

  if (error instanceof APIConnectionTimeoutError) {
    return new ModelError("timeout", error.message, {
      requestId,
      cause: error
    });
  }

  if (error instanceof APIError) {
    const message = error.message.toLowerCase();
    const kind =
      error.status === 529
        ? "overloaded"
        : error.status === 400 &&
            (message.includes("prompt") || message.includes("context")) &&
            (message.includes("long") || message.includes("large") || message.includes("maximum"))
          ? "prompt_too_long"
          : "unknown";
    return new ModelError(kind, error.message, {
      requestId,
      status: error.status,
      cause: error
    });
  }

  return new ModelError("unknown", error instanceof Error ? error.message : String(error), {
    requestId,
    cause: error
  });
}

function toModelResponse(raw: unknown, requestId: string): ModelResponse {
  const message = raw as {
    content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: unknown }>;
    stop_reason?: string | null;
    usage?: { input_tokens?: number; output_tokens?: number };
  };

  return {
    message: {
      role: "assistant",
      content: toInternalContent(message.content ?? [])
    },
    usage: toModelUsage(message.usage),
    stopReason: message.stop_reason,
    requestId
  };
}

function toAnthropicContent(content: MessageContent): string | Array<Record<string, unknown>> {
  if (typeof content === "string") {
    return content;
  }

  const blocks: Array<Record<string, unknown>> = [];

  for (const block of content) {
    if (block.type === "text") {
      blocks.push({ type: "text", text: block.text });
      continue;
    }

    if (block.type === "tool_use") {
      blocks.push({
        type: "tool_use",
        id: block.toolUse.id,
        name: block.toolUse.name,
        input: block.toolUse.input
      });
      continue;
    }

    blocks.push({
      type: "tool_result",
      tool_use_id: block.result.toolUseId,
      content: block.result.content || block.result.error || "",
      is_error: block.result.status === "error"
    });
  }

  return blocks;
}

function toInternalContent(
  blocks: Array<{ type?: string; text?: string; id?: string; name?: string; input?: unknown }>
): MessageContent {
  const content: Array<TextBlock | ToolUseBlock | ToolResultBlock> = [];

  for (const block of blocks) {
    if (block.type === "text") {
      content.push({ type: "text", text: block.text ?? "" });
      continue;
    }

    if (block.type === "tool_use" && block.id && block.name) {
      const input = isRecord(block.input) ? block.input : {};
      const toolUse: ToolUse = {
        id: block.id,
        name: block.name,
        input
      };
      content.push({ type: "tool_use", toolUse });
    }
  }

  if (content.length === 1 && content[0]?.type === "text") {
    return content[0].text;
  }

  return content;
}

function toAnthropicTools(
  tools: readonly ModelToolDefinition[] | undefined
): { tools?: Array<Record<string, unknown>> } {
  if (!tools || tools.length === 0) {
    return {};
  }

  return {
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema
    }))
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toModelUsage(
  usage: { input_tokens?: number; output_tokens?: number } | undefined
): ModelUsage | undefined {
  if (!usage) {
    return undefined;
  }

  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens
  };
}

function parseToolInput(
  partialJson: string,
  inputFromStart: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!partialJson.trim()) {
    return inputFromStart ?? {};
  }

  const parsed: unknown = JSON.parse(partialJson);
  return isRecord(parsed) ? parsed : {};
}

function toAnthropicRequestOptions(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined
): AnthropicRequestOptions {
  const options: AnthropicRequestOptions = {};

  if (signal) {
    options.signal = signal;
  }

  if (timeoutMs !== undefined) {
    options.timeout = timeoutMs;
  }

  return options;
}

export function normalizeAnthropicBaseURL(baseURL: string | undefined): string | undefined {
  if (!baseURL) {
    return undefined;
  }

  const withoutTrailingSlash = baseURL.replace(/\/+$/, "");
  return withoutTrailingSlash.endsWith("/v1")
    ? withoutTrailingSlash.slice(0, -"/v1".length)
    : withoutTrailingSlash;
}
