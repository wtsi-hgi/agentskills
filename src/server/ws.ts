import type { WebSocket } from "ws";

import type { Orchestrator } from "../orchestrator/machine";
import type {
  AddendumEntry,
  BugfixStatus,
  ClientMessage,
  DashboardControlBridge,
  OrchestratorState,
  PrReviewStatus,
  ServerMessage,
} from "../types";

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

function deriveBugfixStatus(state: OrchestratorState): BugfixStatus | undefined {
  if (!state.bugStep || typeof state.bugIndex !== "number") {
    return undefined;
  }

  return {
    bugIndex: state.bugIndex,
    bugCount: state.bugIssues?.length ?? 0,
    fixCycle: state.bugFixCycle ?? 0,
    bugStep: state.bugStep,
  };
}

function derivePrReviewStatus(state: OrchestratorState): PrReviewStatus {
  return {
    step: state.prReviewStep ?? "done",
    consecutivePasses: state.prReviewConsecutivePasses ?? 0,
  };
}

function createBugfixStatusMessage(state: OrchestratorState): ServerMessage {
  return {
    type: "bugfix-status",
    data: deriveBugfixStatus(state) ?? null,
  };
}

function createSubscriptionGroup(orchestrator: Orchestrator): SubscriptionGroup {
  const group: SubscriptionGroup = {
    sockets: new Set<WebSocket>(),
    disposeState: orchestrator.onStateChange((state) => {
      broadcast(group, { type: "state", data: state });
      broadcast(group, { type: "pr-review-status", data: derivePrReviewStatus(state) });
      broadcast(group, createBugfixStatusMessage(state));
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
    case "abandon":
    case "copilot-rereview":
      return true;
    case "start-feature":
    case "start-bugfix":
      return typeof candidate.prompt === "string"
        && typeof candidate.conventionsSkill === "string"
        && typeof candidate.testCommand === "string"
        && typeof candidate.lintCommand === "string";
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
    case "override-commands":
      return typeof candidate.testCommand === "string"
        && typeof candidate.lintCommand === "string";
    case "addNote":
      return typeof candidate.itemId === "string" && typeof candidate.text === "string";
    case "submit-clarification":
      return Array.isArray(candidate.answers)
        && candidate.answers.every((answer) => typeof answer === "object"
          && answer !== null
          && typeof (answer as { question?: unknown }).question === "string"
          && typeof (answer as { answer?: unknown }).answer === "string");
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
    case "copilot-rereview":
      orchestrator.startCopilotReReview();
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
    case "override-commands":
      orchestrator.overrideCommands(message.testCommand, message.lintCommand);
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
    case "submit-clarification":
      orchestrator.submitClarification(message.answers);
      return;
  }
}

function dispatchExternalClientMessage(controlBridge: DashboardControlBridge | undefined, message: ClientMessage): boolean {
  if (!controlBridge) {
    return false;
  }

  switch (message.type) {
    case "abandon":
      void controlBridge.abandonRun();
      return true;
    case "start-feature":
      void controlBridge.startRun(message);
      return true;
    case "start-bugfix":
      void controlBridge.fixBugs(message);
      return true;
    default:
      return false;
  }
}

export function handleWebSocket(
  ws: WebSocket,
  orchestrator: Orchestrator,
  controlBridge?: DashboardControlBridge,
): void {
  const group = getSubscriptionGroup(orchestrator);
  group.sockets.add(ws);

  const initialState = orchestrator.getState();
  sendMessage(ws, { type: "state", data: initialState });
  sendMessage(ws, { type: "pr-review-status", data: derivePrReviewStatus(initialState) });
  sendMessage(ws, createBugfixStatusMessage(initialState));
  void (async () => {
    try {
      if (controlBridge) {
        sendMessage(ws, { type: "control-options", data: await controlBridge.getControlOptions() });
      }

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
        if (dispatchExternalClientMessage(controlBridge, parsed)) {
          return;
        }

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
