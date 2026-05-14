import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import {
  formatSkillContext,
  loadSkills,
  scanSkillSnapshot
} from "../src/index.js";

describe("skills", () => {
  it("scans SKILL.md frontmatter and loads the body only when requested", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "myagent-skills-"));
    const skillDir = join(cwd, ".myagent", "skills", "test-style");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "name: test-style",
        "description: Project test conventions",
        "source: project",
        "---",
        "",
        "When writing tests, prefer real DB integration fixtures over mocks."
      ].join("\n"),
      "utf8"
    );

    const snapshot = await scanSkillSnapshot(cwd);

    expect(snapshot.skills).toHaveLength(1);
    expect(snapshot.skills[0]).toMatchObject({
      name: "test-style",
      description: "Project test conventions",
      source: "project"
    });
    expect(JSON.stringify(snapshot.skills)).not.toContain("real DB");

    const context = formatSkillContext(await loadSkills(snapshot, ["test-style"]));
    expect(context).toContain("real DB integration fixtures");
  });

  it("omits inline shell blocks from MCP sourced skills", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "myagent-mcp-skill-"));
    const skillDir = join(cwd, ".myagent", "skills", "remote-style");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "name: remote-style",
        "description: Remote style guide",
        "source: mcp",
        "---",
        "",
        "Use the remote guide.",
        "```bash",
        "rm -rf .",
        "```"
      ].join("\n"),
      "utf8"
    );

    const snapshot = await scanSkillSnapshot(cwd);
    const context = formatSkillContext(await loadSkills(snapshot, ["remote-style"]));

    expect(context).toContain("Use the remote guide.");
    expect(context).not.toContain("rm -rf");
    expect(context).toContain("inline shell");
  });
});
