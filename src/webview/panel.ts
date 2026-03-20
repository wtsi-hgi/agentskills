import { readFileSync } from "node:fs";
import * as path from "node:path";
import type * as vscode from "vscode";

import type { Orchestrator } from "../orchestrator/machine";
import type { ClientMessage, ServerMessage } from "../types";

const DASHBOARD_VIEW_TYPE = "conductor.dashboard";
const DASHBOARD_TITLE = "Conductor Dashboard";
const DASHBOARD_TEMPLATE_PATH = ["src", "webview", "dashboard.html"];

type DashboardVscodeApi = Pick<typeof vscode, "window" | "ViewColumn" | "Uri">;

function loadVscodeApi(): DashboardVscodeApi {
  return require("vscode") as DashboardVscodeApi;
}

function createNonce(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

function getDashboardTemplatePath(context: vscode.ExtensionContext): string {
  return path.join(context.extensionPath, ...DASHBOARD_TEMPLATE_PATH);
}

function loadDashboardTemplate(context: vscode.ExtensionContext): string {
  return readFileSync(getDashboardTemplatePath(context), "utf8");
}

function renderDashboardHtml(
  webview: vscode.Webview,
  template: string,
  templatePath: string,
  uriFactory: DashboardVscodeApi["Uri"],
): string {
  const nonce = createNonce();
  const dashboardUri = webview.asWebviewUri(uriFactory.file(templatePath));

  return template
    .replaceAll("__CSP_SOURCE__", webview.cspSource)
    .replaceAll("__NONCE__", nonce)
    .replaceAll("__DASHBOARD_URI__", dashboardUri.toString());
}

async function postPhaseDefinition(panel: vscode.WebviewPanel, orchestrator: Orchestrator): Promise<void> {
  postServerMessage(panel.webview, { type: "phase", data: await orchestrator.getPhase() });
}

function postServerMessage(webview: vscode.Webview, message: ServerMessage): void {
  void webview.postMessage(message);
}

async function postHistoricalEntries(panel: vscode.WebviewPanel, orchestrator: Orchestrator): Promise<void> {
  const [auditEntries, addendumEntries, transcripts] = await Promise.all([
    orchestrator.getAuditEntries(),
    orchestrator.getAddendumEntries(),
    orchestrator.getTranscripts(),
  ]);

  for (const entry of auditEntries) {
    postServerMessage(panel.webview, { type: "audit", entry });
  }

  for (const entry of addendumEntries) {
    postServerMessage(panel.webview, { type: "addendum", entry });
  }

  for (const entry of transcripts) {
    postServerMessage(panel.webview, { type: "transcript", entry });
  }
}

function handleClientMessage(orchestrator: Orchestrator, message: ClientMessage): void {
  switch (message.type) {
    case "pause":
      orchestrator.pause();
      return;
    case "resume":
      orchestrator.resume();
      return;
    case "approve":
      orchestrator.approve(message.itemId);
      return;
    case "skip":
      orchestrator.skip(message.itemId);
      return;
    case "retry":
      orchestrator.retry(message.itemId);
      return;
    case "reject":
      orchestrator.reject(message.itemId, message.feedback);
      return;
    case "changeModel":
      orchestrator.changeModel(message.role, message.vendor, message.family);
      return;
    case "addNote":
      orchestrator.addNote(message.itemId, message.text);
      return;
    case "submit-clarification":
      orchestrator.submitClarification(message.answers);
      return;
  }
}

export function createDashboardPanel(
  context: vscode.ExtensionContext,
  orchestrator: Orchestrator,
  vscodeApi: DashboardVscodeApi = loadVscodeApi(),
): vscode.WebviewPanel {
  const dashboardRoot = path.join(context.extensionPath, "src", "webview");
  const panel = vscodeApi.window.createWebviewPanel(
    DASHBOARD_VIEW_TYPE,
    DASHBOARD_TITLE,
    vscodeApi.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscodeApi.Uri.file(dashboardRoot)],
    },
  );
  const template = loadDashboardTemplate(context);
  const templatePath = getDashboardTemplatePath(context);
  let currentPhaseNumber = orchestrator.getState().currentPhase;

  panel.webview.html = renderDashboardHtml(panel.webview, template, templatePath, vscodeApi.Uri);

  const stateSubscription = orchestrator.onStateChange((state) => {
    postServerMessage(panel.webview, { type: "state", data: state });
    if (state.currentPhase !== currentPhaseNumber) {
      currentPhaseNumber = state.currentPhase;
      void postPhaseDefinition(panel, orchestrator);
    }
  });
  const auditSubscription = orchestrator.onAuditEntry((entry) => {
    postServerMessage(panel.webview, { type: "audit", entry });
  });
  const addendumSubscription = orchestrator.onAddendum((entry) => {
    postServerMessage(panel.webview, { type: "addendum", entry });
  });
  const transcriptSubscription = orchestrator.onTranscript((entry) => {
    postServerMessage(panel.webview, { type: "transcript", entry });
  });
  const messageSubscription = panel.webview.onDidReceiveMessage((message: ClientMessage) => {
    handleClientMessage(orchestrator, message);
  });
  const disposeSubscription = panel.onDidDispose(() => {
    stateSubscription.dispose();
    auditSubscription.dispose();
    addendumSubscription.dispose();
    transcriptSubscription.dispose();
    messageSubscription.dispose();
    disposeSubscription.dispose();
  });

  postServerMessage(panel.webview, { type: "state", data: orchestrator.getState() });
  void postPhaseDefinition(panel, orchestrator);
  void postHistoricalEntries(panel, orchestrator);

  return panel;
}

export const dashboardPanelConstants = {
  DASHBOARD_VIEW_TYPE,
  DASHBOARD_TITLE,
};
