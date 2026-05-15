import { describe, expect, it } from "vitest";

import { FakeModel, type ModelStreamEvent } from "../src/index.js";

async function streamEvents(model: FakeModel): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const event of model.stream({ messages: [{ role: "user", content: "hi" }] })) {
    events.push(event);
  }
  return events;
}

describe("FakeModel scripted usage (M2.3 A1 extension)", () => {
  it("carries scripted usage on the assistant_message stream event", async () => {
    const model = new FakeModel([
      {
        type: "assistant_message",
        content: "done",
        usage: {
          inputTokens: 1234,
          outputTokens: 56,
          cacheCreationInputTokens: 1000,
          cacheReadInputTokens: 200
        }
      }
    ]);

    const events = await streamEvents(model);
    const assistant = events.find((e) => e.type === "assistant_message");
    expect(assistant).toMatchObject({
      type: "assistant_message",
      usage: {
        inputTokens: 1234,
        outputTokens: 56,
        cacheCreationInputTokens: 1000,
        cacheReadInputTokens: 200
      }
    });
  });

  it("omits usage entirely when the step does not script it (back-compat)", async () => {
    const model = new FakeModel([{ type: "assistant_message", content: "no usage here" }]);
    const events = await streamEvents(model);
    const assistant = events.find((e) => e.type === "assistant_message");
    expect(assistant?.type).toBe("assistant_message");
    expect(assistant && "usage" in assistant ? assistant.usage : undefined).toBeUndefined();
  });

  it("scripts independent usage across multiple turns", async () => {
    const model = new FakeModel([
      { type: "assistant_message", content: "turn 1", usage: { inputTokens: 10, outputTokens: 1 } },
      { type: "turn_break" },
      { type: "assistant_message", content: "turn 2", usage: { inputTokens: 20, outputTokens: 2 } }
    ]);

    const first = await streamEvents(model);
    expect(first.find((e) => e.type === "assistant_message")).toMatchObject({
      usage: { inputTokens: 10, outputTokens: 1 }
    });

    const second = await streamEvents(model);
    expect(second.find((e) => e.type === "assistant_message")).toMatchObject({
      usage: { inputTokens: 20, outputTokens: 2 }
    });
  });
});
