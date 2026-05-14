import { executeToolUse } from "./tool.js";
import type { ToolContext, ToolDefinition, ToolResult, ToolUse } from "./types.js";

const DEFAULT_MAX_TOOL_CONCURRENCY = 10;

export type ToolCallBatch = {
  kind: "parallel" | "serial";
  toolUses: ToolUse[];
};

export type ExecuteToolBatchOptions = {
  batch: ToolCallBatch;
  toolsByName: ReadonlyMap<string, ToolDefinition>;
  context: ToolContext;
  maxConcurrency?: number;
};

export function partitionToolCalls(
  toolUses: readonly ToolUse[],
  toolsByName: ReadonlyMap<string, ToolDefinition>,
  context: ToolContext
): ToolCallBatch[] {
  const batches: ToolCallBatch[] = [];
  let pendingParallel: ToolUse[] = [];

  const flushParallel = () => {
    if (pendingParallel.length === 0) {
      return;
    }
    batches.push({ kind: "parallel", toolUses: pendingParallel });
    pendingParallel = [];
  };

  for (const toolUse of toolUses) {
    if (isConcurrencySafeToolUse(toolUse, toolsByName, context)) {
      pendingParallel.push(toolUse);
      continue;
    }

    flushParallel();
    batches.push({ kind: "serial", toolUses: [toolUse] });
  }

  flushParallel();
  return batches;
}

export async function executeToolBatch(options: ExecuteToolBatchOptions): Promise<ToolResult[]> {
  if (options.batch.kind === "serial") {
    const results: ToolResult[] = [];
    for (const toolUse of options.batch.toolUses) {
      results.push(
        await executeOneToolUse(toolUse, options.toolsByName, options.context, {
          siblingSignal: undefined
        })
      );
    }
    return results;
  }

  const siblingController = new AbortController();
  const maxConcurrency = Math.max(
    1,
    Math.floor(options.maxConcurrency ?? DEFAULT_MAX_TOOL_CONCURRENCY)
  );

  return runBounded(options.batch.toolUses, maxConcurrency, async (toolUse) => {
    const result = await executeOneToolUse(toolUse, options.toolsByName, options.context, {
      siblingSignal: siblingController.signal
    });

    if (
      result.status === "error" &&
      shouldCancelSiblingToolsOnError(toolUse, options.toolsByName, options.context)
    ) {
      siblingController.abort();
    }

    return result;
  });
}

export async function executeToolBatches(
  batches: readonly ToolCallBatch[],
  toolsByName: ReadonlyMap<string, ToolDefinition>,
  context: ToolContext,
  maxConcurrency = DEFAULT_MAX_TOOL_CONCURRENCY
): Promise<ToolResult[]> {
  const results: ToolResult[] = [];
  for (const batch of batches) {
    results.push(
      ...(await executeToolBatch({
        batch,
        toolsByName,
        context,
        maxConcurrency
      }))
    );
  }
  return results;
}

function isConcurrencySafeToolUse(
  toolUse: ToolUse,
  toolsByName: ReadonlyMap<string, ToolDefinition>,
  context: ToolContext
): boolean {
  const tool = toolsByName.get(toolUse.name);
  if (!tool) {
    return false;
  }

  const parsed = tool.inputSchema.safeParse(toolUse.input);
  if (!parsed.success) {
    return false;
  }

  return tool.isConcurrencySafe(parsed.data, context);
}

function shouldCancelSiblingToolsOnError(
  toolUse: ToolUse,
  toolsByName: ReadonlyMap<string, ToolDefinition>,
  context: ToolContext
): boolean {
  const tool = toolsByName.get(toolUse.name);
  if (!tool?.cancelSiblingToolsOnError) {
    return false;
  }

  const parsed = tool.inputSchema.safeParse(toolUse.input);
  if (!parsed.success) {
    return false;
  }

  return tool.cancelSiblingToolsOnError(parsed.data, context);
}

async function executeOneToolUse(
  toolUse: ToolUse,
  toolsByName: ReadonlyMap<string, ToolDefinition>,
  context: ToolContext,
  options: { siblingSignal: AbortSignal | undefined }
): Promise<ToolResult> {
  const perToolController = new AbortController();
  const unlinkSignals = linkAbortSignals(perToolController, [
    context.abortSignal,
    options.siblingSignal
  ]);

  try {
    const run = () =>
      executeToolUse(toolUse, toolsByName, {
        ...context,
        abortSignal: perToolController.signal
      });
    return context.profile
      ? await context.profile.time(`tool.${toolUse.name}`, run, { toolUseId: toolUse.id })
      : await run();
  } finally {
    unlinkSignals();
  }
}

async function runBounded<T, R>(
  items: readonly T[],
  maxConcurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      if (item === undefined) {
        continue;
      }
      results[index] = await worker(item, index);
    }
  }

  const workerCount = Math.min(maxConcurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

function linkAbortSignals(
  controller: AbortController,
  signals: readonly (AbortSignal | undefined)[]
): () => void {
  const cleanupCallbacks: Array<() => void> = [];

  for (const signal of signals) {
    if (!signal) {
      continue;
    }

    if (signal.aborted) {
      controller.abort();
      continue;
    }

    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    cleanupCallbacks.push(() => signal.removeEventListener("abort", abort));
  }

  return () => {
    for (const cleanup of cleanupCallbacks) {
      cleanup();
    }
  };
}
