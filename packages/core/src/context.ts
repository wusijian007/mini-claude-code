import { messageContentToText, type ModelUsage } from "./model.js";
import type { Message, MessageContent } from "./types.js";

const CHARS_PER_TOKEN = 4;
const DEFAULT_SNIP_CHARS = 2_000;

export type TokenBudget = {
  estimatedTokens: number;
  source: "api_usage" | "estimate";
};

export type CompactOptions = {
  targetTokens?: number;
  keepFirstMessages?: number;
  keepLastMessages?: number;
  maxMessageChars?: number;
  /**
   * Synchronously invoked with the (unsnipped) messages that were dropped
   * by compaction. Callers can capture this slice to persist it as an
   * archive on disk so the compaction is reversible / inspectable.
   * Not called if no messages were omitted.
   */
  archiveSink?: (omitted: readonly Message[]) => void;
};

export function estimateTokensForText(text: string): number {
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}

export function estimateMessageTokens(message: Message): number {
  return estimateTokensForText(message.role) + estimateTokensForText(messageContentToText(message.content));
}

export function estimateMessagesTokens(messages: readonly Message[]): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

export function tokenBudgetFromUsage(
  usage: ModelUsage | undefined,
  fallbackMessages: readonly Message[]
): TokenBudget {
  if (usage && (usage.inputTokens !== undefined || usage.outputTokens !== undefined)) {
    return {
      estimatedTokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
      source: "api_usage"
    };
  }

  return {
    estimatedTokens: estimateMessagesTokens(fallbackMessages),
    source: "estimate"
  };
}

export function compactMessages(
  messages: readonly Message[],
  options: CompactOptions = {}
): Message[] {
  const targetTokens = options.targetTokens ?? 8_000;
  const keepFirst = options.keepFirstMessages ?? 1;
  const keepLast = options.keepLastMessages ?? 6;
  const maxMessageChars = options.maxMessageChars ?? DEFAULT_SNIP_CHARS;
  const snipped = messages.map((message) => snipMessage(message, maxMessageChars));

  if (estimateMessagesTokens(snipped) <= targetTokens || snipped.length <= keepFirst + keepLast) {
    return snipped;
  }

  const first = snipped.slice(0, keepFirst);
  const last = snipped.slice(-keepLast);
  const omitted = snipped.slice(keepFirst, -keepLast);
  const omittedTokens = estimateMessagesTokens(omitted);
  // Hand the dropped slice to the caller so it can be archived on disk.
  // Pass the *original* (unsnipped) messages — snipped content would be lossy.
  const omittedOriginal = messages.slice(keepFirst, messages.length - keepLast);
  if (omittedOriginal.length > 0) {
    options.archiveSink?.(omittedOriginal);
  }

  return [
    ...first,
    {
      role: "assistant",
      content: `[context compacted: ${omitted.length} messages omitted, about ${omittedTokens} estimated tokens removed]`
    },
    ...last
  ];
}

function snipMessage(message: Message, maxChars: number): Message {
  if (typeof message.content === "string") {
    return {
      ...message,
      content: snipText(message.content, maxChars)
    };
  }

  return {
    ...message,
    content: message.content.map((block) => {
      if (block.type === "text") {
        return {
          ...block,
          text: snipText(block.text, maxChars)
        };
      }

      if (block.type === "tool_result") {
        return {
          ...block,
          result: {
            ...block.result,
            content: snipText(block.result.content, maxChars)
          }
        };
      }

      return block;
    }) as MessageContent
  };
}

function snipText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  const half = Math.floor(maxChars / 2);
  return `${text.slice(0, half)}\n[snip: ${text.length - maxChars} chars omitted]\n${text.slice(-half)}`;
}
