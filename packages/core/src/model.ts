import { randomUUID } from "node:crypto";

import type { Message, MessageContent, ModelToolDefinition, ToolUse } from "./types.js";

export const DEFAULT_MODEL = "claude-sonnet-4-6";
export const DEFAULT_MAX_TOKENS = 1024;
export const DEFAULT_IDLE_TIMEOUT_MS = 90_000;

export type ModelUsage = {
  inputTokens?: number;
  outputTokens?: number;
  /**
   * Tokens written into Anthropic's prompt cache on this turn (i.e. the
   * input portion that became a cache entry). Counts only when the
   * request had at least one `cache_control` marker.
   */
  cacheCreationInputTokens?: number;
  /**
   * Tokens served from a previously-written prompt cache entry on this
   * turn. These are billed at a discount and are the main signal that
   * prompt caching is working.
   */
  cacheReadInputTokens?: number;
};

/**
 * A single text block in a structured system prompt. The optional
 * `cache_control` marker turns this block into an Anthropic prompt-cache
 * breakpoint: the cumulative content up to and including this block is
 * cached and reused across requests that share the same prefix.
 */
export type SystemTextBlock = {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
};

export type ModelRequest = {
  messages: readonly Message[];
  model?: string;
  maxTokens?: number;
  /**
   * The system prompt. A plain string preserves the legacy flat form
   * (no caching). An array of `SystemTextBlock`s enables structured
   * caching when at least one block carries `cache_control`.
   */
  system?: string | readonly SystemTextBlock[];
  requestId?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  tools?: readonly ModelToolDefinition[];
};

export type ModelResponse = {
  message: Message;
  usage?: ModelUsage;
  stopReason?: string | null;
  requestId: string;
};

export type ModelErrorKind =
  | "auth_error"
  | "rate_limit"
  | "overloaded"
  | "prompt_too_long"
  | "max_output"
  | "timeout"
  | "stream_error"
  | "unknown";

export class ModelError extends Error {
  readonly kind: ModelErrorKind;
  readonly requestId?: string;
  readonly status?: number;
  override readonly cause?: unknown;

  constructor(
    kind: ModelErrorKind,
    message: string,
    options: { requestId?: string; status?: number; cause?: unknown } = {}
  ) {
    super(message);
    this.name = "ModelError";
    this.kind = kind;
    this.requestId = options.requestId;
    this.status = options.status;
    this.cause = options.cause;
  }
}

export type ModelStreamEvent =
  | {
      type: "text_delta";
      text: string;
      requestId?: string;
    }
  | {
      type: "assistant_message";
      message: Message;
      usage?: ModelUsage;
      stopReason?: string | null;
      requestId?: string;
    }
  | {
      type: "tool_use";
      toolUse: ToolUse;
      requestId?: string;
    };

export type ModelClient = {
  create(request: ModelRequest): Promise<ModelResponse>;
  stream(request: ModelRequest): AsyncIterable<ModelStreamEvent>;
};

export type FakeModelStep =
  | {
      type: "text_delta";
      text: string;
    }
  | {
      type: "assistant_message";
      content: string;
      /**
       * Optional scripted token usage for this assistant turn. Lets
       * offline tests (esp. the M2.3 eval suite) assert deterministic
       * token / cost accounting without a live model. When omitted the
       * stream event carries no usage, exactly as before.
       */
      usage?: ModelUsage;
    }
  | {
      type: "tool_use";
      toolUse: ToolUse;
    }
  | {
      type: "delay";
      ms: number;
    }
  | {
      type: "turn_break";
    };

export class FakeModel implements ModelClient {
  readonly #script: readonly FakeModelStep[];
  #createCursor = 0;
  #streamCursor = 0;

  constructor(script: readonly FakeModelStep[]) {
    this.#script = script;
  }

  async create(request: ModelRequest): Promise<ModelResponse> {
    const content: Exclude<MessageContent, string> = [];

    while (this.#createCursor < this.#script.length) {
      const step = this.#script[this.#createCursor];
      this.#createCursor += 1;

      if (step.type === "turn_break") {
        break;
      }

      if (step.type === "text_delta") {
        content.push({ type: "text", text: step.text });
      }

      if (step.type === "assistant_message") {
        content.push({ type: "text", text: step.content });
      }

      if (step.type === "tool_use") {
        content.push({ type: "tool_use", toolUse: step.toolUse });
      }
    }

    return {
      message: {
        role: "assistant",
        content: content.length === 1 && content[0]?.type === "text" ? content[0].text : content
      },
      requestId: resolveRequestId(request)
    };
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const requestId = resolveRequestId(request);

    while (this.#streamCursor < this.#script.length) {
      const step = this.#script[this.#streamCursor];
      this.#streamCursor += 1;

      if (step.type === "turn_break") {
        return;
      }

      if (step.type === "delay") {
        await new Promise((resolve) => setTimeout(resolve, step.ms));
        continue;
      }

      if (step.type === "text_delta") {
        yield {
          type: "text_delta",
          text: step.text,
          requestId
        };
        continue;
      }

      if (step.type === "assistant_message") {
        yield {
          type: "assistant_message",
          message: {
            role: "assistant",
            content: step.content
          },
          ...(step.usage ? { usage: step.usage } : {}),
          requestId
        };
        continue;
      }

      yield {
        type: "tool_use",
        toolUse: step.toolUse,
        requestId
      };
    }
  }
}

export function resolveRequestId(request: Pick<ModelRequest, "requestId">): string {
  return request.requestId ?? `req_${randomUUID()}`;
}

export function messageContentToText(content: MessageContent): string {
  if (typeof content === "string") {
    return content;
  }

  return content
    .map((block) => {
      if (block.type === "text") {
        return block.text;
      }

      if (block.type === "tool_result") {
        return block.result.content;
      }

      return "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
}
