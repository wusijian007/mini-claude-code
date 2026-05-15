import { describe, expect, it } from "vitest";
import {
  createAnthropicModelClientFromEnv,
  ModelError,
  normalizeAnthropicBaseURL,
  parseIdleTimeoutMs,
  toAnthropicMessages
} from "../src/index.js";

describe("Anthropic adapter", () => {
  it("converts internal user and assistant text messages", () => {
    expect(
      toAnthropicMessages([
        { role: "user", content: "Hello" },
        { role: "assistant", content: [{ type: "text", text: "Hi" }] }
      ])
    ).toEqual([
      { role: "user", content: "Hello" },
      { role: "assistant", content: [{ type: "text", text: "Hi" }] }
    ]);
  });

  it("maps internal tool results to Anthropic user tool_result blocks", () => {
    expect(
      toAnthropicMessages([
        {
          role: "tool",
          content: [
            {
              type: "tool_result",
              result: {
                toolUseId: "toolu_1",
                status: "success",
                content: "README contents"
              }
            }
          ]
        }
      ])
    ).toEqual([
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: "README contents",
            is_error: false
          }
        ]
      }
    ]);
  });

  it("classifies missing API key as auth_error before creating a network client", () => {
    expect(() => createAnthropicModelClientFromEnv({})).toThrow(
      expect.objectContaining({
        kind: "auth_error"
      })
    );
  });

  it("normalizes Anthropic-compatible proxy base URLs", () => {
    expect(normalizeAnthropicBaseURL("https://claude.proai.love/v1")).toBe(
      "https://claude.proai.love"
    );
    expect(normalizeAnthropicBaseURL("https://api.anthropic.com/")).toBe(
      "https://api.anthropic.com"
    );
  });

  it("parses MYAGENT_IDLE_TIMEOUT_MS into a positive integer", () => {
    expect(parseIdleTimeoutMs("300000")).toBe(300000);
    expect(parseIdleTimeoutMs("60000.7")).toBe(60000);
  });

  it("rejects malformed or non-positive MYAGENT_IDLE_TIMEOUT_MS values", () => {
    expect(parseIdleTimeoutMs(undefined)).toBeUndefined();
    expect(parseIdleTimeoutMs("")).toBeUndefined();
    expect(parseIdleTimeoutMs("   ")).toBeUndefined();
    expect(parseIdleTimeoutMs("not-a-number")).toBeUndefined();
    expect(parseIdleTimeoutMs("0")).toBeUndefined();
    expect(parseIdleTimeoutMs("-5000")).toBeUndefined();
  });

  it("createAnthropicModelClientFromEnv accepts MYAGENT_IDLE_TIMEOUT_MS without throwing", () => {
    expect(() =>
      createAnthropicModelClientFromEnv({
        ANTHROPIC_API_KEY: "sk-test",
        ANTHROPIC_BASE_URL: "https://example.test/v1",
        MYAGENT_IDLE_TIMEOUT_MS: "300000"
      })
    ).not.toThrow();
    // A malformed value should not crash either — the client just falls
    // back to the default (90s).
    expect(() =>
      createAnthropicModelClientFromEnv({
        ANTHROPIC_API_KEY: "sk-test",
        MYAGENT_IDLE_TIMEOUT_MS: "bogus"
      })
    ).not.toThrow();
  });
});
