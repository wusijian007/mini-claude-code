import { describe, expect, it } from "vitest";
import {
  ModelError,
  streamTextWithFallback,
  withIdleWatchdog,
  type ModelClient,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamEvent
} from "../src/index.js";

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of source) {
    values.push(value);
  }
  return values;
}

describe("streaming watchdog", () => {
  it("turns an idle stream into a timeout model error", async () => {
    async function* stalled(): AsyncIterable<string> {
      await new Promise(() => {
        // Intentionally never resolves.
      });
    }

    await expect(
      collect(withIdleWatchdog(stalled(), { idleMs: 1, requestId: "req_watchdog" }))
    ).rejects.toMatchObject({
      kind: "timeout",
      requestId: "req_watchdog"
    });
  });
});

describe("stream fallback", () => {
  it("falls back to create when stream fails before output", async () => {
    class FailingStreamClient implements ModelClient {
      async create(request: ModelRequest): Promise<ModelResponse> {
        return {
          message: {
            role: "assistant",
            content: "fallback response"
          },
          requestId: request.requestId ?? "req_fallback"
        };
      }

      async *stream(_request: ModelRequest): AsyncIterable<ModelStreamEvent> {
        throw new ModelError("stream_error", "stream failed before output");
      }
    }

    const events = await collect(
      streamTextWithFallback(new FailingStreamClient(), {
        messages: [{ role: "user", content: "hello" }],
        requestId: "req_fallback"
      })
    );

    expect(events.map((event) => event.type)).toEqual(["text_delta", "assistant_message"]);
    expect(events[0]).toEqual({
      type: "text_delta",
      text: "fallback response",
      requestId: "req_fallback"
    });
  });
});
