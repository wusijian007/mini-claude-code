import type { z } from "zod";
import type { ModelClient, ModelUsage, SystemTextBlock } from "./model.js";
import type { ForkTrace } from "./fork.js";
import type { ProfileRecorder } from "./profile.js";
import type { TaskStore } from "./task.js";

export type MessageRole = "user" | "assistant" | "tool";

export type TextBlock = {
  type: "text";
  text: string;
};

export type ToolUseBlock = {
  type: "tool_use";
  toolUse: ToolUse;
};

export type ToolResultBlock = {
  type: "tool_result";
  result: ToolResult;
};

export type MessageContent = string | Array<TextBlock | ToolUseBlock | ToolResultBlock>;

export type Message = {
  role: MessageRole;
  content: MessageContent;
};

export type ToolUse = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type ToolResultStatus = "success" | "error";

export type ToolResult = {
  toolUseId: string;
  status: ToolResultStatus;
  content: string;
  error?: string;
  artifactPath?: string;
};

export type JsonObjectSchema = {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
};

export type ModelToolDefinition = {
  name: string;
  description: string;
  inputSchema: JsonObjectSchema;
};

export type ToolCallResult = {
  status: ToolResultStatus;
  content: string;
  error?: string;
};

export type PermissionMode = "plan" | "default" | "bypassPermissions";

export type ToolContext = {
  cwd: string;
  permissionMode?: PermissionMode;
  abortSignal?: AbortSignal;
  artifactDir?: string;
  toolResultBudgetChars?: number;
  profile?: ProfileRecorder;
  requestPermission?: (request: PermissionRequest) => Promise<PermissionDecision> | PermissionDecision;
  hookSnapshot?: HookSnapshot;
  model?: ModelClient;
  modelName?: string;
  maxTokens?: number;
  system?: string | readonly SystemTextBlock[];
  parentMessages?: readonly Message[];
  tools?: readonly ToolDefinition[];
  taskStore?: TaskStore;
  subAgentDepth?: number;
  maxSubAgentDepth?: number;
  recordForkTrace?: (trace: ForkTrace) => Promise<void> | void;
};

export type ToolDefinition<TInput extends Record<string, unknown> = Record<string, unknown>> = {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  inputJsonSchema: JsonObjectSchema;
  maxResultSizeChars?: number;
  isReadOnly(input: TInput, context: ToolContext): boolean;
  isConcurrencySafe(input: TInput, context: ToolContext): boolean;
  cancelSiblingToolsOnError?(input: TInput, context: ToolContext): boolean;
  validateInput?(input: TInput, context: ToolContext): Promise<string | null> | string | null;
  call(input: TInput, context: ToolContext): Promise<ToolCallResult> | ToolCallResult;
};

export type TerminalStateStatus = "completed" | "aborted" | "max_turns" | "error";

export type TerminalState = {
  status: TerminalStateStatus;
  reason?: string;
  error?: string;
};

export type PermissionDecisionKind = "allow" | "deny" | "ask";

export type PermissionDecision = {
  kind: PermissionDecisionKind;
  reason?: string;
};

export type PermissionRequest = {
  toolName: string;
  input: Record<string, unknown>;
  reason: string;
};

export type HookEventName = "PreToolUse" | "PostToolUse";

export type HookCommand = {
  name: string;
  event: HookEventName;
  command: string;
  tools?: readonly string[];
  timeoutMs?: number;
};

export type HookSnapshot = {
  configPath: string;
  loadedAt: string;
  hooks: readonly HookCommand[];
};

export type HookRunPayload = {
  event: HookEventName;
  cwd: string;
  toolUse: ToolUse;
  result?: ToolResult;
};

export type HookWarning = {
  hookName: string;
  event: HookEventName;
  message: string;
};

export type HookRunResult =
  | {
      status: "passed";
      warnings: HookWarning[];
    }
  | {
      status: "blocked";
      hookName: string;
      reason: string;
      warnings: HookWarning[];
    };

export type AssistantMessageEvent = {
  type: "assistant_message";
  message: Message;
  usage?: ModelUsage;
  stopReason?: string | null;
  requestId?: string;
};

export type ToolUseEvent = {
  type: "tool_use";
  toolUse: ToolUse;
};

export type ToolResultEvent = {
  type: "tool_result";
  result: ToolResult;
};

export type TerminalStateEvent = {
  type: "terminal_state";
  state: TerminalState;
};

export type LoopEvent =
  | AssistantMessageEvent
  | ToolUseEvent
  | ToolResultEvent
  | TerminalStateEvent;
