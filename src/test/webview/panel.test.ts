import { readFileSync } from "node:fs";
import * as path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";

import { createDashboardPanel, dashboardPanelConstants } from "../../webview/panel";
import type { Orchestrator } from "../../orchestrator/machine";
import type {
  AuditEntry,
  ClarificationAnswer,
  ClientMessage,
  DashboardControlBridge,
  DisposableLike,
  OrchestratorState,
  Phase,
} from "../../types";

class TestEmitter<T> {
  private readonly listeners = new Set<(value: T) => void>();

  public readonly event = (listener: (value: T) => void): DisposableLike => {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  };

  public fire(value: T): void {
    for (const listener of this.listeners) {
      listener(value);
    }
  }
}

class FakeElement {
  public textContent = "";
  public innerHTML = "";
  public value = "all";
  public hidden = false;
  private readonly listeners = new Map<string, Array<(event?: { type: string; preventDefault?: () => void }) => void>>();

  public addEventListener(type: string, listener: (event?: { type: string; preventDefault?: () => void }) => void): void {
    const entries = this.listeners.get(type) ?? [];
    entries.push(listener);
    this.listeners.set(type, entries);
  }

  public dispatchEvent(event: { type: string; preventDefault?: () => void }): void {
    for (const listener of this.listeners.get(event.type) ?? []) {
      listener();
    }
  }

  public click(): void {
    this.dispatchEvent({ type: "click" });
  }
}

class FakeDocument {
  private readonly elements = new Map<string, FakeElement>();

  public getElementById(id: string): FakeElement {
    let element = this.elements.get(id);
    if (!element) {
      element = new FakeElement();
      this.elements.set(id, element);
    }

    return element;
  }
}

class FakeWindow {
  private readonly listeners = new Map<string, Array<(event: { data: unknown }) => void>>();

  public addEventListener(type: string, listener: (event: { data: unknown }) => void): void {
    const entries = this.listeners.get(type) ?? [];
    entries.push(listener);
    this.listeners.set(type, entries);
  }

  public dispatchMessage(data: unknown): void {
    for (const listener of this.listeners.get("message") ?? []) {
      listener({ data });
    }
  }
}

function createState(overrides: Partial<OrchestratorState> = {}): OrchestratorState {
  return {
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
    status: "running",
    modelAssignments: [
      { role: "implementor", vendor: "copilot", family: "gpt-5.4" },
      { role: "reviewer", vendor: "copilot", family: "o3" },
    ],
    itemStatuses: {},
    ...overrides,
  };
}

function createAuditEntry(role: AuditEntry["role"], overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    timestamp: "2026-03-19T12:00:00.000Z",
    role,
    model: "copilot/o3",
    itemId: "A1",
    promptSummary: `${role} summary`,
    result: "PASS",
    tokensIn: 10,
    tokensOut: 5,
    durationMs: 100,
    ...overrides,
  };
}

function createPhase(): Phase {
  return {
    number: 1,
    title: "Phase 1",
    items: [
      { id: "A1", title: "Activate extension", specSection: "A1", implemented: true, reviewed: true },
      { id: "B1", title: "Tool schema", specSection: "B1", implemented: true, reviewed: false },
    ],
    batches: [],
  };
}

function createOrchestratorSpy(initialState: OrchestratorState = createState()) {
  const stateEmitter = new TestEmitter<OrchestratorState>();
  const auditEmitter = new TestEmitter<AuditEntry>();
  const addendumEmitter = new TestEmitter<{ timestamp: string; itemId: string; deviation: string; rationale: string; author?: string }>();
  const transcriptEmitter = new TestEmitter<{ timestamp: string; role: string; model: string; itemId: string; messages: Array<{ role: string; content: string }> }>();
  const calls = {
    pause: 0,
    resume: 0,
    startCopilotReReview: 0,
    startRun: [] as Array<{ prompt: string; conventionsSkill: string; testCommand: string; lintCommand: string }>,
    fixBugs: [] as Array<{ prompt: string; conventionsSkill: string; testCommand: string; lintCommand: string }>,
    abandonRun: 0,
    approve: [] as string[],
    skip: [] as string[],
    retry: [] as string[],
    reject: [] as Array<{ itemId: string; feedback: string }>,
    changeModel: [] as Array<{ role: string; vendor: string; family: string }>,
    overrideCommands: [] as Array<{ testCommand: string; lintCommand: string }>,
    addNote: [] as Array<{ itemId: string; text: string; author?: string }>,
    submitClarification: [] as ClarificationAnswer[][],
  };

  const orchestrator: Orchestrator = {
    run: async () => {},
    startCopilotReReview() {
      calls.startCopilotReReview += 1;
    },
    abandon() {},
    pause() {
      calls.pause += 1;
    },
    resume() {
      calls.resume += 1;
    },
    skip(itemId: string) {
      calls.skip.push(itemId);
    },
    retry(itemId: string) {
      calls.retry.push(itemId);
    },
    changeModel(role, vendor, family) {
      calls.changeModel.push({ role, vendor, family });
    },
    overrideCommands(testCommand: string, lintCommand: string) {
      calls.overrideCommands.push({ testCommand, lintCommand });
    },
    approve(itemId: string) {
      calls.approve.push(itemId);
    },
    reject(itemId: string, feedback: string) {
      calls.reject.push({ itemId, feedback });
    },
    submitClarification(answers: ClarificationAnswer[]) {
      calls.submitClarification.push(answers);
    },
    addNote(itemId: string, text: string, author?: string) {
      calls.addNote.push({ itemId, text, author });
    },
    getState() {
      return initialState;
    },
    async getAuditEntries() {
      return [];
    },
    async getPhase() {
      return createPhase();
    },
    async getPhases() {
      return [createPhase()];
    },
    async getAddendumEntries() {
      return [{
        timestamp: "2026-03-19T11:00:00.000Z",
        itemId: "A1",
        deviation: "Keep the reviewer note visible.",
        rationale: "Historical context for the dashboard.",
        author: "reviewer",
      }];
    },
    async getTranscripts() {
      return [];
    },
    onStateChange: stateEmitter.event as never,
    onAuditEntry: auditEmitter.event as never,
    onAddendum: addendumEmitter.event as never,
    onTranscript: transcriptEmitter.event as never,
  };

  const controlBridge: DashboardControlBridge = {
    getControlOptions() {
      return {
        conventionsSkills: ["python-conventions", "nextjs-fastapi-conventions"],
        chatModels: [
          { vendor: "copilot", family: "gpt-5.4", name: "GPT-5.4", label: "GPT-5.4" },
          { vendor: "copilot", family: "o3", name: "o3", label: "o3" },
        ],
      };
    },
    startRun(request) {
      calls.startRun.push(request);
    },
    fixBugs(request) {
      calls.fixBugs.push(request);
    },
    abandonRun() {
      calls.abandonRun += 1;
    },
  };

  return { orchestrator, controlBridge, calls, stateEmitter, auditEmitter, addendumEmitter, transcriptEmitter };
}

function createPanelHarness(initialState: OrchestratorState = createState()) {
  const receivedMessages: unknown[] = [];
  let messageListener: ((message: ClientMessage) => void) | undefined;
  let disposeListener: (() => void) | undefined;
  const panel = {
    webview: {
      cspSource: "vscode-webview-resource://dashboard",
      html: "",
      asWebviewUri(value: { fsPath?: string; toString?: () => string }) {
        return {
          toString() {
            return value.fsPath ?? value.toString?.() ?? "vscode-webview://dashboard";
          },
        };
      },
      async postMessage(message: unknown) {
        receivedMessages.push(message);
        return true;
      },
      onDidReceiveMessage(listener: (message: ClientMessage) => void) {
        messageListener = listener;
        return {
          dispose() {
            messageListener = undefined;
          },
        };
      },
    },
    onDidDispose(listener: () => void) {
      disposeListener = listener;
      return {
        dispose() {
          disposeListener = undefined;
        },
      };
    },
  };
  const createWebviewPanelCalls: Array<{ viewType: string; title: string }> = [];
  const vscodeApi = {
    Uri: {
      file(filePath: string) {
        return { fsPath: filePath };
      },
    },
    ViewColumn: {
      Active: 1,
    },
    window: {
      createWebviewPanel(viewType: string, title: string) {
        createWebviewPanelCalls.push({ viewType, title });
        return panel;
      },
    },
  };
  const context = {
    extensionPath: process.cwd(),
  };
  const spy = createOrchestratorSpy(initialState);

  const createdPanel = createDashboardPanel(
    context as never,
    spy.orchestrator,
    spy.controlBridge,
    vscodeApi as never,
  );

  return {
    context,
    panel: createdPanel,
    panelState: panel,
    calls: spy.calls,
    stateEmitter: spy.stateEmitter,
    auditEmitter: spy.auditEmitter,
    addendumEmitter: spy.addendumEmitter,
    transcriptEmitter: spy.transcriptEmitter,
    createWebviewPanelCalls,
    receivedMessages,
    receiveMessage(message: ClientMessage) {
      messageListener?.(message);
    },
    dispose() {
      disposeListener?.();
    },
  };
}

async function waitFor<T>(predicate: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 3_000;

  while (Date.now() < deadline) {
    const value = predicate();
    if (value !== undefined) {
      return value;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("Timed out waiting for condition");
}

function extractInlineScript(html: string): string {
  const match = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/);
  if (!match) {
    throw new Error("Expected inline dashboard script");
  }

  return match[1];
}

function createDashboardDomHarness(html: string) {
  const document = new FakeDocument();
  const window = new FakeWindow();
  const vscodeMessages: unknown[] = [];
  const context = {
    window,
    document,
    console,
    acquireVsCodeApi() {
      return {
        postMessage(message: unknown) {
          vscodeMessages.push(message);
        },
        getState() {
          return undefined;
        },
        setState() {},
      };
    },
  };

  vm.createContext(context);
  vm.runInContext(extractInlineScript(html), context);

  return {
    document,
    window,
    vscodeMessages,
    app: (context as Record<string, unknown>).__conductorDashboardApp as {
      applyMessage(message: unknown): void;
    },
  };
}

function createDashboardBrowserHarness(html: string) {
  const vscodeMessages: unknown[] = [];
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    url: "https://example.test/",
    beforeParse(window) {
      Object.assign(window, {
        acquireVsCodeApi() {
          return {
            postMessage(message: unknown) {
              vscodeMessages.push(message);
            },
            getState() {
              return undefined;
            },
            setState() {},
          };
        },
      });
    },
  });

  return {
    dom,
    document: dom.window.document,
    vscodeMessages,
    dispatchMessage(message: unknown) {
      dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: message }));
    },
  };
}

describe("dashboard panel G1", () => {
  it("shows that a prompt is needed before any runnable feature exists", () => {
    const harness = createPanelHarness();
    const dom = createDashboardBrowserHarness(harness.panelState.webview.html);
    const initialStateMessage = harness.receivedMessages.find((message) => {
      return typeof message === "object"
        && message !== null
        && (message as { type?: string }).type === "state"
        ? message
        : undefined;
    });

    try {
      expect(initialStateMessage).toEqual({
        type: "state",
        data: createState(),
      });
      expect(harness.receivedMessages.some((message) => {
        return typeof message === "object"
          && message !== null
          && (message as { type?: string }).type === "phase";
      })).toBe(false);

      dom.dispatchMessage(initialStateMessage);

      expect(dom.document.getElementById("step-value")?.textContent).toBe("Prompt needed");
    } finally {
      dom.dom.window.close();
    }
  });

  it("creates a webview panel with the conductor.dashboard view type", () => {
    const harness = createPanelHarness();

    expect(harness.panel).toBeDefined();
    expect(harness.createWebviewPanelCalls).toEqual([
      {
        viewType: dashboardPanelConstants.DASHBOARD_VIEW_TYPE,
        title: dashboardPanelConstants.DASHBOARD_TITLE,
      },
    ]);
  });

  it("posts orchestrator state updates to the webview", () => {
    const harness = createPanelHarness();
    const nextState = createState({ currentPhase: 2, currentItemIndex: 3, status: "paused" });

    harness.stateEmitter.fire(nextState);

    expect(harness.receivedMessages).toContainEqual({
      type: "state",
      data: nextState,
    });
  });

  it("posts bugfix-status updates to the webview when bugfix state is present", () => {
    const harness = createPanelHarness(createState({
      bugStep: "approving",
      bugIndex: 0,
      bugFixCycle: 2,
      bugIssues: [{ title: "bug", description: "desc" }],
    }));

    expect(harness.receivedMessages).toContainEqual({
      type: "bugfix-status",
      data: {
        bugIndex: 0,
        bugCount: 1,
        fixCycle: 2,
        bugStep: "approving",
      },
    });

    harness.stateEmitter.fire(createState({
      bugStep: "done",
      bugIndex: 1,
      bugFixCycle: 4,
      bugIssues: [{ title: "bug", description: "desc" }],
    }));

    expect(harness.receivedMessages).toContainEqual({
      type: "bugfix-status",
      data: {
        bugIndex: 1,
        bugCount: 1,
        fixCycle: 4,
        bugStep: "done",
      },
    });
  });

  it("posts a cleared bugfix-status message when state leaves bugfix mode", () => {
    const harness = createPanelHarness(createState({
      bugStep: "reviewing",
      bugIndex: 0,
      bugFixCycle: 2,
      bugIssues: [{ title: "bug", description: "desc" }],
    }));

    harness.stateEmitter.fire(createState({
      currentPhase: 2,
      currentItemIndex: 1,
      bugStep: undefined,
      bugIndex: undefined,
      bugFixCycle: undefined,
      bugIssues: undefined,
    }));

    expect(harness.receivedMessages).toContainEqual({
      type: "bugfix-status",
      data: null,
    });
  });

  it("posts pr-review-status updates to the webview on initial load and state changes", () => {
    const harness = createPanelHarness(createState({
      prReviewStep: "spec-aware",
      prReviewConsecutivePasses: 1,
    }));

    expect(harness.receivedMessages).toContainEqual({
      type: "pr-review-status",
      data: {
        step: "spec-aware",
        consecutivePasses: 1,
      },
    });

    harness.stateEmitter.fire(createState({
      prReviewStep: "spec-free",
      prReviewConsecutivePasses: 2,
    }));

    expect(harness.receivedMessages).toContainEqual({
      type: "pr-review-status",
      data: {
        step: "spec-free",
        consecutivePasses: 2,
      },
    });
  });

  it("posts control options to the webview", async () => {
    const harness = createPanelHarness();

    await waitFor(() => harness.receivedMessages.find((message) => {
      return typeof message === "object"
        && message !== null
        && (message as { type?: string }).type === "control-options"
        ? true
        : undefined;
    }));

    expect(harness.receivedMessages).toContainEqual({
      type: "control-options",
      data: {
        conventionsSkills: ["python-conventions", "nextjs-fastapi-conventions"],
        chatModels: [
          { vendor: "copilot", family: "gpt-5.4", name: "GPT-5.4", label: "GPT-5.4" },
          { vendor: "copilot", family: "o3", name: "o3", label: "o3" },
        ],
      },
    });
  });

  it("posts live audit and transcript updates to the webview", () => {
    const harness = createPanelHarness();
    const auditEntry = createAuditEntry("reviewer", { promptSummary: "reviewer work" });
    const transcript = {
      timestamp: "2026-03-19T12:00:00.000Z",
      role: "reviewer",
      model: "copilot/o3",
      itemId: "A1",
      messages: [{ role: "assistant", content: "PASS" }],
    };

    harness.auditEmitter.fire(auditEntry);
    harness.transcriptEmitter.fire(transcript as never);

    expect(harness.receivedMessages).toContainEqual({ type: "audit", entry: auditEntry });
    expect(harness.receivedMessages).toContainEqual({ type: "transcript", entry: transcript });
  });

  it("posts historical and live addendum updates to the webview", async () => {
    const harness = createPanelHarness();
    const liveAddendum = {
      timestamp: "2026-03-19T12:00:00.000Z",
      itemId: "A1",
      deviation: "Share the latest note.",
      rationale: "Keep the panel in sync.",
      author: "reviewer",
    };

    await waitFor(() => harness.receivedMessages.some((message) => JSON.stringify(message) === JSON.stringify({
      type: "addendum",
      entry: {
        timestamp: "2026-03-19T11:00:00.000Z",
        itemId: "A1",
        deviation: "Keep the reviewer note visible.",
        rationale: "Historical context for the dashboard.",
        author: "reviewer",
      },
    })) ? true : undefined);

    harness.addendumEmitter.fire(liveAddendum as never);

    expect(harness.receivedMessages.some((message) => JSON.stringify(message) === JSON.stringify({ type: "addendum", entry: liveAddendum }))).toBe(true);
  });

  it("routes pause messages to orchestrator.pause", () => {
    const harness = createPanelHarness();

    harness.receiveMessage({ type: "pause" });

    expect(harness.calls.pause).toBe(1);
  });

  it("routes resume messages to orchestrator.resume", () => {
    const harness = createPanelHarness();

    harness.receiveMessage({ type: "resume" });

    expect(harness.calls.resume).toBe(1);
  });

  it("routes abandon messages to the control bridge", () => {
    const harness = createPanelHarness();

    harness.receiveMessage({ type: "abandon" });

    expect(harness.calls.abandonRun).toBe(1);
  });

  it("routes start-feature messages to the control bridge", () => {
    const harness = createPanelHarness();

    harness.receiveMessage({
      type: "start-feature",
      prompt: "Build the new controls",
      conventionsSkill: "python-conventions",
      testCommand: "pytest",
      lintCommand: "ruff check .",
    });

    expect(harness.calls.startRun).toEqual([
      {
        type: "start-feature",
        prompt: "Build the new controls",
        conventionsSkill: "python-conventions",
        testCommand: "pytest",
        lintCommand: "ruff check .",
      },
    ]);
  });

  it("routes start-bugfix messages to the control bridge", () => {
    const harness = createPanelHarness();

    harness.receiveMessage({
      type: "start-bugfix",
      prompt: "Fix the websocket bug",
      conventionsSkill: "nextjs-fastapi-conventions",
      testCommand: "pnpm test",
      lintCommand: "pnpm lint",
    });

    expect(harness.calls.fixBugs).toEqual([
      {
        type: "start-bugfix",
        prompt: "Fix the websocket bug",
        conventionsSkill: "nextjs-fastapi-conventions",
        testCommand: "pnpm test",
        lintCommand: "pnpm lint",
      },
    ]);
  });

  it("routes approve messages to orchestrator.approve", () => {
    const harness = createPanelHarness();

    harness.receiveMessage({ type: "approve", itemId: "A1" });

    expect(harness.calls.approve).toEqual(["A1"]);
  });

  it("renders cumulative token totals from audit entries", () => {
    const harness = createPanelHarness();
    const dom = createDashboardDomHarness(harness.panelState.webview.html);

    dom.window.dispatchMessage({
      type: "audit",
      entry: createAuditEntry("reviewer", { tokensIn: 500, tokensOut: 200 }),
    });

    expect(dom.document.getElementById("token-total").textContent).toContain("700");
  });

  it("renders transcripts in an expandable viewer", () => {
    const harness = createPanelHarness();
    const dom = createDashboardDomHarness(harness.panelState.webview.html);

    dom.window.dispatchMessage({
      type: "transcript",
      entry: {
        timestamp: "2026-03-19T12:00:00.000Z",
        role: "reviewer",
        model: "copilot/o3",
        itemId: "A1",
        messages: [{ role: "assistant", content: "PASS" }],
      },
    });

    expect(dom.document.getElementById("transcript-list").innerHTML).toContain("<details>");
    expect(dom.document.getElementById("transcript-list").innerHTML).toContain("PASS");
  });

  it("includes a CSP meta tag with nonce-based inline script restrictions", () => {
    const harness = createPanelHarness();

    expect(harness.panelState.webview.html).toMatch(/<meta\s+http-equiv="Content-Security-Policy"/);
    expect(harness.panelState.webview.html).toMatch(/script-src 'nonce-[^']+'/);
  });

  it("renders the current audit role filter options", () => {
    const harness = createPanelHarness();
    const auditFilterMarkup = harness.panelState.webview.html.match(
      /<select id="audit-filter">([\s\S]*?)<\/select>/,
    )?.[1] ?? "";
    const optionValues = Array.from(auditFilterMarkup.matchAll(/<option value="([^"]+)">/g), (match) => match[1]);

    expect(optionValues).toEqual([
      "all",
      "implementor",
      "reviewer",
      "clarifier",
      "spec-author",
      "spec-reviewer",
      "spec-proofreader",
      "phase-creator",
      "phase-reviewer",
    ]);
  });

  it("routes submit-clarification messages to orchestrator.submitClarification", () => {
    const harness = createPanelHarness();

    harness.receiveMessage({
      type: "submit-clarification",
      answers: [{ question: "Which language?", answer: "TypeScript" }],
    });

    expect(harness.calls.submitClarification).toEqual([
      [{ question: "Which language?", answer: "TypeScript" }],
    ]);
  });

  it("routes skip messages to orchestrator.skip", () => {
    const harness = createPanelHarness();

    harness.receiveMessage({ type: "skip", itemId: "A1" });

    expect(harness.calls.skip).toEqual(["A1"]);
  });

  it("routes retry messages to orchestrator.retry", () => {
    const harness = createPanelHarness();

    harness.receiveMessage({ type: "retry", itemId: "A1" });

    expect(harness.calls.retry).toEqual(["A1"]);
  });

  it("routes reject messages to orchestrator.reject", () => {
    const harness = createPanelHarness();

    harness.receiveMessage({ type: "reject", itemId: "A1", feedback: "fix X" });

    expect(harness.calls.reject).toEqual([{ itemId: "A1", feedback: "fix X" }]);
  });

  it("routes changeModel messages to orchestrator.changeModel", () => {
    const harness = createPanelHarness();

    harness.receiveMessage({ type: "changeModel", role: "reviewer", vendor: "copilot", family: "o3" });

    expect(harness.calls.changeModel).toEqual([
      { role: "reviewer", vendor: "copilot", family: "o3" },
    ]);
  });

  it("routes override-commands messages to orchestrator.overrideCommands", () => {
    const harness = createPanelHarness();

    harness.receiveMessage({
      type: "override-commands",
      testCommand: "pnpm test",
      lintCommand: "pnpm lint --fix",
    });

    expect(harness.calls.overrideCommands).toEqual([
      { testCommand: "pnpm test", lintCommand: "pnpm lint --fix" },
    ]);
  });

  it("routes copilot-rereview messages to orchestrator.startCopilotReReview", () => {
    const harness = createPanelHarness();

    harness.receiveMessage({ type: "copilot-rereview" });

    expect(harness.calls.startCopilotReReview).toBe(1);
  });

  it("emits dashboard control messages from the real webview UI", () => {
    const harness = createPanelHarness();
    const dom = createDashboardDomHarness(harness.panelState.webview.html);

    dom.window.dispatchMessage({
      type: "control-options",
      data: {
        conventionsSkills: ["python-conventions"],
        chatModels: [
          { vendor: "copilot", family: "gpt-5.4", name: "GPT-5.4", label: "GPT-5.4" },
          { vendor: "copilot", family: "o3", name: "o3", label: "o3" },
        ],
      },
    });
    dom.document.getElementById("item-id-input").value = "A1";
    dom.document.getElementById("reject-feedback-input").value = "fix X";
    dom.document.getElementById("role-select").value = "reviewer";
    dom.document.getElementById("model-select").value = JSON.stringify({ vendor: "copilot", family: "o3" });
    dom.document.getElementById("inline-prompt-input").value = "Add inline dashboard controls";
    dom.document.getElementById("conventions-skill-select").value = "python-conventions";
    dom.document.getElementById("test-command-input").value = "pytest";
    dom.document.getElementById("lint-command-input").value = "ruff check .";

    dom.document.getElementById("pause-button").click();
    dom.document.getElementById("resume-button").click();
    dom.document.getElementById("copilot-rereview-button").click();
    dom.document.getElementById("abandon-button").click();
    dom.document.getElementById("override-commands-button").click();
    dom.document.getElementById("start-run-button").click();
    dom.document.getElementById("fix-bugs-button").click();
    dom.document.getElementById("approve-button").click();
    dom.document.getElementById("reject-button").click();
    dom.document.getElementById("skip-button").click();
    dom.document.getElementById("retry-button").click();
    dom.document.getElementById("change-model-button").click();

    expect(dom.vscodeMessages).toEqual([
      { type: "pause" },
      { type: "resume" },
      { type: "copilot-rereview" },
      { type: "abandon" },
      { type: "override-commands", testCommand: "pytest", lintCommand: "ruff check ." },
      {
        type: "start-feature",
        prompt: "Add inline dashboard controls",
        conventionsSkill: "python-conventions",
        testCommand: "pytest",
        lintCommand: "ruff check .",
      },
      {
        type: "start-bugfix",
        prompt: "Add inline dashboard controls",
        conventionsSkill: "python-conventions",
        testCommand: "pytest",
        lintCommand: "ruff check .",
      },
      { type: "approve", itemId: "A1" },
      { type: "reject", itemId: "A1", feedback: "fix X" },
      { type: "skip", itemId: "A1" },
      { type: "retry", itemId: "A1" },
      { type: "changeModel", role: "reviewer", vendor: "copilot", family: "o3" },
    ]);
  });

  it("preserves a locally selected conventions skill after Apply commands rerenders the controls with unchanged persisted state", () => {
    const harness = createPanelHarness(createState({ conventionsSkill: "python-conventions" }));
    const dom = createDashboardBrowserHarness(harness.panelState.webview.html);

    try {
      dom.dispatchMessage({
        type: "control-options",
        data: {
          conventionsSkills: ["python-conventions", "nextjs-fastapi-conventions"],
          chatModels: [
            { vendor: "copilot", family: "gpt-5.4", name: "GPT-5.4", label: "GPT-5.4" },
          ],
        },
      });
      dom.dispatchMessage({
        type: "state",
        data: createState({ conventionsSkill: "python-conventions", testCommand: "npm test", lintCommand: "" }),
      });

      const inlinePromptInput = dom.document.getElementById("inline-prompt-input") as HTMLTextAreaElement;
      const conventionsSkillSelect = dom.document.getElementById("conventions-skill-select") as HTMLSelectElement;
      const testCommandInput = dom.document.getElementById("test-command-input") as HTMLInputElement;
      const lintCommandInput = dom.document.getElementById("lint-command-input") as HTMLInputElement;

      inlinePromptInput.value = "Fix the dashboard controls";
      conventionsSkillSelect.value = "nextjs-fastapi-conventions";
      testCommandInput.value = "pnpm test";
      lintCommandInput.value = "pnpm lint";

      (dom.document.getElementById("override-commands-button") as HTMLButtonElement).click();

      dom.dispatchMessage({
        type: "state",
        data: createState({ conventionsSkill: "python-conventions", testCommand: "pnpm test", lintCommand: "pnpm lint" }),
      });

      expect(conventionsSkillSelect.value).toBe("nextjs-fastapi-conventions");

      (dom.document.getElementById("start-run-button") as HTMLButtonElement).click();
      (dom.document.getElementById("fix-bugs-button") as HTMLButtonElement).click();

      expect(dom.vscodeMessages).toEqual([
        { type: "override-commands", testCommand: "pnpm test", lintCommand: "pnpm lint" },
        {
          type: "start-feature",
          prompt: "Fix the dashboard controls",
          conventionsSkill: "nextjs-fastapi-conventions",
          testCommand: "pnpm test",
          lintCommand: "pnpm lint",
        },
        {
          type: "start-bugfix",
          prompt: "Fix the dashboard controls",
          conventionsSkill: "nextjs-fastapi-conventions",
          testCommand: "pnpm test",
          lintCommand: "pnpm lint",
        },
      ]);
    } finally {
      dom.dom.window.close();
    }
  });

  it("renders spec-writing roles in the dashboard model selector", () => {
    const harness = createPanelHarness();
    const html = harness.panelState.webview.html;

    expect(html).toContain('<option value="implementor">Implementor</option>');
    expect(html).toContain('<option value="reviewer">Reviewer</option>');
    expect(html).toContain('<option value="pr-reviewer">PR reviewer</option>');
    expect(html).toContain('<option value="spec-author">Spec author</option>');
    expect(html).toContain('<option value="spec-reviewer">Spec reviewer</option>');
    expect(html).toContain('<option value="spec-proofreader">Spec proofreader</option>');
    expect(html).toContain('<option value="phase-creator">Phase creator</option>');
    expect(html).toContain('<option value="phase-reviewer">Phase reviewer</option>');
  });

  it("renders runtime chat models plus Auto in the dashboard model dropdown and refreshes when options change", () => {
    const harness = createPanelHarness(createState({
      modelAssignments: [
        { role: "implementor", vendor: "copilot", family: "gpt-5.4" },
        { role: "reviewer", vendor: "copilot", family: "o3" },
      ],
    }));
    const dom = createDashboardDomHarness(harness.panelState.webview.html);

    dom.window.dispatchMessage({
      type: "state",
      data: createState({
        modelAssignments: [
          { role: "implementor", vendor: "copilot", family: "gpt-5.4" },
          { role: "reviewer", vendor: "copilot", family: "o3" },
        ],
      }),
    });
    dom.window.dispatchMessage({
      type: "control-options",
      data: {
        conventionsSkills: [],
        chatModels: [
          { vendor: "copilot", family: "gpt-5.4", name: "GPT-5.4", label: "GPT-5.4" },
          { vendor: "copilot", family: "o3", name: "o3", label: "o3" },
        ],
      },
    });

    const modelSelect = dom.document.getElementById("model-select");
    expect(modelSelect.innerHTML).toContain(">Auto<");
    expect(modelSelect.innerHTML).toContain(">o3<");
    expect(modelSelect.value).toBe(JSON.stringify({ vendor: "copilot", family: "gpt-5.4" }));

    dom.window.dispatchMessage({
      type: "control-options",
      data: {
        conventionsSkills: [],
        chatModels: [
          { vendor: "copilot", family: "gpt-5.4", name: "GPT-5.4", label: "GPT-5.4" },
        ],
      },
    });

    expect(modelSelect.innerHTML).not.toContain(">o3<");
  });

  it("defaults the dashboard role selector based on the current spec-writing step", () => {
    const harness = createPanelHarness();
    const dom = createDashboardBrowserHarness(harness.panelState.webview.html);

    try {
      const roleSelect = dom.document.getElementById("role-select") as HTMLSelectElement;
      const modelSelect = dom.document.getElementById("model-select") as HTMLSelectElement;

      dom.dispatchMessage({
        type: "control-options",
        data: {
          conventionsSkills: [],
          chatModels: [
            { vendor: "copilot", family: "gpt-5.4", name: "GPT-5.4", label: "GPT-5.4" },
            { vendor: "copilot", family: "o3", name: "o3", label: "o3" },
          ],
        },
      });

      const cases = [
        {
          specStep: "clarifying",
          expectedRole: "spec-author",
          expectedModel: JSON.stringify({ vendor: "copilot", family: "gpt-5.4" }),
        },
        {
          specStep: "authoring",
          expectedRole: "spec-author",
          expectedModel: JSON.stringify({ vendor: "copilot", family: "gpt-5.4" }),
        },
        {
          specStep: "reviewing",
          expectedRole: "spec-reviewer",
          expectedModel: JSON.stringify({ vendor: "copilot", family: "o3" }),
        },
        {
          specStep: "proofreading",
          expectedRole: "spec-proofreader",
          expectedModel: JSON.stringify({ vendor: "copilot", family: "gpt-5.4" }),
        },
        {
          specStep: "creating-phases",
          expectedRole: "phase-creator",
          expectedModel: JSON.stringify({ vendor: "copilot", family: "o3" }),
        },
        {
          specStep: "reviewing-phases",
          expectedRole: "phase-reviewer",
          expectedModel: JSON.stringify({ vendor: "copilot", family: "gpt-5.4" }),
        },
      ] as const;

      for (const testCase of cases) {
        dom.dispatchMessage({
          type: "state",
          data: createState({
            specStep: testCase.specStep,
            modelAssignments: [
              { role: "spec-author", vendor: "copilot", family: "gpt-5.4" },
              { role: "spec-reviewer", vendor: "copilot", family: "o3" },
              { role: "spec-proofreader", vendor: "copilot", family: "gpt-5.4" },
              { role: "phase-creator", vendor: "copilot", family: "o3" },
              { role: "phase-reviewer", vendor: "copilot", family: "gpt-5.4" },
            ],
          }),
        });

        expect(roleSelect.value).toBe(testCase.expectedRole);
        expect(modelSelect.value).toBe(testCase.expectedModel);
      }
    } finally {
      dom.dom.window.close();
    }
  });

  it("defaults the dashboard role selector to pr-reviewer during PR review", () => {
    const harness = createPanelHarness();
    const dom = createDashboardBrowserHarness(harness.panelState.webview.html);

    try {
      const roleSelect = dom.document.getElementById("role-select") as HTMLSelectElement;
      const modelSelect = dom.document.getElementById("model-select") as HTMLSelectElement;

      dom.dispatchMessage({
        type: "control-options",
        data: {
          conventionsSkills: [],
          chatModels: [
            { vendor: "copilot", family: "gpt-5.4", name: "GPT-5.4", label: "GPT-5.4" },
            { vendor: "copilot", family: "o3", name: "o3", label: "o3" },
          ],
        },
      });

      dom.dispatchMessage({
        type: "state",
        data: createState({
          prReviewStep: "spec-aware",
          modelAssignments: [
            { role: "implementor", vendor: "copilot", family: "gpt-5.4" },
            { role: "reviewer", vendor: "copilot", family: "o3" },
            { role: "pr-reviewer", vendor: "copilot", family: "o3" },
          ],
        }),
      });

      expect(roleSelect.value).toBe("pr-reviewer");
      expect(modelSelect.value).toBe(JSON.stringify({ vendor: "copilot", family: "o3" }));
    } finally {
      dom.dom.window.close();
    }
  });

  it("falls back to implementor when the current state is not review-oriented", () => {
    const harness = createPanelHarness();
    const dom = createDashboardBrowserHarness(harness.panelState.webview.html);

    try {
      const roleSelect = dom.document.getElementById("role-select") as HTMLSelectElement;
      const modelSelect = dom.document.getElementById("model-select") as HTMLSelectElement;

      dom.dispatchMessage({
        type: "control-options",
        data: {
          conventionsSkills: [],
          chatModels: [
            { vendor: "copilot", family: "gpt-5.4", name: "GPT-5.4", label: "GPT-5.4" },
            { vendor: "copilot", family: "o3", name: "o3", label: "o3" },
          ],
        },
      });

      dom.dispatchMessage({
        type: "state",
        data: createState({
          currentItemIndex: 1,
          itemStatuses: { A1: "pass", B1: "in-progress" },
          prReviewStep: "done",
          bugStep: undefined,
          modelAssignments: [
            { role: "implementor", vendor: "copilot", family: "gpt-5.4" },
            { role: "reviewer", vendor: "copilot", family: "o3" },
            { role: "pr-reviewer", vendor: "copilot", family: "o3" },
          ],
        }),
      });

      expect(roleSelect.value).toBe("implementor");
      expect(modelSelect.value).toBe(JSON.stringify({ vendor: "copilot", family: "gpt-5.4" }));
    } finally {
      dom.dom.window.close();
    }
  });

  it("preserves a user-chosen role across later state-driven rerenders", () => {
    const harness = createPanelHarness();
    const dom = createDashboardBrowserHarness(harness.panelState.webview.html);

    try {
      dom.dispatchMessage({
        type: "control-options",
        data: {
          conventionsSkills: [],
          chatModels: [
            { vendor: "copilot", family: "gpt-5.4", name: "GPT-5.4", label: "GPT-5.4" },
            { vendor: "copilot", family: "o3", name: "o3", label: "o3" },
          ],
        },
      });

      dom.dispatchMessage({
        type: "state",
        data: createState({
          specStep: "reviewing",
          modelAssignments: [
            { role: "reviewer", vendor: "copilot", family: "o3" },
            { role: "spec-reviewer", vendor: "copilot", family: "gpt-5.4" },
            { role: "spec-proofreader", vendor: "copilot", family: "gpt-5.4" },
          ],
        }),
      });

      const roleSelect = dom.document.getElementById("role-select") as HTMLSelectElement;
      const modelSelect = dom.document.getElementById("model-select") as HTMLSelectElement;

      expect(roleSelect.value).toBe("spec-reviewer");
      expect(modelSelect.value).toBe(JSON.stringify({ vendor: "copilot", family: "gpt-5.4" }));

      roleSelect.value = "reviewer";
      roleSelect.dispatchEvent(new dom.dom.window.Event("change", { bubbles: true }));

      expect(modelSelect.value).toBe(JSON.stringify({ vendor: "copilot", family: "o3" }));

      dom.dispatchMessage({
        type: "state",
        data: createState({
          specStep: "proofreading",
          modelAssignments: [
            { role: "reviewer", vendor: "copilot", family: "o3" },
            { role: "spec-reviewer", vendor: "copilot", family: "gpt-5.4" },
            { role: "spec-proofreader", vendor: "copilot", family: "gpt-5.4" },
          ],
        }),
      });

      expect(roleSelect.value).toBe("reviewer");
      expect(modelSelect.value).toBe(JSON.stringify({ vendor: "copilot", family: "o3" }));

      (dom.document.getElementById("change-model-button") as HTMLButtonElement).click();

      expect(dom.vscodeMessages).toEqual([
        { type: "changeModel", role: "reviewer", vendor: "copilot", family: "o3" },
      ]);
    } finally {
      dom.dom.window.close();
    }
  });

  it("maps Auto model selection back to empty vendor and family values", () => {
    const harness = createPanelHarness();
    const dom = createDashboardDomHarness(harness.panelState.webview.html);

    dom.window.dispatchMessage({
      type: "control-options",
      data: {
        conventionsSkills: [],
        chatModels: [
          { vendor: "copilot", family: "o3", name: "o3", label: "o3" },
        ],
      },
    });
    dom.document.getElementById("role-select").value = "reviewer";
    dom.document.getElementById("model-select").value = JSON.stringify({ vendor: "", family: "" });

    dom.document.getElementById("change-model-button").click();

    expect(dom.vscodeMessages).toEqual([
      { type: "changeModel", role: "reviewer", vendor: "", family: "" },
    ]);
  });

  it("filters audit entries by reviewer role", () => {
    const harness = createPanelHarness();
    const dom = createDashboardDomHarness(harness.panelState.webview.html);

    dom.window.dispatchMessage({
      type: "audit",
      entry: createAuditEntry("implementor", { promptSummary: "implementor work" }),
    });
    dom.window.dispatchMessage({
      type: "audit",
      entry: createAuditEntry("reviewer", { promptSummary: "reviewer work" }),
    });

    const filter = dom.document.getElementById("audit-filter");
    filter.value = "reviewer";
    filter.dispatchEvent({ type: "change" });

    const auditHtml = dom.document.getElementById("audit-list").innerHTML;
    expect(auditHtml).toContain("reviewer work");
    expect(auditHtml).not.toContain("implementor work");
  });

  it("filters audit entries by result status", () => {
    const harness = createPanelHarness();
    const dom = createDashboardDomHarness(harness.panelState.webview.html);

    dom.window.dispatchMessage({
      type: "audit",
      entry: createAuditEntry("implementor", { promptSummary: "failing work", result: "FAIL" }),
    });
    dom.window.dispatchMessage({
      type: "audit",
      entry: createAuditEntry("reviewer", { promptSummary: "passing work", result: "PASS" }),
    });

    const filter = dom.document.getElementById("audit-status-filter");
    filter.value = "PASS";
    filter.dispatchEvent({ type: "change" });

    const auditHtml = dom.document.getElementById("audit-list").innerHTML;
    expect(auditHtml).toContain("passing work");
    expect(auditHtml).not.toContain("failing work");
  });

  it("renders phase items with status pills", () => {
    const harness = createPanelHarness(createState({
      currentItemIndex: 1,
      itemStatuses: { A1: "pass", B1: "in-progress" },
    }));
    const dom = createDashboardDomHarness(harness.panelState.webview.html);

    dom.window.dispatchMessage({ type: "phase", data: createPhase() });
    dom.window.dispatchMessage({
      type: "state",
      data: createState({ currentItemIndex: 1, itemStatuses: { A1: "pass", B1: "in-progress" } }),
    });

    const phaseHtml = dom.document.getElementById("phase-items-list").innerHTML;
    expect(phaseHtml).toContain("A1");
    expect(phaseHtml).toContain("pass");
    expect(phaseHtml).toContain("B1");
    expect(phaseHtml).toContain("in-progress");
  });

  it("renders spec-writing progress when specStep is active", () => {
    const harness = createPanelHarness();
    const dom = createDashboardDomHarness(harness.panelState.webview.html);

    dom.window.dispatchMessage({
      type: "state",
      data: createState({ specStep: "reviewing-phases", specConsecutivePasses: 1 }),
    });

    expect(dom.document.getElementById("spec-status-section").hidden).toBe(false);
    expect(dom.document.getElementById("spec-step-value").textContent).toBe("Reviewing Phases");
    expect(dom.document.getElementById("spec-pass-count").textContent).toBe("1");
  });

  it("renders bugfix status when bugfix-status messages arrive", () => {
    const harness = createPanelHarness();
    const dom = createDashboardDomHarness(harness.panelState.webview.html);

    dom.window.dispatchMessage({
      type: "bugfix-status",
      data: {
        bugIndex: 1,
        bugCount: 3,
        fixCycle: 4,
        bugStep: "approving",
      },
    });

    expect(dom.document.getElementById("bugfix-status-section").hidden).toBe(false);
    expect(dom.document.getElementById("bugfix-current-value").textContent).toBe("2 / 3");
    expect(dom.document.getElementById("bugfix-cycle-value").textContent).toBe("4");
    expect(dom.document.getElementById("bugfix-step-value").textContent).toBe("Awaiting approval");
  });

  it("hides bugfix status when a cleared bugfix-status message arrives", () => {
    const harness = createPanelHarness();
    const dom = createDashboardDomHarness(harness.panelState.webview.html);

    dom.window.dispatchMessage({
      type: "bugfix-status",
      data: {
        bugIndex: 1,
        bugCount: 3,
        fixCycle: 4,
        bugStep: "approving",
      },
    });

    expect(dom.document.getElementById("bugfix-status-section").hidden).toBe(false);

    dom.window.dispatchMessage({
      type: "bugfix-status",
      data: null,
    });

    expect(dom.document.getElementById("bugfix-status-section").hidden).toBe(true);
  });

  it("renders PR review status when pr-review-status messages arrive", () => {
    const harness = createPanelHarness();
    const dom = createDashboardDomHarness(harness.panelState.webview.html);

    dom.window.dispatchMessage({
      type: "pr-review-status",
      data: { step: "spec-free", consecutivePasses: 2 },
    });

    expect(dom.document.getElementById("pr-review-status-section").hidden).toBe(false);
    expect(dom.document.getElementById("pr-review-step-value").textContent).toBe("Spec Free");
    expect(dom.document.getElementById("pr-review-pass-count").textContent).toBe("2");
  });

  it("renders clarification questions and emits submit-clarification from the UI", () => {
    const harness = createPanelHarness();
    const dom = createDashboardDomHarness(harness.panelState.webview.html);

    dom.window.dispatchMessage({
      type: "state",
      data: createState({
        specStep: "clarifying",
        clarificationQuestions: [
          {
            question: "Which language should the extension target?",
            suggestedOptions: ["TypeScript", "JavaScript"],
          },
        ],
      }),
    });

    expect(dom.document.getElementById("clarification-section").hidden).toBe(false);
    expect(dom.document.getElementById("clarification-questions").innerHTML).toContain("Which language should the extension target?");

    dom.document.getElementById("clarification-answer-0").value = "TypeScript";
    dom.document.getElementById("clarification-form").dispatchEvent({
      type: "submit",
      preventDefault() {},
    });

    expect(dom.vscodeMessages).toContainEqual({
      type: "submit-clarification",
      answers: [{ question: "Which language should the extension target?", answer: "TypeScript" }],
    });
  });

  it("hides clarification questions when questions exist outside the clarifying step", () => {
    const harness = createPanelHarness();
    const dom = createDashboardDomHarness(harness.panelState.webview.html);

    dom.window.dispatchMessage({
      type: "state",
      data: createState({
        specStep: "reviewing",
        clarificationQuestions: [
          {
            question: "Which language should the extension target?",
            suggestedOptions: ["TypeScript", "JavaScript"],
          },
        ],
      }),
    });

    expect(dom.document.getElementById("clarification-section").hidden).toBe(true);
    expect(dom.document.getElementById("clarification-questions").innerHTML).toBe("");
  });
});
