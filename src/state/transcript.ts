import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";

import type { RunTranscript } from "../types";

export async function saveTranscript(conductorDir: string, transcript: RunTranscript): Promise<void> {
  const runDir = path.join(conductorDir, "runs", transcript.timestamp);
  const transcriptPath = path.join(runDir, `${transcript.role}-${transcript.itemId}.json`);

  await mkdir(runDir, { recursive: true });
  await writeFile(transcriptPath, JSON.stringify(transcript, null, 2), "utf8");
}

export async function loadTranscript(transcriptPath: string): Promise<RunTranscript> {
  const raw = await readFile(transcriptPath, "utf8");
  return JSON.parse(raw) as RunTranscript;
}

export async function loadTranscripts(conductorDir: string): Promise<RunTranscript[]> {
  const runsDir = path.join(conductorDir, "runs");

  try {
    const runDirectories = await readdir(runsDir, { withFileTypes: true });
    const transcripts: RunTranscript[] = [];

    for (const directory of runDirectories) {
      if (!directory.isDirectory()) {
        continue;
      }

      const runDir = path.join(runsDir, directory.name);
      const entries = await readdir(runDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) {
          continue;
        }

        transcripts.push(await loadTranscript(path.join(runDir, entry.name)));
      }
    }

    return transcripts.sort((left, right) => right.timestamp.localeCompare(left.timestamp));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }
}