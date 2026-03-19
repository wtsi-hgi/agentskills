import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import type * as vscode from "vscode";

import { parsePhaseFile } from "../orchestrator/parser";
import type { ItemStatus, OrchestratorState, Phase, Role } from "../types";

const COLLAPSIBLE_STATE_NONE = 0 as vscode.TreeItemCollapsibleState;
const COLLAPSIBLE_STATE_COLLAPSED = 1 as vscode.TreeItemCollapsibleState;
const OPEN_FILE_COMMAND = "vscode.open";
const CONDUCTOR_DIRECTORY = ".conductor";
const RUNS_DIRECTORY = "runs";
const AUDIT_FILE = "audit.md";

type Listener<T> = (value: T) => void;

type ProviderOptions = {
  onStateChange?: vscode.Event<OrchestratorState>;
  readDirectory?: (directoryPath: string) => string[];
  readFile?: (filePath: string) => string;
  createFileUri?: (filePath: string) => vscode.Uri;
  workspaceRoot?: string;
};

type ItemRole = Extract<Role, "implementor" | "reviewer">;

type VscodeUriModule = {
  Uri: {
    file: (filePath: string) => vscode.Uri;
  };
};

let cachedVscodeUriModule: VscodeUriModule | undefined;

class SimpleEventEmitter<T> {
  private readonly listeners = new Set<Listener<T>>();

  public readonly event = (listener: Listener<T>): { dispose(): void } => {
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

function getStatusIcon(status: ItemStatus | undefined): vscode.ThemeIcon {
  switch (status) {
    case "in-progress":
      return { id: "sync" } as vscode.ThemeIcon;
    case "pass":
      return { id: "check" } as vscode.ThemeIcon;
    case "fail":
      return { id: "error" } as vscode.ThemeIcon;
    case "pending-approval":
      return { id: "eye" } as vscode.ThemeIcon;
    case "skipped":
      return { id: "circle-slash" } as vscode.ThemeIcon;
    case "pending":
    default:
      return { id: "circle" } as vscode.ThemeIcon;
  }
}

function getWorkspaceDir(specDir: string, workspaceRoot?: string): string {
  const resolvedSpecDir = resolveSpecDir(specDir, workspaceRoot);

  if (path.basename(resolvedSpecDir) === "conductor" && path.basename(path.dirname(resolvedSpecDir)) === ".docs") {
    return path.dirname(path.dirname(resolvedSpecDir));
  }

  if (path.basename(resolvedSpecDir) === ".docs") {
    return path.dirname(resolvedSpecDir);
  }

  return path.dirname(resolvedSpecDir);
}

function resolveSpecDir(specDir: string, workspaceRoot?: string): string {
  if (path.isAbsolute(specDir)) {
    return specDir;
  }

  if (workspaceRoot) {
    return path.join(workspaceRoot, specDir);
  }

  return specDir;
}

function getVscodeUriModule(): VscodeUriModule {
  cachedVscodeUriModule ??= require("vscode") as VscodeUriModule;

  return cachedVscodeUriModule;
}

function buildOpenTarget(target: vscode.Uri): vscode.Command {
  return {
    command: OPEN_FILE_COMMAND,
    title: "Open Conductor Artifact",
    arguments: [target],
  };
}

function getItemRole(status: ItemStatus | undefined): ItemRole {
  switch (status) {
    case "pass":
    case "fail":
    case "pending-approval":
      return "reviewer";
    default:
      return "implementor";
  }
}

function getStatusLabel(status: ItemStatus | undefined): string {
  return status ?? "pending";
}

function deriveStatus(state: OrchestratorState, phaseItem: Phase["items"][number]): ItemStatus {
  const explicitStatus = state.itemStatuses[phaseItem.id];

  if (explicitStatus) {
    return explicitStatus;
  }

  if (phaseItem.reviewed) {
    return "pass";
  }

  if (phaseItem.implemented) {
    return "in-progress";
  }

  return "pending";
}

function loadPhases(
  specDir: string,
  readDirectory: (directoryPath: string) => string[],
  readFile: (filePath: string) => string,
): Phase[] {
  let entries: string[];

  try {
    entries = readDirectory(specDir);
  } catch {
    return [];
  }

  return entries
    .filter((entry) => /^phase\d+\.md$/i.test(entry))
    .map((entry) => {
      const filePath = path.join(specDir, entry);
      return parsePhaseFile(readFile(filePath));
    })
    .filter((phase) => phase.number > 0)
    .sort((left, right) => left.number - right.number);
}

export interface ConductorTreeItem extends vscode.TreeItem {
  type: "phase" | "item";
  label: string;
  status?: ItemStatus;
  phaseNumber?: number;
  itemId?: string;
}

export class ConductorTreeProvider implements vscode.TreeDataProvider<ConductorTreeItem> {
  private readonly changeEmitter = new SimpleEventEmitter<ConductorTreeItem | undefined | null | void>();

  private readonly readDirectory: (directoryPath: string) => string[];

  private readonly readFile: (filePath: string) => string;

  private readonly createFileUri: (filePath: string) => vscode.Uri;

  private readonly stateChangeSubscription?: { dispose(): void };

  private readonly workspaceRoot?: string;

  public readonly onDidChangeTreeData = this.changeEmitter.event;

  public constructor(
    private readonly getState: () => OrchestratorState,
    options: ProviderOptions = {},
  ) {
    this.readDirectory = options.readDirectory ?? ((directoryPath) => readdirSync(directoryPath));
    this.readFile = options.readFile ?? ((filePath) => readFileSync(filePath, "utf8"));
    this.createFileUri = options.createFileUri ?? ((filePath) => getVscodeUriModule().Uri.file(filePath));
    this.workspaceRoot = options.workspaceRoot;
    this.stateChangeSubscription = options.onStateChange?.(() => {
      this.refresh();
    });
  }

  public getTreeItem(el: ConductorTreeItem): vscode.TreeItem {
    if (el.type === "phase") {
      return {
        ...el,
        collapsibleState: COLLAPSIBLE_STATE_COLLAPSED,
        contextValue: "phase",
      } satisfies ConductorTreeItem;
    }

    const state = this.getState();
    const role = getItemRole(el.status);
    const model = state.modelAssignments.find((assignment) => assignment.role === role);
    const modelLabel = model?.family || model?.vendor || "unassigned";
    const openTargetPath = this.resolveItemOpenTarget(state, el.itemId);
    const openTarget = this.createFileUri(openTargetPath);

    return {
      ...el,
      collapsibleState: COLLAPSIBLE_STATE_NONE,
      command: buildOpenTarget(openTarget),
      contextValue: "item",
      description: getStatusLabel(el.status),
      iconPath: getStatusIcon(el.status),
      resourceUri: openTarget,
      tooltip: `${el.itemId ?? el.label} • ${role}: ${modelLabel}`,
    } satisfies ConductorTreeItem;
  }

  public getChildren(el?: ConductorTreeItem): ConductorTreeItem[] {
    const state = this.getState();
    const specDir = resolveSpecDir(state.specDir, this.workspaceRoot);
    const phases = loadPhases(specDir, this.readDirectory, this.readFile);

    if (!el) {
      return phases.map((phase) => ({
        type: "phase",
        label: `Phase ${phase.number}: ${phase.title}`,
        phaseNumber: phase.number,
      }));
    }

    if (el.type !== "phase" || el.phaseNumber === undefined) {
      return [];
    }

    const phase = phases.find((candidate) => candidate.number === el.phaseNumber);
    if (!phase) {
      return [];
    }

    return phase.items.map((item) => ({
      type: "item",
      label: `${item.id} - ${item.title}`,
      itemId: item.id,
      phaseNumber: phase.number,
      status: deriveStatus(state, item),
    }));
  }

  public refresh(): void {
    this.changeEmitter.fire(undefined);
  }

  private resolveItemOpenTarget(state: OrchestratorState, itemId?: string): string {
    const conductorDir = path.join(getWorkspaceDir(state.specDir, this.workspaceRoot), CONDUCTOR_DIRECTORY);
    const transcriptPath = itemId ? this.findLatestTranscriptPath(conductorDir, itemId) : undefined;

    return transcriptPath ?? path.join(conductorDir, AUDIT_FILE);
  }

  private findLatestTranscriptPath(conductorDir: string, itemId: string): string | undefined {
    const runsDir = path.join(conductorDir, RUNS_DIRECTORY);
    let runDirectories: string[];

    try {
      runDirectories = this.readDirectory(runsDir);
    } catch {
      return undefined;
    }

    for (const runDirectory of [...runDirectories].sort((left, right) => right.localeCompare(left))) {
      const candidateDir = path.join(runsDir, runDirectory);
      let transcriptFiles: string[];

      try {
        transcriptFiles = this.readDirectory(candidateDir);
      } catch {
        continue;
      }

      const match = transcriptFiles
        .filter((entry) => entry.endsWith(`-${itemId}.json`))
        .sort((left, right) => left.localeCompare(right))[0];

      if (match) {
        return path.join(candidateDir, match);
      }
    }

    return undefined;
  }

  public dispose(): void {
    this.stateChangeSubscription?.dispose();
  }
}