import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type * as vscode from "vscode";
import { afterEach, describe, expect, it } from "vitest";

import { createExtensionController } from "../extension";
import type { Orchestrator } from "../orchestrator/machine";
import type {
  ConfigurationLike,
  DashboardControlBridge,
  DisposableLike,
  ExtensionContextLike,
  ModelAssignment,
  OrchestratorState,
  TextDocumentLike,
  VscodeApiLike,
} from "../types";

class FakeTextDocument implements TextDocumentLike {
  public constructor(
    public readonly uri: { path: string; scheme: string; toString(): string },
    private text: string,
  ) {}

  public getText(): string {
    return this.text;
  }

  public setText(text: string): void {
    this.text = text;
  }
}

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

function createFakeVscode(
  workspaceDir: string,
  configurationValues: Record<string, unknown> = {},
  languageModels: Array<{ name: string; id: string; vendor: string; family: string; version: string; maxInputTokens: number }> = [],
) {
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const infoMessages: Array<{ message: string; options: string[] }> = [];
  const errorMessages: Array<{ message: string; options: string[] }> = [];
  const responses: Array<string | undefined> = [];
  const quickPickResponses: Array<string | undefined> = [];
  const inputBoxResponses: Array<string | undefined> = [];
  const quickPickCalls: Array<{ items: string[]; options?: { placeHolder?: string; activeItem?: string } }> = [];
  const inputBoxCalls: Array<{ prompt?: string; placeHolder?: string; value?: string }> = [];
  const treeRegistrations: Array<{ viewId: string; provider: unknown }> = [];
  const openTextDocumentCalls: Array<{ language?: string; content?: string }> = [];
  const shownDocuments: FakeTextDocument[] = [];
  const closeDocumentListeners = new Set<(document: TextDocumentLike) => void>();
  const saveDocumentListeners = new Set<(document: TextDocumentLike) => void>();
  let untitledCounter = 0;
  const configuration = new FakeConfiguration({
    skillsDir: path.join(workspaceDir, ".missing-skills"),
    ...configurationValues,
  });

  const api: VscodeApiLike & {
    lm: {
      selectChatModels(selector?: { vendor?: string; family?: string }): Promise<vscode.LanguageModelChat[]>;
    };
  } = {
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
      async showInputBox(options) {
        inputBoxCalls.push({
          prompt: options?.prompt,
          placeHolder: options?.placeHolder,
          value: options?.value,
        });
        return inputBoxResponses.length > 0 ? inputBoxResponses.shift() : options?.value;
      },
      async showQuickPick(items: readonly string[], options?: { placeHolder?: string; activeItem?: string }) {
        quickPickCalls.push({ items: [...items], options });
        return quickPickResponses.shift();
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
      async showTextDocument(document) {
        shownDocuments.push(document as FakeTextDocument);
        return {};
      },
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: workspaceDir } }],
      getConfiguration() {
        return configuration;
      },
      async openTextDocument(options) {
        openTextDocumentCalls.push({
          language: options?.language,
          content: options?.content,
        });
        untitledCounter += 1;
        const documentId = untitledCounter;
        return new FakeTextDocument(
          {
            scheme: "untitled",
            path: `Untitled-${documentId}`,
            toString() {
              return `untitled:Untitled-${documentId}`;
            },
          },
          options?.content ?? "",
        );
      },
      onDidCloseTextDocument(listener) {
        closeDocumentListeners.add(listener);
        return createDisposable(() => {
          closeDocumentListeners.delete(listener);
        });
      },
      onDidSaveTextDocument(listener) {
        saveDocumentListeners.add(listener);
        return createDisposable(() => {
          saveDocumentListeners.delete(listener);
        });
      },
    },
    lm: {
      async selectChatModels(selector?: { vendor?: string; family?: string }) {
        return languageModels.filter((model) => {
          const matchesVendor = !selector?.vendor || model.vendor === selector.vendor;
          const matchesFamily = !selector?.family || model.family === selector.family;
          return matchesVendor && matchesFamily;
        }) as unknown as vscode.LanguageModelChat[];
      },
    },
  };

  return {
    api,
    commands,
    infoMessages,
    errorMessages,
    inputBoxCalls,
    openTextDocumentCalls,
    quickPickCalls,
    shownDocuments,
    treeRegistrations,
    enqueueInfoResponse(response: string | undefined) {
      responses.push(response);
    },
    enqueueInputBoxResponse(response: string | undefined) {
      inputBoxResponses.push(response);
    },
    enqueueQuickPickResponse(response: string | undefined) {
      quickPickResponses.push(response);
    },
    closeTextDocument(document: FakeTextDocument, text?: string) {
      if (text !== undefined) {
        document.setText(text);
      }

      for (const listener of closeDocumentListeners) {
        listener(document);
      }
    },
    saveTextDocument(document: FakeTextDocument, text?: string) {
      if (text !== undefined) {
        document.setText(text);
      }

      for (const listener of saveDocumentListeners) {
        listener(document);
      }
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
    conventionsSkill: "",
    testCommand: "npm test",
    lintCommand: "",
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
    startCopilotReReview() {},
    abandon() {},
    pause() {},
    resume() {},
    skip() {},
    retry() {},
    changeModel() {},
    overrideCommands() {},
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
    abandon: number;
  };
} {
  const calls = { run: 0, resume: 0, abandon: 0 };
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
      abandon() {
        calls.abandon += 1;
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

async function writeSkillFixture(skillsDir: string, skillName: string): Promise<void> {
  await mkdir(path.join(skillsDir, skillName), { recursive: true });
  await writeFile(path.join(skillsDir, skillName, "SKILL.md"), `# ${skillName}\n`, "utf8");
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

async function readNestedState(specDir: string): Promise<OrchestratorState> {
  const statePath = path.join(specDir, ".conductor", "state.json");
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

  it("opens an untitled prompt document when Start is invoked from the command palette without a selected directory", async () => {
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
    const startPromise = fakeVscode.commands.get("conductor.start")?.();

    await waitFor(() => fakeVscode.openTextDocumentCalls.length === 1 && fakeVscode.shownDocuments.length === 1);

    expect(fakeVscode.openTextDocumentCalls).toEqual([
      {
        language: "markdown",
        content: "",
      },
    ]);
    expect(fakeVscode.quickPickCalls).toEqual([]);

    fakeVscode.closeTextDocument(fakeVscode.shownDocuments[0] as FakeTextDocument, "Implement a new feature\nwith extra detail.");
    await startPromise;

    expect(harness.calls.run).toBe(1);
  });

  it("uses text confirmed from the untitled prompt document as the inline Start prompt", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    const fakeVscode = createFakeVscode(workspaceDir);
    fakeVscode.enqueueInputBoxResponse("typed-feature");
    const controller = createExtensionController({
      vscode: fakeVscode.api,
      async deriveFeatureSlug() {
        return "derived-feature";
      },
      createOrchestrator() {
        return createStubOrchestrator();
      },
    });

    await controller.activate(createContext());
    const startPromise = fakeVscode.commands.get("conductor.start")?.();

    await waitFor(() => fakeVscode.shownDocuments.length === 1);
    fakeVscode.closeTextDocument(
      fakeVscode.shownDocuments[0] as FakeTextDocument,
      "Implement a command-palette flow.\nCapture the prompt on close.",
    );
    await startPromise;

    const promptPath = path.join(workspaceDir, ".docs", "typed-feature", "prompt.md");
    await expect(readFile(promptPath, "utf8")).resolves.toBe(
      "Implement a command-palette flow.\nCapture the prompt on close.\n",
    );
  });

  it("does not create a directory or start a run when the untitled prompt document is cancelled", async () => {
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
    const startPromise = fakeVscode.commands.get("conductor.start")?.();

    await waitFor(() => fakeVscode.shownDocuments.length === 1);
    fakeVscode.closeTextDocument(fakeVscode.shownDocuments[0] as FakeTextDocument, "");
    await startPromise;

    expect(harness.calls.run).toBe(0);
    await expect(readState(workspaceDir)).rejects.toThrow();
    await expect(readFile(path.join(workspaceDir, ".docs"), "utf8")).rejects.toThrow();
  });

  it("opens an untitled prompt document when Fix Bugs is invoked from the command palette without a selected directory", async () => {
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
    const startPromise = fakeVscode.commands.get("conductor.fixBugs")?.();

    await waitFor(() => fakeVscode.openTextDocumentCalls.length === 1 && fakeVscode.shownDocuments.length === 1);

    expect(fakeVscode.openTextDocumentCalls).toEqual([
      {
        language: "markdown",
        content: "",
      },
    ]);
    expect(fakeVscode.quickPickCalls).toEqual([]);

    fakeVscode.closeTextDocument(fakeVscode.shownDocuments[0] as FakeTextDocument, "Fix intermittent timeout in worker\nAdd retry coverage.");
    await startPromise;

    expect(harness.calls.run).toBe(1);
  });

  it("uses text confirmed from the untitled prompt document as the inline Fix Bugs prompt", async () => {
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
    const startPromise = fakeVscode.commands.get("conductor.fixBugs")?.();

    await waitFor(() => fakeVscode.shownDocuments.length === 1);
    fakeVscode.closeTextDocument(
      fakeVscode.shownDocuments[0] as FakeTextDocument,
      "Fix intermittent timeout in worker\nAdd retry coverage.",
    );
    await startPromise;

    const promptPath = path.join(workspaceDir, ".docs", "bugs1", "prompt.md");
    await expect(readFile(promptPath, "utf8")).resolves.toBe(
      "Fix intermittent timeout in worker\nAdd retry coverage.\n",
    );
  });

  it("shows an error and does not start when a selected specDir has neither spec.md nor prompt.md", async () => {
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
    await fakeVscode.commands.get("conductor.start")?.({ targetPath: ".docs/conductor" });

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

  it("writes model assignments including pr-reviewer on Start", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    await writeDefaultSpecFixtures(workspaceDir);
    const fakeVscode = createFakeVscode(workspaceDir, {
      "models.implementor": { vendor: "copilot", family: "gpt-5.4" },
      "models.reviewer": { vendor: "copilot", family: "o3" },
      "models.prReviewer": { vendor: "copilot", family: "o3" },
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
      { role: "pr-reviewer", vendor: "copilot", family: "o3" },
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
      activationEvents: string[];
      contributes: {
        commands: Array<{ command: string; title: string }>;
        configuration: {
          properties: Record<string, { default: unknown }>;
        };
      };
    };

    expect(packageJson.activationEvents).toContain("onCommand:conductor.fixBugs");
    expect(packageJson.activationEvents).toContain("onCommand:conductor.abandon");
    expect(packageJson.contributes.commands).toContainEqual({
      command: "conductor.fixBugs",
      title: "Conductor: Fix Bugs",
    });
    expect(packageJson.contributes.commands).toContainEqual({
      command: "conductor.abandon",
      title: "Conductor: Abandon Run",
    });
    expect(packageJson.contributes.configuration.properties["conductor.docsDir"].default).toBe(".docs/");
    expect(packageJson.contributes.configuration.properties["conductor.maxTurns"].default).toBe(50);
    expect(packageJson.contributes.configuration.properties["conductor.maxRetries"].default).toBe(3);
  });

  it("persists per-feature command fields in state on Start", async () => {
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
    const nestedState = await readNestedState(path.join(workspaceDir, ".docs", "conductor"));
    expect(state.conventionsSkill).toBe("");
    expect(state.testCommand).toBe("npm test");
    expect(state.lintCommand).toBe("");
    expect(nestedState.conventionsSkill).toBe("");
    expect(nestedState.testCommand).toBe("npm test");
    expect(nestedState.lintCommand).toBe("");
  });

  it("resumes a paused nested feature state on activation", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    const specDir = path.join(workspaceDir, ".docs", "feature-alpha");
    await mkdir(path.join(specDir, ".conductor"), { recursive: true });
    await writeFile(
      path.join(specDir, ".conductor", "state.json"),
      JSON.stringify({
        specDir,
        conventionsSkill: "python-conventions",
        testCommand: "pytest",
        lintCommand: "ruff check .",
        currentPhase: 2,
        currentItemIndex: 1,
        consecutivePasses: {},
        specStep: "done",
        specConsecutivePasses: 0,
        specPhaseFileIndex: 0,
        clarificationQuestions: [],
        status: "paused",
        modelAssignments: [],
        itemStatuses: {},
      }),
      "utf8",
    );
    const fakeVscode = createFakeVscode(workspaceDir);
    fakeVscode.enqueueInfoResponse("Resume");
    const harness = createTrackedStubOrchestrator({ status: "paused", specDir });
    const controller = createExtensionController({
      vscode: fakeVscode.api,
      createOrchestrator() {
        return harness.orchestrator;
      },
    });

    await controller.activate(createContext());

    expect(fakeVscode.infoMessages[0]?.message).toContain("feature-alpha");
    expect(harness.calls.resume).toBe(1);
    expect((await readState(workspaceDir)).status).toBe("running");
    expect((await readState(workspaceDir)).testCommand).toBe("pytest");
  });

  it("resumes a running nested feature state on activation", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    const specDir = path.join(workspaceDir, ".docs", "feature-beta");
    await mkdir(path.join(specDir, ".conductor"), { recursive: true });
    await writeFile(
      path.join(specDir, ".conductor", "state.json"),
      JSON.stringify({
        specDir,
        conventionsSkill: "go-conventions",
        testCommand: "go test ./...",
        lintCommand: "golangci-lint run",
        currentPhase: 1,
        currentItemIndex: 0,
        consecutivePasses: {},
        specStep: "done",
        specConsecutivePasses: 0,
        specPhaseFileIndex: 0,
        clarificationQuestions: [],
        status: "running",
        modelAssignments: [],
        itemStatuses: {},
      }),
      "utf8",
    );
    const fakeVscode = createFakeVscode(workspaceDir);
    fakeVscode.enqueueInfoResponse("Resume");
    const harness = createTrackedStubOrchestrator({ status: "running", specDir });
    const controller = createExtensionController({
      vscode: fakeVscode.api,
      createOrchestrator() {
        return harness.orchestrator;
      },
    });

    await controller.activate(createContext());

    expect(harness.calls.resume).toBe(1);
    expect((await readState(workspaceDir)).status).toBe("running");
    expect((await readState(workspaceDir)).conventionsSkill).toBe("go-conventions");
  });

  it("abandons a recoverable nested feature state on activation", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    const specDir = path.join(workspaceDir, ".docs", "feature-gamma");
    await mkdir(path.join(specDir, ".conductor"), { recursive: true });
    await writeFile(
      path.join(specDir, ".conductor", "state.json"),
      JSON.stringify({
        specDir,
        conventionsSkill: "python-conventions",
        testCommand: "pytest",
        lintCommand: "ruff check .",
        currentPhase: 3,
        currentItemIndex: 2,
        consecutivePasses: {},
        specStep: "done",
        specConsecutivePasses: 0,
        specPhaseFileIndex: 0,
        clarificationQuestions: [],
        status: "running",
        modelAssignments: [],
        itemStatuses: {},
      }),
      "utf8",
    );
    const fakeVscode = createFakeVscode(workspaceDir);
    fakeVscode.enqueueInfoResponse("Abandon");
    const harness = createTrackedStubOrchestrator({ status: "idle" });
    const controller = createExtensionController({
      vscode: fakeVscode.api,
      createOrchestrator() {
        return harness.orchestrator;
      },
    });

    await controller.activate(createContext());

    expect(harness.calls.resume).toBe(0);
    expect((await readNestedState(specDir)).status).toBe("abandoned");
    expect((await readState(workspaceDir)).status).toBe("abandoned");
  });

  it("prompts for each active nested feature state found during activation", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    const firstSpecDir = path.join(workspaceDir, ".docs", "feature-epsilon");
    const secondSpecDir = path.join(workspaceDir, ".docs", "feature-zeta");
    await mkdir(path.join(firstSpecDir, ".conductor"), { recursive: true });
    await mkdir(path.join(secondSpecDir, ".conductor"), { recursive: true });
    await writeFile(
      path.join(firstSpecDir, ".conductor", "state.json"),
      JSON.stringify({
        specDir: firstSpecDir,
        conventionsSkill: "python-conventions",
        testCommand: "pytest",
        lintCommand: "ruff check .",
        currentPhase: 1,
        currentItemIndex: 0,
        consecutivePasses: {},
        specStep: "done",
        specConsecutivePasses: 0,
        specPhaseFileIndex: 0,
        clarificationQuestions: [],
        status: "running",
        modelAssignments: [],
        itemStatuses: {},
      }),
      "utf8",
    );
    await writeFile(
      path.join(secondSpecDir, ".conductor", "state.json"),
      JSON.stringify({
        specDir: secondSpecDir,
        conventionsSkill: "go-conventions",
        testCommand: "go test ./...",
        lintCommand: "golangci-lint run",
        currentPhase: 2,
        currentItemIndex: 1,
        consecutivePasses: {},
        specStep: "done",
        specConsecutivePasses: 0,
        specPhaseFileIndex: 0,
        clarificationQuestions: [],
        status: "paused",
        modelAssignments: [],
        itemStatuses: {},
      }),
      "utf8",
    );
    const fakeVscode = createFakeVscode(workspaceDir);
    fakeVscode.enqueueInfoResponse("Abandon");
    fakeVscode.enqueueInfoResponse("Resume");
    const harness = createTrackedStubOrchestrator({ status: "paused", specDir: secondSpecDir });
    const controller = createExtensionController({
      vscode: fakeVscode.api,
      createOrchestrator() {
        return harness.orchestrator;
      },
    });

    await controller.activate(createContext());

    expect(fakeVscode.infoMessages.map((entry) => entry.message)).toEqual([
      "Resume previous Conductor run for feature-epsilon?",
      "Resume previous Conductor run for feature-zeta?",
    ]);
    expect((await readNestedState(firstSpecDir)).status).toBe("abandoned");
    expect((await readNestedState(secondSpecDir)).status).toBe("running");
    expect((await readState(workspaceDir)).specDir).toBe(secondSpecDir);
    expect(harness.calls.resume).toBe(1);
  });

  it("ignores nested feature states that are already complete on activation", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    const specDir = path.join(workspaceDir, ".docs", "feature-delta");
    await mkdir(path.join(specDir, ".conductor"), { recursive: true });
    await writeFile(
      path.join(specDir, ".conductor", "state.json"),
      JSON.stringify({
        specDir,
        conventionsSkill: "python-conventions",
        testCommand: "pytest",
        lintCommand: "ruff check .",
        currentPhase: 4,
        currentItemIndex: 0,
        consecutivePasses: {},
        specStep: "done",
        specConsecutivePasses: 0,
        specPhaseFileIndex: 0,
        clarificationQuestions: [],
        status: "done",
        modelAssignments: [],
        itemStatuses: {},
      }),
      "utf8",
    );
    const fakeVscode = createFakeVscode(workspaceDir);
    const controller = createExtensionController({
      vscode: fakeVscode.api,
      createOrchestrator() {
        return createStubOrchestrator();
      },
    });

    await controller.activate(createContext());

    expect(fakeVscode.infoMessages).toEqual([]);
  });

  it("shows the guessed conventions skill as the quick-pick default", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    await writeDefaultSpecFixtures(workspaceDir);
    await writeFile(path.join(workspaceDir, "go.mod"), "module example.com/test\n", "utf8");
    await writeFile(path.join(workspaceDir, "go.sum"), "example\n", "utf8");
    const skillsDir = path.join(workspaceDir, "skills-fixture");
    await writeSkillFixture(skillsDir, "go-conventions");
    await writeSkillFixture(skillsDir, "python-conventions");
    const fakeVscode = createFakeVscode(workspaceDir, { skillsDir });
    fakeVscode.enqueueQuickPickResponse("go-conventions");
    const controller = createExtensionController({
      vscode: fakeVscode.api,
      async guessConventionsSkill() {
        return "go-conventions";
      },
      createOrchestrator() {
        return createStubOrchestrator();
      },
    });

    await controller.activate(createContext());
    await fakeVscode.commands.get("conductor.start")?.();

    expect(fakeVscode.quickPickCalls).toHaveLength(1);
    expect(fakeVscode.quickPickCalls[0]?.options?.activeItem).toBe("go-conventions");
  });

  it("stores the user-selected conventions skill override in state", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    await writeDefaultSpecFixtures(workspaceDir);
    const skillsDir = path.join(workspaceDir, "skills-fixture");
    await writeSkillFixture(skillsDir, "go-conventions");
    await writeSkillFixture(skillsDir, "python-conventions");
    const fakeVscode = createFakeVscode(workspaceDir, { skillsDir });
    fakeVscode.enqueueQuickPickResponse("python-conventions");
    const controller = createExtensionController({
      vscode: fakeVscode.api,
      async guessConventionsSkill() {
        return "go-conventions";
      },
      createOrchestrator() {
        return createStubOrchestrator();
      },
    });

    await controller.activate(createContext());
    await fakeVscode.commands.get("conductor.start")?.();

    const state = await readState(workspaceDir);
    expect(state.conventionsSkill).toBe("python-conventions");
  });

  it("shows all available conventions skills in the quick-pick", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    await writeDefaultSpecFixtures(workspaceDir);
    const skillsDir = path.join(workspaceDir, "skills-fixture");
    await writeSkillFixture(skillsDir, "go-conventions");
    await writeSkillFixture(skillsDir, "python-conventions");
    const fakeVscode = createFakeVscode(workspaceDir, { skillsDir });
    fakeVscode.enqueueQuickPickResponse("go-conventions");
    const controller = createExtensionController({
      vscode: fakeVscode.api,
      async guessConventionsSkill() {
        return "go-conventions";
      },
      createOrchestrator() {
        return createStubOrchestrator();
      },
    });

    await controller.activate(createContext());
    await fakeVscode.commands.get("conductor.start")?.();

    expect(fakeVscode.quickPickCalls).toHaveLength(1);
    expect(fakeVscode.quickPickCalls[0]?.items).toEqual(["go-conventions", "python-conventions"]);
  });

  it("shows no default quick-pick selection when the guessed skill is invalid", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    await writeDefaultSpecFixtures(workspaceDir);
    const skillsDir = path.join(workspaceDir, "skills-fixture");
    await writeSkillFixture(skillsDir, "go-conventions");
    await writeSkillFixture(skillsDir, "python-conventions");
    const fakeVscode = createFakeVscode(workspaceDir, { skillsDir });
    fakeVscode.enqueueQuickPickResponse("go-conventions");
    const controller = createExtensionController({
      vscode: fakeVscode.api,
      async guessConventionsSkill() {
        return "!!! not valid";
      },
      createOrchestrator() {
        return createStubOrchestrator();
      },
    });

    await controller.activate(createContext());
    await fakeVscode.commands.get("conductor.start")?.();

    expect(fakeVscode.quickPickCalls).toHaveLength(1);
    expect(fakeVscode.quickPickCalls[0]?.options?.activeItem).toBeUndefined();
  });

  it("keeps the selected conventions skill across pause and resume", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    await writeDefaultSpecFixtures(workspaceDir);
    const skillsDir = path.join(workspaceDir, "skills-fixture");
    await writeSkillFixture(skillsDir, "go-conventions");
    await writeSkillFixture(skillsDir, "python-conventions");
    const fakeVscode = createFakeVscode(workspaceDir, { skillsDir });
    fakeVscode.enqueueQuickPickResponse("python-conventions");
    const controller = createExtensionController({
      vscode: fakeVscode.api,
      async guessConventionsSkill() {
        return "go-conventions";
      },
      createOrchestrator() {
        return createStubOrchestrator({ conventionsSkill: "python-conventions", status: "running" });
      },
    });

    await controller.activate(createContext());
    await fakeVscode.commands.get("conductor.start")?.();
    await fakeVscode.commands.get("conductor.pause")?.();
    await fakeVscode.commands.get("conductor.resume")?.();

    const state = await readState(workspaceDir);
    expect(state.conventionsSkill).toBe("python-conventions");
    expect(state.status).toBe("running");
  });

  it("does not contribute removed global config settings in package.json", async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(process.cwd(), "package.json"), "utf8"),
    ) as {
      contributes: {
        configuration: {
          properties: Record<string, { default: unknown }>;
        };
      };
    };

    expect(packageJson.contributes.configuration.properties).not.toHaveProperty("conductor.specDir");
    expect(packageJson.contributes.configuration.properties).not.toHaveProperty("conductor.conventionsSkill");
    expect(packageJson.contributes.configuration.properties).not.toHaveProperty("conductor.testCommand");
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
    const panels: Array<{ context: ExtensionContextLike; orchestrator: Orchestrator; controlBridge: { startRun(request: { prompt: string; conventionsSkill: string; testCommand: string; lintCommand: string }): void | Promise<void> } }> = [];
    const controller = createExtensionController({
      vscode: fakeVscode.api,
      createDashboardPanel(context, orchestrator, controlBridge) {
        panels.push({
          context: context as unknown as ExtensionContextLike,
          orchestrator,
          controlBridge,
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

  it("starts a run from the dashboard control bridge with inline prompt and command overrides", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    const fakeVscode = createFakeVscode(workspaceDir);
    const harness = createTrackedStubOrchestrator();
    let capturedBridge:
      | { startRun(request: { prompt: string; conventionsSkill: string; testCommand: string; lintCommand: string }): void | Promise<void> }
      | undefined;
    const controller = createExtensionController({
      vscode: fakeVscode.api,
      async deriveFeatureSlug() {
        return "dashboard-start";
      },
      createOrchestrator() {
        return harness.orchestrator;
      },
      createDashboardPanel(_context, _orchestrator, controlBridge) {
        capturedBridge = controlBridge;
        return { dispose() {} } as never;
      },
    });

    await controller.activate(createContext());
    await fakeVscode.commands.get("conductor.dashboard")?.();
    await capturedBridge?.startRun({
      prompt: "Add dashboard bridge coverage",
      conventionsSkill: "python-conventions",
      testCommand: "pytest",
      lintCommand: "ruff check .",
    });

    const state = await readState(workspaceDir);
    expect(state.specDir).toBe(path.join(workspaceDir, ".docs", "dashboard-start"));
    expect(state.conventionsSkill).toBe("python-conventions");
    expect(state.testCommand).toBe("pytest");
    expect(state.lintCommand).toBe("ruff check .");
    expect(harness.calls.run).toBe(1);
  });

  it("exposes runtime chat models through the dashboard control bridge", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    const fakeVscode = createFakeVscode(workspaceDir, {}, [
      { name: "GPT-5.4", id: "gpt-5.4", vendor: "copilot", family: "gpt-5.4", version: "1", maxInputTokens: 128_000 },
      { name: "o3", id: "o3", vendor: "copilot", family: "o3", version: "1", maxInputTokens: 128_000 },
    ]);
    let capturedBridge: DashboardControlBridge | undefined;
    const controller = createExtensionController({
      vscode: fakeVscode.api,
      createDashboardPanel(_context, _orchestrator, controlBridge) {
        capturedBridge = controlBridge;
        return { dispose() {} } as never;
      },
    });

    await controller.activate(createContext());
    await fakeVscode.commands.get("conductor.dashboard")?.();

    await expect(Promise.resolve(capturedBridge?.getControlOptions())).resolves.toEqual({
      conventionsSkills: [],
      chatModels: [
        { vendor: "copilot", family: "gpt-5.4", name: "GPT-5.4", label: "GPT-5.4" },
        { vendor: "copilot", family: "o3", name: "o3", label: "o3" },
      ],
    });
  });

  it("creates a slugged feature directory and prompt.md from an inline prompt", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    const fakeVscode = createFakeVscode(workspaceDir);
    const controller = createExtensionController({
      vscode: fakeVscode.api,
      async deriveFeatureSlug() {
        return "batch-retry-logic";
      },
      createOrchestrator() {
        return createStubOrchestrator();
      },
    });

    await controller.activate(createContext());
    await fakeVscode.commands.get("conductor.start")?.({ prompt: "Add batch retry logic" });

    const specDir = path.join(workspaceDir, ".docs", "batch-retry-logic");
    const state = await readState(workspaceDir);
    expect(state.specDir).toBe(specDir);
    expect(state.specStep).toBe("clarifying");
    expect(await readFile(path.join(specDir, "prompt.md"), "utf8")).toBe("Add batch retry logic\n");
    expect(fakeVscode.inputBoxCalls[0]?.value).toBe("batch-retry-logic");
  });

  it("appends a numeric suffix when the suggested slug directory already exists", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    await mkdir(path.join(workspaceDir, ".docs", "batch-retry-logic"), { recursive: true });
    const fakeVscode = createFakeVscode(workspaceDir);
    const controller = createExtensionController({
      vscode: fakeVscode.api,
      async deriveFeatureSlug() {
        return "batch-retry-logic";
      },
      createOrchestrator() {
        return createStubOrchestrator();
      },
    });

    await controller.activate(createContext());
    await fakeVscode.commands.get("conductor.start")?.({ prompt: "Add batch retry logic" });

    const state = await readState(workspaceDir);
    expect(state.specDir).toBe(path.join(workspaceDir, ".docs", "batch-retry-logic-2"));
    expect(await readFile(path.join(state.specDir, "prompt.md"), "utf8")).toBe("Add batch retry logic\n");
  });

  it("falls back to the next unused feature-N slug when the slug model returns garbage", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    const fakeVscode = createFakeVscode(workspaceDir);
    const controller = createExtensionController({
      vscode: fakeVscode.api,
      async deriveFeatureSlug() {
        return "!!! not valid";
      },
      createOrchestrator() {
        return createStubOrchestrator();
      },
    });

    await controller.activate(createContext());
    await fakeVscode.commands.get("conductor.start")?.({ prompt: "Add batch retry logic" });

    const state = await readState(workspaceDir);
    expect(state.specDir).toBe(path.join(workspaceDir, ".docs", "feature-1"));
    expect(fakeVscode.inputBoxCalls[0]?.value).toBe("feature-1");
  });

  it("uses the user-provided slug override for inline prompt starts", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    const fakeVscode = createFakeVscode(workspaceDir);
    fakeVscode.enqueueInputBoxResponse("my-feature");
    const controller = createExtensionController({
      vscode: fakeVscode.api,
      async deriveFeatureSlug() {
        return "batch-retry";
      },
      createOrchestrator() {
        return createStubOrchestrator();
      },
    });

    await controller.activate(createContext());
    await fakeVscode.commands.get("conductor.start")?.({ prompt: "Add batch retry logic" });

    const state = await readState(workspaceDir);
    expect(state.specDir).toBe(path.join(workspaceDir, ".docs", "my-feature"));
    expect(fakeVscode.inputBoxCalls[0]?.value).toBe("batch-retry");
  });

  it("starts from an existing selected directory with prompt.md without deriving a slug", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    const selectedDir = path.join(workspaceDir, ".docs", "existing-feature");
    await mkdir(selectedDir, { recursive: true });
    await writeFile(path.join(selectedDir, "prompt.md"), "Existing prompt\n", "utf8");
    let deriveCalls = 0;
    const fakeVscode = createFakeVscode(workspaceDir);
    const controller = createExtensionController({
      vscode: fakeVscode.api,
      async deriveFeatureSlug() {
        deriveCalls += 1;
        return "should-not-run";
      },
      createOrchestrator() {
        return createStubOrchestrator();
      },
    });

    await controller.activate(createContext());
    await fakeVscode.commands.get("conductor.start")?.({ targetPath: selectedDir, prompt: "Ignored prompt" });

    const state = await readState(workspaceDir);
    expect(state.specDir).toBe(selectedDir);
    expect(state.specStep).toBe("clarifying");
    expect(deriveCalls).toBe(0);
    await expect(readFile(path.join(workspaceDir, ".docs", "should-not-run", "prompt.md"), "utf8")).rejects.toThrow();
  });

  it("creates inline feature directories under the configured docsDir", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    const fakeVscode = createFakeVscode(workspaceDir, { docsDir: ".specs/" });
    const controller = createExtensionController({
      vscode: fakeVscode.api,
      async deriveFeatureSlug() {
        return "batch-retry-logic";
      },
      createOrchestrator() {
        return createStubOrchestrator();
      },
    });

    await controller.activate(createContext());
    await fakeVscode.commands.get("conductor.start")?.({ prompt: "Add batch retry logic" });

    const state = await readState(workspaceDir);
    expect(state.specDir).toBe(path.join(workspaceDir, ".specs", "batch-retry-logic"));
    expect(await readFile(path.join(state.specDir, "prompt.md"), "utf8")).toBe("Add batch retry logic\n");
  });

  it("blocks inline feature starts while an active bugfix run exists", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    await mkdir(path.join(workspaceDir, ".conductor"), { recursive: true });
    await writeFile(
      path.join(workspaceDir, ".conductor", "state.json"),
      JSON.stringify({
        specDir: path.join(workspaceDir, ".docs", "bugs1"),
        conventionsSkill: "",
        testCommand: "npm test",
        lintCommand: "",
        currentPhase: 1,
        currentItemIndex: 0,
        consecutivePasses: {},
        specStep: "done",
        specConsecutivePasses: 0,
        specPhaseFileIndex: 0,
        clarificationQuestions: [],
        status: "pending-approval",
        modelAssignments: [],
        itemStatuses: {},
        bugStep: "reviewing",
      }),
      "utf8",
    );
    let deriveCalls = 0;
    const fakeVscode = createFakeVscode(workspaceDir);
    const harness = createTrackedStubOrchestrator({ status: "pending-approval" });
    const controller = createExtensionController({
      vscode: fakeVscode.api,
      async deriveFeatureSlug() {
        deriveCalls += 1;
        return "batch-retry-logic";
      },
      createOrchestrator() {
        return harness.orchestrator;
      },
    });

    await controller.activate(createContext());
    await fakeVscode.commands.get("conductor.start")?.({ prompt: "Add batch retry logic" });

    expect(fakeVscode.errorMessages).toContainEqual({
      message: "Complete or abandon current run first.",
      options: [],
    });
    expect(deriveCalls).toBe(0);
    expect(harness.calls.run).toBe(0);
    await expect(readFile(path.join(workspaceDir, ".docs", "batch-retry-logic", "prompt.md"), "utf8")).rejects.toThrow();
  });

  it("creates .docs/bugs1 with prompt.md from an inline bugfix prompt", async () => {
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
    expect(fakeVscode.commands.has("conductor.fixBugs")).toBe(true);
    await fakeVscode.commands.get("conductor.fixBugs")?.({ prompt: "Fix intermittent timeout in worker" });

    const bugDir = path.join(workspaceDir, ".docs", "bugs1");
    expect(await readFile(path.join(bugDir, "prompt.md"), "utf8")).toBe("Fix intermittent timeout in worker\n");
    expect((await readNestedState(bugDir)).status).toBe("running");
    expect(harness.calls.run).toBe(1);
  });

  it("marks an active run abandoned and calls orchestrator.abandon", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    const specDir = path.join(workspaceDir, ".docs", "bugs1");
    await mkdir(path.join(workspaceDir, ".conductor"), { recursive: true });
    await mkdir(path.join(specDir, ".conductor"), { recursive: true });
    await writeFile(
      path.join(workspaceDir, ".conductor", "state.json"),
      JSON.stringify({
        specDir,
        conventionsSkill: "",
        testCommand: "npm test",
        lintCommand: "",
        currentPhase: 1,
        currentItemIndex: 0,
        consecutivePasses: {},
        specStep: "done",
        specConsecutivePasses: 0,
        specPhaseFileIndex: 0,
        clarificationQuestions: [],
        status: "running",
        modelAssignments: [],
        itemStatuses: {},
        bugStep: "fixing",
        bugIndex: 0,
      }),
      "utf8",
    );
    await writeFile(
      path.join(specDir, ".conductor", "state.json"),
      JSON.stringify({
        specDir,
        status: "running",
      }),
      "utf8",
    );
    const fakeVscode = createFakeVscode(workspaceDir);
    fakeVscode.enqueueInfoResponse("Resume");
    const harness = createTrackedStubOrchestrator({ status: "running", specDir });
    const controller = createExtensionController({
      vscode: fakeVscode.api,
      createOrchestrator() {
        return harness.orchestrator;
      },
    });

    await controller.activate(createContext());
    await fakeVscode.commands.get("conductor.abandon")?.();

    expect((await readState(workspaceDir))?.status).toBe("abandoned");
    expect((await readNestedState(specDir))?.status).toBe("abandoned");
  });

  it("shows an info message when there is no active run to abandon", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    const fakeVscode = createFakeVscode(workspaceDir);
    const harness = createTrackedStubOrchestrator({ status: "idle" });
    const controller = createExtensionController({
      vscode: fakeVscode.api,
      createOrchestrator() {
        return harness.orchestrator;
      },
    });

    await controller.activate(createContext());
    await fakeVscode.commands.get("conductor.abandon")?.();

    expect(fakeVscode.infoMessages).toContainEqual({
      message: "No active run to abandon.",
      options: [],
    });
    expect(harness.calls.abandon).toBe(0);
  });

  it("shows an error and does not start Fix Bugs when an active feature run exists", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    await writeDefaultSpecFixtures(workspaceDir);
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
    await fakeVscode.commands.get("conductor.fixBugs")?.({ prompt: "Fix intermittent timeout in worker" });

    expect(fakeVscode.errorMessages).toContainEqual({
      message: "Complete or abandon current run first.",
      options: [],
    });
    expect(harness.calls.run).toBe(1);
    await expect(readFile(path.join(workspaceDir, ".docs", "bugs1", "prompt.md"), "utf8")).rejects.toThrow();
  });

  it("creates .docs/bugs2 when .docs/bugs1 already exists", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    await mkdir(path.join(workspaceDir, ".docs", "bugs1"), { recursive: true });
    const fakeVscode = createFakeVscode(workspaceDir);
    const controller = createExtensionController({
      vscode: fakeVscode.api,
      createOrchestrator() {
        return createStubOrchestrator();
      },
    });

    await controller.activate(createContext());
    await fakeVscode.commands.get("conductor.fixBugs")?.({ prompt: "Fix intermittent timeout in worker" });

    const bugDir = path.join(workspaceDir, ".docs", "bugs2");
    expect(await readFile(path.join(bugDir, "prompt.md"), "utf8")).toBe("Fix intermittent timeout in worker\n");
  });

  it("creates the next bug directory after the highest existing bugs number", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    await mkdir(path.join(workspaceDir, ".docs", "bugs1"), { recursive: true });
    await mkdir(path.join(workspaceDir, ".docs", "bugs3"), { recursive: true });
    const fakeVscode = createFakeVscode(workspaceDir);
    const controller = createExtensionController({
      vscode: fakeVscode.api,
      createOrchestrator() {
        return createStubOrchestrator();
      },
    });

    await controller.activate(createContext());
    await fakeVscode.commands.get("conductor.fixBugs")?.({ prompt: "Fix intermittent timeout in worker" });

    const bugDir = path.join(workspaceDir, ".docs", "bugs4");
    expect(await readFile(path.join(bugDir, "prompt.md"), "utf8")).toBe("Fix intermittent timeout in worker\n");
  });

  it("initializes the nested bugfix state file with running status", async () => {
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
    await fakeVscode.commands.get("conductor.fixBugs")?.({ prompt: "Fix intermittent timeout in worker" });

    const bugDir = path.join(workspaceDir, ".docs", "bugs1");
    const workspaceState = await readState(workspaceDir);
    const state = await readNestedState(bugDir);
    expect(workspaceState.bugStep).toBe("fixing");
    expect(workspaceState.bugIndex).toBe(0);
    expect(state.status).toBe("running");
    expect(state.specDir).toBe(bugDir);
    expect(state.bugStep).toBe("fixing");
    expect(state.bugIndex).toBe(0);
  });

  it("starts from an existing selected bugfix directory without creating a new one", async () => {
    const workspaceDir = await createWorkspace();
    workspacesToCleanup.push(workspaceDir);
    const selectedDir = path.join(workspaceDir, ".docs", "bugs1");
    await mkdir(selectedDir, { recursive: true });
    await writeFile(path.join(selectedDir, "prompt.md"), "Existing bug prompt\n", "utf8");
    const harness = createTrackedStubOrchestrator();
    const fakeVscode = createFakeVscode(workspaceDir);
    const controller = createExtensionController({
      vscode: fakeVscode.api,
      createOrchestrator() {
        return harness.orchestrator;
      },
    });

    await controller.activate(createContext());
    await fakeVscode.commands.get("conductor.fixBugs")?.({ targetPath: selectedDir, prompt: "Ignored bug prompt" });

    expect(harness.calls.run).toBe(1);
    expect((await readNestedState(selectedDir)).specDir).toBe(selectedDir);
    await expect(readFile(path.join(workspaceDir, ".docs", "bugs2", "prompt.md"), "utf8")).rejects.toThrow();
  });
});
