import type { ModelClient } from "./model.js";
import type { LoopEvent, Message, ToolResult, ToolUse } from "./types.js";

export type ToolResultResolver = (toolUse: ToolUse) => Promise<ToolResult> | ToolResult;

export type RunTranscriptOptions = {
  model: ModelClient;
  initialMessages: readonly Message[];
  modelName?: string;
  maxTokens?: number;
  resolveToolResult: ToolResultResolver;
  abortSignal?: AbortSignal;
  maxModelEvents?: number;
};

export async function* runTranscript(options: RunTranscriptOptions): AsyncIterable<LoopEvent> {
  const maxModelEvents = options.maxModelEvents ?? 100;
  let seenModelEvents = 0;

  if (options.abortSignal?.aborted) {
    yield {
      type: "terminal_state",
      state: { status: "aborted", reason: "aborted before transcript start" }
    };
    return;
  }

  try {
    for await (const modelEvent of options.model.stream({
      messages: options.initialMessages,
      model: options.modelName,
      maxTokens: options.maxTokens,
      signal: options.abortSignal
    })) {
      if (options.abortSignal?.aborted) {
        yield {
          type: "terminal_state",
          state: { status: "aborted", reason: "abort signal received" }
        };
        return;
      }

      seenModelEvents += 1;
      if (seenModelEvents > maxModelEvents) {
        yield {
          type: "terminal_state",
          state: { status: "max_turns", reason: `model event limit ${maxModelEvents} exceeded` }
        };
        return;
      }

      if (modelEvent.type === "assistant_message") {
        yield {
          type: "assistant_message",
          message: modelEvent.message
        };
        continue;
      }

      if (modelEvent.type === "text_delta") {
        continue;
      }

      yield {
        type: "tool_use",
        toolUse: modelEvent.toolUse
      };

      const result = await options.resolveToolResult(modelEvent.toolUse);
      yield {
        type: "tool_result",
        result
      };
    }

    yield {
      type: "terminal_state",
      state: { status: "completed" }
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

export async function collectTranscript(options: RunTranscriptOptions): Promise<LoopEvent[]> {
  const events: LoopEvent[] = [];
  for await (const event of runTranscript(options)) {
    events.push(event);
  }
  return events;
}
