import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";

import type { Orchestrator } from "../../orchestrator/machine";
import { handleWebSocket } from "../../server/ws";
import type {
  AddendumEntry,
  AuditEntry,
  ClarificationAnswer,
  DashboardControlBridge,
  OrchestratorState,
  RunTranscript,
} from "../../types";

class TestEmitter<T> {
  private readonly listeners = new Set<(value: T) => void>();

  public readonly event = (listener: (value: T) => void) => {
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

type OrchestratorHarness = {
  orchestrator: Orchestrator;
  stateEmitter: TestEmitter<OrchestratorState>;
  auditEmitter: TestEmitter<AuditEntry>;
  addendumEmitter: TestEmitter<AddendumEntry>;
  transcriptEmitter: TestEmitter<RunTranscript>;
  calls: {
    pause: number;
    startCopilotReReview: number;
    startRun: Array<{ prompt: string; conventionsSkill: string; testCommand: string; lintCommand: string }>;
    fixBugs: Array<{ prompt: string; conventionsSkill: string; testCommand: string; lintCommand: string }>;
    abandonRun: number;
    addNote: Array<{ itemId: string; text: string; author?: string }>;
    submitClarification: ClarificationAnswer[][];
    overrideCommands: Array<{ testCommand: string; lintCommand: string }>;
  };
  controlBridge: DashboardControlBridge;
};

const socketsToClose: WebSocket[] = [];
const serversToClose: WebSocketServer[] = [];
const httpServersToClose: Array<ReturnType<typeof createServer>> = [];

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
    modelAssignments: [],
    itemStatuses: {},
    ...overrides,
  };
}

function createHarness(initialState = createState()): OrchestratorHarness {
  const stateEmitter = new TestEmitter<OrchestratorState>();
  const auditEmitter = new TestEmitter<AuditEntry>();
  const addendumEmitter = new TestEmitter<AddendumEntry>();
  const transcriptEmitter = new TestEmitter<RunTranscript>();
  const calls = {
    pause: 0,
    startCopilotReReview: 0,
    startRun: [] as Array<{ prompt: string; conventionsSkill: string; testCommand: string; lintCommand: string }>,
    fixBugs: [] as Array<{ prompt: string; conventionsSkill: string; testCommand: string; lintCommand: string }>,
    abandonRun: 0,
    addNote: [] as Array<{ itemId: string; text: string; author?: string }>,
    submitClarification: [] as ClarificationAnswer[][],
    overrideCommands: [] as Array<{ testCommand: string; lintCommand: string }>,
  };

  let currentState = initialState;

  const orchestrator: Orchestrator = {
    async run() {},
    startCopilotReReview() {
      calls.startCopilotReReview += 1;
    },
    abandon() {},
    pause() {
      calls.pause += 1;
    },
    resume() {},
    skip() {},
    retry() {},
    changeModel() {},
    overrideCommands(testCommand: string, lintCommand: string) {
      calls.overrideCommands.push({ testCommand, lintCommand });
    },
    approve() {},
    reject() {},
    submitClarification(answers: ClarificationAnswer[]) {
      calls.submitClarification.push(answers);
    },
    addNote(itemId: string, text: string, author?: string) {
      calls.addNote.push({ itemId, text, author });
    },
    getState() {
      return currentState;
    },
    async getPhase() {
      return { number: 1, title: "Phase 1", items: [], batches: [] };
    },
    async getPhases() {
      return [
        { number: 1, title: "Phase 1", items: [], batches: [] },
        { number: 2, title: "Phase 2", items: [], batches: [] },
      ];
    },
    async getAuditEntries() {
      return [];
    },
    async getAddendumEntries() {
      return [{
        timestamp: "2025-03-19T09:00:00.000Z",
        itemId: "A1",
        deviation: "Carry this note forward.",
        rationale: "Historical context for the next reviewer.",
        author: "reviewer",
      }];
    },
    async getTranscripts() {
      return [];
    },
    onStateChange: ((listener: (value: OrchestratorState) => void) => stateEmitter.event((value) => {
      currentState = value;
      listener(value);
    })) as never,
    onAuditEntry: auditEmitter.event as never,
    onAddendum: addendumEmitter.event as never,
    onTranscript: transcriptEmitter.event as never,
  };

  const controlBridge: DashboardControlBridge = {
    getControlOptions() {
      return {
        conventionsSkills: ["python-conventions", "nextjs-fastapi-conventions"],
        chatModels: [],
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

  return { orchestrator, stateEmitter, auditEmitter, addendumEmitter, transcriptEmitter, calls, controlBridge };
}

async function createWsServer(
  orchestrator: Orchestrator,
  controlBridge?: DashboardControlBridge,
): Promise<{ server: WebSocketServer; port: number }> {
  const httpServer = createServer();
  const server = new WebSocketServer({ server: httpServer });
  server.on("connection", (socket: WebSocket) => {
    handleWebSocket(socket, orchestrator, controlBridge);
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => resolve());
  });

  serversToClose.push(server);
  httpServersToClose.push(httpServer);

  return {
    server,
    port: (httpServer.address() as AddressInfo).port,
  };
}

async function openClient(port: number): Promise<{ socket: WebSocket; messages: unknown[] }> {
  const messages: unknown[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  socketsToClose.push(socket);
  socket.on("message", (value: Buffer) => {
    messages.push(JSON.parse(value.toString()) as unknown);
  });

  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });

  return { socket, messages };
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

afterEach(async () => {
  await Promise.all(socketsToClose.splice(0).map(async (socket) => {
    if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) {
      await new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
        socket.close();
      });
    }
  }));

  await Promise.all(serversToClose.splice(0).map(async (server) => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }));

  await Promise.all(httpServersToClose.splice(0).map(async (server) => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }));
});

describe("handleWebSocket", () => {
  it("sends all phases to newly connected clients", async () => {
    const harness = createHarness();
    const { port } = await createWsServer(harness.orchestrator, harness.controlBridge);
    const client = await openClient(port);

    const phaseMessages = await waitFor(() => {
      const phases = client.messages.filter((message) => {
        return typeof message === "object" && message !== null && (message as { type?: string }).type === "phase";
      });

      return phases.length === 2 ? phases : undefined;
    });

    expect(phaseMessages).toEqual([
      { type: "phase", data: { number: 1, title: "Phase 1", items: [], batches: [] } },
      { type: "phase", data: { number: 2, title: "Phase 2", items: [], batches: [] } },
    ]);
  });

  it("sends control options to newly connected clients", async () => {
    const harness = createHarness();
    const { port } = await createWsServer(harness.orchestrator, harness.controlBridge);
    const client = await openClient(port);

    const controlOptionsMessage = await waitFor(() => client.messages.find((message) => {
      return typeof message === "object"
        && message !== null
        && (message as { type?: string }).type === "control-options"
        ? message
        : undefined;
    }));

    expect(controlOptionsMessage).toEqual({
      type: "control-options",
      data: {
        conventionsSkills: ["python-conventions", "nextjs-fastapi-conventions"],
        chatModels: [],
      },
    });
  });

  it("broadcasts state updates to multiple connected clients", async () => {
    const harness = createHarness();
    const { port } = await createWsServer(harness.orchestrator);
    const firstClient = await openClient(port);
    const secondClient = await openClient(port);

    harness.stateEmitter.fire(createState({ currentItemIndex: 1 }));

    await waitFor(() => firstClient.messages.find((message) => {
      return typeof message === "object"
        && message !== null
        && (message as { type?: string }).type === "state"
        && (message as { data?: { currentItemIndex?: number } }).data?.currentItemIndex === 1
        ? message
        : undefined;
    }));
    await waitFor(() => secondClient.messages.find((message) => {
      return typeof message === "object"
        && message !== null
        && (message as { type?: string }).type === "state"
        && (message as { data?: { currentItemIndex?: number } }).data?.currentItemIndex === 1
        ? message
        : undefined;
    }));
  });

  it("broadcasts bugfix-status updates when bugfix state is present", async () => {
    const harness = createHarness(createState({
      bugStep: "reviewing",
      bugIndex: 1,
      bugFixCycle: 3,
      bugIssues: [
        { title: "one", description: "first" },
        { title: "two", description: "second" },
      ],
    }));
    const { port } = await createWsServer(harness.orchestrator);
    const client = await openClient(port);

    const initialBugfixStatus = await waitFor(() => client.messages.find((message) => {
      return typeof message === "object"
        && message !== null
        && (message as { type?: string }).type === "bugfix-status"
        ? message
        : undefined;
    }));

    expect(initialBugfixStatus).toEqual({
      type: "bugfix-status",
      data: {
        bugIndex: 1,
        bugCount: 2,
        fixCycle: 3,
        bugStep: "reviewing",
      },
    });

    harness.stateEmitter.fire(createState({
      bugStep: "done",
      bugIndex: 2,
      bugFixCycle: 5,
      bugIssues: [
        { title: "one", description: "first" },
        { title: "two", description: "second" },
      ],
    }));

    const finalBugfixStatus = await waitFor(() => {
      const reversed = [...client.messages].reverse();
      return reversed.find((message) => {
        return typeof message === "object"
          && message !== null
          && (message as { type?: string }).type === "bugfix-status"
          && (message as { data?: { bugStep?: string } }).data?.bugStep === "done"
          ? message
          : undefined;
      });
    });

    expect(finalBugfixStatus).toEqual({
      type: "bugfix-status",
      data: {
        bugIndex: 2,
        bugCount: 2,
        fixCycle: 5,
        bugStep: "done",
      },
    });
  });

  it("broadcasts a cleared bugfix-status when the next state is not a bugfix run", async () => {
    const harness = createHarness(createState({
      bugStep: "reviewing",
      bugIndex: 0,
      bugFixCycle: 2,
      bugIssues: [{ title: "one", description: "first" }],
    }));
    const { port } = await createWsServer(harness.orchestrator);
    const client = await openClient(port);

    await waitFor(() => client.messages.find((message) => {
      return typeof message === "object"
        && message !== null
        && (message as { type?: string }).type === "bugfix-status"
        && (message as { data?: { bugStep?: string } }).data?.bugStep === "reviewing"
        ? message
        : undefined;
    }));

    harness.stateEmitter.fire(createState({
      currentPhase: 2,
      currentItemIndex: 1,
      bugStep: undefined,
      bugIndex: undefined,
      bugFixCycle: undefined,
      bugIssues: undefined,
    }));

    const clearedBugfixStatus = await waitFor(() => {
      const reversed = [...client.messages].reverse();
      return reversed.find((message) => {
        return typeof message === "object"
          && message !== null
          && (message as { type?: string }).type === "bugfix-status"
          && (message as { data?: unknown }).data === null
          ? message
          : undefined;
      });
    });

    expect(clearedBugfixStatus).toEqual({
      type: "bugfix-status",
      data: null,
    });
  });

  it("broadcasts pr-review-status updates on connect and state changes", async () => {
    const harness = createHarness(createState({
      prReviewStep: "spec-aware",
      prReviewConsecutivePasses: 1,
    }));
    const { port } = await createWsServer(harness.orchestrator);
    const client = await openClient(port);

    const initialPrReviewStatus = await waitFor(() => client.messages.find((message) => {
      return typeof message === "object"
        && message !== null
        && (message as { type?: string }).type === "pr-review-status"
        ? message
        : undefined;
    }));

    expect(initialPrReviewStatus).toEqual({
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

    const finalPrReviewStatus = await waitFor(() => {
      const reversed = [...client.messages].reverse();
      return reversed.find((message) => {
        return typeof message === "object"
          && message !== null
          && (message as { type?: string }).type === "pr-review-status"
          && (message as { data?: { step?: string } }).data?.step === "spec-free"
          ? message
          : undefined;
      });
    });

    expect(finalPrReviewStatus).toEqual({
      type: "pr-review-status",
      data: {
        step: "spec-free",
        consecutivePasses: 2,
      },
    });
  });

  it("sends historical addendum entries to newly connected clients", async () => {
    const harness = createHarness();
    const { port } = await createWsServer(harness.orchestrator);
    const client = await openClient(port);

    const addendumMessage = await waitFor(() => client.messages.find((message) => {
      return typeof message === "object"
        && message !== null
        && (message as { type?: string }).type === "addendum"
        && (message as { entry?: { timestamp?: string } }).entry?.timestamp === "2025-03-19T09:00:00.000Z"
        ? message
        : undefined;
    }));

    expect(addendumMessage).toEqual({
      type: "addendum",
      entry: {
        timestamp: "2025-03-19T09:00:00.000Z",
        itemId: "A1",
        deviation: "Carry this note forward.",
        rationale: "Historical context for the next reviewer.",
        author: "reviewer",
      },
    });
  });

  it("broadcasts audit entries to connected clients", async () => {
    const harness = createHarness();
    const { port } = await createWsServer(harness.orchestrator);
    const firstClient = await openClient(port);
    const secondClient = await openClient(port);

    harness.auditEmitter.fire({
      timestamp: "2025-03-19T12:00:00.000Z",
      role: "reviewer",
      model: "gpt-5.4",
      itemId: "A1",
      promptSummary: "Needs another pass",
      result: "FAIL",
      tokensIn: 120,
      tokensOut: 45,
      durationMs: 500,
    });

    await waitFor(() => firstClient.messages.find((message) => {
      return typeof message === "object"
        && message !== null
        && (message as { type?: string }).type === "audit"
        && (message as { entry?: { promptSummary?: string } }).entry?.promptSummary === "Needs another pass"
        ? message
        : undefined;
    }));
    await waitFor(() => secondClient.messages.find((message) => {
      return typeof message === "object"
        && message !== null
        && (message as { type?: string }).type === "audit"
        && (message as { entry?: { promptSummary?: string } }).entry?.promptSummary === "Needs another pass"
        ? message
        : undefined;
    }));
  });

  it("broadcasts addendum entries to connected clients", async () => {
    const harness = createHarness();
    const { port } = await createWsServer(harness.orchestrator);
    const client = await openClient(port);

    harness.addendumEmitter.fire({
      timestamp: "2025-03-19T12:00:00.000Z",
      itemId: "A1",
      deviation: "Document the edge case.",
      rationale: "Shared clarification for implementors.",
      author: "reviewer",
    });

    const addendumMessage = await waitFor(() => client.messages.find((message) => {
      return typeof message === "object"
        && message !== null
        && (message as { type?: string }).type === "addendum"
        && (message as { entry?: { timestamp?: string } }).entry?.timestamp === "2025-03-19T12:00:00.000Z"
        ? message
        : undefined;
    }));

    expect(addendumMessage).toEqual({
      type: "addendum",
      entry: {
        timestamp: "2025-03-19T12:00:00.000Z",
        itemId: "A1",
        deviation: "Document the edge case.",
        rationale: "Shared clarification for implementors.",
        author: "reviewer",
      },
    });
  });

  it("broadcasts transcript entries to connected clients", async () => {
    const harness = createHarness();
    const { port } = await createWsServer(harness.orchestrator);
    const client = await openClient(port);

    harness.transcriptEmitter.fire({
      timestamp: "2025-03-19T12:00:00.000Z",
      role: "implementor",
      model: "gpt-5.4",
      itemId: "A1",
      messages: [{ role: "assistant", content: "Applied the change." }],
    });

    const transcriptMessage = await waitFor(() => client.messages.find((message) => {
      return typeof message === "object"
        && message !== null
        && (message as { type?: string }).type === "transcript"
        && (message as { entry?: { itemId?: string } }).entry?.itemId === "A1"
        ? message
        : undefined;
    }));

    expect(transcriptMessage).toEqual({
      type: "transcript",
      entry: {
        timestamp: "2025-03-19T12:00:00.000Z",
        role: "implementor",
        model: "gpt-5.4",
        itemId: "A1",
        messages: [{ role: "assistant", content: "Applied the change." }],
      },
    });
  });

  it("calls orchestrator.pause when a client sends a pause message", async () => {
    const harness = createHarness();
    const { port } = await createWsServer(harness.orchestrator);
    const client = await openClient(port);

    client.socket.send(JSON.stringify({ type: "pause" }));

    await waitFor(() => harness.calls.pause > 0 ? harness.calls.pause : undefined);
    expect(harness.calls.pause).toBe(1);
  });

  it("calls orchestrator.addNote when a client sends an addNote message", async () => {
    const harness = createHarness();
    const { port } = await createWsServer(harness.orchestrator);
    const client = await openClient(port);

    client.socket.send(JSON.stringify({ type: "addNote", itemId: "A1", text: "needs fix" }));

    await waitFor(() => harness.calls.addNote[0]);
    expect(harness.calls.addNote).toEqual([{ itemId: "A1", text: "needs fix", author: undefined }]);
  });

  it("calls orchestrator.submitClarification when a client sends a submit-clarification message", async () => {
    const harness = createHarness();
    const { port } = await createWsServer(harness.orchestrator);
    const client = await openClient(port);

    client.socket.send(JSON.stringify({
      type: "submit-clarification",
      answers: [
        {
          question: "Which language should the extension target?",
          answer: "TypeScript",
        },
      ],
    }));

    await waitFor(() => harness.calls.submitClarification[0]);
    expect(harness.calls.submitClarification).toEqual([[
      {
        question: "Which language should the extension target?",
        answer: "TypeScript",
      },
    ]]);
  });

  it("calls orchestrator.overrideCommands when a client sends an override-commands message", async () => {
    const harness = createHarness();
    const { port } = await createWsServer(harness.orchestrator);
    const client = await openClient(port);

    client.socket.send(JSON.stringify({
      type: "override-commands",
      testCommand: "pnpm test",
      lintCommand: "pnpm lint --fix",
    }));

    await waitFor(() => harness.calls.overrideCommands[0]);
    expect(harness.calls.overrideCommands).toEqual([
      { testCommand: "pnpm test", lintCommand: "pnpm lint --fix" },
    ]);
  });

  it("calls orchestrator.startCopilotReReview when a client sends a copilot-rereview message", async () => {
    const harness = createHarness();
    const { port } = await createWsServer(harness.orchestrator, harness.controlBridge);
    const client = await openClient(port);

    client.socket.send(JSON.stringify({ type: "copilot-rereview" }));

    await waitFor(() => harness.calls.startCopilotReReview > 0 ? harness.calls.startCopilotReReview : undefined);
    expect(harness.calls.startCopilotReReview).toBe(1);
  });

  it("calls the control bridge when a client sends a start-feature message", async () => {
    const harness = createHarness();
    const { port } = await createWsServer(harness.orchestrator, harness.controlBridge);
    const client = await openClient(port);

    client.socket.send(JSON.stringify({
      type: "start-feature",
      prompt: "Add dashboard controls",
      conventionsSkill: "python-conventions",
      testCommand: "pytest",
      lintCommand: "ruff check .",
    }));

    await waitFor(() => harness.calls.startRun[0]);
    expect(harness.calls.startRun).toEqual([
      {
        type: "start-feature",
        prompt: "Add dashboard controls",
        conventionsSkill: "python-conventions",
        testCommand: "pytest",
        lintCommand: "ruff check .",
      },
    ]);
  });

  it("calls the control bridge when a client sends a start-bugfix message", async () => {
    const harness = createHarness();
    const { port } = await createWsServer(harness.orchestrator, harness.controlBridge);
    const client = await openClient(port);

    client.socket.send(JSON.stringify({
      type: "start-bugfix",
      prompt: "Fix the websocket status bug",
      conventionsSkill: "nextjs-fastapi-conventions",
      testCommand: "pnpm test",
      lintCommand: "pnpm lint",
    }));

    await waitFor(() => harness.calls.fixBugs[0]);
    expect(harness.calls.fixBugs).toEqual([
      {
        type: "start-bugfix",
        prompt: "Fix the websocket status bug",
        conventionsSkill: "nextjs-fastapi-conventions",
        testCommand: "pnpm test",
        lintCommand: "pnpm lint",
      },
    ]);
  });

  it("calls the control bridge when a client sends an abandon message", async () => {
    const harness = createHarness();
    const { port } = await createWsServer(harness.orchestrator, harness.controlBridge);
    const client = await openClient(port);

    client.socket.send(JSON.stringify({ type: "abandon" }));

    await waitFor(() => harness.calls.abandonRun > 0 ? harness.calls.abandonRun : undefined);
    expect(harness.calls.abandonRun).toBe(1);
  });
});
