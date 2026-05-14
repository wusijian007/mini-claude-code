import type { FakeModelStep, Message, ToolResult, ToolUse } from "../../src/index.js";

export const goldenInitialMessages = [
  {
    role: "user",
    content: "Read README.md and summarize it."
  }
] satisfies Message[];

export const goldenToolUse = {
  id: "toolu_read_readme",
  name: "Read",
  input: {
    path: "README.md"
  }
} satisfies ToolUse;

export const goldenToolResult = {
  toolUseId: goldenToolUse.id,
  status: "success",
  content: "# Mini Claude Code\n\nA learning project for building an agentic CLI."
} satisfies ToolResult;

export const goldenScript = [
  {
    type: "assistant_message",
    content: "I will inspect README.md first."
  },
  {
    type: "tool_use",
    toolUse: goldenToolUse
  },
  {
    type: "assistant_message",
    content: "README.md describes Mini Claude Code as a learning project for building an agentic CLI."
  }
] satisfies FakeModelStep[];

export const goldenEventTypes = [
  "assistant_message",
  "tool_use",
  "tool_result",
  "assistant_message",
  "terminal_state"
] as const;
