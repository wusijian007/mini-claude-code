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

export type TieredCompactOptions = {
  targetTokens?: number;
  /** Messages at the head kept verbatim (the root task). Default 1. */
  rootMessages?: number;
  /** Messages at the tail kept verbatim (recent, most-relevant). Default 6. */
  recentWindowMessages?: number;
  /** tool_result content longer than this (chars) gets pointer-ized. Default 600. */
  pointerizeOverChars?: number;
  /** Stale text blocks snipped to this many chars. Default DEFAULT_SNIP_CHARS. */
  maxTextChars?: number;
  archiveSink?: (omitted: readonly Message[]) => void;
};

/**
 * M3.2a — tiered, deterministic "smart" compaction.
 *
 * Unlike the legacy {@link compactMessages} (which drops a contiguous middle
 * slice and risks orphaning a tool_use/tool_result pair), this shrinks stale
 * messages IN PLACE so every pairing stays valid:
 *
 * - root task (first `rootMessages`) — kept verbatim
 * - recent window (last `recentWindowMessages`) — kept verbatim
 * - stale zone in between:
 *     - large tool_result blocks  -> a compact pointer ("[archived <tool>(...)
 *       result: N chars -> <artifactPath>]"); the file/output is re-readable
 *       on disk, and these are the dominant token cost in an agent transcript
 *     - long text blocks          -> snipped head+tail
 *     - tool_use blocks           -> untouched (tiny: name + input)
 *
 * Token reduction comes from pointer-izing the whales, not from dropping
 * messages. Deterministic by construction (no model call) -> eval-safe.
 *
 * Compaction is an amortized cache-reset: it rewrites the stale prefix once
 * (one cache miss), then the new prefix is the cache base for many turns.
 * Callers should trigger it infrequently and compact aggressively (well
 * below target) to maximize turns-between-compactions.
 *
 * If shrink-in-place still leaves the transcript over `targetTokens` (rare:
 * a conversation dominated by many small non-tool messages), it falls back
 * to the legacy drop-middle compaction on top.
 */
export function compactMessagesTiered(
  messages: readonly Message[],
  options: TieredCompactOptions = {}
): Message[] {
  const target = options.targetTokens ?? 8_000;
  const root = Math.max(0, options.rootMessages ?? 1);
  const recent = Math.max(0, options.recentWindowMessages ?? 6);
  const pointerOver = options.pointerizeOverChars ?? 600;
  const maxText = options.maxTextChars ?? DEFAULT_SNIP_CHARS;

  // Already within budget — return untouched so the cached prefix survives.
  if (estimateMessagesTokens(messages) <= target) {
    return [...messages];
  }

  const n = messages.length;
  if (n <= root + recent) {
    // Not enough stale middle to tier — defer to legacy snip (archives itself).
    return compactMessages(messages, {
      targetTokens: target,
      maxMessageChars: maxText,
      archiveSink: options.archiveSink
    });
  }

  // Correlate tool_result blocks back to their originating tool_use (which
  // carries the human-meaningful name + input) for the pointer text.
  const toolMeta = new Map<string, { name: string; input: Record<string, unknown> }>();
  for (const message of messages) {
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === "tool_use") {
          toolMeta.set(block.toolUse.id, { name: block.toolUse.name, input: block.toolUse.input });
        }
      }
    }
  }

  const staleStart = root;
  const staleEnd = n - recent; // exclusive
  const staleOriginal = messages.slice(staleStart, staleEnd);
  if (staleOriginal.length > 0) {
    options.archiveSink?.(staleOriginal);
  }

  const shrunk = messages.map((message, index) => {
    if (index < staleStart || index >= staleEnd) {
      return message;
    }
    return shrinkStaleMessage(message, toolMeta, pointerOver, maxText);
  });

  if (estimateMessagesTokens(shrunk) > target) {
    // Shrink wasn't enough — drop the middle as a last resort. Original stale
    // slice is already archived above, so pass no archiveSink (avoid double).
    return compactMessages(shrunk, {
      targetTokens: target,
      keepFirstMessages: root,
      keepLastMessages: recent,
      maxMessageChars: maxText
    });
  }

  return shrunk;
}

function shrinkStaleMessage(
  message: Message,
  toolMeta: ReadonlyMap<string, { name: string; input: Record<string, unknown> }>,
  pointerOver: number,
  maxText: number
): Message {
  if (typeof message.content === "string") {
    return { ...message, content: snipText(message.content, maxText) };
  }

  return {
    ...message,
    content: message.content.map((block) => {
      if (block.type === "text") {
        return { ...block, text: snipText(block.text, maxText) };
      }
      if (block.type === "tool_result" && block.result.content.length > pointerOver) {
        const meta = toolMeta.get(block.result.toolUseId);
        const pointer = formatToolResultPointer(block.result.content.length, block.result.artifactPath, meta);
        return {
          ...block,
          result: { ...block.result, content: pointer }
        };
      }
      return block;
    }) as MessageContent
  };
}

function formatToolResultPointer(
  originalChars: number,
  artifactPath: string | undefined,
  meta: { name: string; input: Record<string, unknown> } | undefined
): string {
  const tool = meta ? `${meta.name}(${summarizeToolInput(meta.input)})` : "tool";
  const where = artifactPath ? ` -> ${artifactPath}` : " (re-run the tool to see full output)";
  return `[archived ${tool} result: ${originalChars} chars omitted${where}]`;
}

function summarizeToolInput(input: Record<string, unknown>): string {
  // Prefer the one salient identifier; fall back to a truncated JSON.
  for (const key of ["path", "pattern", "command", "query"]) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) {
      return value.length > 80 ? `${value.slice(0, 80)}...` : value;
    }
  }
  const json = JSON.stringify(input);
  return json.length > 80 ? `${json.slice(0, 80)}...` : json;
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
