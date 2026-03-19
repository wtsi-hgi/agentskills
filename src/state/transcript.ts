import { mkdir, readFile, writeFile } from "node:fs/promises";
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