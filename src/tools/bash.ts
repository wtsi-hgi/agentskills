import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import * as path from "node:path";

import type { ToolResult } from "../types";

const DEFAULT_TIMEOUT_MS = 30_000;

const SUDO_PATTERN = /\bsudo\b/;
const GIT_PUSH_PATTERN = /\bgit\s+push(?:\s|$)/;
const INTERACTIVE_COMMAND_PATTERN = /\b(?:ssh|less|vi|vim|nano)\b/;
const DANGEROUS_SHELL_SYNTAX_PATTERNS = [
  /\$\(/,
  /\$\{/,
  /`/,
  /&&/,
  /\|\|/,
  /(^|[^\\])\|/,
  /(^|[^\\]);/,
  /(^|[^\\])>/,
  /(^|[^\\])</,
  /(^|[^\\])&/,
  /\n/,
];

function isPathLikeToken(token: string): boolean {
  return token === "."
    || token === ".."
    || token.startsWith("./")
    || token.startsWith("../")
    || token.startsWith("/")
    || token.includes("/");
}

function splitShellTokens(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;

  for (const character of command) {
    if (quote) {
      current += character;
      if (character === quote) {
        quote = undefined;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }

    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += character;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

function stripShellPunctuation(token: string): string {
  let cleaned = token.trim();
  cleaned = cleaned.replace(/^[;&|()]+/, "");
  cleaned = cleaned.replace(/[;&|()]+$/, "");

  if (
    (cleaned.startsWith("\"") && cleaned.endsWith("\""))
    || (cleaned.startsWith("'") && cleaned.endsWith("'"))
  ) {
    cleaned = cleaned.slice(1, -1);
  }

  return cleaned;
}

function isWithinProject(resolvedPath: string, projectDir: string): boolean {
  const relative = path.relative(projectDir, resolvedPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function realpathIfExists(candidatePath: string): string | undefined {
  try {
    return realpathSync(candidatePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

function resolveExistingAncestorRealPath(candidatePath: string): string {
  let currentPath = candidatePath;

  while (true) {
    const realPath = realpathIfExists(currentPath);
    if (realPath) {
      return realPath;
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return currentPath;
    }

    currentPath = parentPath;
  }
}

function extractPathCandidates(command: string): string[] {
  const candidates: string[] = [];

  for (const token of splitShellTokens(command)) {
    const cleaned = stripShellPunctuation(token);
    if (!cleaned) {
      continue;
    }

    if (isPathLikeToken(cleaned)) {
      candidates.push(cleaned);
    }

    const equalsIndex = cleaned.indexOf("=");
    if (equalsIndex > 0 && equalsIndex < cleaned.length - 1) {
      const assignedValue = stripShellPunctuation(cleaned.slice(equalsIndex + 1));
      if (assignedValue && isPathLikeToken(assignedValue)) {
        candidates.push(assignedValue);
      }
    }
  }

  return candidates;
}

function containsDangerousShellSyntax(command: string): boolean {
  return DANGEROUS_SHELL_SYNTAX_PATTERNS.some((pattern) => pattern.test(command));
}

function formatOutput(stdout: string, stderr: string, exitCode: number | null, signal: NodeJS.Signals | null): string {
  const sections: string[] = [];

  if (stdout.trim().length > 0) {
    sections.push(`stdout:\n${stdout.trimEnd()}`);
  }

  if (stderr.trim().length > 0) {
    sections.push(`stderr:\n${stderr.trimEnd()}`);
  }

  if (exitCode !== null) {
    sections.push(`exit code: ${exitCode}`);
  } else if (signal) {
    sections.push(`signal: ${signal}`);
  }

  return sections.join("\n");
}

function runBashCommand(
  shellPath: string,
  command: string,
  projectDir: string,
  timeoutMs: number,
): Promise<ToolResult> {
  return new Promise<ToolResult>((resolve) => {
    execFile(shellPath, ["-lc", command], {
      cwd: projectDir,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    }, (error, stdout, stderr) => {
      if (!error) {
        resolve({
          success: true,
          output: formatOutput(stdout, stderr, 0, null),
        });
        return;
      }

      const exitCode = typeof error.code === "number" ? error.code : null;
      const output = formatOutput(stdout, stderr, exitCode, error.signal ?? null);

      if (error.killed) {
        resolve({
          success: false,
          output,
          error: `command timeout after ${timeoutMs}ms`,
        });
        return;
      }

      resolve({
        success: false,
        output,
        error: `command exited with code ${exitCode ?? "unknown"}`,
      });
    });
  });
}

export function validateBashCommand(
  command: string,
  projectDir: string,
): { valid: boolean; reason?: string } {
  if (SUDO_PATTERN.test(command)) {
    return { valid: false, reason: "sudo is prohibited" };
  }

  if (GIT_PUSH_PATTERN.test(command)) {
    return { valid: false, reason: "git push is prohibited" };
  }

  if (INTERACTIVE_COMMAND_PATTERN.test(command)) {
    return { valid: false, reason: "interactive commands are prohibited" };
  }

  const resolvedProjectDir = path.resolve(projectDir);
  const realProjectDir = realpathIfExists(resolvedProjectDir) ?? resolvedProjectDir;
  for (const candidatePath of extractPathCandidates(command)) {
    const resolvedCandidatePath = path.resolve(resolvedProjectDir, candidatePath);
    if (!isWithinProject(resolvedCandidatePath, resolvedProjectDir)) {
      return {
        valid: false,
        reason: `path '${candidatePath}' is outside project directory`,
      };
    }

    const realCandidatePath = realpathIfExists(resolvedCandidatePath)
      ?? resolveExistingAncestorRealPath(resolvedCandidatePath);
    if (!isWithinProject(realCandidatePath, realProjectDir)) {
      return {
        valid: false,
        reason: `path '${candidatePath}' is outside project directory`,
      };
    }
  }

  if (containsDangerousShellSyntax(command)) {
    return {
      valid: false,
      reason: "shell metacharacters and expansions are prohibited",
    };
  }

  return { valid: true };
}

export function executeBash(
  command: string,
  projectDir: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ToolResult> {
  const validation = validateBashCommand(command, projectDir);
  if (!validation.valid) {
    return Promise.resolve({
      success: false,
      output: "",
      error: validation.reason,
    });
  }

  return runBashCommand("bash", command, projectDir, timeoutMs);
}

export function executeTrusted(
  command: string,
  projectDir: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ToolResult> {
  return runBashCommand("/bin/bash", command, projectDir, timeoutMs);
}
