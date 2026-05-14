import { createHash } from "node:crypto";

import type { Message, ToolDefinition } from "./types.js";

export type ForkTrace = {
  id: string;
  parentDepth: number;
  subagentType: string;
  model: string;
  systemPromptHash: string;
  toolHash: string;
  prefixHash: string;
  directiveHash: string;
  cacheMissSources: readonly string[];
};

export type ForkTraceInput = {
  parentDepth: number;
  subagentType: string;
  model: string;
  systemPrompt?: string;
  tools: readonly ToolDefinition[];
  prefixMessages: readonly Message[];
  directive: string;
  previous?: ForkTrace;
};

export function createForkTrace(input: ForkTraceInput): ForkTrace {
  const systemPromptHash = sha256(input.systemPrompt ?? "");
  const toolHash = hashToolDefinitions(input.tools);
  const prefixHash = hashMessages(input.prefixMessages);
  const directiveHash = sha256(input.directive);
  const trace: Omit<ForkTrace, "cacheMissSources"> = {
    id: `fork_${sha256(
      stableStringify({
        systemPromptHash,
        toolHash,
        prefixHash,
        directiveHash,
        parentDepth: input.parentDepth,
        subagentType: input.subagentType,
        model: input.model
      })
    ).slice(0, 12)}`,
    parentDepth: input.parentDepth,
    subagentType: input.subagentType,
    model: input.model,
    systemPromptHash,
    toolHash,
    prefixHash,
    directiveHash
  };

  return {
    ...trace,
    cacheMissSources: input.previous ? compareForkTraces(input.previous, trace) : []
  };
}

export function compareForkTraces(
  previous: Pick<ForkTrace, "systemPromptHash" | "toolHash" | "prefixHash" | "directiveHash" | "model">,
  next: Pick<ForkTrace, "systemPromptHash" | "toolHash" | "prefixHash" | "directiveHash" | "model">
): string[] {
  const sources: string[] = [];
  if (previous.systemPromptHash !== next.systemPromptHash) {
    sources.push("system_prompt");
  }
  if (previous.toolHash !== next.toolHash) {
    sources.push("tools");
  }
  if (previous.prefixHash !== next.prefixHash) {
    sources.push("message_prefix");
  }
  if (previous.directiveHash !== next.directiveHash) {
    sources.push("child_directive");
  }
  if (previous.model !== next.model) {
    sources.push("model");
  }
  return sources;
}

export function hashToolDefinitions(tools: readonly ToolDefinition[]): string {
  return sha256(
    stableStringify(
      tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputJsonSchema
      }))
    )
  );
}

export function hashMessages(messages: readonly Message[]): string {
  return sha256(stableStringify(messages));
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right)
    );
    return Object.fromEntries(entries.map(([key, item]) => [key, sortJson(item)]));
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
