import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";

import type { OrchestratorState } from "../types";

const STATE_FILE = "state.json";

function createDefaultState(): OrchestratorState {
  return {
    specDir: "",
    currentPhase: 0,
    currentItemIndex: 0,
    consecutivePasses: {},
    status: "idle",
    modelAssignments: [],
    itemStatuses: {},
  };
}

export async function loadState(conductorDir: string): Promise<OrchestratorState> {
  try {
    const statePath = path.join(conductorDir, STATE_FILE);
    const raw = await readFile(statePath, "utf8");
    return JSON.parse(raw) as OrchestratorState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return createDefaultState();
    }

    throw error;
  }
}

export async function saveState(conductorDir: string, state: OrchestratorState): Promise<void> {
  await mkdir(conductorDir, { recursive: true });
  await writeFile(path.join(conductorDir, STATE_FILE), JSON.stringify(state, null, 2), "utf8");
}