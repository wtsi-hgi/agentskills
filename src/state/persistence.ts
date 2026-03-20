import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";

import type { OrchestratorState } from "../types";

const STATE_FILE = "state.json";

function createDefaultState(): OrchestratorState {
  return {
    specDir: "",
    conventionsSkill: "",
    testCommand: "npm test",
    lintCommand: "",
    currentPhase: 0,
    currentItemIndex: 0,
    consecutivePasses: {},
    specStep: "done",
    specConsecutivePasses: 0,
    specPhaseFileIndex: 0,
    clarificationQuestions: [],
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
  const statePath = path.join(conductorDir, STATE_FILE);
  const tempPath = `${statePath}.tmp`;
  await writeFile(tempPath, JSON.stringify(state, null, 2), "utf8");
  await rename(tempPath, statePath);

  if (state.status === "done") {
    await rm(path.join(conductorDir, "..", ".trash"), { recursive: true, force: true });
  }
}
