import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

import fg from "fast-glob";

import type { ToolCall, ToolResult } from "../types";
import { executeBash } from "./bash";

const execFileAsync = promisify(execFile);

function failure(error: string, output = ""): ToolResult {
  return {
    success: false,
    output,
    error,
  };
}

function ensureObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function requireString(argumentsObject: Record<string, unknown>, key: string): string {
  const value = argumentsObject[key];
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string`);
  }

  return value;
}

function optionalNumber(argumentsObject: Record<string, unknown>, key: string): number | undefined {
  const value = argumentsObject[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${key} must be a positive integer`);
  }

  return value;
}

function optionalBoolean(argumentsObject: Record<string, unknown>, key: string): boolean | undefined {
  const value = argumentsObject[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean`);
  }

  return value;
}

function isWithinProject(projectDir: string, candidatePath: string): boolean {
  const root = path.resolve(projectDir);
  const resolvedCandidate = path.resolve(candidatePath);
  const relative = path.relative(root, resolvedCandidate);

  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function realpathIfExists(candidatePath: string): Promise<string | undefined> {
  try {
    return await fs.realpath(candidatePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

async function resolveExistingAncestorRealPath(candidatePath: string): Promise<string> {
  let currentPath = candidatePath;

  while (true) {
    const realPath = await realpathIfExists(currentPath);
    if (realPath) {
      return realPath;
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      throw new Error(`path does not exist: ${candidatePath}`);
    }

    currentPath = parentPath;
  }
}

async function resolveProjectPath(projectDir: string, requestedPath: string): Promise<string> {
  const root = path.resolve(projectDir);
  const candidate = path.resolve(root, requestedPath);

  if (!isWithinProject(root, candidate)) {
    throw new Error(`path resolves outside project: ${requestedPath}`);
  }

  const realRoot = await realpathIfExists(root) ?? root;
  const realTarget = await realpathIfExists(candidate) ?? await resolveExistingAncestorRealPath(candidate);
  if (!isWithinProject(realRoot, realTarget)) {
    throw new Error(`path resolves outside project: ${requestedPath}`);
  }

  return candidate;
}

function validateGlobPattern(projectDir: string, pattern: string): void {
  const root = path.resolve(projectDir);
  const normalizedPattern = pattern.replace(/\\/g, "/");
  const strippedNegation = normalizedPattern.startsWith("!")
    ? normalizedPattern.slice(1)
    : normalizedPattern;

  if (path.isAbsolute(strippedNegation) && !isWithinProject(root, strippedNegation)) {
    throw new Error(`glob pattern resolves outside project: ${pattern}`);
  }

  const normalizedPath = path.posix.normalize(strippedNegation);
  if (normalizedPath === ".." || normalizedPath.startsWith("../")) {
    throw new Error(`glob pattern resolves outside project: ${pattern}`);
  }
}

async function normalizeGlobOutput(projectDir: string, matches: string[]): Promise<string> {
  const realRoot = await fs.realpath(path.resolve(projectDir));
  const normalizedMatches = await Promise.all(matches.map(async (match) => {
    const absoluteMatch = path.isAbsolute(match)
      ? path.resolve(match)
      : path.resolve(projectDir, match);

    if (!isWithinProject(projectDir, absoluteMatch)) {
      throw new Error(`glob match resolves outside project: ${match}`);
    }

    const realMatch = await fs.realpath(absoluteMatch);
    if (!isWithinProject(realRoot, realMatch)) {
      throw new Error(`glob match resolves outside project: ${match}`);
    }

    return path.isAbsolute(match)
      ? relativizeOutput(projectDir, absoluteMatch)
      : match;
  }));

  return normalizedMatches.join("\n");
}

function relativizeOutput(projectDir: string, absolutePath: string): string {
  return path.relative(path.resolve(projectDir), absolutePath) || ".";
}

function normalizeSearchOutput(projectDir: string, output: string): string {
  if (!output.trim()) {
    return "";
  }

  const root = path.resolve(projectDir);

  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(.+?):(\d+):(.*)$/);
      if (!match) {
        return line;
      }

      const [, filePath, lineNumber, content] = match;
      const normalizedPath = path.isAbsolute(filePath)
        ? relativizeOutput(root, filePath)
        : filePath;

      return `${normalizedPath}:${lineNumber}:${content}`;
    })
    .join("\n");
}

function readLines(content: string, startLine?: number, endLine?: number): string {
  if (startLine === undefined && endLine === undefined) {
    return content;
  }

  const chunks = content.match(/[^\n]*\n|[^\n]+/g) ?? [];
  const startIndex = (startLine ?? 1) - 1;
  const endIndex = endLine ?? chunks.length;

  if (endIndex < startIndex + 1) {
    throw new Error("endLine must be greater than or equal to startLine");
  }

  return chunks.slice(startIndex, endIndex).join("");
}

async function dispatchRead(argumentsObject: Record<string, unknown>, projectDir: string): Promise<ToolResult> {
  const filePath = await resolveProjectPath(projectDir, requireString(argumentsObject, "path"));
  const startLine = optionalNumber(argumentsObject, "startLine");
  const endLine = optionalNumber(argumentsObject, "endLine");
  const content = await fs.readFile(filePath, "utf8");

  return {
    success: true,
    output: readLines(content, startLine, endLine),
  };
}

async function dispatchEdit(argumentsObject: Record<string, unknown>, projectDir: string): Promise<ToolResult> {
  const filePath = await resolveProjectPath(projectDir, requireString(argumentsObject, "path"));
  const oldString = requireString(argumentsObject, "oldString");
  const newString = requireString(argumentsObject, "newString");
  const content = await fs.readFile(filePath, "utf8");
  const index = content.indexOf(oldString);

  if (index === -1) {
    return failure(`oldString not found in ${relativizeOutput(projectDir, filePath)}`);
  }

  const updated = `${content.slice(0, index)}${newString}${content.slice(index + oldString.length)}`;
  await fs.writeFile(filePath, updated, "utf8");

  return {
    success: true,
    output: relativizeOutput(projectDir, filePath),
  };
}

async function dispatchWrite(argumentsObject: Record<string, unknown>, projectDir: string): Promise<ToolResult> {
  const filePath = await resolveProjectPath(projectDir, requireString(argumentsObject, "path"));
  const content = requireString(argumentsObject, "content");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");

  return {
    success: true,
    output: relativizeOutput(projectDir, filePath),
  };
}

async function dispatchGrep(argumentsObject: Record<string, unknown>, projectDir: string): Promise<ToolResult> {
  const pattern = requireString(argumentsObject, "pattern");
  const requestedPath = argumentsObject.path;
  const isRegex = optionalBoolean(argumentsObject, "isRegex") ?? false;
  const absoluteSearchTarget = typeof requestedPath === "string"
    ? await resolveProjectPath(projectDir, requestedPath)
    : path.resolve(projectDir);
  const searchTarget = typeof requestedPath === "string"
    ? relativizeOutput(projectDir, absoluteSearchTarget)
    : ".";
  const rgArgs = ["--line-number", "--no-heading", "--color", "never"];

  if (!isRegex) {
    rgArgs.push("--fixed-strings");
  }

  rgArgs.push(pattern, searchTarget);

  try {
    const { stdout } = await execFileAsync("rg", rgArgs, { cwd: projectDir, maxBuffer: 1024 * 1024 });
    return {
      success: true,
      output: normalizeSearchOutput(projectDir, stdout.trimEnd()),
    };
  } catch (error) {
    const details = error as { code?: number | string; stdout?: string; stderr?: string; message?: string };

    if (details.code === 1) {
      return {
        success: true,
        output: normalizeSearchOutput(projectDir, (details.stdout ?? "").trimEnd()),
      };
    }

    if (details.code !== "ENOENT") {
      return failure(details.stderr?.trim() || details.message || "rg failed");
    }
  }

  try {
    const searchTargetStats = await fs.stat(absoluteSearchTarget);
    const grepArgs = ["-H", "-n"];

    if (searchTargetStats.isDirectory()) {
      grepArgs.push("-r");
    }

    grepArgs.push(isRegex ? "-E" : "-F", "--", pattern, searchTarget);

    const { stdout } = await execFileAsync("grep", grepArgs, { cwd: projectDir, maxBuffer: 1024 * 1024 });
    return {
      success: true,
      output: normalizeSearchOutput(projectDir, stdout.trimEnd()),
    };
  } catch (error) {
    const details = error as { code?: number | string; stdout?: string; stderr?: string; message?: string };

    if (details.code === 1) {
      return {
        success: true,
        output: normalizeSearchOutput(projectDir, (details.stdout ?? "").trimEnd()),
      };
    }

    return failure(details.stderr?.trim() || details.message || "grep failed");
  }
}

async function dispatchGlob(argumentsObject: Record<string, unknown>, projectDir: string): Promise<ToolResult> {
  const pattern = requireString(argumentsObject, "pattern");
  validateGlobPattern(projectDir, pattern);
  const matches = await fg(pattern, {
    cwd: projectDir,
    dot: true,
    onlyFiles: false,
  });

  return {
    success: true,
    output: await normalizeGlobOutput(projectDir, matches),
  };
}

export async function dispatchTool(call: ToolCall, projectDir: string): Promise<ToolResult> {
  try {
    const argumentsObject = ensureObject(call.arguments);

    switch (call.name) {
      case "Read":
        return await dispatchRead(argumentsObject, projectDir);
      case "Edit":
        return await dispatchEdit(argumentsObject, projectDir);
      case "Write":
        return await dispatchWrite(argumentsObject, projectDir);
      case "Grep":
        return await dispatchGrep(argumentsObject, projectDir);
      case "Glob":
        return await dispatchGlob(argumentsObject, projectDir);
      case "Bash": {
        const command = requireString(argumentsObject, "command");
        const timeoutMs = optionalNumber(argumentsObject, "timeoutMs");
        return await executeBash(command, projectDir, timeoutMs);
      }
      default:
        return failure(`unknown tool: ${call.name}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure(message);
  }
}