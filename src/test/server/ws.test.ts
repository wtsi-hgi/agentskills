import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";

import type { Orchestrator } from "../../orchestrator/machine";
import { handleWebSocket } from "../../server/ws";
import type { AddendumEntry, AuditEntry, OrchestratorState, RunTranscript } from "../../types";

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
    addNote: Array<{ itemId: string; text: string; author?: string }>;
  };
};

const socketsToClose: WebSocket[] = [];
const serversToClose: WebSocketServer[] = [];
const httpServersToClose: Array<ReturnType<typeof createServer>> = [];

function createState(overrides: Partial<OrchestratorState> = {}): OrchestratorState {
  return {
    specDir: ".docs/conductor",
    currentPhase: 1,
    currentItemIndex: 0,
    consecutivePasses: {},
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
    addNote: [] as Array<{ itemId: string; text: string; author?: string }>,
  };

  let currentState = initialState;

  const orchestrator: Orchestrator = {
    async run() {},
    pause() {
      calls.pause += 1;
    },
    resume() {},
    skip() {},
    retry() {},
    changeModel() {},
    approve() {},
    reject() {},
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

  return { orchestrator, stateEmitter, auditEmitter, addendumEmitter, transcriptEmitter, calls };
}

async function createWsServer(orchestrator: Orchestrator): Promise<{ server: WebSocketServer; port: number }> {
  const httpServer = createServer();
  const server = new WebSocketServer({ server: httpServer });
  server.on("connection", (socket: WebSocket) => {
    handleWebSocket(socket, orchestrator);
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
    const { port } = await createWsServer(harness.orchestrator);
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
        && (message as { entry?: { itemId?: string } }).entry?.itemId === "A1"
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
});