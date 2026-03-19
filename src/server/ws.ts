import type { WebSocket } from "ws";

import type { Orchestrator } from "../orchestrator/machine";
import type { AddendumEntry, ClientMessage, ServerMessage } from "../types";

type SubscriptionGroup = {
  sockets: Set<WebSocket>;
  disposeState: { dispose(): void };
  disposeAudit: { dispose(): void };
  disposeAddendum: { dispose(): void };
  disposeTranscript: { dispose(): void };
};

const subscriptionGroups = new WeakMap<Orchestrator, SubscriptionGroup>();

function sendMessage(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState !== socket.OPEN) {
    return;
  }

  socket.send(JSON.stringify(message));
}

function broadcast(group: SubscriptionGroup, message: ServerMessage): void {
  for (const socket of group.sockets) {
    sendMessage(socket, message);
  }
}

function createAddendumMessage(entry: AddendumEntry): ServerMessage {
  return { type: "addendum", entry };
}

function createSubscriptionGroup(orchestrator: Orchestrator): SubscriptionGroup {
  const group: SubscriptionGroup = {
    sockets: new Set<WebSocket>(),
    disposeState: orchestrator.onStateChange((state) => {
      broadcast(group, { type: "state", data: state });
    }),
    disposeAudit: orchestrator.onAuditEntry((entry) => {
      broadcast(group, { type: "audit", entry });
    }),
    disposeAddendum: orchestrator.onAddendum((entry) => {
      broadcast(group, createAddendumMessage(entry));
    }),
    disposeTranscript: orchestrator.onTranscript((entry) => {
      broadcast(group, { type: "transcript", entry });
    }),
  };

  subscriptionGroups.set(orchestrator, group);
  return group;
}

function getSubscriptionGroup(orchestrator: Orchestrator): SubscriptionGroup {
  return subscriptionGroups.get(orchestrator) ?? createSubscriptionGroup(orchestrator);
}

function cleanupSocket(orchestrator: Orchestrator, socket: WebSocket): void {
  const group = subscriptionGroups.get(orchestrator);
  if (!group) {
    return;
  }

  group.sockets.delete(socket);
  if (group.sockets.size > 0) {
    return;
  }

  group.disposeState.dispose();
  group.disposeAudit.dispose();
  group.disposeAddendum.dispose();
  group.disposeTranscript.dispose();
  subscriptionGroups.delete(orchestrator);
}

function isClientMessage(value: unknown): value is ClientMessage {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  switch (candidate.type) {
    case "pause":
    case "resume":
      return true;
    case "skip":
    case "retry":
    case "approve":
      return typeof candidate.itemId === "string";
    case "reject":
      return typeof candidate.itemId === "string" && typeof candidate.feedback === "string";
    case "changeModel":
      return typeof candidate.role === "string"
        && typeof candidate.vendor === "string"
        && typeof candidate.family === "string";
    case "addNote":
      return typeof candidate.itemId === "string" && typeof candidate.text === "string";
    default:
      return false;
  }
}

function dispatchClientMessage(orchestrator: Orchestrator, message: ClientMessage): void {
  switch (message.type) {
    case "pause":
      orchestrator.pause();
      return;
    case "resume":
      orchestrator.resume();
      return;
    case "skip":
      orchestrator.skip(message.itemId);
      return;
    case "retry":
      orchestrator.retry(message.itemId);
      return;
    case "changeModel":
      orchestrator.changeModel(message.role, message.vendor, message.family);
      return;
    case "approve":
      orchestrator.approve(message.itemId);
      return;
    case "reject":
      orchestrator.reject(message.itemId, message.feedback);
      return;
    case "addNote":
      orchestrator.addNote(message.itemId, message.text);
      return;
  }
}

export function handleWebSocket(ws: WebSocket, orchestrator: Orchestrator): void {
  const group = getSubscriptionGroup(orchestrator);
  group.sockets.add(ws);

  sendMessage(ws, { type: "state", data: orchestrator.getState() });
  void (async () => {
    try {
      for (const phase of await orchestrator.getPhases()) {
        sendMessage(ws, { type: "phase", data: phase });
      }

      for (const entry of await orchestrator.getAuditEntries()) {
        sendMessage(ws, { type: "audit", entry });
      }

      for (const entry of await orchestrator.getAddendumEntries()) {
        sendMessage(ws, createAddendumMessage(entry));
      }

      for (const entry of await orchestrator.getTranscripts()) {
        sendMessage(ws, { type: "transcript", entry });
      }
    } catch {
      return;
    }
  })();

  ws.on("message", (raw, isBinary) => {
    if (isBinary) {
      return;
    }

    try {
      const parsed = JSON.parse(raw.toString()) as unknown;
      if (isClientMessage(parsed)) {
        dispatchClientMessage(orchestrator, parsed);
      }
    } catch {
      return;
    }
  });

  ws.on("close", () => {
    cleanupSocket(orchestrator, ws);
  });

  ws.on("error", () => {
    cleanupSocket(orchestrator, ws);
  });
}