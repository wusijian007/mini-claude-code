import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const packagesRoot = join(repoRoot, "packages");

const FORBIDDEN_PATTERNS: ReadonlyArray<{ name: string; regex: RegExp }> = [
  // Hardcoded drive-letter absolute paths (Windows-only).
  { name: "Windows drive-letter path", regex: /["'][A-Za-z]:[\\/]/ },
  // Hardcoded POSIX home paths that bake in a specific user.
  { name: "hardcoded /home/<user>/ path", regex: /["']\/home\/[A-Za-z0-9_.-]+\// },
  // Hardcoded macOS Users path.
  { name: "hardcoded /Users/<user>/ path", regex: /["']\/Users\/[A-Za-z0-9_.-]+\// }
];

// Paths (relative to repo root, posix-normalised) allowed to mention these
// patterns. The security/ test dirs intentionally embed the forbidden
// literals to assert the runtime rejects them.
const ALLOWLIST_PREFIXES: ReadonlyArray<string> = [
  "packages/core/test/security/",
  "packages/tools/test/security/"
];

function isAllowlisted(relPath: string): boolean {
  return ALLOWLIST_PREFIXES.some((prefix) => relPath.startsWith(prefix));
}

function listTestFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      out.push(...listTestFiles(full));
    } else if (entry.isFile() && /\.test\.ts$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe("security: test file platform-path hygiene", () => {
  it("no test file embeds a platform-specific absolute path literal", () => {
    expect(statSync(packagesRoot).isDirectory()).toBe(true);
    const files = listTestFiles(packagesRoot);
    const violations: string[] = [];

    for (const file of files) {
      const rel = relative(repoRoot, file).replace(/[\\/]/g, "/");
      if (isAllowlisted(rel)) continue;
      const content = readFileSync(file, "utf8");
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        for (const { name, regex } of FORBIDDEN_PATTERNS) {
          if (regex.test(line)) {
            violations.push(`${rel}:${index + 1}  [${name}]  ${line.trim()}`);
          }
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `Hardcoded platform paths in test files (use node:path + process.cwd()/os.tmpdir() instead):\n  ${violations.join("\n  ")}`
      );
    }
  });

  it("finds at least one .test.ts under packages/ (sanity)", () => {
    const files = listTestFiles(packagesRoot);
    expect(files.length).toBeGreaterThan(5);
    // Smoke-check the helper resolves the repo correctly.
    expect(files.some((f) => f.endsWith(`${sep}state.test.ts`))).toBe(true);
  });
});
