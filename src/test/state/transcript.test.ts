import { mkdtemp, readdir, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { RunTranscript } from "../../types";
import { loadTranscript, saveTranscript } from "../../state/transcript";

const dirsToCleanup: string[] = [];

async function createConductorDir(): Promise<string> {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "conductor-e1-transcript-"));
  dirsToCleanup.push(workspaceDir);
  return path.join(workspaceDir, ".conductor");
}

function buildTranscript(): RunTranscript {
  return {
    timestamp: "2026-03-19T10:11:12.000Z",
    role: "implementor",
    model: "gpt-5.4",
    itemId: "1.6",
    messages: [
      { role: "system", content: "You are implementing E1." },
      { role: "user", content: "Persist orchestrator state." },
      { role: "assistant", content: "Saving state.json." },
      { role: "tool", content: "saveState succeeded." },
    ],
  };
}

afterEach(async () => {
  await Promise.all(
    dirsToCleanup.splice(0).map(async (dirPath) => {
      await rm(dirPath, { recursive: true, force: true });
    }),
  );
});

describe("transcript storage", () => {
  it("stores transcripts under runs/timestamp/role-itemId.json", async () => {
    const conductorDir = await createConductorDir();
    const transcript = buildTranscript();

    await saveTranscript(conductorDir, transcript);

    const runDirs = await readdir(path.join(conductorDir, "runs"));
    expect(runDirs).toEqual([transcript.timestamp]);

    const runFiles = await readdir(path.join(conductorDir, "runs", transcript.timestamp));
    expect(runFiles).toEqual([`${transcript.role}-${transcript.itemId}.json`]);
  });

  it("loads a previously saved transcript with four messages", async () => {
    const conductorDir = await createConductorDir();
    const transcript = buildTranscript();

    await saveTranscript(conductorDir, transcript);

    const transcriptPath = path.join(
      conductorDir,
      "runs",
      transcript.timestamp,
      `${transcript.role}-${transcript.itemId}.json`,
    );

    await expect(loadTranscript(transcriptPath)).resolves.toMatchObject({
      timestamp: transcript.timestamp,
      role: transcript.role,
      itemId: transcript.itemId,
      messages: expect.arrayContaining(transcript.messages),
    });
    await expect(loadTranscript(transcriptPath)).resolves.toHaveProperty("messages", expect.any(Array));
    const loaded = await loadTranscript(transcriptPath);
    expect(loaded.messages).toHaveLength(4);
  });
});