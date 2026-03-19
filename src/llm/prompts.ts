import type { Role, ToolDefinition } from "../types";
import { loadSkill } from "../skills/loader";

const TOOL_CALL_INSTRUCTIONS = [
  "Emit tool calls using this wire format:",
  "<tool_call>",
  '{"name":"Read","arguments":{"path":"src/foo.ts"}}',
  "</tool_call>",
  "When the task is complete, emit:",
  "<done>",
  "PASS|FAIL|result text",
  "</done>",
  "If you need to record a deviation, emit:",
  "<addendum>",
  "deviation text with rationale",
  "</addendum>",
].join("\n");

function deriveRoleSkillName(role: Role, conventionsSkill: string): string {
  if (role === "spec-writer") {
    return "spec-writer";
  }

  if (!conventionsSkill) {
    throw new Error(
      `cannot infer ${role} skill: configure conductor.conventionsSkill with a '<stack>-conventions' skill`,
    );
  }

  if (!conventionsSkill.endsWith("-conventions")) {
    throw new Error(
      `cannot infer ${role} skill from conventions skill '${conventionsSkill}': expected a '<stack>-conventions' skill name`,
    );
  }

  return `${conventionsSkill.slice(0, -"-conventions".length)}-${role}`;
}

function formatToolDefinitions(tools: ToolDefinition[]): string {
  if (tools.length === 0) {
    return "No tools available.";
  }

  return tools
    .map((tool) => `- ${tool.name}: ${tool.description} | parameters: ${JSON.stringify(tool.parameters)}`)
    .join("\n");
}

export async function assembleSystemPrompt(
  role: Role,
  skillsDir: string,
  conventionsSkill: string,
  itemContext: string,
  tools: ToolDefinition[],
): Promise<string> {
  const sections: string[] = [];

  if (conventionsSkill) {
    sections.push(await loadSkill(skillsDir, conventionsSkill));
  }

  sections.push(await loadSkill(skillsDir, deriveRoleSkillName(role, conventionsSkill)));
  sections.push(["# Tool Definitions", formatToolDefinitions(tools)].join("\n\n"));
  sections.push(["# Tool Call Wire Format", TOOL_CALL_INSTRUCTIONS].join("\n\n"));
  sections.push(["# Item Context", itemContext].join("\n\n"));

  return sections.join("\n\n");
}