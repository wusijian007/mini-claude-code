import { open, readFile, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { normalizePath } from "./state.js";

export type SkillSource = "project" | "mcp";

export type SkillSummary = {
  name: string;
  description: string;
  source: SkillSource;
  path: string;
};

export type SkillSnapshot = {
  rootDir: string;
  loadedAt: string;
  skills: readonly SkillSummary[];
};

export type LoadedSkill = SkillSummary & {
  body: string;
  safetyNotes: readonly string[];
};

const FRONTMATTER_READ_BYTES = 16_384;
const SHELL_FENCE_PATTERN = /```(?:bash|sh|shell|powershell|ps1|cmd|bat)\b[\s\S]*?```/gi;

export async function scanSkillSnapshot(cwd: string, rootDir?: string): Promise<SkillSnapshot> {
  const resolvedRoot = normalizePath(resolve(rootDir ?? join(cwd, ".myagent", "skills")));
  const skills: SkillSummary[] = [];
  const entries = await readdir(resolvedRoot, { withFileTypes: true }).catch(() => []);

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) {
      continue;
    }

    const path = normalizePath(join(resolvedRoot, entry.name, "SKILL.md"));
    const summary = await readSkillSummary(path, entry.name).catch(() => null);
    if (summary) {
      skills.push(summary);
    }
  }

  return Object.freeze({
    rootDir: resolvedRoot,
    loadedAt: new Date().toISOString(),
    skills: Object.freeze(skills)
  });
}

export async function loadSkill(snapshot: SkillSnapshot, name: string): Promise<LoadedSkill | null> {
  const summary = snapshot.skills.find((skill) => skill.name === name);
  if (!summary) {
    return null;
  }

  const raw = await readFile(summary.path, "utf8");
  const parsed = splitFrontmatter(raw);
  const body = sanitizeSkillBody(summary, parsed.body.trim());
  return {
    ...summary,
    body: body.text,
    safetyNotes: body.safetyNotes
  };
}

export async function loadSkills(
  snapshot: SkillSnapshot,
  names: readonly string[]
): Promise<LoadedSkill[]> {
  const uniqueNames = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
  const loaded: LoadedSkill[] = [];
  for (const name of uniqueNames) {
    const skill = await loadSkill(snapshot, name);
    if (skill) {
      loaded.push(skill);
    }
  }
  return loaded;
}

export function formatSkillContext(skills: readonly LoadedSkill[]): string {
  if (skills.length === 0) {
    return "";
  }

  const lines = [
    "Active skills:",
    "Use these skill instructions only when relevant to the current request."
  ];
  for (const skill of skills) {
    lines.push(`\n## ${skill.name}`);
    lines.push(`Source: ${skill.source}`);
    lines.push(skill.body);
    for (const note of skill.safetyNotes) {
      lines.push(`[skill safety] ${note}`);
    }
  }

  return lines.join("\n").trim();
}

async function readSkillSummary(path: string, fallbackName: string): Promise<SkillSummary | null> {
  const raw = await readFilePrefix(path, FRONTMATTER_READ_BYTES);
  const parsed = splitFrontmatter(raw);
  if (!parsed.frontmatter) {
    return null;
  }

  const meta = parseFrontmatter(parsed.frontmatter);
  const name = meta.name ?? fallbackName;
  const description = meta.description ?? "";
  const source = meta.source === "mcp" ? "mcp" : "project";
  return {
    name,
    description,
    source,
    path
  };
}

async function readFilePrefix(path: string, bytes: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function splitFrontmatter(raw: string): { frontmatter: string | null; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return { frontmatter: null, body: raw };
  }
  return {
    frontmatter: match[1] ?? "",
    body: raw.slice(match[0].length)
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

function sanitizeSkillBody(
  summary: SkillSummary,
  body: string
): { text: string; safetyNotes: string[] } {
  if (summary.source !== "mcp") {
    return { text: body, safetyNotes: [] };
  }

  const stripped = body.replace(SHELL_FENCE_PATTERN, "[omitted inline shell block from MCP skill]");
  const safetyNotes =
    stripped === body
      ? []
      : ["Inline shell blocks from MCP-sourced skills are omitted and never executed."];
  return {
    text: stripped,
    safetyNotes
  };
}

export function skillDisplayName(summary: Pick<SkillSummary, "name" | "description">): string {
  return summary.description ? `${summary.name} - ${summary.description}` : summary.name;
}

export function defaultSkillDirectoryName(name: string): string {
  return basename(name).replace(/[^A-Za-z0-9_-]/g, "-") || "skill";
}
