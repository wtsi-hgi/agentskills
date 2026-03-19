import { mkdtemp, readFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { appendAddendum } from "../../state/addendum";

const dirsToCleanup: string[] = [];

async function createConductorDir(): Promise<string> {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "conductor-e1-addendum-"));
  dirsToCleanup.push(workspaceDir);
  return path.join(workspaceDir, ".conductor");
}

afterEach(async () => {
  await Promise.all(
    dirsToCleanup.splice(0).map(async (dirPath) => {
      await rm(dirPath, { recursive: true, force: true });
    }),
  );
});

describe("addendum log", () => {
  it("writes stable markdown list items to addendum.md", async () => {
    const conductorDir = await createConductorDir();

    await appendAddendum(conductorDir, {
      timestamp: "2026-03-19T10:11:12.000Z",
      itemId: "1.6",
      deviation: "Used a plain markdown section instead of bullets.",
      rationale: "Keeps parsing simpler for Phase 1.",
      author: "reviewer",
    });

    const addendumMarkdown = await readFile(path.join(conductorDir, "addendum.md"), "utf8");
    expect(addendumMarkdown).toBe(
      "- {\"timestamp\":\"2026-03-19T10:11:12.000Z\",\"itemId\":\"1.6\",\"deviation\":\"Used a plain markdown section instead of bullets.\",\"rationale\":\"Keeps parsing simpler for Phase 1.\",\"author\":\"reviewer\"}\n",
    );
  });

  it("appends additional entries as separate list items", async () => {
    const conductorDir = await createConductorDir();

    await appendAddendum(conductorDir, {
      timestamp: "2026-03-19T10:11:12.000Z",
      itemId: "1.6",
      deviation: "First deviation.",
      rationale: "First rationale.",
    });
    await appendAddendum(conductorDir, {
      timestamp: "2026-03-19T10:12:12.000Z",
      itemId: "1.7",
      deviation: "Second deviation.",
      rationale: "Second rationale.",
      author: "reviewer",
    });

    const addendumMarkdown = await readFile(path.join(conductorDir, "addendum.md"), "utf8");
    expect(addendumMarkdown).toBe([
      "- {\"timestamp\":\"2026-03-19T10:11:12.000Z\",\"itemId\":\"1.6\",\"deviation\":\"First deviation.\",\"rationale\":\"First rationale.\",\"author\":null}",
      "- {\"timestamp\":\"2026-03-19T10:12:12.000Z\",\"itemId\":\"1.7\",\"deviation\":\"Second deviation.\",\"rationale\":\"Second rationale.\",\"author\":\"reviewer\"}",
    ].join("\n"));
  });
});