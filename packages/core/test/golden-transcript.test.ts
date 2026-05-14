import { describe, expect, it } from "vitest";
import { collectTranscript, FakeModel } from "../src/index.js";
import {
  goldenEventTypes,
  goldenInitialMessages,
  goldenScript,
  goldenToolResult
} from "./fixtures/golden-transcript.js";

describe("golden transcript", () => {
  it("collects fake model events, tool result, and terminal state in order", async () => {
    const events = await collectTranscript({
      model: new FakeModel(goldenScript),
      initialMessages: goldenInitialMessages,
      resolveToolResult: (toolUse) => ({
        ...goldenToolResult,
        toolUseId: toolUse.id
      })
    });

    expect(events.map((event) => event.type)).toEqual([...goldenEventTypes]);
    expect(events.at(-1)).toEqual({
      type: "terminal_state",
      state: { status: "completed" }
    });
  });
});
