import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createExtensionController } from "../extension";
import { createOrchestrator as createMachineOrchestrator, type Orchestrator } from "../orchestrator/machine";
import type {
  ConfigurationLike,
  DisposableLike,
  ExtensionContextLike,
  OrchestratorState,
  VscodeApiLike,
} from "../types";

class FakeConfiguration implements ConfigurationLike {
  public get<T>(_section: string, defaultValue: T): T {
    return defaultValue;
  }
}

function createDisposable(onDispose: () => void): DisposableLike {
  return {
    dispose: onDispose,
  };
}

function createFakeVscode(workspaceDir: string) {
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const infoMessages: Array<{ message: string; options: string[] }> = [];
  const responses: Array<string | undefined> = [];
  const treeRegistrations: Array<{ viewId: string; provider: unknown }> = [];

  const api: VscodeApiLike = {
    commands: {
      registerCommand(command, callback) {
        commands.set(command, callback);
        return createDisposable(() => {
          commands.delete(command);
        });
      },
    },
    window: {
      async showInformationMessage(message: string, ...items: string[]) {
        infoMessages.push({ message, options: items });
        return responses.shift();
      },
      registerTreeDataProvider(viewId, treeDataProvider) {
        const registration = { viewId, provider: treeDataProvider };
        treeRegistrations.push(registration);
        return createDisposable(() => {
          const index = treeRegistrations.indexOf(registration);
          if (index >= 0) {
            treeRegistrations.splice(index, 1);
          }
        });
      },
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: workspaceDir } }],
      getConfiguration() {
        return new FakeConfiguration();
      },
    },
  };

  return {
    api,
    commands,
    infoMessages,
    treeRegistrations,
    enqueueInfoResponse(response: string | undefined) {
      responses.push(response);
    },
  };
}

function createContext(): ExtensionContextLike {
  return {
    subscriptions: [],
  };
}

async function writeDefaultSpecFixtures(workspaceDir: string): Promise<void> {
  const specDir = path.join(workspaceDir, ".docs", "conductor");
  await mkdir(specDir, { recursive: true });
  await writeFile(
    path.join(specDir, "phase1.md"),
    [
      "# Phase 1: Kickoff",
      "",
      "### Item 1.1: A1 - Initialize extension",
      "spec.md section: A1",
      "- [ ] implemented",
      "- [ ] reviewed",
      "",
    ].join("\n"),
    "utf8",
  );
}

async function createWorkspace(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "conductor-a1-"));
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const timeoutAt = Date.now() + 3_000;

  while (Date.now() < timeoutAt) {
    if (await predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("Timed out waiting for condition");
}

async function readState(workspaceDir: string): Promise<OrchestratorState> {
  const statePath = path.join(workspaceDir, ".conductor", "state.json");
  return JSON.parse(await readFile(statePath, "utf8")) as OrchestratorState;
}

const workspacesToCleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    workspacesToCleanup.splice(0).map(async (workspaceDir) => {
      await rm(workspaceDir, { recursive: true, force: true });
    }),
  );
});

describe("Conductor extension A1", () => {
  it("creates .conductor/state.json with running status on Start", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    const fakeVscode = createFakeVscode(workspaceDir);
    const controller = createExtensionController({ vscode: fakeVscode.api });
    const context = createContext();

    await controller.activate(context);
    await fakeVscode.commands.get("conductor.start")?.();

    const state = await readState(workspaceDir);
    expect(state.status).toBe("running");
  });

  it("writes paused status on Pause", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    const fakeVscode = createFakeVscode(workspaceDir);
    const controller = createExtensionController({ vscode: fakeVscode.api });
    const context = createContext();

    await controller.activate(context);
    await fakeVscode.commands.get("conductor.start")?.();
    await fakeVscode.commands.get("conductor.pause")?.();

    const state = await readState(workspaceDir);
    expect(state.status).toBe("paused");
  });

  it("writes running status on Resume", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    const fakeVscode = createFakeVscode(workspaceDir);
    const controller = createExtensionController({ vscode: fakeVscode.api });
    const context = createContext();

    await controller.activate(context);
    await fakeVscode.commands.get("conductor.start")?.();
    await fakeVscode.commands.get("conductor.pause")?.();
    await fakeVscode.commands.get("conductor.resume")?.();

    const state = await readState(workspaceDir);
    expect(state.status).toBe("running");
  });

  it("does not show a resume prompt on activation when no state exists", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    const fakeVscode = createFakeVscode(workspaceDir);
    const controller = createExtensionController({ vscode: fakeVscode.api });

    await controller.activate(createContext());

    expect(fakeVscode.infoMessages).toHaveLength(0);
  });

  it("shows a resume prompt when activation finds paused state", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    await mkdir(path.join(workspaceDir, ".conductor"), { recursive: true });
    await writeFile(
      path.join(workspaceDir, ".conductor", "state.json"),
      JSON.stringify({ status: "paused" }),
      "utf8",
    );
    const fakeVscode = createFakeVscode(workspaceDir);
    const controller = createExtensionController({ vscode: fakeVscode.api });

    await controller.activate(createContext());

    expect(fakeVscode.infoMessages).toEqual([
      {
        message: "Resume previous Conductor run?",
        options: ["Yes", "No"],
      },
    ]);
  });

  it("shows a resume prompt when activation finds running state", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    await mkdir(path.join(workspaceDir, ".conductor"), { recursive: true });
    await writeFile(
      path.join(workspaceDir, ".conductor", "state.json"),
      JSON.stringify({ status: "running" }),
      "utf8",
    );
    const fakeVscode = createFakeVscode(workspaceDir);
    const controller = createExtensionController({ vscode: fakeVscode.api });

    await controller.activate(createContext());

    expect(fakeVscode.infoMessages).toEqual([
      {
        message: "Resume previous Conductor run?",
        options: ["Yes", "No"],
      },
    ]);
  });

  it("declares maxTurns and maxRetries defaults in package.json", async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(process.cwd(), "package.json"), "utf8"),
    ) as {
      contributes: {
        configuration: {
          properties: Record<string, { default: unknown }>;
        };
      };
    };

    expect(packageJson.contributes.configuration.properties["conductor.specDir"].default).toBe(".docs/conductor");
    expect(packageJson.contributes.configuration.properties["conductor.maxTurns"].default).toBe(50);
    expect(packageJson.contributes.configuration.properties["conductor.maxRetries"].default).toBe(3);
  });

  it("contributes the Conductor sidebar view container and tree view in package.json", async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(process.cwd(), "package.json"), "utf8"),
    ) as {
      contributes: {
        viewsContainers: {
          activitybar: Array<{ id: string; title: string; icon: string }>;
        };
        views: Record<string, Array<{ id: string; name: string }>>;
      };
    };

    expect(packageJson.contributes.viewsContainers.activitybar).toContainEqual({
      id: "conductor",
      title: "Conductor",
      icon: "media/conductor.svg",
    });
    expect(packageJson.contributes.views.conductor).toContainEqual({
      id: "conductor.sidebar",
      name: "Run Progress",
    });
  });

  it("registers the Conductor tree provider on activation", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    const fakeVscode = createFakeVscode(workspaceDir);
    const controller = createExtensionController({ vscode: fakeVscode.api });

    await controller.activate(createContext());

    expect(fakeVscode.treeRegistrations).toHaveLength(1);
    expect(fakeVscode.treeRegistrations[0]?.viewId).toBe("conductor.sidebar");
  });

  it("refreshes the registered tree provider when the real orchestrator emits a state change", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    const fakeVscode = createFakeVscode(workspaceDir);
    let orchestrator: Orchestrator | undefined;
    const controller = createExtensionController({
      vscode: fakeVscode.api,
      createOrchestrator(config, context) {
        orchestrator = createMachineOrchestrator(config, context as never);
        return orchestrator;
      },
    });

    await controller.activate(createContext());

    const registration = fakeVscode.treeRegistrations[0] as {
      viewId: string;
      provider: { onDidChangeTreeData: (listener: (value: unknown) => void) => DisposableLike };
    };
    const events: unknown[] = [];
    registration.provider.onDidChangeTreeData((value) => {
      events.push(value);
    });

    orchestrator?.pause();
    await waitFor(() => events.length === 1);

    expect(registration.viewId).toBe("conductor.sidebar");
    expect(events).toEqual([undefined]);
  });

  it("stores an absolute workspace-rooted specDir on Start", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    const fakeVscode = createFakeVscode(workspaceDir);
    const controller = createExtensionController({ vscode: fakeVscode.api });

    await controller.activate(createContext());
    await fakeVscode.commands.get("conductor.start")?.();

    const state = await readState(workspaceDir);
    expect(state.specDir).toBe(path.join(workspaceDir, ".docs", "conductor"));
  });

  it("yields phase nodes from the registered provider with default specDir after activation and Start", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    await writeDefaultSpecFixtures(workspaceDir);
    const fakeVscode = createFakeVscode(workspaceDir);
    const controller = createExtensionController({ vscode: fakeVscode.api });

    await controller.activate(createContext());
    await fakeVscode.commands.get("conductor.start")?.();

    const registration = fakeVscode.treeRegistrations[0] as {
      viewId: string;
      provider: { getChildren(element?: unknown): Array<{ label: string; type: string; phaseNumber?: number }> };
    };
    const phases = registration.provider.getChildren();

    expect(registration.viewId).toBe("conductor.sidebar");
    expect(phases).toEqual([
      {
        type: "phase",
        label: "Phase 1: Kickoff",
        phaseNumber: 1,
      },
    ]);
  });

  it("normalizes a legacy relative specDir when reading existing state", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    await mkdir(path.join(workspaceDir, ".conductor"), { recursive: true });
    await writeFile(
      path.join(workspaceDir, ".conductor", "state.json"),
      JSON.stringify({
        specDir: ".docs/conductor",
        currentPhase: 1,
        currentItemIndex: 0,
        consecutivePasses: {},
        status: "paused",
        modelAssignments: [],
        itemStatuses: {},
      }),
      "utf8",
    );
    const fakeVscode = createFakeVscode(workspaceDir);
    const controller = createExtensionController({ vscode: fakeVscode.api });

    await controller.activate(createContext());
    await fakeVscode.commands.get("conductor.status")?.();

    expect(fakeVscode.infoMessages.at(-1)).toEqual({
      message: "Conductor status: phase 1, item 1, paused",
      options: [],
    });
  });

  it("records startedBy from the OS username on Start", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    const fakeVscode = createFakeVscode(workspaceDir);
    const controller = createExtensionController({ vscode: fakeVscode.api });

    await controller.activate(createContext());
    await fakeVscode.commands.get("conductor.start")?.();

    const state = await readState(workspaceDir);
    expect(state.startedBy).toBe(os.userInfo().username);
  });

  it("shows the Phase 1 dashboard no-op message before Phase 2 exists", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    const fakeVscode = createFakeVscode(workspaceDir);
    const controller = createExtensionController({ vscode: fakeVscode.api });

    await controller.activate(createContext());
    await fakeVscode.commands.get("conductor.dashboard")?.();

    expect(fakeVscode.infoMessages).toEqual([
      {
        message: "Dashboard not yet available",
        options: [],
      },
    ]);
  });
});