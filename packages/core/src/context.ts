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

export type UsageAnchor = {
  /** Exact server-side prompt tokens of the last request (input + cache_read + cache_creation). */
  promptTokens: number;
  /** Number of messages that were in that request — the strict-extension prefix length. */
  messageCount: number;
};

/**
 * M4.0 — usage-anchored token estimate. The last API usage gives the EXACT
 * server-side prompt-token count of the prefix that was already sent (system +
 * tools + the first `messageCount` messages); only the messages appended since
 * are estimated (chars/4). Error stays small because the bulk — the prefix — is
 * exact and only the recent delta is guessed (<5% in practice). Falls back to a
 * full heuristic estimate when there is no anchor, or when the transcript is
 * shorter than the anchored prefix (e.g. right after a compaction rewrote it).
 */
export function estimateAnchoredTokens(
  messages: readonly Message[],
  anchor: UsageAnchor | undefined
): number {
  if (!anchor || messages.length < anchor.messageCount) {
    return estimateMessagesTokens(messages);
  }
  return anchor.promptTokens + estimateMessagesTokens(messages.slice(anchor.messageCount));
}

export type CompactionStage = {
  name: string;
  run(messages: readonly Message[]): Promise<readonly Message[]> | readonly Message[];
};

/**
 * M4.0 — the pre-flight compaction cascade (Claude Code five-layer pipeline;
 * see docs/v4-compaction-pipeline-roadmap.md). Runs stages cheapest-first and
 * SHORT-CIRCUITS as soon as the transcript is under target, so an expensive
 * later layer only acts if the cheaper earlier ones did not free enough. Same
 * shape as the M3.5 done-gate chain: an ordered list with early exit.
 */
export async function runCompactionPipeline(
  messages: readonly Message[],
  options: {
    stages: readonly CompactionStage[];
    isUnderTarget: (messages: readonly Message[]) => boolean;
  }
): Promise<{ messages: Message[]; ranStages: string[] }> {
  let current: Message[] = [...messages];
  const ranStages: string[] = [];
  for (const stage of options.stages) {
    if (options.isUnderTarget(current)) {
      break;
    }
    current = [...(await stage.run(current))];
    ranStages.push(stage.name);
  }
  return { messages: current, ranStages };
}

export type SnipScaffoldingOptions = {
  /** Messages at the head kept verbatim (the root task). Default 1. */
  rootMessages?: number;
  /** Messages at the tail kept verbatim (recent, most-relevant). Default 6. */
  recentWindowMessages?: number;
  /** Stale tool_result content longer than this (chars) gets snipped to a marker. Default 200. */
  snipOverChars?: number;
};

/**
 * M4.2 (L2) — deterministically drop stale tool SCAFFOLDING. In the stale zone
 * (outside the root task and the recent window) it replaces oversized
 * `tool_result` content with a tiny marker — the dominant token cost of old
 * tool turns — while leaving `tool_use` blocks (tiny), prose/reasoning text, and
 * user turns ALONE. Prose is intentionally untouched: that is L5's job
 * (semantic recap); L2 only reclaims the cheap, low-value tool apparatus.
 * Pairing is always safe because blocks are snipped in place, never removed.
 * The artifactPath (if any) is preserved so the full output stays restorable.
 */
export function snipStaleToolScaffolding(
  messages: readonly Message[],
  options: SnipScaffoldingOptions = {}
): Message[] {
  const root = Math.max(0, options.rootMessages ?? 1);
  const recent = Math.max(0, options.recentWindowMessages ?? 6);
  const snipOver = options.snipOverChars ?? 200;
  const staleStart = root;
  const staleEnd = Math.max(staleStart, messages.length - recent);

  return messages.map((message, index) => {
    if (index < staleStart || index >= staleEnd || !Array.isArray(message.content)) {
      return message;
    }
    let changed = false;
    const blocks = message.content.map((block) => {
      if (block.type === "tool_result" && block.result.content.length > snipOver) {
        changed = true;
        return {
          ...block,
          result: {
            ...block.result,
            content: `[stale tool result snipped: ${block.result.content.length} chars${
              block.result.artifactPath ? ` -> ${block.result.artifactPath}` : ""
            }]`
          }
        };
      }
      return block;
    });
    return changed ? { ...message, content: blocks as MessageContent } : message;
  });
}

export type CollapseViewOptions = {
  /** Messages at the head kept verbatim (the root task). Default 1. */
  rootMessages?: number;
  /** Messages at the tail kept verbatim (recent, most-relevant). Default 6. */
  recentWindowMessages?: number;
};

/**
 * M4.4 (L4) — context collapse: a REVERSIBLE VIEW of the transcript. Replaces
 * the stale region (between root and the recent window) with a single
 * deterministic collapse marker, keeping the root task + recent window. Unlike
 * the destructive cascade this does NOT mutate its input — the caller SENDS the
 * returned view while keeping the canonical `messages` intact, so it is fully
 * reversible (each turn re-derives the view from the unchanged history; the
 * originals can always be restored). The recent-window start is snapped past a
 * leading `tool_result` so no `tool_use` is orphaned in the view.
 */
export function collapseMessagesView(
  messages: readonly Message[],
  options: CollapseViewOptions = {}
): Message[] {
  const root = Math.max(0, options.rootMessages ?? 1);
  const recent = Math.max(0, options.recentWindowMessages ?? 6);
  const n = messages.length;
  let recentStart = Math.max(root, n - recent);
  while (recentStart > root && messages[recentStart]?.role === "tool") {
    recentStart -= 1;
  }
  const staleSlice = messages.slice(root, recentStart);
  if (staleSlice.length === 0) {
    return [...messages];
  }
  return [
    ...messages.slice(0, root),
    {
      role: "assistant",
      content: `[context collapsed: ${staleSlice.length} earlier turn(s) hidden from view; full history retained and restorable]`
    },
    ...messages.slice(recentStart)
  ];
}

export type MicrocompactOptions = {
  /** Number of newest tool_result blocks kept verbatim; older ones are cleared. Default 3. */
  keepRecentToolResults?: number;
  /** Only clear tool_result content longer than this (chars). Default 200. */
  clearOverChars?: number;
};

/**
 * M4.3 (L3) — microcompact: keep the N NEWEST tool_result blocks verbatim and
 * clear every older one to a marker (count-based, transcript-wide — so it
 * reaches tool results inside the recent window too, unlike L2's stale-zone
 * snip). This is the more aggressive deterministic reclaim; the query loop only
 * applies it on the cache-COLD path (the prefix it rewrites is already expired,
 * so the rewrite is free), and defers on the cache-HOT path to preserve the
 * warm prefix. `artifactPath` is preserved so the full output stays restorable.
 */
export function microcompactToolResults(
  messages: readonly Message[],
  options: MicrocompactOptions = {}
): Message[] {
  const keep = Math.max(0, options.keepRecentToolResults ?? 3);
  const clearOver = options.clearOverChars ?? 200;

  const positions: Array<`${number}:${number}`> = [];
  messages.forEach((message, mi) => {
    if (Array.isArray(message.content)) {
      message.content.forEach((block, bi) => {
        if (block.type === "tool_result") {
          positions.push(`${mi}:${bi}`);
        }
      });
    }
  });
  const clearCount = Math.max(0, positions.length - keep);
  const clearSet = new Set(positions.slice(0, clearCount));

  return messages.map((message, mi) => {
    if (!Array.isArray(message.content)) {
      return message;
    }
    let changed = false;
    const blocks = message.content.map((block, bi) => {
      if (
        block.type === "tool_result" &&
        clearSet.has(`${mi}:${bi}`) &&
        block.result.content.length > clearOver
      ) {
        changed = true;
        return {
          ...block,
          result: {
            ...block.result,
            content: `[cleared tool result: ${block.result.content.length} chars${
              block.result.artifactPath ? ` -> ${block.result.artifactPath}` : ""
            }]`
          }
        };
      }
      return block;
    });
    return changed ? { ...message, content: blocks as MessageContent } : message;
  });
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

/** M3.2c — async LLM summarizer seam: condenses the dropped stale turns into a recap. */
export type MessageSummarizer = (dropped: readonly Message[]) => Promise<string>;

export type SummarizeCompactOptions = {
  targetTokens?: number;
  /** Messages at the head kept verbatim (the root task). Default 1. */
  rootMessages?: number;
  /** Messages at the tail kept verbatim (recent, most-relevant). Default 6. */
  recentWindowMessages?: number;
  /** Required: condenses the dropped stale turns into a single recap string. */
  summarizer: MessageSummarizer;
  archiveSink?: (omitted: readonly Message[]) => void;
};

/**
 * M3.2c — opt-in semantic (LLM) compaction. Where {@link compactMessagesTiered}
 * shrinks stale messages in place (deterministic, pointer-izing the whales),
 * this REPLACES the whole stale region with a single LLM-written recap message —
 * recovering the reasoning/prose that pointers cannot. The default deterministic
 * path is untouched; this only runs when a `summarizer` is injected (CLI
 * `--semantic-compaction`).
 *
 * Boundary safety: the recent-window start is snapped earlier past any leading
 * `tool_result` (role "tool") message, so a kept tool_result never gets its
 * originating tool_use dropped into the summarized block (no orphaned pairing).
 * Root task + recent window stay verbatim.
 *
 * Like all compaction this is an amortized cache reset (it rewrites the prefix
 * once); the summarizer is non-deterministic, so tests inject a scripted fake
 * (invariant #2 — see docs/v3-kernel-roadmap.md §1 M3.2c).
 */
export async function compactMessagesWithSummary(
  messages: readonly Message[],
  options: SummarizeCompactOptions
): Promise<Message[]> {
  const target = options.targetTokens ?? 8_000;
  const root = Math.max(0, options.rootMessages ?? 1);
  const recent = Math.max(0, options.recentWindowMessages ?? 6);

  // Already within budget — return untouched so the cached prefix survives.
  if (estimateMessagesTokens(messages) <= target) {
    return [...messages];
  }

  const n = messages.length;
  // Snap recent-window start earlier past any leading tool_result so its
  // originating tool_use is never orphaned in the dropped stale block.
  let recentStart = Math.max(root, n - recent);
  while (recentStart > root && messages[recentStart]?.role === "tool") {
    recentStart -= 1;
  }

  const staleSlice = messages.slice(root, recentStart);
  if (staleSlice.length === 0) {
    // Everything is root or recent — there is no stale HISTORY to summarize
    // yet (e.g. one big recent tool_result). Semantic compaction only condenses
    // accumulated history; a pathological short-but-oversized transcript is left
    // to the reactive prompt_too_long net (deterministic compactMessages).
    return [...messages];
  }

  const recap = await options.summarizer(staleSlice);
  options.archiveSink?.(staleSlice);

  return [
    ...messages.slice(0, root),
    {
      role: "assistant",
      content: `[summary of ${staleSlice.length} earlier turn(s)]\n${recap}`
    },
    ...messages.slice(recentStart)
  ];
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
