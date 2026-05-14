import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";

import type { ModelUsage } from "./model.js";
import { normalizePath } from "./state.js";

export type ProfileMetric = {
  name: string;
  value: number;
  unit: "ms" | "tokens" | "usd" | "count" | "chars";
  metadata?: Record<string, unknown>;
};

export type ProfileCheckpoint = {
  name: string;
  atMs: number;
  startedAtMs?: number;
  endedAtMs?: number;
  durationMs?: number;
  metadata?: Record<string, unknown>;
};

export type ProfileRun = {
  version: 1;
  runId: string;
  createdAt: string;
  updatedAt: string;
  status: "running" | "completed" | "failed";
  durationMs?: number;
  checkpoints: ProfileCheckpoint[];
  metrics: ProfileMetric[];
};

export type ProfileRecorder = {
  readonly runId: string;
  mark(name: string, metadata?: Record<string, unknown>): void;
  time<T>(name: string, work: () => Promise<T> | T, metadata?: Record<string, unknown>): Promise<T>;
  addMetric(name: string, value: number, unit: ProfileMetric["unit"], metadata?: Record<string, unknown>): void;
  finish(status?: ProfileRun["status"]): ProfileRun;
  snapshot(): ProfileRun;
};

export type CostRates = {
  inputUsdPerMillionTokens?: number;
  outputUsdPerMillionTokens?: number;
  /**
   * Per-million-token rate for input tokens that *create* a prompt cache
   * entry. Anthropic charges these at a small premium over the base
   * input rate. Defaults to the base input rate when not provided.
   */
  cacheWriteUsdPerMillionTokens?: number;
  /**
   * Per-million-token rate for input tokens served from a prompt cache
   * hit. Significantly cheaper than the base input rate; the cache's
   * raison d'être.
   */
  cacheReadUsdPerMillionTokens?: number;
};

export type ProfileStore = {
  rootDir: string;
  save(run: ProfileRun): Promise<string>;
  load(runId: string): Promise<ProfileRun>;
  list(): Promise<ProfileRun[]>;
  pathFor(runId: string): string;
};

type Clock = {
  nowMs(): number;
  nowIso(): string;
};

export function createProfileRecorder(options: {
  runId?: string;
  clock?: Clock;
} = {}): ProfileRecorder {
  const clock = options.clock ?? {
    nowMs: () => performance.now(),
    nowIso: () => new Date().toISOString()
  };
  const runId = options.runId ?? `profile_${compactTimestamp(clock.nowIso())}_${randomUUID().slice(0, 8)}`;
  const startMs = clock.nowMs();
  const createdAt = clock.nowIso();
  let status: ProfileRun["status"] = "running";
  let finishedDurationMs: number | undefined;
  const checkpoints: ProfileCheckpoint[] = [];
  const metrics: ProfileMetric[] = [];

  const elapsedMs = () => roundMs(clock.nowMs() - startMs);

  return {
    runId,
    mark(name, metadata) {
      checkpoints.push({
        name,
        atMs: elapsedMs(),
        metadata: sanitizeMetadata(metadata)
      });
    },
    async time(name, work, metadata) {
      const startedAtMs = elapsedMs();
      try {
        return await work();
      } finally {
        const endedAtMs = elapsedMs();
        checkpoints.push({
          name,
          atMs: endedAtMs,
          startedAtMs,
          endedAtMs,
          durationMs: roundMs(endedAtMs - startedAtMs),
          metadata: sanitizeMetadata(metadata)
        });
      }
    },
    addMetric(name, value, unit, metadata) {
      metrics.push({
        name,
        value: roundMetric(value),
        unit,
        metadata: sanitizeMetadata(metadata)
      });
    },
    finish(nextStatus = "completed") {
      status = nextStatus;
      finishedDurationMs = elapsedMs();
      return this.snapshot();
    },
    snapshot() {
      return {
        version: 1,
        runId,
        createdAt,
        updatedAt: clock.nowIso(),
        status,
        durationMs: finishedDurationMs ?? elapsedMs(),
        checkpoints: [...checkpoints],
        metrics: [...metrics]
      };
    }
  };
}

export function createProfileStore(cwd: string, rootDir?: string): ProfileStore {
  const normalizedRoot = normalizePath(resolve(rootDir ?? join(cwd, ".myagent", "profiles")));

  return {
    rootDir: normalizedRoot,
    async save(run) {
      await mkdir(normalizedRoot, { recursive: true });
      const path = this.pathFor(run.runId);
      await writeFile(path, `${JSON.stringify(run, null, 2)}\n`, "utf8");
      return path;
    },
    async load(runId) {
      return JSON.parse(await readFile(this.pathFor(runId), "utf8")) as ProfileRun;
    },
    async list() {
      const names = await readdir(normalizedRoot).catch(() => []);
      const runs: ProfileRun[] = [];
      for (const name of names.sort()) {
        if (name.endsWith(".json")) {
          runs.push(await this.load(name.replace(/\.json$/, "")));
        }
      }
      return runs.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    },
    pathFor(runId) {
      if (!/^[A-Za-z0-9_-]+$/.test(runId)) {
        throw new Error("Invalid profile run id");
      }
      return join(normalizedRoot, `${runId}.json`);
    }
  };
}

export function estimateUsageCostUsd(usage: ModelUsage | undefined, rates: CostRates | undefined): number {
  if (!usage || !rates) {
    return 0;
  }

  const baseInputRate = rates.inputUsdPerMillionTokens ?? 0;
  const input = ((usage.inputTokens ?? 0) / 1_000_000) * baseInputRate;
  const output = ((usage.outputTokens ?? 0) / 1_000_000) * (rates.outputUsdPerMillionTokens ?? 0);
  // Cache writes default to the base input rate (Anthropic's actual
  // premium varies by model and is small; users can override via the
  // `MYAGENT_CACHE_WRITE_USD_PER_MTOK` env var). Cache reads default to
  // zero unless the user supplies the discounted rate.
  const cacheWriteRate = rates.cacheWriteUsdPerMillionTokens ?? baseInputRate;
  const cacheWrite =
    ((usage.cacheCreationInputTokens ?? 0) / 1_000_000) * cacheWriteRate;
  const cacheRead =
    ((usage.cacheReadInputTokens ?? 0) / 1_000_000) * (rates.cacheReadUsdPerMillionTokens ?? 0);
  return roundCost(input + output + cacheWrite + cacheRead);
}

export function formatProfileReport(run: ProfileRun, path?: string): string {
  const lines = [
    `[profile] ${run.runId} ${run.status}`,
    `durationMs: ${run.durationMs ?? 0}`,
    `checkpoints: ${run.checkpoints.length}`,
    `metrics: ${run.metrics.length}`
  ];

  if (path) {
    lines.push(`path: ${normalizePath(path)}`);
  }

  if (run.metrics.length > 0) {
    lines.push("metric summary:");
    for (const metric of run.metrics) {
      lines.push(`- ${metric.name}: ${metric.value} ${metric.unit}`);
    }
  }

  if (run.checkpoints.length > 0) {
    lines.push("checkpoint summary:");
    for (const checkpoint of run.checkpoints) {
      const duration = checkpoint.durationMs === undefined ? `at ${checkpoint.atMs}ms` : `${checkpoint.durationMs}ms`;
      lines.push(`- ${checkpoint.name}: ${duration}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function sanitizeMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value !== undefined)
  );
}

function compactTimestamp(iso: string): string {
  return iso.replace(/[-:.TZ]/g, "").slice(0, 14);
}

function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function roundMetric(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function roundCost(value: number): number {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}
