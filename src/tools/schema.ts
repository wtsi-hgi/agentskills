import type { ToolDefinition } from "../types";

type ParameterDefinition = {
  type: string;
  description: string;
  required?: boolean;
};

type ParameterDefinitions = Record<string, ParameterDefinition>;

const TOOL_DEFINITIONS: Array<ToolDefinition & { parameters: ParameterDefinitions }> = [
  {
    name: "Read",
    description: "Read a UTF-8 text file, optionally constrained to an inclusive line range.",
    parameters: {
      path: { type: "string", description: "Path relative to projectDir.", required: true },
      startLine: { type: "number", description: "Optional 1-based starting line number." },
      endLine: { type: "number", description: "Optional 1-based ending line number." },
    },
  },
  {
    name: "Edit",
    description: "Replace the first occurrence of oldString in a UTF-8 text file.",
    parameters: {
      path: { type: "string", description: "Path relative to projectDir.", required: true },
      oldString: { type: "string", description: "Exact text to replace.", required: true },
      newString: { type: "string", description: "Replacement text.", required: true },
    },
  },
  {
    name: "Write",
    description: "Create or overwrite a UTF-8 text file.",
    parameters: {
      path: { type: "string", description: "Path relative to projectDir.", required: true },
      content: { type: "string", description: "Full file contents to write.", required: true },
    },
  },
  {
    name: "Delete",
    description: "Delete a file relative to projectDir; LLM-written files are moved to .trash when applicable.",
    parameters: {
      path: { type: "string", description: "Path relative to projectDir.", required: true },
    },
  },
  {
    name: "Grep",
    description: "Search files with ripgrep and return file:line:match output.",
    parameters: {
      pattern: { type: "string", description: "Search pattern for ripgrep.", required: true },
      path: { type: "string", description: "Optional file or directory relative to projectDir." },
      isRegex: { type: "boolean", description: "Treat pattern as a regular expression when true." },
    },
  },
  {
    name: "Glob",
    description: "Match project-relative paths using fast-glob.",
    parameters: {
      pattern: { type: "string", description: "fast-glob pattern relative to projectDir.", required: true },
    },
  },
  {
    name: "Bash",
    description: "Execute a validated shell command inside projectDir.",
    parameters: {
      command: { type: "string", description: "Shell command to run.", required: true },
      timeoutMs: { type: "number", description: "Optional timeout in milliseconds." },
    },
  },
];

export function getToolDefinitions(): ToolDefinition[] {
  return TOOL_DEFINITIONS.map((definition) => ({
    ...definition,
    parameters: { ...definition.parameters },
  }));
}

function formatParameter(name: string, definition: ParameterDefinition): string {
  const required = definition.required ? "required" : "optional";
  return `  - ${name} (${definition.type}, ${required}): ${definition.description}`;
}

export function formatToolsForPrompt(tools: ToolDefinition[]): string {
  return tools
    .map((tool) => {
      const parameters = Object.entries(tool.parameters as ParameterDefinitions)
        .map(([name, definition]) => formatParameter(name, definition))
        .join("\n");

      return `${tool.name}: ${tool.description}\n${parameters}`;
    })
    .join("\n\n");
}
