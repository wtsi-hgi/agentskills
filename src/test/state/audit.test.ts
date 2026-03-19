import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { AuditEntry } from "../../types";
import { appendAudit, readAudit } from "../../state/audit";

const dirsToCleanup: string[] = [];

async function createConductorDir(): Promise<string> {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "conductor-e1-audit-"));
  dirsToCleanup.push(workspaceDir);
  return path.join(workspaceDir, ".conductor");
}

function buildEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    timestamp: "2026-03-19T10:11:12.000Z",
    role: "reviewer",
    model: "gpt-5.4",
    itemId: "1.6",
    promptSummary: "Checked persistence behavior",
    result: "PASS",
    tokensIn: 123,
    tokensOut: 456,
    durationMs: 789,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    dirsToCleanup.splice(0).map(async (dirPath) => {
      await rm(dirPath, { recursive: true, force: true });
    }),
  );
});

describe("audit log", () => {
  it("creates audit.md with header and first data row", async () => {
    const conductorDir = await createConductorDir();
    const entry = buildEntry();

    await appendAudit(conductorDir, entry);

    const auditMarkdown = await readFile(path.join(conductorDir, "audit.md"), "utf8");
    expect(auditMarkdown).toContain("| Timestamp | Role | Model | Item ID | Prompt Summary | Result | Tokens In | Tokens Out | Duration (ms) |");
    expect(auditMarkdown).toContain(entry.timestamp);
    expect(auditMarkdown).toContain(entry.role);
    expect(auditMarkdown).toContain(entry.model);
    expect(auditMarkdown).toContain(entry.itemId);
    expect(auditMarkdown).toContain(entry.result);
  });

  it("appends a second audit row without duplicating the header", async () => {
    const conductorDir = await createConductorDir();

    await appendAudit(conductorDir, buildEntry({ itemId: "1.6" }));
    await appendAudit(conductorDir, buildEntry({ timestamp: "2026-03-19T10:11:13.000Z", itemId: "1.7" }));

    const auditMarkdown = await readFile(path.join(conductorDir, "audit.md"), "utf8");
    expect(auditMarkdown.match(/^\| Timestamp \| Role \| Model \| Item ID \| Prompt Summary \| Result \| Tokens In \| Tokens Out \| Duration \(ms\) \|$/gm)).toHaveLength(1);
    expect(auditMarkdown.match(/^\| 2026-03-19T10:11:/gm)).toHaveLength(2);
  });

  it("reads three audit entries with all fields populated", async () => {
    const conductorDir = await createConductorDir();
    const entries = [
      buildEntry({ itemId: "1.6", result: "PASS" }),
      buildEntry({ timestamp: "2026-03-19T10:11:13.000Z", itemId: "1.7", result: "FAIL", tokensIn: 200, tokensOut: 300, durationMs: 400 }),
      buildEntry({ timestamp: "2026-03-19T10:11:14.000Z", itemId: "1.8", result: "error", tokensIn: 210, tokensOut: 310, durationMs: 410 }),
    ];

    const fileContent = [
      "| Timestamp | Role | Model | Item ID | Prompt Summary | Result | Tokens In | Tokens Out | Duration (ms) |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
      "| 2026-03-19T10:11:12.000Z | reviewer | gpt-5.4 | 1.6 | Checked persistence behavior | PASS | 123 | 456 | 789 |",
      "| 2026-03-19T10:11:13.000Z | reviewer | gpt-5.4 | 1.7 | Checked persistence behavior | FAIL | 200 | 300 | 400 |",
      "| 2026-03-19T10:11:14.000Z | reviewer | gpt-5.4 | 1.8 | Checked persistence behavior | error | 210 | 310 | 410 |",
      "",
    ].join("\n");

    await mkdir(conductorDir, { recursive: true });
    await writeFile(path.join(conductorDir, "audit.md"), fileContent, "utf8");

    await expect(readAudit(conductorDir)).resolves.toEqual(entries);
  });
});