import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";

import type { AddendumEntry } from "../types";

const ADDENDUM_FILE = "addendum.md";

function serializeAddendumEntry(entry: AddendumEntry): string {
  return `- ${JSON.stringify({
    timestamp: entry.timestamp,
    itemId: entry.itemId,
    deviation: entry.deviation,
    rationale: entry.rationale,
    author: entry.author ?? null,
  })}`;
}

export async function appendAddendum(conductorDir: string, entry: AddendumEntry): Promise<void> {
  await mkdir(conductorDir, { recursive: true });

  const addendumPath = path.join(conductorDir, ADDENDUM_FILE);
  const block = serializeAddendumEntry(entry);

  let existing = "";
  try {
    existing = await readFile(addendumPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const nextContent = existing.length > 0 ? `${existing.replace(/\s+$/, "")}\n${block}` : `${block}\n`;
  await writeFile(addendumPath, nextContent, "utf8");
}