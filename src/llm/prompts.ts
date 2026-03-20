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

const CLARIFICATION_TOOL_CALL_INSTRUCTIONS = [
  "Emit tool calls using this wire format:",
  "<tool_call>",
  '{"name":"Read","arguments":{"path":"src/foo.ts"}}',
  "</tool_call>",
  "When you are done, emit:",
  "<done>",
  "NONE | JSON array of questions",
  "</done>",
].join("\n");

const CLARIFICATION_TEMPLATE = [
  "Read prompt.md. Research the codebase to understand what exists.",
  "Produce 3-5 clarifying questions with suggested answer options that must be answered before a spec can be written.",
  "Return ONLY the questions as a JSON array of objects with question and suggestedOptions fields.",
  "If prompt.md already addresses everything, return NONE.",
].join("\n");

function deriveRoleSkillName(role: Role, conventionsSkill: string): string {
  if (
    role === "spec-author"
    || role === "spec-reviewer"
    || role === "spec-proofreader"
    || role === "phase-creator"
    || role === "phase-reviewer"
  ) {
    return role;
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

const AGENT_CONDUCT_PARAGRAPH = /^read and follow \*{0,2}agent-conduct\*{0,2}(?: and .+)? before starting\.?$/i;

function stripAgentConductReferences(text: string): string {
  return text
    .split(/\n\s*\n/u)
    .filter((paragraph) => {
      const normalized = paragraph.trim().replace(/\s+/gu, " ");
      return normalized.length > 0 && !AGENT_CONDUCT_PARAGRAPH.test(normalized);
    })
    .join("\n\n");
}

function roleUsesConventionsSkill(role: Role): boolean {
  return role === "implementor" || role === "reviewer";
}

export async function assembleSystemPrompt(
  role: Role,
  skillsDir: string,
  conventionsSkill: string,
  itemContext: string,
  tools: ToolDefinition[],
): Promise<string> {
  const sections: string[] = [];

  if (conventionsSkill && roleUsesConventionsSkill(role)) {
    sections.push(stripAgentConductReferences(await loadSkill(skillsDir, conventionsSkill)));
  }

  sections.push(stripAgentConductReferences(await loadSkill(skillsDir, deriveRoleSkillName(role, conventionsSkill))));
  sections.push(["# Tool Definitions", formatToolDefinitions(tools)].join("\n\n"));
  sections.push(["# Tool Call Wire Format", TOOL_CALL_INSTRUCTIONS].join("\n\n"));
  sections.push(["# Item Context", itemContext].join("\n\n"));

  return sections.join("\n\n");
}

export async function buildClarificationSystemPrompt(
  skillsDir: string,
  conventionsSkill: string,
  tools: ToolDefinition[],
): Promise<string> {
  const sections: string[] = [];

  if (conventionsSkill) {
    sections.push(stripAgentConductReferences(await loadSkill(skillsDir, conventionsSkill)));
  }

  sections.push(["# Tool Definitions", formatToolDefinitions(tools)].join("\n\n"));
  sections.push(["# Tool Call Wire Format", CLARIFICATION_TOOL_CALL_INSTRUCTIONS].join("\n\n"));
  sections.push(["# Task", CLARIFICATION_TEMPLATE].join("\n\n"));

  return sections.join("\n\n");
}
