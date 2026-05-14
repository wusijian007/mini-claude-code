import { describe, expect, it } from "vitest";

import {
  addTokenUsage,
  createBootstrapState,
  estimateUsageCostUsd
} from "../../src/index.js";

describe("security: cache token accounting", () => {
  it("addTokenUsage sums cache fields alongside input/output", () => {
    const base = {
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationInputTokens: 100,
      cacheReadInputTokens: 200
    };

    const after = addTokenUsage(base, {
      inputTokens: 1,
      outputTokens: 2,
      cacheCreationInputTokens: 50,
      cacheReadInputTokens: 75
    });

    expect(after).toEqual({
      inputTokens: 11,
      outputTokens: 7,
      cacheCreationInputTokens: 150,
      cacheReadInputTokens: 275
    });
  });

  it("addTokenUsage treats missing delta cache fields as zero", () => {
    const base = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 10,
      cacheReadInputTokens: 20
    };
    const after = addTokenUsage(base, { inputTokens: 5, outputTokens: 5 });
    expect(after).toEqual({
      inputTokens: 5,
      outputTokens: 5,
      cacheCreationInputTokens: 10,
      cacheReadInputTokens: 20
    });
  });

  it("createBootstrapState initializes all four token fields to zero", () => {
    const state = createBootstrapState({
      cwd: process.cwd(),
      model: "test-model",
      permissionMode: "default"
    });
    expect(state.tokenUsage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0
    });
  });

  it("createBootstrapState accepts partial token usage including cache fields", () => {
    const state = createBootstrapState({
      cwd: process.cwd(),
      model: "test-model",
      permissionMode: "default",
      tokenUsage: {
        inputTokens: 100,
        cacheCreationInputTokens: 50
      }
    });
    expect(state.tokenUsage).toEqual({
      inputTokens: 100,
      outputTokens: 0,
      cacheCreationInputTokens: 50,
      cacheReadInputTokens: 0
    });
  });

  it("estimateUsageCostUsd factors all four token streams", () => {
    const cost = estimateUsageCostUsd(
      {
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        cacheCreationInputTokens: 200_000,
        cacheReadInputTokens: 800_000
      },
      {
        inputUsdPerMillionTokens: 3,
        outputUsdPerMillionTokens: 15,
        cacheWriteUsdPerMillionTokens: 3.75,
        cacheReadUsdPerMillionTokens: 0.3
      }
    );
    // 1M*3 + 0.5M*15 + 0.2M*3.75 + 0.8M*0.3 = 3 + 7.5 + 0.75 + 0.24 = 11.49
    expect(cost).toBeCloseTo(11.49, 4);
  });

  it("estimateUsageCostUsd defaults cache write to base input rate when unset", () => {
    const withDefault = estimateUsageCostUsd(
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 1_000_000,
        cacheReadInputTokens: 0
      },
      { inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 0 }
    );
    expect(withDefault).toBeCloseTo(3, 4);
  });

  it("estimateUsageCostUsd defaults cache read rate to zero when unset", () => {
    const cost = estimateUsageCostUsd(
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 5_000_000
      },
      { inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 15 }
    );
    expect(cost).toBe(0);
  });

  it("estimateUsageCostUsd returns 0 when rates are undefined (back-compat)", () => {
    const cost = estimateUsageCostUsd(
      { inputTokens: 1_000_000, cacheCreationInputTokens: 1_000_000 },
      undefined
    );
    expect(cost).toBe(0);
  });
});
