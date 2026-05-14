import { describe, expect, it } from "vitest";
import {
  createAnthropicModelClientFromEnv,
  ModelError,
  normalizeAnthropicBaseURL,
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
});
