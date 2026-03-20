import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { OrchestratorState } from "../../types";
import { loadState, saveState } from "../../state/persistence";

const dirsToCleanup: string[] = [];

async function createConductorDir(): Promise<string> {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "conductor-e1-state-"));
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

describe("state persistence", () => {
  it("round-trips saved orchestrator state", async () => {
    const conductorDir = await createConductorDir();
    const state: OrchestratorState = {
      specDir: ".docs/conductor",
      currentPhase: 1,
      currentItemIndex: 5,
      consecutivePasses: { "1.6": 2 },
      specStep: "reviewing",
      specConsecutivePasses: 1,
      specPhaseFileIndex: 0,
      clarificationQuestions: [],
      status: "running",
      modelAssignments: [
        { role: "implementor", vendor: "openai", family: "gpt-5.4" },
        { role: "reviewer", vendor: "anthropic", family: "claude" },
      ],
      itemStatuses: { "1.6": "pass" },
      startedBy: "sb10",
    };

    await saveState(conductorDir, state);

    await expect(loadState(conductorDir)).resolves.toEqual(state);
  });

  it("returns idle default state when state.json is missing", async () => {
    const conductorDir = await createConductorDir();

    await expect(loadState(conductorDir)).resolves.toMatchObject({
      specDir: "",
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
    });
  });
});
