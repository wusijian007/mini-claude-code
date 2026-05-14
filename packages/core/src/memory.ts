import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";

import { normalizePath } from "./state.js";

export type MemoryTaxonomy = "user" | "feedback" | "project" | "reference";

export type MemoryEntry = {
  id: string;
  taxonomy: MemoryTaxonomy;
  content: string;
  createdAt: string;
  updatedAt: string;
  path: string;
  source?: string;
};

export type MemorySaveInput = {
  taxonomy: MemoryTaxonomy;
  content: string;
  source?: string;
  now?: Date;
};

export type MemorySaveResult =
  | {
      ok: true;
      entry: MemoryEntry;
    }
  | {
      ok: false;
      reason: string;
    };

export type MemoryRecallOptions = {
  query: string;
  entries: readonly MemoryEntry[];
  maxEntries?: number;
  now?: Date;
};

export type MemoryStore = {
  rootDir: string;
  projectSlug: string;
  save(input: MemorySaveInput): Promise<MemorySaveResult>;
  load(): Promise<MemoryEntry[]>;
  recall(query: string, options?: Omit<MemoryRecallOptions, "query" | "entries">): Promise<MemoryEntry[]>;
  formatContext(query: string, options?: Omit<MemoryRecallOptions, "query" | "entries">): Promise<string>;
  pathFor(entry: Pick<MemoryEntry, "taxonomy" | "id">): string;
  indexPath(): string;
};

const TAXONOMIES: readonly MemoryTaxonomy[] = ["user", "feedback", "project", "reference"];
const STALE_MEMORY_MS = 24 * 60 * 60 * 1000;
const MAX_MEMORY_CONTENT_CHARS = 4_000;

export function isMemoryTaxonomy(value: string): value is MemoryTaxonomy {
  return TAXONOMIES.includes(value as MemoryTaxonomy);
}

export function createMemoryStore(cwd: string, rootDir?: string): MemoryStore {
  const projectSlug = projectSlugForPath(cwd);
  const normalizedRoot = normalizePath(
    resolve(rootDir ?? join(cwd, ".myagent", "projects", projectSlug, "memory"))
  );

  return {
    rootDir: normalizedRoot,
    projectSlug,
    async save(input) {
      const normalized = normalizeMemoryContent(input.content);
      if (!normalized.ok) {
        return normalized;
      }

      const rejectedReason = memoryRejectionReason(normalized.content);
      if (rejectedReason) {
        return {
          ok: false,
          reason: rejectedReason
        };
      }

      const now = (input.now ?? new Date()).toISOString();
      const id = `mem_${compactTimestamp(now)}_${hashShort(
        `${input.taxonomy}:${normalized.content}:${now}`
      )}`;
      const entry: MemoryEntry = {
        id,
        taxonomy: input.taxonomy,
        content: normalized.content,
        createdAt: now,
        updatedAt: now,
        path: `${input.taxonomy}/${id}.md`,
        source: input.source
      };

      await mkdir(join(normalizedRoot, input.taxonomy), { recursive: true });
      await writeFile(this.pathFor(entry), serializeMemoryEntry(entry), "utf8");
      await writeMemoryIndex(normalizedRoot, projectSlug, await this.load());
      return { ok: true, entry };
    },
    async load() {
      const entries: MemoryEntry[] = [];
      for (const taxonomy of TAXONOMIES) {
        const dir = join(normalizedRoot, taxonomy);
        const names = await readdir(dir).catch(() => []);
        for (const name of names.sort()) {
          if (!name.endsWith(".md")) {
            continue;
          }
          const absolutePath = join(dir, name);
          const content = await readFile(absolutePath, "utf8").catch(() => "");
          if (!content.trim()) {
            continue;
          }
          const info = await stat(absolutePath).catch(() => null);
          entries.push(parseMemoryEntry(content, taxonomy, name, info?.mtime.toISOString()));
        }
      }
      return entries.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    },
    async recall(query, options = {}) {
      return recallMemories({
        query,
        entries: await this.load(),
        ...options
      });
    },
    async formatContext(query, options = {}) {
      return formatMemoryContext(await this.recall(query, options), options.now);
    },
    pathFor(entry) {
      return join(normalizedRoot, entry.taxonomy, `${entry.id}.md`);
    },
    indexPath() {
      return join(normalizedRoot, "MEMORY.md");
    }
  };
}

export function projectSlugForPath(cwd: string): string {
  const normalized = normalizePath(resolve(cwd));
  const name = slugify(basename(normalized) || "project");
  return `${name}-${hashShort(normalized)}`;
}

export function recallMemories(options: MemoryRecallOptions): MemoryEntry[] {
  const maxEntries = options.maxEntries ?? 6;
  const queryTokens = tokenizeForMemory(options.query);
  const scored = options.entries.map((entry) => ({
    entry,
    score: scoreMemoryEntry(entry, queryTokens)
  }));
  const sorted = scored
    .filter((item) => item.score > 0 || options.entries.length <= maxEntries)
    .sort((left, right) => right.score - left.score || right.entry.updatedAt.localeCompare(left.entry.updatedAt));

  return sorted.slice(0, maxEntries).map((item) => item.entry);
}

export function formatMemoryContext(entries: readonly MemoryEntry[], now = new Date()): string {
  if (entries.length === 0) {
    return "";
  }

  const lines = [
    "Long-term memory recall:",
    "Use these preferences or constraints when relevant. Do not treat memory as proof of current code behavior."
  ];

  for (const entry of entries) {
    const staleWarning = isStaleMemory(entry, now) ? " [stale: older than 1 day; verify before relying]" : "";
    lines.push(`- [${entry.taxonomy}] ${entry.content}${staleWarning}`);
  }

  return lines.join("\n");
}

export function memoryRejectionReason(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed) {
    return "Memory content is empty";
  }

  if (trimmed.length > MAX_MEMORY_CONTENT_CHARS) {
    return `Memory content must be <= ${MAX_MEMORY_CONTENT_CHARS} characters`;
  }

  const lower = trimmed.toLowerCase();
  const forbiddenPatterns: Array<[RegExp, string]> = [
    [/```|^\s*(import|export|const|let|var|function|class)\s/m, "Do not save code patterns as memory"],
    [/\b(src|packages|lib|test|tests)\/[\w./-]+\.(ts|tsx|js|jsx|py|go|rs)\b/i, "Do not save codebase facts that can be re-derived from files"],
    [/\b(latest|last|previous|current)\s+(git\s+)?(commit|branch|diff)\b|\bgit\s+(log|history)\b|\bcommit\s+[0-9a-f]{7,40}\b|\b[0-9a-f]{7,40}\b.*\b(commit|sha)\b/i, "Do not save git history or repository state as memory"],
    [/\b(todo|fixme)\b/i, "Do not save temporary codebase observations as memory"]
  ];

  for (const [pattern, reason] of forbiddenPatterns) {
    if (pattern.test(trimmed) || pattern.test(lower)) {
      return reason;
    }
  }

  return null;
}

function normalizeMemoryContent(content: string): { ok: true; content: string } | { ok: false; reason: string } {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return { ok: false, reason: "Memory content is empty" };
  }
  if (normalized.length > MAX_MEMORY_CONTENT_CHARS) {
    return {
      ok: false,
      reason: `Memory content must be <= ${MAX_MEMORY_CONTENT_CHARS} characters`
    };
  }
  return { ok: true, content: normalized };
}

async function writeMemoryIndex(rootDir: string, projectSlug: string, entries: readonly MemoryEntry[]): Promise<void> {
  await mkdir(rootDir, { recursive: true });
  await writeFile(join(rootDir, "MEMORY.md"), renderMemoryIndex(projectSlug, entries), "utf8");
}

function renderMemoryIndex(projectSlug: string, entries: readonly MemoryEntry[]): string {
  const lines = [
    "# myagent memory",
    "",
    `Project: ${projectSlug}`,
    `Updated: ${new Date().toISOString()}`,
    "",
    "This index is generated from editable memory files under the taxonomy folders.",
    ""
  ];

  for (const taxonomy of TAXONOMIES) {
    lines.push(`## ${taxonomy}`);
    const group = entries.filter((entry) => entry.taxonomy === taxonomy);
    if (group.length === 0) {
      lines.push("- _empty_");
    } else {
      for (const entry of group) {
        lines.push(`- [${entry.id}](${entry.path}) - ${preview(entry.content)}`);
      }
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function serializeMemoryEntry(entry: MemoryEntry): string {
  const frontmatter = [
    "---",
    `id: ${entry.id}`,
    `taxonomy: ${entry.taxonomy}`,
    `createdAt: ${entry.createdAt}`,
    `updatedAt: ${entry.updatedAt}`,
    entry.source ? `source: ${entry.source}` : undefined,
    "---"
  ].filter((line): line is string => line !== undefined);

  return `${frontmatter.join("\n")}\n\n${entry.content}\n`;
}

function parseMemoryEntry(
  raw: string,
  fallbackTaxonomy: MemoryTaxonomy,
  fileName: string,
  fallbackUpdatedAt?: string
): MemoryEntry {
  const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const meta = frontmatter ? parseFrontmatter(frontmatter[1] ?? "") : {};
  const body = frontmatter ? raw.slice(frontmatter[0].length).trim() : raw.trim();
  const taxonomy = isMemoryTaxonomy(meta.taxonomy ?? "") ? (meta.taxonomy as MemoryTaxonomy) : fallbackTaxonomy;
  const id = meta.id ?? fileName.replace(/\.md$/, "");
  const updatedAt = meta.updatedAt ?? fallbackUpdatedAt ?? new Date(0).toISOString();
  return {
    id,
    taxonomy,
    content: body,
    createdAt: meta.createdAt ?? updatedAt,
    updatedAt,
    path: `${taxonomy}/${id}.md`,
    source: meta.source
  };
}

function parseFrontmatter(raw: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const index = line.indexOf(":");
    if (index === -1) {
      continue;
    }
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (key) {
      values[key] = value;
    }
  }
  return values;
}

function scoreMemoryEntry(entry: MemoryEntry, queryTokens: readonly string[]): number {
  let score = entry.taxonomy === "project" || entry.taxonomy === "user" ? 1 : 0;
  const contentTokens = new Set(tokenizeForMemory(entry.content));
  for (const token of queryTokens) {
    if (contentTokens.has(token) || entry.content.toLowerCase().includes(token)) {
      score += 3;
    }
  }
  return score;
}

function tokenizeForMemory(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function isStaleMemory(entry: MemoryEntry, now: Date): boolean {
  const updatedAt = Date.parse(entry.updatedAt);
  if (Number.isNaN(updatedAt)) {
    return true;
  }
  return now.getTime() - updatedAt > STALE_MEMORY_MS;
}

function compactTimestamp(iso: string): string {
  return iso.replace(/[-:.TZ]/g, "").slice(0, 14);
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "project";
}

function preview(content: string): string {
  const oneLine = content.replace(/\s+/g, " ").trim();
  return oneLine.length > 100 ? `${oneLine.slice(0, 97)}...` : oneLine;
}

function hashShort(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

export function toProjectRelativeMemoryPath(cwd: string, absolutePath: string): string {
  return normalizePath(relative(cwd, absolutePath));
}
