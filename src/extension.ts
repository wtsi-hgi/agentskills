import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type * as vscode from "vscode";

import type {
  DashboardControlBridge,
  ExtensionContextLike,
  ExtensionDependencies,
  InlineRunRequest,
  ModelAssignment,
  OrchestratorConfig,
  OrchestratorState,
  RunStatus,
  SpecStep,
  TextDocumentLike,
  VscodeApiLike,
} from "./types";
import { discoverSkills } from "./skills/loader";
import { createOrchestrator, deriveFeatureSlug, guessConventionsSkill, type Orchestrator } from "./orchestrator/machine";
import { startServer } from "./server/http";
import { ConductorTreeProvider } from "./views/treeProvider";
import { createDashboardPanel } from "./webview/panel";

const CONDUCTOR_DIR = ".conductor";
const STATE_FILE = "state.json";
const RESUME_PROMPT = "Resume previous Conductor run?";
const COMMAND_START = "conductor.start";
const COMMAND_FIX_BUGS = "conductor.fixBugs";
const COMMAND_ABANDON = "conductor.abandon";
const COMMAND_PAUSE = "conductor.pause";
const COMMAND_RESUME = "conductor.resume";
const COMMAND_STATUS = "conductor.status";
const COMMAND_DASHBOARD = "conductor.dashboard";
const SIDEBAR_VIEW_ID = "conductor.sidebar";
const SERVER_APP_DIR = ["src", "server", "app"];
const MISSING_SPEC_INPUT_MESSAGE = "No spec.md or prompt.md found in specDir.";
const ACTIVE_BUGFIX_MESSAGE = "Complete or abandon current run first.";

const DEFAULTS = {
  docsDir: ".docs/",
  skillsDir: "~/.agents/skills/",
  maxTurns: 50,
  maxRetries: 3,
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
  controlBridge: DashboardControlBridge,
) => vscode.WebviewPanel;

type StartServerLike = typeof startServer;
type GuessConventionsSkillLike = typeof guessConventionsSkill;
type DeriveFeatureSlugLike = typeof deriveFeatureSlug;

type StartCommandArgs = {
  prompt?: string;
  targetPath?: string;
  conventionsSkill?: string;
  testCommand?: string;
  lintCommand?: string;
};

type ControllerDependencies = ExtensionDependencies & {
  createOrchestrator: CreateOrchestratorLike;
  createDashboardPanel: CreateDashboardPanelLike;
  startServer: StartServerLike;
  guessConventionsSkill: GuessConventionsSkillLike;
  deriveFeatureSlug: DeriveFeatureSlugLike;
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
    guessConventionsSkill: overrides.guessConventionsSkill ?? guessConventionsSkill,
    deriveFeatureSlug: overrides.deriveFeatureSlug ?? deriveFeatureSlug,
  };
}

function getWorkspaceDir(vscodeApi: VscodeApiLike): string | undefined {
  return vscodeApi.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function getStatePath(deps: ExtensionDependencies, workspaceDir: string): string {
  return deps.path.join(workspaceDir, CONDUCTOR_DIR, STATE_FILE);
}

function getNestedStatePath(deps: ExtensionDependencies, rootDir: string): string {
  return deps.path.join(rootDir, CONDUCTOR_DIR, STATE_FILE);
}

function resolveWorkspacePath(deps: ExtensionDependencies, workspaceDir: string, targetPath: string): string {
  return deps.path.isAbsolute(targetPath) ? targetPath : deps.path.join(workspaceDir, targetPath);
}

function expandHomePath(deps: ExtensionDependencies, targetPath: string): string {
  if (targetPath === "~") {
    return process.env.HOME ?? targetPath;
  }

  if (targetPath.startsWith("~/") && process.env.HOME) {
    return deps.path.join(process.env.HOME, targetPath.slice(2));
  }

  return targetPath;
}

function getConfiguredDocsDir(deps: ExtensionDependencies, workspaceDir: string): string {
  const configuration = deps.vscode.workspace.getConfiguration("conductor");
  return resolveWorkspacePath(deps, workspaceDir, configuration.get("docsDir", DEFAULTS.docsDir));
}

function getConfiguredSkillsDir(deps: ExtensionDependencies, workspaceDir: string): string {
  const configuration = deps.vscode.workspace.getConfiguration("conductor");
  return resolveWorkspacePath(deps, workspaceDir, expandHomePath(deps, configuration.get("skillsDir", DEFAULTS.skillsDir)));
}

function getDefaultSpecDir(deps: ExtensionDependencies, workspaceDir: string): string {
  return deps.path.join(getConfiguredDocsDir(deps, workspaceDir), "conductor");
}

function normalizeState(deps: ExtensionDependencies, workspaceDir: string, state: OrchestratorState): OrchestratorState {
  return {
    ...state,
    specDir: resolveWorkspacePath(deps, workspaceDir, state.specDir || getDefaultSpecDir(deps, workspaceDir)),
    conventionsSkill: state.conventionsSkill ?? "",
    testCommand: state.testCommand ?? "npm test",
    lintCommand: state.lintCommand ?? "",
    specStep: state.specStep ?? "done",
    specConsecutivePasses: state.specConsecutivePasses ?? 0,
    specPhaseFileIndex: state.specPhaseFileIndex ?? 0,
    clarificationQuestions: state.clarificationQuestions ?? [],
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
  const prReviewer = configuration.get<{ vendor: string; family: string }>("models.prReviewer", {
    vendor: "",
    family: "",
  });
  const specAuthor = configuration.get<{ vendor: string; family: string }>("models.specAuthor", {
    vendor: "",
    family: "",
  });
  const specReviewer = configuration.get<{ vendor: string; family: string }>("models.specReviewer", {
    vendor: "",
    family: "",
  });
  const specProofreader = configuration.get<{ vendor: string; family: string }>("models.specProofreader", {
    vendor: "",
    family: "",
  });
  const phaseCreator = configuration.get<{ vendor: string; family: string }>("models.phaseCreator", {
    vendor: "",
    family: "",
  });
  const phaseReviewer = configuration.get<{ vendor: string; family: string }>("models.phaseReviewer", {
    vendor: "",
    family: "",
  });

  return [
    { role: "implementor", ...implementor },
    { role: "reviewer", ...reviewer },
    { role: "pr-reviewer", ...prReviewer },
    { role: "spec-author", ...specAuthor },
    { role: "spec-reviewer", ...specReviewer },
    { role: "spec-proofreader", ...specProofreader },
    { role: "phase-creator", ...phaseCreator },
    { role: "phase-reviewer", ...phaseReviewer },
  ];
}

function createInitialState(
  deps: ExtensionDependencies,
  workspaceDir: string,
  status: RunStatus,
  specStep: SpecStep = "done",
): OrchestratorState {
  return {
    specDir: getDefaultSpecDir(deps, workspaceDir),
    conventionsSkill: "",
    testCommand: "npm test",
    lintCommand: "",
    currentPhase: 1,
    currentItemIndex: 0,
    consecutivePasses: {},
    specStep,
    specConsecutivePasses: 0,
    specPhaseFileIndex: 0,
    clarificationQuestions: [],
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
    projectDir: workspaceDir,
    docsDir: getConfiguredDocsDir(deps, workspaceDir),
    skillsDir: getConfiguredSkillsDir(deps, workspaceDir),
    modelAssignments,
    maxTurns: configuration.get("maxTurns", DEFAULTS.maxTurns),
    maxRetries: configuration.get("maxRetries", DEFAULTS.maxRetries),
    requireApproval: configuration.get("requireApproval", DEFAULTS.requireApproval),
  };
}

async function getAvailableConventionsSkills(deps: ControllerDependencies, workspaceDir: string): Promise<string[]> {
  try {
    return (await discoverSkills(getConfiguredSkillsDir(deps, workspaceDir)))
      .filter((skillName) => skillName.endsWith("-conventions"));
  } catch {
    return [];
  }
}

async function selectConventionsSkill(
  deps: ControllerDependencies,
  workspaceDir: string,
  modelAssignments: ModelAssignment[],
): Promise<string | undefined> {
  const availableSkills = await getAvailableConventionsSkills(deps, workspaceDir);
  if (availableSkills.length === 0) {
    return "";
  }

  const guessedSkill = await deps.guessConventionsSkill(
    workspaceDir,
    availableSkills,
    modelAssignments,
    createFallbackCancellationToken(),
  );
  const defaultSkill = guessedSkill && availableSkills.includes(guessedSkill)
    ? guessedSkill
    : undefined;

  if (!deps.vscode.window.showQuickPick) {
    return defaultSkill ?? availableSkills[0];
  }

  return await deps.vscode.window.showQuickPick(availableSkills, {
    placeHolder: "Select conventions skill for this run",
    activeItem: defaultSkill,
  });
}

async function ensureConductorDir(deps: ExtensionDependencies, workspaceDir: string): Promise<void> {
  await deps.fs.mkdir(deps.path.join(workspaceDir, CONDUCTOR_DIR), { recursive: true });
}

async function ensureNestedConductorDir(deps: ExtensionDependencies, rootDir: string): Promise<void> {
  await deps.fs.mkdir(deps.path.join(rootDir, CONDUCTOR_DIR), { recursive: true });
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

async function writeNestedState(deps: ExtensionDependencies, rootDir: string, state: OrchestratorState): Promise<void> {
  await ensureNestedConductorDir(deps, rootDir);
  await deps.fs.writeFile(getNestedStatePath(deps, rootDir), JSON.stringify(state, null, 2), "utf8");
}

function isNestedFeatureState(deps: ExtensionDependencies, workspaceDir: string, specDir: string): boolean {
  const docsDir = getConfiguredDocsDir(deps, workspaceDir);
  const relativePath = path.relative(docsDir, specDir);
  return relativePath.length > 0 && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

async function writeWorkspaceAndNestedState(
  deps: ExtensionDependencies,
  workspaceDir: string,
  state: OrchestratorState,
): Promise<void> {
  await writeState(deps, workspaceDir, state);

  if (isNestedFeatureState(deps, workspaceDir, state.specDir) || await fileExists(deps, getNestedStatePath(deps, state.specDir))) {
    await writeNestedState(deps, state.specDir, state);
  }
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

  await writeWorkspaceAndNestedState(deps, workspaceDir, nextState);
  return nextState;
}

async function showWorkspaceRequiredMessage(vscodeApi: VscodeApiLike): Promise<void> {
  if (vscodeApi.window.showErrorMessage) {
    await vscodeApi.window.showErrorMessage("Open a workspace folder to use Conductor.");
    return;
  }

  await vscodeApi.window.showInformationMessage("Open a workspace folder to use Conductor.");
}

async function showStartErrorMessage(vscodeApi: VscodeApiLike, message: string): Promise<void> {
  if (vscodeApi.window.showErrorMessage) {
    await vscodeApi.window.showErrorMessage(message);
    return;
  }

  await vscodeApi.window.showInformationMessage(message);
}

async function canStartRun(
  deps: ExtensionDependencies,
  state: OrchestratorState,
): Promise<boolean> {
  const specPath = deps.path.join(state.specDir, "spec.md");
  const promptPath = deps.path.join(state.specDir, "prompt.md");
  const [hasSpec, hasPrompt] = await Promise.all([
    fileExists(deps, specPath),
    fileExists(deps, promptPath),
  ]);

  if (hasSpec || hasPrompt) {
    return true;
  }

  await showStartErrorMessage(deps.vscode, MISSING_SPEC_INPUT_MESSAGE);
  return false;
}

async function detectStartSpecStep(
  deps: ExtensionDependencies,
  specDir: string,
): Promise<SpecStep | undefined> {
  const specPath = deps.path.join(specDir, "spec.md");
  const promptPath = deps.path.join(specDir, "prompt.md");
  const [hasSpec, hasPrompt] = await Promise.all([
    fileExists(deps, specPath),
    fileExists(deps, promptPath),
  ]);

  if (hasSpec) {
    return "done";
  }

  if (hasPrompt) {
    return "clarifying";
  }

  await showStartErrorMessage(deps.vscode, MISSING_SPEC_INPUT_MESSAGE);
  return undefined;
}

async function hasSpecInputFiles(
  deps: ExtensionDependencies,
  specDir: string,
): Promise<boolean> {
  const specPath = deps.path.join(specDir, "spec.md");
  const promptPath = deps.path.join(specDir, "prompt.md");
  const [hasSpec, hasPrompt] = await Promise.all([
    fileExists(deps, specPath),
    fileExists(deps, promptPath),
  ]);

  return hasSpec || hasPrompt;
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

type RecoveryDecision = {
  state: OrchestratorState | undefined;
  resume: boolean;
};

async function findRecoverableFeatureStates(
  deps: ExtensionDependencies,
  workspaceDir: string,
): Promise<OrchestratorState[]> {
  const docsDir = getConfiguredDocsDir(deps, workspaceDir);
  if (!(await fileExists(deps, docsDir))) {
    return [];
  }

  const entries = await deps.fs.readdir(docsDir);
  const states: OrchestratorState[] = [];

  for (const entry of entries) {
    const specDir = deps.path.join(docsDir, entry);
    const nestedStatePath = getNestedStatePath(deps, specDir);
    if (!(await fileExists(deps, nestedStatePath))) {
      continue;
    }

    const raw = await deps.fs.readFile(nestedStatePath, "utf8");
    const parsed = normalizeState(deps, workspaceDir, JSON.parse(raw) as OrchestratorState);
    if (parsed.status === "running" || parsed.status === "paused") {
      states.push(parsed);
    }
  }

  return states;
}

async function recoverFeatureStateOnActivation(
  deps: ExtensionDependencies,
  workspaceDir: string,
): Promise<RecoveryDecision> {
  const recoverableStates = await findRecoverableFeatureStates(deps, workspaceDir);

  for (const featureState of recoverableStates) {
    const featureName = path.basename(featureState.specDir);
    const choice = await deps.vscode.window.showInformationMessage(
      `Resume previous Conductor run for ${featureName}?`,
      "Resume",
      "Abandon",
    );

    if (choice === "Resume") {
      const resumedState = {
        ...featureState,
        status: "running" as const,
      };
      await writeWorkspaceAndNestedState(deps, workspaceDir, resumedState);
      return { state: resumedState, resume: true };
    }

    if (choice === "Abandon") {
      const abandonedState = {
        ...featureState,
        status: "abandoned" as const,
      };
      await writeWorkspaceAndNestedState(deps, workspaceDir, abandonedState);
    }
  }

  return { state: undefined, resume: false };
}

function extractKebabCaseSlug(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  return trimmed.match(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)?.[0];
}

function normalizeInlinePrompt(promptText: string | undefined): string | undefined {
  const trimmed = promptText?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function isSameTextDocument(left: TextDocumentLike, right: TextDocumentLike): boolean {
  if (left === right) {
    return true;
  }

  const leftUri = left.uri.toString?.() ?? `${left.uri.scheme ?? ""}:${left.uri.path ?? ""}:${left.uri.fsPath ?? ""}`;
  const rightUri = right.uri.toString?.() ?? `${right.uri.scheme ?? ""}:${right.uri.path ?? ""}:${right.uri.fsPath ?? ""}`;
  return leftUri === rightUri;
}

async function promptForSingleLineInlinePrompt(
  deps: ExtensionDependencies,
  promptLabel: string,
): Promise<string | undefined> {
  if (!deps.vscode.window.showInputBox) {
    return undefined;
  }

  return normalizeInlinePrompt(await deps.vscode.window.showInputBox({
    prompt: `Enter ${promptLabel}`,
    placeHolder: "Short single-line prompt",
  }));
}

async function promptForMultilineInlinePrompt(
  deps: ExtensionDependencies,
): Promise<string | undefined> {
  if (!deps.vscode.workspace.openTextDocument || !deps.vscode.window.showTextDocument || !deps.vscode.workspace.onDidCloseTextDocument) {
    return undefined;
  }

  const document = await deps.vscode.workspace.openTextDocument({
    language: "markdown",
    content: "",
  });
  await deps.vscode.window.showTextDocument(document, { preview: false });

  return await new Promise<string | undefined>((resolve) => {
    let settled = false;
    const disposables: Array<{ dispose(): void }> = [];

    const finish = (promptText: string | undefined) => {
      if (settled) {
        return;
      }

      settled = true;
      for (const disposable of disposables) {
        disposable.dispose();
      }
      resolve(normalizeInlinePrompt(promptText));
    };

    disposables.push(deps.vscode.workspace.onDidCloseTextDocument!((closedDocument) => {
      if (isSameTextDocument(closedDocument, document)) {
        finish(closedDocument.getText());
      }
    }));

    if (deps.vscode.workspace.onDidSaveTextDocument) {
      disposables.push(deps.vscode.workspace.onDidSaveTextDocument((savedDocument) => {
        if (isSameTextDocument(savedDocument, document)) {
          finish(savedDocument.getText());
        }
      }));
    }
  });
}

async function promptForCommandPaletteInlinePrompt(
  deps: ExtensionDependencies,
  promptLabel: string,
): Promise<string | undefined> {
  return await promptForMultilineInlinePrompt(deps)
    ?? await promptForSingleLineInlinePrompt(deps, promptLabel);
}

async function resolveCommandArgsWithInlinePrompt(
  deps: ExtensionDependencies,
  args: StartCommandArgs | undefined,
  promptLabel: string,
  shouldPrompt: boolean,
): Promise<StartCommandArgs | undefined> {
  if (args?.targetPath?.trim() || args?.prompt?.trim() || !shouldPrompt) {
    return args ?? {};
  }

  const promptText = await promptForCommandPaletteInlinePrompt(deps, promptLabel);
  if (!promptText) {
    return undefined;
  }

  return {
    ...args,
    prompt: promptText,
  };
}

function isActiveBugfixRun(state: OrchestratorState | undefined): boolean {
  if (!state) {
    return false;
  }

  if (state.status !== "running" && state.status !== "paused" && state.status !== "pending-approval") {
    return false;
  }

  const bugStep = (state as OrchestratorState & { bugStep?: unknown }).bugStep;
  if (typeof bugStep === "string" && bugStep.length > 0) {
    return true;
  }

  return /^bugs\d+$/u.test(path.basename(state.specDir));
}

function hasActiveOrPausedRun(state: OrchestratorState | undefined): boolean {
  if (!state) {
    return false;
  }

  return state.status === "running"
    || state.status === "paused"
    || state.status === "pending-approval";
}

async function getNextUnusedFeatureSlug(deps: ExtensionDependencies, docsDir: string): Promise<string> {
  let index = 1;

  while (await fileExists(deps, deps.path.join(docsDir, `feature-${index}`))) {
    index += 1;
  }

  return `feature-${index}`;
}

async function getUniqueSlugDirectory(deps: ExtensionDependencies, docsDir: string, slug: string): Promise<string> {
  const basePath = deps.path.join(docsDir, slug);
  if (!(await fileExists(deps, basePath))) {
    return basePath;
  }

  let suffix = 2;
  while (await fileExists(deps, deps.path.join(docsDir, `${slug}-${suffix}`))) {
    suffix += 1;
  }

  return deps.path.join(docsDir, `${slug}-${suffix}`);
}

async function promptForFeatureSlug(
  deps: ControllerDependencies,
  promptText: string,
  docsDir: string,
  modelAssignments: ModelAssignment[],
): Promise<string | undefined> {
  const suggestedSlug = extractKebabCaseSlug(
    await deps.deriveFeatureSlug(promptText, modelAssignments, createFallbackCancellationToken()),
  ) ?? await getNextUnusedFeatureSlug(deps, docsDir);

  const enteredSlug = deps.vscode.window.showInputBox
    ? await deps.vscode.window.showInputBox({
        prompt: "Choose a feature slug",
        placeHolder: "kebab-case feature slug",
        value: suggestedSlug,
      })
    : suggestedSlug;

  if (enteredSlug === undefined) {
    return undefined;
  }

  return extractKebabCaseSlug(enteredSlug) ?? suggestedSlug;
}

async function createInlineFeatureSpecDir(
  deps: ControllerDependencies,
  workspaceDir: string,
  promptText: string,
  modelAssignments: ModelAssignment[],
): Promise<string | undefined> {
  const existingState = await readState(deps, workspaceDir);
  if (isActiveBugfixRun(existingState)) {
    await showStartErrorMessage(deps.vscode, ACTIVE_BUGFIX_MESSAGE);
    return undefined;
  }

  const docsDir = getConfiguredDocsDir(deps, workspaceDir);
  const selectedSlug = await promptForFeatureSlug(deps, promptText, docsDir, modelAssignments);
  if (!selectedSlug) {
    return undefined;
  }

  const specDir = await getUniqueSlugDirectory(deps, docsDir, selectedSlug);
  await deps.fs.mkdir(specDir, { recursive: true });

  const normalizedPrompt = promptText.trimEnd();
  await deps.fs.writeFile(
    deps.path.join(specDir, "prompt.md"),
    `${normalizedPrompt}${normalizedPrompt.endsWith("\n") ? "" : "\n"}`,
    "utf8",
  );

  return specDir;
}

async function getNextBugfixSpecDir(deps: ExtensionDependencies, docsDir: string): Promise<string> {
  await deps.fs.mkdir(docsDir, { recursive: true });
  const entries = await deps.fs.readdir(docsDir);
  const highestIndex = entries.reduce((highest, entry) => {
    const match = entry.match(/^bugs(\d+)$/u);
    if (!match) {
      return highest;
    }

    return Math.max(highest, Number(match[1]));
  }, 0);

  return deps.path.join(docsDir, `bugs${highestIndex + 1}`);
}

async function createInlineBugfixSpecDir(
  deps: ExtensionDependencies,
  workspaceDir: string,
  promptText: string,
): Promise<string> {
  const docsDir = getConfiguredDocsDir(deps, workspaceDir);
  const specDir = await getNextBugfixSpecDir(deps, docsDir);
  await deps.fs.mkdir(specDir, { recursive: true });

  const normalizedPrompt = promptText.trimEnd();
  await deps.fs.writeFile(
    deps.path.join(specDir, "prompt.md"),
    `${normalizedPrompt}${normalizedPrompt.endsWith("\n") ? "" : "\n"}`,
    "utf8",
  );

  return specDir;
}

async function getSelectedSpecDir(
  deps: ExtensionDependencies,
  workspaceDir: string,
  targetPath: string | undefined,
): Promise<string | undefined> {
  if (!targetPath || targetPath.trim().length === 0) {
    return undefined;
  }

  const specDir = resolveWorkspacePath(deps, workspaceDir, targetPath);
  const promptPath = deps.path.join(specDir, "prompt.md");
  if (!(await fileExists(deps, promptPath))) {
    return undefined;
  }

  return specDir;
}

async function getSelectedBugfixSpecDir(
  deps: ExtensionDependencies,
  workspaceDir: string,
  targetPath: string | undefined,
): Promise<string | undefined> {
  const specDir = await getSelectedSpecDir(deps, workspaceDir, targetPath);
  if (!specDir) {
    return undefined;
  }

  return /^bugs\d+$/u.test(path.basename(specDir)) ? specDir : undefined;
}

async function handleStart(deps: ControllerDependencies, args?: StartCommandArgs): Promise<boolean> {
  const workspaceDir = getWorkspaceDir(deps.vscode);
  if (!workspaceDir) {
    await showWorkspaceRequiredMessage(deps.vscode);
    return false;
  }

  const initialState = createInitialState(deps, workspaceDir, "running");
  const selectedSpecDir = await getSelectedSpecDir(deps, workspaceDir, args?.targetPath);
  const inlinePrompt = args?.prompt?.trim();
  const resolvedSpecDir = selectedSpecDir
    ?? (inlinePrompt
      ? await createInlineFeatureSpecDir(deps, workspaceDir, inlinePrompt, initialState.modelAssignments)
      : initialState.specDir);

  if (!resolvedSpecDir) {
    return false;
  }

  const specStep = await detectStartSpecStep(deps, resolvedSpecDir);
  if (!specStep) {
    return false;
  }

  initialState.specDir = resolvedSpecDir;
  initialState.specStep = specStep;
  const requestedConventionsSkill = args?.conventionsSkill?.trim();
  const selectedConventionsSkill = requestedConventionsSkill !== undefined
    ? requestedConventionsSkill
    : await selectConventionsSkill(deps, workspaceDir, initialState.modelAssignments);
  if (selectedConventionsSkill === undefined) {
    return false;
  }
  initialState.conventionsSkill = selectedConventionsSkill;
  initialState.testCommand = args?.testCommand?.trim() || initialState.testCommand;
  initialState.lintCommand = args?.lintCommand?.trim() ?? initialState.lintCommand;

  await writeWorkspaceAndNestedState(deps, workspaceDir, initialState);
  return true;
}

async function handleFixBugs(deps: ControllerDependencies, args?: StartCommandArgs): Promise<boolean> {
  const workspaceDir = getWorkspaceDir(deps.vscode);
  if (!workspaceDir) {
    await showWorkspaceRequiredMessage(deps.vscode);
    return false;
  }

  const existingState = await readState(deps, workspaceDir);
  if (hasActiveOrPausedRun(existingState)) {
    await showStartErrorMessage(deps.vscode, ACTIVE_BUGFIX_MESSAGE);
    return false;
  }

  const selectedSpecDir = await getSelectedBugfixSpecDir(deps, workspaceDir, args?.targetPath);
  const inlinePrompt = args?.prompt?.trim();
  const resolvedSpecDir = selectedSpecDir
    ?? (inlinePrompt ? await createInlineBugfixSpecDir(deps, workspaceDir, inlinePrompt) : undefined);

  if (!resolvedSpecDir) {
    return false;
  }

  const initialState = createInitialState(deps, workspaceDir, "running", "clarifying");
  initialState.specDir = resolvedSpecDir;
  initialState.bugStep = "fixing";
  initialState.bugIndex = 0;
  initialState.conventionsSkill = args?.conventionsSkill?.trim() ?? initialState.conventionsSkill;
  initialState.testCommand = args?.testCommand?.trim() || initialState.testCommand;
  initialState.lintCommand = args?.lintCommand?.trim() ?? initialState.lintCommand;

  await Promise.all([
    writeWorkspaceAndNestedState(deps, workspaceDir, initialState),
    writeNestedState(deps, resolvedSpecDir, initialState),
  ]);

  return true;
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

async function handleAbandon(deps: ExtensionDependencies): Promise<boolean> {
  const workspaceDir = getWorkspaceDir(deps.vscode);
  if (!workspaceDir) {
    await showWorkspaceRequiredMessage(deps.vscode);
    return false;
  }

  const state = await readState(deps, workspaceDir);
  if (!hasActiveOrPausedRun(state)) {
    await deps.vscode.window.showInformationMessage("No active run to abandon.");
    return false;
  }

  const abandonedState = {
    ...(state ?? createInitialState(deps, workspaceDir, "abandoned")),
    status: "abandoned" as const,
  };

  await writeWorkspaceAndNestedState(deps, workspaceDir, abandonedState);

  return true;
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
  controlBridge: DashboardControlBridge,
): Promise<void> {
  if (!orchestrator) {
    await showWorkspaceRequiredMessage(deps.vscode);
    return;
  }

  deps.createDashboardPanel(context as vscode.ExtensionContext, orchestrator, controlBridge);
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
      const recoveredFeatureState = workspaceDir
        ? await recoverFeatureStateOnActivation(deps, workspaceDir)
        : { state: undefined, resume: false };
      let currentState = workspaceDir
        ? recoveredFeatureState.state ?? (await readState(deps, workspaceDir)) ?? createInitialState(deps, workspaceDir, "idle")
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

      const register = (command: string, handler: (...args: unknown[]) => Promise<void>) => {
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

      const runInlineAction = async (request: InlineRunRequest, action: "start" | "fix-bugs"): Promise<void> => {
        const actionArgs: StartCommandArgs = {
          prompt: request.prompt,
          conventionsSkill: request.conventionsSkill,
          testCommand: request.testCommand,
          lintCommand: request.lintCommand,
        };
        const started = action === "start"
          ? await handleStart(deps, actionArgs)
          : await handleFixBugs(deps, actionArgs);
        if (!started) {
          return;
        }

        void orchestrator?.run(runToken);
        if (workspaceDir) {
          const nextState = await readState(deps, workspaceDir);
          updateTreeState(nextState);
          await syncServer(nextState);
        }
      };

      const controlBridge: DashboardControlBridge = {
        async getControlOptions() {
          return {
            conventionsSkills: workspaceDir ? await getAvailableConventionsSkills(deps, workspaceDir) : [],
          };
        },
        async startRun(request) {
          await runInlineAction(request, "start");
        },
        async fixBugs(request) {
          await runInlineAction(request, "fix-bugs");
        },
        async abandonRun() {
          const abandoned = await handleAbandon(deps);
          if (!abandoned) {
            return;
          }

          orchestrator?.abandon();
          if (workspaceDir) {
            const nextState = await readState(deps, workspaceDir);
            updateTreeState(nextState);
            await syncServer(nextState);
          }
        },
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
            serverHandle = await deps.startServer(port, staticDir, authToken, orchestrator, controlBridge);
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

      register(COMMAND_START, async (...args: unknown[]) => {
        const startArgs = args[0] as StartCommandArgs | undefined;
        const shouldPrompt = workspaceDir
          ? !(startArgs?.targetPath?.trim() || startArgs?.prompt?.trim())
            && !(await hasSpecInputFiles(deps, getDefaultSpecDir(deps, workspaceDir)))
          : false;
        const resolvedArgs = await resolveCommandArgsWithInlinePrompt(
          deps,
          startArgs,
          "a feature prompt",
          shouldPrompt,
        );
        if (!resolvedArgs) {
          return;
        }

        const started = await handleStart(deps, resolvedArgs);
        if (!started) {
          return;
        }

        void orchestrator?.run(runToken);
        if (workspaceDir) {
          const nextState = await readState(deps, workspaceDir);
          updateTreeState(nextState);
          await syncServer(nextState);
        }
      });
      register(COMMAND_FIX_BUGS, async (...args: unknown[]) => {
        const fixBugArgs = args[0] as StartCommandArgs | undefined;
        const shouldPrompt = !fixBugArgs?.targetPath?.trim() && !fixBugArgs?.prompt?.trim();
        const resolvedArgs = await resolveCommandArgsWithInlinePrompt(
          deps,
          fixBugArgs,
          "a bugfix prompt",
          shouldPrompt,
        );
        if (!resolvedArgs) {
          return;
        }

        const started = await handleFixBugs(deps, resolvedArgs);
        if (!started) {
          return;
        }

        void orchestrator?.run(runToken);
        if (workspaceDir) {
          const nextState = await readState(deps, workspaceDir);
          updateTreeState(nextState);
          await syncServer(nextState);
        }
      });
      register(COMMAND_ABANDON, async () => {
        const abandoned = await handleAbandon(deps);
        if (!abandoned) {
          return;
        }

        orchestrator?.abandon();
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
      register(COMMAND_DASHBOARD, () => handleDashboard(deps, context, orchestrator, controlBridge));
      registerTreeProvider();

      if (workspaceDir) {
        const shouldResume = recoveredFeatureState.resume || await maybePromptToResume(deps, workspaceDir);
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
