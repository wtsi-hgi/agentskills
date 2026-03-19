import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";

import type { AuditEntry } from "../types";

const AUDIT_FILE = "audit.md";
const AUDIT_HEADER = "| Timestamp | Role | Model | Item ID | Prompt Summary | Result | Tokens In | Tokens Out | Duration (ms) |";
const AUDIT_SEPARATOR = "| --- | --- | --- | --- | --- | --- | --- | --- | --- |";

function serializeCell(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

function parseTableRow(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) {
    return [];
  }

  const row = trimmed.slice(1, -1);
  const cells: string[] = [];
  let current = "";
  let escaped = false;

  for (const character of row) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }

    if (character === "\\") {
      escaped = true;
      continue;
    }

    if (character === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }

    current += character;
  }

  if (escaped) {
    current += "\\";
  }

  cells.push(current.trim());
  return cells.map((cell) => cell.replace(/<br>/g, "\n"));
}

function formatAuditRow(entry: AuditEntry): string {
  return [
    entry.timestamp,
    entry.role,
    entry.model,
    entry.itemId,
    entry.promptSummary,
    entry.result,
    String(entry.tokensIn),
    String(entry.tokensOut),
    String(entry.durationMs),
  ]
    .map((cell) => serializeCell(cell))
    .join(" | ")
    .replace(/^/, "| ")
    .concat(" |");
}

export async function appendAudit(conductorDir: string, entry: AuditEntry): Promise<void> {
  await mkdir(conductorDir, { recursive: true });

  const auditPath = path.join(conductorDir, AUDIT_FILE);
  let content = "";

  try {
    content = await readFile(auditPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const lines = content.length > 0 ? [content.replace(/\s+$/, "")] : [AUDIT_HEADER, AUDIT_SEPARATOR];
  lines.push(formatAuditRow(entry));

  await writeFile(auditPath, `${lines.join("\n")}\n`, "utf8");
}

export async function readAudit(conductorDir: string): Promise<AuditEntry[]> {
  try {
    const content = await readFile(path.join(conductorDir, AUDIT_FILE), "utf8");
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("|"))
      .filter((line) => line !== AUDIT_HEADER && line !== AUDIT_SEPARATOR)
      .filter((line) => line.length > 0)
      .map((line) => {
        const [timestamp, role, model, itemId, promptSummary, result, tokensIn, tokensOut, durationMs] = parseTableRow(line);

        return {
          timestamp,
          role: role as AuditEntry["role"],
          model,
          itemId,
          promptSummary,
          result: result as AuditEntry["result"],
          tokensIn: Number(tokensIn),
          tokensOut: Number(tokensOut),
          durationMs: Number(durationMs),
        } satisfies AuditEntry;
      });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }
}