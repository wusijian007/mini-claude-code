import { describe, expect, it, afterEach } from "vitest";
import {
  addTokenUsage,
  createBootstrapState,
  createStore,
  getBootstrapState,
  initializeBootstrapState,
  resetBootstrapStateForTests,
  updateBootstrapState
} from "../src/index.js";

afterEach(() => {
  resetBootstrapStateForTests();
});

describe("bootstrap state", () => {
  it("initializes a normalized singleton without UI or tool dependencies", () => {
    const state = initializeBootstrapState({
      sessionId: "sess_test",
      cwd: "D:\\paper\\Mini-ClaudeCode\\",
      model: "test-model",
      permissionMode: "default"
    });

    expect(state).toMatchObject({
      sessionId: "sess_test",
      cwd: "D:/paper/Mini-ClaudeCode",
      model: "test-model",
      costUsd: 0,
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
      permissionMode: "default"
    });
    expect(getBootstrapState()).toEqual(state);
  });

  it("updates token usage with explicit deltas", () => {
    initializeBootstrapState({
      sessionId: "sess_usage",
      cwd: process.cwd(),
      model: "test-model",
      permissionMode: "plan"
    });

    const updated = updateBootstrapState((state) => ({
      ...state,
      tokenUsage: addTokenUsage(state.tokenUsage, { inputTokens: 12, outputTokens: 8 })
    }));

    expect(updated.tokenUsage).toEqual({ inputTokens: 12, outputTokens: 8 });
  });

  it("creates independent bootstrap snapshots when no singleton is needed", () => {
    const state = createBootstrapState({
      cwd: process.cwd(),
      model: "test-model",
      permissionMode: "bypassPermissions",
      tokenUsage: { inputTokens: 1 }
    });

    expect(state.sessionId).toMatch(/^sess_/);
    expect(state.tokenUsage).toEqual({ inputTokens: 1, outputTokens: 0 });
  });
});

describe("reactive store", () => {
  it("supports get, set, subscribe, and selected onChange", () => {
    const store = createStore({ model: "a", permissionMode: "plan" });
    const snapshots: string[] = [];
    const permissionChanges: string[] = [];

    const unsubscribe = store.subscribe((next) => snapshots.push(next.model));
    const unsubscribePermission = store.onChange(
      (state) => state.permissionMode,
      (next, previous) => permissionChanges.push(`${previous}->${next}`)
    );

    store.set((previous) => ({ ...previous, model: "b" }));
    store.set((previous) => ({ ...previous, permissionMode: "default" }));
    unsubscribe();
    unsubscribePermission();
    store.set((previous) => ({ ...previous, model: "c", permissionMode: "bypassPermissions" }));

    expect(store.get()).toEqual({ model: "c", permissionMode: "bypassPermissions" });
    expect(snapshots).toEqual(["b", "b"]);
    expect(permissionChanges).toEqual(["plan->default"]);
  });
});
