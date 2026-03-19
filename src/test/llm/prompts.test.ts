import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { assembleSystemPrompt } from "../../llm/prompts";
import { discoverSkills, loadSkill } from "../../skills/loader";
import type { ToolDefinition } from "../../types";

const tempDirs: string[] = [];

async function createSkillsDir(): Promise<string> {
  const skillsDir = await mkdtemp(path.join(os.tmpdir(), "conductor-c1-"));
  tempDirs.push(skillsDir);
  return skillsDir;
}

async function writeSkill(skillsDir: string, name: string, content: string): Promise<void> {
  await mkdir(path.join(skillsDir, name), { recursive: true });
  await writeFile(path.join(skillsDir, name, "SKILL.md"), content, "utf8");
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dir) => rm(dir, { recursive: true, force: true })));
});

describe("skill loading", () => {
  it("loads a skill from skillsDir/name/SKILL.md", async () => {
    const skillsDir = await createSkillsDir();
    await writeSkill(skillsDir, "go-conventions", "# Go Conventions\n\nUse GoConvey.\n");

    const skill = await loadSkill(skillsDir, "go-conventions");

    expect(skill.startsWith("# Go Conventions")).toBe(true);
  });

  it("throws when a skill is missing", async () => {
    const skillsDir = await createSkillsDir();

    await expect(loadSkill(skillsDir, "missing-skill")).rejects.toThrow(/skill not found/i);
  });

  it("discovers sorted skill names that contain SKILL.md", async () => {
    const skillsDir = await createSkillsDir();
    await writeSkill(skillsDir, "b", "# B\n");
    await writeSkill(skillsDir, "a", "# A\n");
    await mkdir(path.join(skillsDir, "c"), { recursive: true });

    await expect(discoverSkills(skillsDir)).resolves.toEqual(["a", "b"]);
  });
});

describe("assembleSystemPrompt", () => {
  it("includes tool call instructions and all tool names", async () => {
    const skillsDir = await createSkillsDir();
    await writeSkill(skillsDir, "go-conventions", "# Go Conventions\n");
    await writeSkill(skillsDir, "go-implementor", "# Go Implementor\n");
    const tools: ToolDefinition[] = [
      { name: "Read", description: "Read files", parameters: {} },
      { name: "Edit", description: "Edit files", parameters: {} },
      { name: "Write", description: "Write files", parameters: {} },
      { name: "Bash", description: "Run commands", parameters: {} },
      { name: "Grep", description: "Search text", parameters: {} },
      { name: "Glob", description: "Find files", parameters: {} },
    ];

    const prompt = await assembleSystemPrompt(
      "implementor",
      skillsDir,
      "go-conventions",
      "Item 1.4 context",
      tools,
    );

    expect(prompt).toContain("<tool_call>");
    expect(prompt).toContain("Read");
    expect(prompt).toContain("Edit");
    expect(prompt).toContain("Write");
    expect(prompt).toContain("Bash");
    expect(prompt).toContain("Grep");
    expect(prompt).toContain("Glob");
  });

  it("includes the role skill derived from the conventions skill", async () => {
    const skillsDir = await createSkillsDir();
    await writeSkill(skillsDir, "go-conventions", "# Go Conventions\nTeam rules\n");
    await writeSkill(skillsDir, "go-implementor", "# Go Implementor\nFollow TDD.\n");

    const prompt = await assembleSystemPrompt(
      "implementor",
      skillsDir,
      "go-conventions",
      "Context",
      [],
    );

    expect(prompt).toContain("# Go Implementor");
  });

  it("fails clearly when implementor skill cannot be inferred from the default empty conventions skill", async () => {
    const skillsDir = await createSkillsDir();

    await expect(
      assembleSystemPrompt(
        "implementor",
        skillsDir,
        "",
        "Context",
        [],
      ),
    ).rejects.toThrow(/cannot infer implementor skill/i);
  });

  it("fails clearly when reviewer skill cannot be inferred from a non-stack conventions skill", async () => {
    const skillsDir = await createSkillsDir();
    await writeSkill(skillsDir, "custom-skill", "# Custom Skill\n");

    await expect(
      assembleSystemPrompt(
        "reviewer",
        skillsDir,
        "custom-skill",
        "Context",
        [],
      ),
    ).rejects.toThrow(/expected a '<stack>-conventions' skill name/i);
  });

  it("still allows spec-writer prompts without a conventions skill", async () => {
    const skillsDir = await createSkillsDir();
    await writeSkill(skillsDir, "spec-writer", "# Spec Writer\n");

    const prompt = await assembleSystemPrompt(
      "spec-writer",
      skillsDir,
      "",
      "Context",
      [],
    );

    expect(prompt).toContain("# Spec Writer");
  });
});