import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createExtensionController } from "../extension";
import type { Orchestrator } from "../orchestrator/machine";
import type {
  ConfigurationLike,
  DisposableLike,
  ExtensionContextLike,
  ModelAssignment,
  OrchestratorState,
  VscodeApiLike,
} from "../types";

class FakeConfiguration implements ConfigurationLike {
  public constructor(private readonly values: Record<string, unknown> = {}) {}

  public get<T>(section: string, defaultValue: T): T {
    return (this.values[section] as T | undefined) ?? defaultValue;
  }
}

function createDisposable(onDispose: () => void): DisposableLike {
  return {
    dispose: onDispose,
  };
}

function createFakeVscode(workspaceDir: string, configurationValues: Record<string, unknown> = {}) {
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const infoMessages: Array<{ message: string; options: string[] }> = [];
  const errorMessages: Array<{ message: string; options: string[] }> = [];
  const responses: Array<string | undefined> = [];
  const treeRegistrations: Array<{ viewId: string; provider: unknown }> = [];
  const configuration = new FakeConfiguration(configurationValues);

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
      async showErrorMessage(message: string, ...items: string[]) {
        errorMessages.push({ message, options: items });
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
        return configuration;
      },
    },
  };

  return {
    api,
    commands,
    infoMessages,
    errorMessages,
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

function createStubOrchestrator(initialState?: Partial<OrchestratorState>): Orchestrator {
  const state: OrchestratorState = {
    specDir: ".docs/conductor",
    currentPhase: 1,
    currentItemIndex: 0,
    consecutivePasses: {},
    specStep: "done",
    specConsecutivePasses: 0,
    specPhaseFileIndex: 0,
    clarificationQuestions: [],
    status: "idle",
    modelAssignments: [],
    itemStatuses: {},
    ...initialState,
  };

  return {
    async run() {},
    pause() {},
    resume() {},
    skip() {},
    retry() {},
    changeModel() {},
    approve() {},
    reject() {},
    submitClarification() {},
    addNote() {},
    getState() {
      return state;
    },
    async getPhase() {
      return {
        number: 1,
        title: "Phase 1: Kickoff",
        items: [
          { id: "A1", title: "Initialize extension", specSection: "A1", implemented: false, reviewed: false },
        ],
        batches: [],
      };
    },
    async getPhases() {
      return [
        {
          number: 1,
          title: "Phase 1: Kickoff",
          items: [
            { id: "A1", title: "Initialize extension", specSection: "A1", implemented: false, reviewed: false },
          ],
          batches: [],
        },
      ];
    },
    async getAuditEntries() {
      return [];
    },
    async getAddendumEntries() {
      return [];
    },
    async getTranscripts() {
      return [];
    },
    onStateChange: (() => ({ dispose() {} })) as never,
    onAuditEntry: (() => ({ dispose() {} })) as never,
    onAddendum: (() => ({ dispose() {} })) as never,
    onTranscript: (() => ({ dispose() {} })) as never,
  };
}

function createTrackedStubOrchestrator(initialState?: Partial<OrchestratorState>): {
  orchestrator: Orchestrator;
  calls: {
    run: number;
    resume: number;
  };
} {
  const calls = { run: 0, resume: 0 };
  const orchestrator = createStubOrchestrator(initialState);

  return {
    orchestrator: {
      ...orchestrator,
      async run() {
        calls.run += 1;
      },
      resume() {
        calls.resume += 1;
      },
    },
    calls,
  };
}

async function writeDefaultSpecFixtures(workspaceDir: string): Promise<void> {
  const specDir = path.join(workspaceDir, ".docs", "conductor");
  await mkdir(specDir, { recursive: true });
  await writeFile(
    path.join(specDir, "spec.md"),
    [
      "# Spec",
      "",
      "### A1: Initialize extension",
      "Acceptance placeholder.",
      "",
    ].join("\n"),
    "utf8",
  );
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

async function writePromptFixture(workspaceDir: string): Promise<void> {
  const specDir = path.join(workspaceDir, ".docs", "conductor");
  await mkdir(specDir, { recursive: true });
  await writeFile(
    path.join(specDir, "prompt.md"),
    [
      "# Prompt",
      "",
      "Describe the feature to implement.",
      "",
    ].join("\n"),
    "utf8",
  );
}

async function writeServerAppFixture(workspaceDir: string): Promise<void> {
  const appDir = path.join(workspaceDir, "src", "server", "app");
  await mkdir(appDir, { recursive: true });
  await writeFile(path.join(appDir, "index.html"), "<html><body>server</body></html>", "utf8");
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
    await writeDefaultSpecFixtures(workspaceDir);
    const fakeVscode = createFakeVscode(workspaceDir);
    const controller = createExtensionController({
      vscode: fakeVscode.api,
      createOrchestrator() {
        return createStubOrchestrator();
      },
    });
    const context = createContext();

    await controller.activate(context);
    await fakeVscode.commands.get("conductor.start")?.();

    const state = await readState(workspaceDir);
    expect(state.status).toBe("running");
  });

  it("starts spec-writing in clarifying mode when prompt.md exists without spec.md", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    await writePromptFixture(workspaceDir);
    const fakeVscode = createFakeVscode(workspaceDir);
    const controller = createExtensionController({
      vscode: fakeVscode.api,
      createOrchestrator() {
        return createStubOrchestrator();
      },
    });

    await controller.activate(createContext());
    await fakeVscode.commands.get("conductor.start")?.();

    const state = await readState(workspaceDir);
    expect(state.status).toBe("running");
    expect(state.specStep).toBe("clarifying");
  });

  it("starts implementation mode when spec.md exists", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    await writeDefaultSpecFixtures(workspaceDir);
    await writePromptFixture(workspaceDir);
    const fakeVscode = createFakeVscode(workspaceDir);
    const controller = createExtensionController({
      vscode: fakeVscode.api,
      createOrchestrator() {
        return createStubOrchestrator();
      },
    });

    await controller.activate(createContext());
    await fakeVscode.commands.get("conductor.start")?.();

    const state = await readState(workspaceDir);
    expect(state.status).toBe("running");
    expect(state.specStep).toBe("done");
  });

  it("shows an error and does not start when specDir has neither spec.md nor prompt.md", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    const fakeVscode = createFakeVscode(workspaceDir);
    const harness = createTrackedStubOrchestrator();
    const controller = createExtensionController({
      vscode: fakeVscode.api,
      createOrchestrator() {
        return harness.orchestrator;
      },
    });

    await controller.activate(createContext());
    await fakeVscode.commands.get("conductor.start")?.();

    expect(fakeVscode.errorMessages).toEqual([
      {
        message: "No spec.md or prompt.md found in specDir.",
        options: [],
      },
    ]);
    expect(harness.calls.run).toBe(0);
    await expect(readState(workspaceDir)).rejects.toThrow();
  });

  it("writes paused status on Pause", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    await writeDefaultSpecFixtures(workspaceDir);
    const fakeVscode = createFakeVscode(workspaceDir);
    const controller = createExtensionController({
      vscode: fakeVscode.api,
      createOrchestrator() {
        return createStubOrchestrator();
      },
    });
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
    await writeDefaultSpecFixtures(workspaceDir);
    const fakeVscode = createFakeVscode(workspaceDir);
    const controller = createExtensionController({
      vscode: fakeVscode.api,
      createOrchestrator() {
        return createStubOrchestrator();
      },
    });
    const context = createContext();

    await controller.activate(context);
    await fakeVscode.commands.get("conductor.start")?.();
    await fakeVscode.commands.get("conductor.pause")?.();
    await fakeVscode.commands.get("conductor.resume")?.();

    const state = await readState(workspaceDir);
    expect(state.status).toBe("running");
  });

  it("writes model assignments for the five spec-writing roles on Start", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    await writeDefaultSpecFixtures(workspaceDir);
    const fakeVscode = createFakeVscode(workspaceDir, {
      "models.implementor": { vendor: "copilot", family: "gpt-5.4" },
      "models.reviewer": { vendor: "copilot", family: "o3" },
      "models.specAuthor": { vendor: "copilot", family: "gpt-4.1" },
      "models.specReviewer": { vendor: "copilot", family: "gpt-4.1-mini" },
      "models.specProofreader": { vendor: "copilot", family: "o3-mini" },
      "models.phaseCreator": { vendor: "copilot", family: "gpt-4.1" },
      "models.phaseReviewer": { vendor: "copilot", family: "o3" },
    });
    const controller = createExtensionController({
      vscode: fakeVscode.api,
      createOrchestrator() {
        return createStubOrchestrator();
      },
    });

    await controller.activate(createContext());
    await fakeVscode.commands.get("conductor.start")?.();

    const state = await readState(workspaceDir);

    expect(state.modelAssignments).toEqual<ModelAssignment[]>([
      { role: "implementor", vendor: "copilot", family: "gpt-5.4" },
      { role: "reviewer", vendor: "copilot", family: "o3" },
      { role: "spec-author", vendor: "copilot", family: "gpt-4.1" },
      { role: "spec-reviewer", vendor: "copilot", family: "gpt-4.1-mini" },
      { role: "spec-proofreader", vendor: "copilot", family: "o3-mini" },
      { role: "phase-creator", vendor: "copilot", family: "gpt-4.1" },
      { role: "phase-reviewer", vendor: "copilot", family: "o3" },
    ]);
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

  it("does not start the team server when resume is declined", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    await writeServerAppFixture(workspaceDir);
    await mkdir(path.join(workspaceDir, ".conductor"), { recursive: true });
    await writeFile(
      path.join(workspaceDir, ".conductor", "state.json"),
      JSON.stringify({
        specDir: ".docs/conductor",
        currentPhase: 1,
        currentItemIndex: 0,
        consecutivePasses: {},
        status: "running",
        modelAssignments: [],
        itemStatuses: {},
      }),
      "utf8",
    );

    const fakeVscode = createFakeVscode(workspaceDir);
    fakeVscode.enqueueInfoResponse("No");
    const startServerCalls: Array<{ port: number; staticDir: string; authToken: string }> = [];
    const controller = createExtensionController({
      vscode: fakeVscode.api,
      createOrchestrator() {
        return createStubOrchestrator({ status: "running" });
      },
      async startServer(port, staticDir, authToken) {
        startServerCalls.push({ port, staticDir, authToken });
        return { close() {} };
      },
    });

    await controller.activate(createContext());

    expect(startServerCalls).toEqual([]);
    expect((await readState(workspaceDir)).status).toBe("idle");
  });

  it("resumes the orchestrator and starts the team server when resume is accepted", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    await writeServerAppFixture(workspaceDir);
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
    fakeVscode.enqueueInfoResponse("Yes");
    const harness = createTrackedStubOrchestrator({ status: "paused" });
    const startServerCalls: Array<{ port: number; staticDir: string; authToken: string }> = [];
    const controller = createExtensionController({
      vscode: fakeVscode.api,
      createOrchestrator() {
        return harness.orchestrator;
      },
      async startServer(port, staticDir, authToken) {
        startServerCalls.push({ port, staticDir, authToken });
        return { close() {} };
      },
    });

    await controller.activate(createContext());

    expect(harness.calls.resume).toBe(1);
    expect(startServerCalls).toHaveLength(1);
    expect((await readState(workspaceDir)).status).toBe("running");
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
    const controller = createExtensionController({
      vscode: fakeVscode.api,
      createOrchestrator() {
        return createStubOrchestrator();
      },
    });

    await controller.activate(createContext());

    const registration = fakeVscode.treeRegistrations[0] as {
      viewId: string;
      provider: {
        onDidChangeTreeData: (listener: (value: unknown) => void) => DisposableLike;
        refresh: () => void;
      };
    };
    const events: unknown[] = [];
    registration.provider.onDidChangeTreeData((value) => {
      events.push(value);
    });

    registration.provider.refresh();
    await waitFor(() => events.length === 1);

    expect(registration.viewId).toBe("conductor.sidebar");
    expect(events).toEqual([undefined]);
  });

  it("stores an absolute workspace-rooted specDir on Start", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    await writeDefaultSpecFixtures(workspaceDir);
    const fakeVscode = createFakeVscode(workspaceDir);
    const controller = createExtensionController({
      vscode: fakeVscode.api,
      createOrchestrator() {
        return createStubOrchestrator();
      },
    });

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
    const controller = createExtensionController({
      vscode: fakeVscode.api,
      createOrchestrator() {
        return createStubOrchestrator();
      },
    });

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
      message: "Conductor status: phase 1, item 1, idle",
      options: [],
    });
  });

  it("records startedBy from the OS username on Start", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    await writeDefaultSpecFixtures(workspaceDir);
    const fakeVscode = createFakeVscode(workspaceDir);
    const controller = createExtensionController({
      vscode: fakeVscode.api,
      createOrchestrator() {
        return createStubOrchestrator();
      },
    });

    await controller.activate(createContext());
    await fakeVscode.commands.get("conductor.start")?.();

    const state = await readState(workspaceDir);
    expect(state.startedBy).toBe(os.userInfo().username);
  });

  it("opens the real dashboard panel when the dashboard command executes", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    const fakeVscode = createFakeVscode(workspaceDir);
    const panels: Array<{ context: ExtensionContextLike; orchestrator: Orchestrator }> = [];
    const controller = createExtensionController({
      vscode: fakeVscode.api,
      createDashboardPanel(context, orchestrator) {
        panels.push({
          context: context as unknown as ExtensionContextLike,
          orchestrator,
        });
        return { dispose() {} } as never;
      },
    });

    const context = createContext();
    await controller.activate(context);
    await fakeVscode.commands.get("conductor.dashboard")?.();

    expect(fakeVscode.infoMessages).toEqual([]);
    expect(panels).toHaveLength(1);
    expect(panels[0]?.context).toBe(context);
  });
});
