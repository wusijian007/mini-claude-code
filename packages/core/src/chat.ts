import {
  ModelError,
  messageContentToText,
  resolveRequestId,
  type ModelClient,
  type ModelRequest,
  type ModelStreamEvent
} from "./model.js";

export async function* streamTextWithFallback(
  client: ModelClient,
  request: ModelRequest
): AsyncIterable<ModelStreamEvent> {
  const requestId = resolveRequestId(request);
  let yieldedOutput = false;

  try {
    for await (const event of client.stream({ ...request, requestId })) {
      if (event.type === "text_delta" || event.type === "assistant_message") {
        yieldedOutput = true;
      }
      yield event;
    }
    return;
  } catch (error) {
    if (yieldedOutput) {
      throw normalizeUnknownModelError(error, requestId, "stream_error");
    }
  }

  const response = await client.create({ ...request, requestId });
  const text = messageContentToText(response.message.content);
  if (text.length > 0) {
    yield {
      type: "text_delta",
      text,
      requestId
    };
  }

  yield {
    type: "assistant_message",
    message: response.message,
    usage: response.usage,
    stopReason: response.stopReason,
    requestId
  };
}

export function normalizeUnknownModelError(
  error: unknown,
  requestId: string | undefined,
  fallbackKind: ModelError["kind"] = "unknown"
): ModelError {
  if (error instanceof ModelError) {
    return error;
  }

  return new ModelError(
    fallbackKind,
    error instanceof Error ? error.message : String(error),
    {
      requestId,
      cause: error
    }
  );
}
