import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import type { PermissionMode } from "./types.js";

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  /**
   * Cumulative count of tokens written into Anthropic's prompt cache
   * over the session's lifetime. Always present (zero before any cached
   * turn occurs and on sessions persisted before M1.5a).
   */
  cacheCreationInputTokens: number;
  /**
   * Cumulative count of tokens served from prompt cache hits.
   */
  cacheReadInputTokens: number;
};

export type BootstrapState = {
  sessionId: string;
  cwd: string;
  model: string;
  costUsd: number;
  tokenUsage: TokenUsage;
  permissionMode: PermissionMode;
};

export type BootstrapStateOptions = {
  sessionId?: string;
  cwd: string;
  model: string;
  permissionMode: PermissionMode;
  costUsd?: number;
  tokenUsage?: Partial<TokenUsage>;
};

let bootstrapState: BootstrapState | undefined;

export function createBootstrapState(options: BootstrapStateOptions): BootstrapState {
  return {
    sessionId: options.sessionId ?? createSessionId(),
    cwd: normalizePath(resolve(options.cwd)),
    model: options.model,
    costUsd: options.costUsd ?? 0,
    tokenUsage: {
      inputTokens: options.tokenUsage?.inputTokens ?? 0,
      outputTokens: options.tokenUsage?.outputTokens ?? 0,
      cacheCreationInputTokens: options.tokenUsage?.cacheCreationInputTokens ?? 0,
      cacheReadInputTokens: options.tokenUsage?.cacheReadInputTokens ?? 0
    },
    permissionMode: options.permissionMode
  };
}

export function initializeBootstrapState(options: BootstrapStateOptions): BootstrapState {
  bootstrapState = createBootstrapState(options);
  return bootstrapState;
}

export function getBootstrapState(): BootstrapState {
  if (!bootstrapState) {
    throw new Error("Bootstrap state has not been initialized");
  }

  return bootstrapState;
}

export function updateBootstrapState(
  updater: (state: BootstrapState) => BootstrapState
): BootstrapState {
  bootstrapState = updater(getBootstrapState());
  return bootstrapState;
}

export function resetBootstrapStateForTests(): void {
  bootstrapState = undefined;
}

export type StoreListener<T> = (next: T, previous: T) => void;
export type StoreUnsubscribe = () => void;

export type ReactiveStore<T> = {
  get(): T;
  set(next: T | ((previous: T) => T)): T;
  subscribe(listener: StoreListener<T>): StoreUnsubscribe;
  onChange<TSelected>(
    selector: (state: T) => TSelected,
    listener: (next: TSelected, previous: TSelected, state: T) => void
  ): StoreUnsubscribe;
};

export function createStore<T>(initialState: T): ReactiveStore<T> {
  let state = initialState;
  const listeners = new Set<StoreListener<T>>();

  return {
    get() {
      return state;
    },
    set(next) {
      const previous = state;
      state = typeof next === "function" ? (next as (value: T) => T)(previous) : next;
      if (!Object.is(previous, state)) {
        for (const listener of listeners) {
          listener(state, previous);
        }
      }
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onChange(selector, listener) {
      let selected = selector(state);
      return this.subscribe((nextState) => {
        const nextSelected = selector(nextState);
        if (Object.is(nextSelected, selected)) {
          return;
        }

        const previousSelected = selected;
        selected = nextSelected;
        listener(nextSelected, previousSelected, nextState);
      });
    }
  };
}

export function addTokenUsage(
  current: TokenUsage,
  delta: Partial<TokenUsage> | undefined
): TokenUsage {
  return {
    inputTokens: current.inputTokens + (delta?.inputTokens ?? 0),
    outputTokens: current.outputTokens + (delta?.outputTokens ?? 0),
    cacheCreationInputTokens:
      current.cacheCreationInputTokens + (delta?.cacheCreationInputTokens ?? 0),
    cacheReadInputTokens:
      current.cacheReadInputTokens + (delta?.cacheReadInputTokens ?? 0)
  };
}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function createSessionId(): string {
  return `sess_${new Date().toISOString().replace(/[-:.TZ]/g, "")}_${randomUUID().slice(0, 8)}`;
}
