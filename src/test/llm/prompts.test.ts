import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { assembleSystemPrompt, buildClarificationSystemPrompt } from "../../llm/prompts";
import { discoverSkills, loadSkill } from "../../skills/loader";
import type { ToolDefinition } from "../../types";

const tempDirs: string[] = [];
const repoSkillsDir = path.join(process.cwd(), "skills");

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

  it("strips frontmatter from loaded repository skills", async () => {
    const skill = await loadSkill(repoSkillsDir, "go-implementor");

    expect(skill.startsWith("# Go Implementor Skill")).toBe(true);
    expect(skill).not.toContain("description: Go TDD implementation workflow.");
    expect(skill).not.toContain("---\nname: go-implementor");
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

    expect(prompt).toContain("# Go Conventions");
    expect(prompt).toContain("# Go Implementor");
  });

  it("allows spec-author prompts without a conventions skill", async () => {
    const skillsDir = await createSkillsDir();
    await writeSkill(skillsDir, "spec-author", "# Spec Author\n");

    const prompt = await assembleSystemPrompt(
      "spec-author",
      skillsDir,
      "",
      "Context",
      [],
    );

    expect(prompt).toContain("# Spec Author");
  });

  it("allows spec-reviewer prompts without a conventions skill", async () => {
    const skillsDir = await createSkillsDir();
    await writeSkill(skillsDir, "spec-reviewer", "# Spec Reviewer\n");

    const prompt = await assembleSystemPrompt(
      "spec-reviewer",
      skillsDir,
      "",
      "Context",
      [],
    );

    expect(prompt).toContain("# Spec Reviewer");
  });

  it("skips conventions skills for spec-reviewer prompts", async () => {
    const skillsDir = await createSkillsDir();
    await writeSkill(skillsDir, "go-conventions", "# Go Conventions\nShared rules\n");
    await writeSkill(skillsDir, "spec-reviewer", "# Spec Reviewer\nReview the spec.\n");

    const prompt = await assembleSystemPrompt(
      "spec-reviewer",
      skillsDir,
      "go-conventions",
      "Context",
      [],
    );

    expect(prompt).toContain("# Spec Reviewer");
    expect(prompt).not.toContain("# Go Conventions");
  });

  it("includes phase-creator skills and tool definitions without a conventions skill", async () => {
    const skillsDir = await createSkillsDir();
    await writeSkill(skillsDir, "phase-creator", "# Phase Creator\nCreate phase files.\n");
    const tools: ToolDefinition[] = [
      { name: "Read", description: "Read files", parameters: { path: { type: "string" } } },
    ];

    const prompt = await assembleSystemPrompt(
      "phase-creator",
      skillsDir,
      "",
      "Context",
      tools,
    );

    expect(prompt).toContain("# Phase Creator");
    expect(prompt).toContain("# Tool Definitions");
    expect(prompt).toContain("Read: Read files");
  });

  it("strips agent-conduct references from spec-proofreader prompts", async () => {
    const skillsDir = await createSkillsDir();
    await writeSkill(
      skillsDir,
      "spec-proofreader",
      "Read and follow **agent-conduct** before starting.\n\n# Spec Proofreader\n\nPolish wording.\n",
    );

    const prompt = await assembleSystemPrompt(
      "spec-proofreader",
      skillsDir,
      "",
      "Context",
      [],
    );

    expect(prompt).toContain("# Spec Proofreader");
    expect(prompt).toContain("Polish wording.");
    expect(prompt).not.toContain("agent-conduct");
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

  it("strips agent-conduct references from loaded skills", async () => {
    const skillsDir = await createSkillsDir();
    await writeSkill(
      skillsDir,
      "go-conventions",
      "# Go Conventions\n\nTeam rules.\n",
    );
    await writeSkill(
      skillsDir,
      "go-implementor",
      "Read and follow **agent-conduct** and **go-conventions** before starting.\n\n# Go Implementor\n\nFollow TDD.\n",
    );

    const prompt = await assembleSystemPrompt(
      "implementor",
      skillsDir,
      "go-conventions",
      "Context",
      [],
    );

    expect(prompt).toContain("# Go Implementor");
    expect(prompt).toContain("Follow TDD.");
    expect(prompt).not.toContain("agent-conduct");
  });

  it("strips wrapped agent-conduct instructions from repository skills", async () => {
    const prompt = await assembleSystemPrompt(
      "implementor",
      repoSkillsDir,
      "nextjs-fastapi-conventions",
      "Context",
      [],
    );

    expect(prompt).toContain("# Next.js + FastAPI Conventions");
    expect(prompt).toContain("# Next.js + FastAPI Implementor Skill");
    expect(prompt).not.toContain("agent-conduct");
    expect(prompt).not.toContain("description: Full-stack TDD implementation workflow.");
    expect(prompt).not.toContain("---\nname: nextjs-fastapi-implementor");
  });

  it("builds clarification prompts from conventions context and the clarification template", async () => {
    const skillsDir = await createSkillsDir();
    await writeSkill(
      skillsDir,
      "go-conventions",
      "Read and follow **agent-conduct** before starting.\n\n# Go Conventions\n\nUse the existing architecture.\n",
    );

    const prompt = await buildClarificationSystemPrompt(
      skillsDir,
      "go-conventions",
      [{ name: "Read", description: "Read files", parameters: {} }],
    );

    expect(prompt).toContain("# Go Conventions");
    expect(prompt).toContain("Return ONLY the questions as a JSON array");
    expect(prompt).toContain("If prompt.md already addresses everything, return NONE.");
    expect(prompt).not.toContain("agent-conduct");
  });
});
