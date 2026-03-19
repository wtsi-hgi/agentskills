import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type * as vscode from "vscode";

import type {
  ExtensionContextLike,
  ExtensionDependencies,
  ModelAssignment,
  OrchestratorConfig,
  OrchestratorState,
  RunStatus,
  VscodeApiLike,
} from "./types";
import { createOrchestrator, type Orchestrator } from "./orchestrator/machine";
import { startServer } from "./server/http";
import { ConductorTreeProvider } from "./views/treeProvider";
import { createDashboardPanel } from "./webview/panel";

const CONDUCTOR_DIR = ".conductor";
const STATE_FILE = "state.json";
const RESUME_PROMPT = "Resume previous Conductor run?";
const COMMAND_START = "conductor.start";
const COMMAND_PAUSE = "conductor.pause";
const COMMAND_RESUME = "conductor.resume";
const COMMAND_STATUS = "conductor.status";
const COMMAND_DASHBOARD = "conductor.dashboard";
const SIDEBAR_VIEW_ID = "conductor.sidebar";
const SERVER_APP_DIR = ["src", "server", "app"];

const DEFAULTS = {
  specDir: ".docs/conductor",
  skillsDir: "~/.agents/skills/",
  conventionsSkill: "",
  maxTurns: 50,
  maxRetries: 3,
  testCommand: "npm test",
  requireApproval: false,
  serverPort: 8484,
  serverAuthToken: "",
};

type CreateOrchestratorLike = (
  config: OrchestratorConfig,
  context: vscode.ExtensionContext,
) => Orchestrator;

type CreateDashboardPanelLike = (
  context: vscode.ExtensionContext,
  orchestrator: Orchestrator,
) => vscode.WebviewPanel;

type StartServerLike = typeof startServer;

type ControllerDependencies = ExtensionDependencies & {
  createOrchestrator: CreateOrchestratorLike;
  createDashboardPanel: CreateDashboardPanelLike;
  startServer: StartServerLike;
};

interface ExtensionController {
  activate(context: ExtensionContextLike): Promise<void>;
  dispose(): void;
}

let activeController: ExtensionController | undefined;

function loadVscodeApi(): VscodeApiLike {
  return require("vscode") as VscodeApiLike;
}

function createFallbackCancellationToken(): vscode.CancellationToken {
  return {
    isCancellationRequested: false,
    onCancellationRequested: () => ({
      dispose() {},
    }),
  };
}

function withDefaultDependencies(overrides: Partial<ExtensionDependencies> & Pick<ExtensionDependencies, "vscode">): ExtensionDependencies {
  return {
    vscode: overrides.vscode,
    fs: overrides.fs ?? fs,
    os: overrides.os ?? os,
    path: overrides.path ?? path,
  };
}

function withControllerDependencies(
  overrides: Partial<ControllerDependencies> & Pick<ControllerDependencies, "vscode">,
): ControllerDependencies {
  return {
    ...withDefaultDependencies(overrides),
    createOrchestrator: overrides.createOrchestrator ?? createOrchestrator,
    createDashboardPanel: overrides.createDashboardPanel ?? createDashboardPanel,
    startServer: overrides.startServer ?? startServer,
  };
}

function getWorkspaceDir(vscodeApi: VscodeApiLike): string | undefined {
  return vscodeApi.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function getStatePath(deps: ExtensionDependencies, workspaceDir: string): string {
  return deps.path.join(workspaceDir, CONDUCTOR_DIR, STATE_FILE);
}

function resolveSpecDir(deps: ExtensionDependencies, workspaceDir: string, specDir: string): string {
  return deps.path.isAbsolute(specDir) ? specDir : deps.path.join(workspaceDir, specDir);
}

function normalizeState(deps: ExtensionDependencies, workspaceDir: string, state: OrchestratorState): OrchestratorState {
  return {
    ...state,
    specDir: resolveSpecDir(deps, workspaceDir, state.specDir || DEFAULTS.specDir),
  };
}

async function fileExists(deps: ExtensionDependencies, filePath: string): Promise<boolean> {
  try {
    await deps.fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function getModelAssignments(vscodeApi: VscodeApiLike): ModelAssignment[] {
  const configuration = vscodeApi.workspace.getConfiguration("conductor");
  const implementor = configuration.get<{ vendor: string; family: string }>("models.implementor", {
    vendor: "",
    family: "",
  });
  const reviewer = configuration.get<{ vendor: string; family: string }>("models.reviewer", {
    vendor: "",
    family: "",
  });
  const specWriter = configuration.get<{ vendor: string; family: string }>("models.specWriter", {
    vendor: "",
    family: "",
  });

  return [
    { role: "implementor", ...implementor },
    { role: "reviewer", ...reviewer },
    { role: "spec-writer", ...specWriter },
  ];
}

function createInitialState(deps: ExtensionDependencies, workspaceDir: string, status: RunStatus): OrchestratorState {
  const configuration = deps.vscode.workspace.getConfiguration("conductor");
  const configuredSpecDir = configuration.get("specDir", DEFAULTS.specDir);

  return {
    specDir: resolveSpecDir(deps, workspaceDir, configuredSpecDir),
    currentPhase: 1,
    currentItemIndex: 0,
    consecutivePasses: {},
    status,
    modelAssignments: getModelAssignments(deps.vscode),
    itemStatuses: {},
    startedBy: deps.os.userInfo().username,
  };
}

function createOrchestratorConfig(
  deps: ExtensionDependencies,
  workspaceDir: string,
  state: OrchestratorState,
): OrchestratorConfig {
  const configuration = deps.vscode.workspace.getConfiguration("conductor");
  const modelAssignments = state.modelAssignments?.length > 0 ? state.modelAssignments : getModelAssignments(deps.vscode);

  return {
    specDir: state.specDir,
    projectDir: workspaceDir,
    skillsDir: configuration.get("skillsDir", DEFAULTS.skillsDir),
    conventionsSkill: configuration.get("conventionsSkill", DEFAULTS.conventionsSkill),
    modelAssignments,
    maxTurns: configuration.get("maxTurns", DEFAULTS.maxTurns),
    maxRetries: configuration.get("maxRetries", DEFAULTS.maxRetries),
    testCommand: configuration.get("testCommand", DEFAULTS.testCommand),
    requireApproval: configuration.get("requireApproval", DEFAULTS.requireApproval),
  };
}

async function ensureConductorDir(deps: ExtensionDependencies, workspaceDir: string): Promise<void> {
  await deps.fs.mkdir(deps.path.join(workspaceDir, CONDUCTOR_DIR), { recursive: true });
}

async function readState(deps: ExtensionDependencies, workspaceDir: string): Promise<OrchestratorState | undefined> {
  const statePath = getStatePath(deps, workspaceDir);
  if (!(await fileExists(deps, statePath))) {
    return undefined;
  }

  const raw = await deps.fs.readFile(statePath, "utf8");
  return normalizeState(deps, workspaceDir, JSON.parse(raw) as OrchestratorState);
}

async function writeState(deps: ExtensionDependencies, workspaceDir: string, state: OrchestratorState): Promise<void> {
  await ensureConductorDir(deps, workspaceDir);
  await deps.fs.writeFile(getStatePath(deps, workspaceDir), JSON.stringify(state, null, 2), "utf8");
}

async function updateStateStatus(
  deps: ExtensionDependencies,
  workspaceDir: string,
  status: RunStatus,
): Promise<OrchestratorState> {
  const existingState = await readState(deps, workspaceDir);
  const nextState = existingState ?? createInitialState(deps, workspaceDir, status);
  nextState.status = status;

  if (!nextState.startedBy) {
    nextState.startedBy = deps.os.userInfo().username;
  }

  await writeState(deps, workspaceDir, nextState);
  return nextState;
}

async function showWorkspaceRequiredMessage(vscodeApi: VscodeApiLike): Promise<void> {
  if (vscodeApi.window.showErrorMessage) {
    await vscodeApi.window.showErrorMessage("Open a workspace folder to use Conductor.");
    return;
  }

  await vscodeApi.window.showInformationMessage("Open a workspace folder to use Conductor.");
}

async function maybePromptToResume(deps: ExtensionDependencies, workspaceDir: string): Promise<boolean> {
  const state = await readState(deps, workspaceDir);
  if (!state || (state.status !== "paused" && state.status !== "running")) {
    return false;
  }

  const choice = await deps.vscode.window.showInformationMessage(RESUME_PROMPT, "Yes", "No");
  if (choice === "Yes") {
    await updateStateStatus(deps, workspaceDir, "running");
    return true;
  }

  await updateStateStatus(deps, workspaceDir, "idle");
  return false;
}

async function handleStart(deps: ExtensionDependencies): Promise<void> {
  const workspaceDir = getWorkspaceDir(deps.vscode);
  if (!workspaceDir) {
    await showWorkspaceRequiredMessage(deps.vscode);
    return;
  }

  await writeState(deps, workspaceDir, createInitialState(deps, workspaceDir, "running"));
}

async function handlePause(deps: ExtensionDependencies): Promise<void> {
  const workspaceDir = getWorkspaceDir(deps.vscode);
  if (!workspaceDir) {
    await showWorkspaceRequiredMessage(deps.vscode);
    return;
  }

  await updateStateStatus(deps, workspaceDir, "paused");
}

async function handleResume(deps: ExtensionDependencies): Promise<void> {
  const workspaceDir = getWorkspaceDir(deps.vscode);
  if (!workspaceDir) {
    await showWorkspaceRequiredMessage(deps.vscode);
    return;
  }

  await updateStateStatus(deps, workspaceDir, "running");
}

async function handleStatus(deps: ExtensionDependencies): Promise<void> {
  const workspaceDir = getWorkspaceDir(deps.vscode);
  if (!workspaceDir) {
    await showWorkspaceRequiredMessage(deps.vscode);
    return;
  }

  const state = (await readState(deps, workspaceDir)) ?? createInitialState(deps, workspaceDir, "idle");
  await deps.vscode.window.showInformationMessage(
    `Conductor status: phase ${state.currentPhase}, item ${state.currentItemIndex + 1}, ${state.status}`,
  );
}

async function handleDashboard(
  deps: ControllerDependencies,
  context: ExtensionContextLike,
  orchestrator: Orchestrator | undefined,
): Promise<void> {
  if (!orchestrator) {
    await showWorkspaceRequiredMessage(deps.vscode);
    return;
  }

  deps.createDashboardPanel(context as vscode.ExtensionContext, orchestrator);
}

export function createExtensionController(
  overrides: Partial<ControllerDependencies> & Pick<ControllerDependencies, "vscode">,
): ExtensionController {
  const deps = withControllerDependencies(overrides);
  const registrations = new Set<{ dispose(): void }>();
  let serverHandle: { close(): void } | undefined;
  let serverStartPromise: Promise<void> | undefined;

  const stopServer = () => {
    serverHandle?.close();
    serverHandle = undefined;
  };

  return {
    async activate(context: ExtensionContextLike): Promise<void> {
      const workspaceDir = getWorkspaceDir(deps.vscode);
      let currentState = workspaceDir
        ? (await readState(deps, workspaceDir)) ?? createInitialState(deps, workspaceDir, "idle")
        : undefined;
      const orchestrator = workspaceDir && currentState
        ? deps.createOrchestrator(createOrchestratorConfig(deps, workspaceDir, currentState), context as vscode.ExtensionContext)
        : undefined;
      const runToken = createFallbackCancellationToken();
      const treeProvider = workspaceDir && orchestrator
        ? new ConductorTreeProvider(() => orchestrator.getState(), {
            onStateChange: orchestrator.onStateChange,
            workspaceRoot: workspaceDir,
          })
        : undefined;

      const register = (command: string, handler: () => Promise<void>) => {
        const disposable = deps.vscode.commands.registerCommand(command, handler);
        registrations.add(disposable);
        context.subscriptions.push(disposable);
      };

      const registerTreeProvider = () => {
        if (!treeProvider || !deps.vscode.window.registerTreeDataProvider) {
          return;
        }

        const disposable = deps.vscode.window.registerTreeDataProvider(SIDEBAR_VIEW_ID, treeProvider);
        registrations.add(disposable);
        context.subscriptions.push(disposable);
      };

      const updateTreeState = (state: OrchestratorState | undefined) => {
        if (!state) {
          return;
        }

        currentState = state;
        treeProvider?.refresh();
      };

      const syncServer = async (state: OrchestratorState | undefined) => {
        if (!workspaceDir || !orchestrator || !state) {
          stopServer();
          return;
        }

        if (state.status !== "running" && state.status !== "paused") {
          stopServer();
          return;
        }

        const staticDir = deps.path.join(workspaceDir, ...SERVER_APP_DIR);
        const appEntry = deps.path.join(staticDir, "index.html");
        if (!(await fileExists(deps, appEntry))) {
          return;
        }

        if (serverHandle || serverStartPromise) {
          return;
        }

        const configuration = deps.vscode.workspace.getConfiguration("conductor");
        const port = configuration.get("server.port", DEFAULTS.serverPort);
        const authToken = configuration.get("server.authToken", DEFAULTS.serverAuthToken);

        serverStartPromise = (async () => {
          try {
            serverHandle = await deps.startServer(port, staticDir, authToken, orchestrator);
          } catch (error) {
            if (deps.vscode.window.showErrorMessage) {
              await deps.vscode.window.showErrorMessage(`Failed to start Conductor server: ${String(error)}`);
            }
          } finally {
            serverStartPromise = undefined;
            if (currentState && currentState.status !== "running" && currentState.status !== "paused") {
              stopServer();
            }
          }
        })();

        await serverStartPromise;
      };

      if (orchestrator) {
        const disposable = orchestrator.onStateChange((state) => {
          updateTreeState(state);
          void syncServer(state);
        });
        registrations.add(disposable);
        context.subscriptions.push(disposable);
      }

      register(COMMAND_START, async () => {
        await handleStart(deps);
        void orchestrator?.run(runToken);
        if (workspaceDir) {
          const nextState = await readState(deps, workspaceDir);
          updateTreeState(nextState);
          await syncServer(nextState);
        }
      });
      register(COMMAND_PAUSE, async () => {
        await handlePause(deps);
        orchestrator?.pause();
        if (workspaceDir) {
          const nextState = await readState(deps, workspaceDir);
          updateTreeState(nextState);
          await syncServer(nextState);
        }
      });
      register(COMMAND_RESUME, async () => {
        await handleResume(deps);
        orchestrator?.resume();
        if (workspaceDir) {
          const nextState = await readState(deps, workspaceDir);
          updateTreeState(nextState);
          await syncServer(nextState);
        }
      });
      register(COMMAND_STATUS, () => handleStatus(deps));
      register(COMMAND_DASHBOARD, () => handleDashboard(deps, context, orchestrator));
      registerTreeProvider();

      if (workspaceDir) {
        const shouldResume = await maybePromptToResume(deps, workspaceDir);
        if (shouldResume) {
          orchestrator?.resume();
        }
        const nextState = await readState(deps, workspaceDir);
        updateTreeState(nextState);
        await syncServer(nextState);
      }
    },

    dispose(): void {
      stopServer();
      for (const registration of registrations) {
        registration.dispose();
      }
      registrations.clear();
    },
  };
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const controller = createExtensionController({ vscode: loadVscodeApi() });
  activeController = controller;
  await controller.activate(context);
}

export function deactivate(): void {
  activeController?.dispose();
  activeController = undefined;
}