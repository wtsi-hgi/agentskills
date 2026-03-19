import { createServer } from "node:http";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import type { IncomingMessage } from "node:http";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import type { Orchestrator } from "../../orchestrator/machine";
import { startServer } from "../../server/http";
import type { AddendumEntry, AuditEntry, OrchestratorState } from "../../types";

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

type ServerHandle = Awaited<ReturnType<typeof startServer>>;

const STATIC_DIR = path.join(process.cwd(), "src", "server", "app");
const clientsToClose: WebSocket[] = [];
const serversToClose: ServerHandle[] = [];

function createState(): OrchestratorState {
  return {
    specDir: ".docs/conductor",
    currentPhase: 1,
    currentItemIndex: 0,
    consecutivePasses: {},
    status: "running",
    modelAssignments: [],
    itemStatuses: {},
  };
}

function createOrchestrator(): Orchestrator {
  const stateEmitter = new TestEmitter<OrchestratorState>();
  const auditEmitter = new TestEmitter<AuditEntry>();
  const addendumEmitter = new TestEmitter<AddendumEntry>();

  return {
    async run() {},
    pause() {},
    resume() {},
    skip() {},
    retry() {},
    changeModel() {},
    approve() {},
    reject() {},
    addNote() {},
    getState() {
      return createState();
    },
    async getPhase() {
      return { number: 1, title: "Phase 1", items: [], batches: [] };
    },
    async getPhases() {
      return [{ number: 1, title: "Phase 1", items: [], batches: [] }];
    },
    async getAuditEntries() {
      return [];
    },
    async getTranscripts() {
      return [];
    },
    onStateChange: stateEmitter.event as never,
    onAuditEntry: auditEmitter.event as never,
    onAddendum: addendumEmitter.event as never,
    onTranscript: (() => ({ dispose() {} })) as never,
  };
}

async function getAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
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

async function openClient(
  port: number,
  options: { authHeader?: string } = {},
): Promise<{ socket: WebSocket; response?: number }> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    headers: options.authHeader ? { Authorization: options.authHeader } : undefined,
  });
  clientsToClose.push(socket);

  return await new Promise((resolve, reject) => {
    socket.once("open", () => resolve({ socket }));
    socket.once("unexpected-response", (_request: IncomingMessage, response: IncomingMessage) => {
      resolve({ socket, response: response.statusCode });
    });
    socket.once("error", (error: Error) => {
      if (socket.readyState === socket.CLOSED) {
        return;
      }

      reject(error);
    });
  });
}

async function waitForPortToBeReusable(port: number): Promise<void> {
  await waitFor(async () => {
    const probe = createServer();

    try {
      await new Promise<void>((resolve, reject) => {
        probe.once("error", reject);
        probe.listen(port, "127.0.0.1", () => resolve());
      });
      await new Promise<void>((resolve) => probe.close(() => resolve()));
      return true;
    } catch {
      probe.close();
      return undefined;
    }
  });
}

afterEach(async () => {
  for (const socket of clientsToClose.splice(0)) {
    if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) {
      await new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
        socket.close();
      });
    }
  }

  for (const server of serversToClose.splice(0)) {
    server.close();
  }
});

describe("startServer", () => {
  it("serves GET / with HTML content", async () => {
    const port = await getAvailablePort();
    const server = await startServer(port, STATIC_DIR, "", createOrchestrator());
    serversToClose.push(server);

    const response = await fetch(`http://127.0.0.1:${port}/`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(body).toContain("Conductor Team Server");
  });

  it("rejects websocket connections without auth when a token is configured", async () => {
    const port = await getAvailablePort();
    const server = await startServer(port, STATIC_DIR, "secret123", createOrchestrator());
    serversToClose.push(server);

    const result = await openClient(port);

    expect(result.response).toBe(401);
  });

  it("accepts websocket connections with a valid bearer token", async () => {
    const port = await getAvailablePort();
    const server = await startServer(port, STATIC_DIR, "secret123", createOrchestrator());
    serversToClose.push(server);

    const result = await openClient(port, { authHeader: "Bearer secret123" });

    expect(result.response).toBeUndefined();
    expect(result.socket.readyState).toBe(WebSocket.OPEN);
  });

  it("stops accepting connections and frees the port when close is called", async () => {
    const port = await getAvailablePort();
    const server = await startServer(port, STATIC_DIR, "", createOrchestrator());

    server.close();
    await waitForPortToBeReusable(port);

    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(port, "127.0.0.1", () => resolve()));
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  });

  it("accepts websocket connections without auth when the token is empty", async () => {
    const port = await getAvailablePort();
    const server = await startServer(port, STATIC_DIR, "", createOrchestrator());
    serversToClose.push(server);

    const result = await openClient(port);

    expect(result.response).toBeUndefined();
    expect(result.socket.readyState).toBe(WebSocket.OPEN);
  });
});