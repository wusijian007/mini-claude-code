import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import {
  FakeModel,
  buildTool,
  collectQuery,
  createProfileRecorder,
  createProfileStore,
  estimateUsageCostUsd,
  formatProfileReport,
  type ToolDefinition
} from "../src/index.js";
import { z } from "zod";

describe("profile metrics", () => {
  it("records checkpoints and metrics to a profile store", async () => {
    let now = 100;
    const profile = createProfileRecorder({
      runId: "profile_test",
      clock: {
        nowMs: () => {
          now += 5;
          return now;
        },
        nowIso: () => "2026-05-13T00:00:00.000Z"
      }
    });

    profile.mark("start");
    await profile.time("work", async () => "ok");
    profile.addMetric("tokens", 12, "tokens");
    const run = profile.finish();

    expect(run.checkpoints.map((checkpoint) => checkpoint.name)).toEqual(["start", "work"]);
    expect(run.metrics).toEqual([{ name: "tokens", value: 12, unit: "tokens", metadata: undefined }]);
    expect(formatProfileReport(run)).toContain("[profile] profile_test completed");

    const cwd = mkdtempSync(join(tmpdir(), "myagent-profile-"));
    const store = createProfileStore(cwd);
    await store.save(run);
    await expect(store.load("profile_test")).resolves.toMatchObject({ runId: "profile_test" });
  });

  it("estimates cost from caller-provided rates", () => {
    expect(
      estimateUsageCostUsd(
        { inputTokens: 1_000_000, outputTokens: 500_000 },
        { inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 15 }
      )
    ).toBe(10.5);
    expect(estimateUsageCostUsd({ inputTokens: 10 }, undefined)).toBe(0);
  });

  it("records model first token and tool latency from query", async () => {
    const profile = createProfileRecorder({ runId: "profile_query" });
    const readTool: ToolDefinition = buildTool({
      name: "Read",
      description: "Read fixture.",
      inputSchema: z.object({ path: z.string() }).strict(),
      inputJsonSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false
      },
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      call(input) {
        return { status: "success", content: `read:${input.path}` };
      }
    });

    await collectQuery({
      model: new FakeModel([
        { type: "text_delta", text: "Reading." },
        { type: "tool_use", toolUse: { id: "toolu_read", name: "Read", input: { path: "README.md" } } },
        { type: "turn_break" },
        { type: "assistant_message", content: "done" }
      ]),
      initialMessages: [{ role: "user", content: "read" }],
      tools: [readTool],
      toolContext: { cwd: process.cwd(), profile },
      profile
    });

    const run = profile.finish();
    expect(run.checkpoints.map((checkpoint) => checkpoint.name)).toContain("model.first_token");
    expect(run.checkpoints.map((checkpoint) => checkpoint.name)).toContain("tool.Read");
  });
});
