import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type * as vscode from "vscode";

import { ConductorTreeProvider } from "../../views/treeProvider";
import type { ModelAssignment, OrchestratorState } from "../../types";

type Listener<T> = (value: T) => void;

class TestEventEmitter<T> {
  private readonly listeners = new Set<Listener<T>>();

  public readonly event = (listener: Listener<T>) => {
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

class TestUri {
  public readonly scheme = "file";

  public constructor(
    public readonly fsPath: string,
    public readonly path: string = fsPath,
  ) {}
}

const workspacesToCleanup: string[] = [];

const MODEL_ASSIGNMENTS: ModelAssignment[] = [
  { role: "implementor", vendor: "copilot", family: "gpt-5.4" },
  { role: "reviewer", vendor: "copilot", family: "gpt-4.1" },
  { role: "spec-author", vendor: "copilot", family: "gpt-4.1" },
  { role: "spec-reviewer", vendor: "copilot", family: "gpt-4.1-mini" },
  { role: "spec-proofreader", vendor: "copilot", family: "o3" },
  { role: "phase-creator", vendor: "copilot", family: "gpt-4.1" },
  { role: "phase-reviewer", vendor: "copilot", family: "o3-mini" },
];

afterEach(async () => {
  await Promise.all(workspacesToCleanup.splice(0).map(async (workspaceDir) => {
    await rm(workspaceDir, { recursive: true, force: true });
  }));
});

async function createWorkspace(): Promise<string> {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "conductor-f1-"));
  workspacesToCleanup.push(workspaceDir);
  return workspaceDir;
}

async function writePhaseFixtures(specDir: string): Promise<void> {
  await mkdir(specDir, { recursive: true });

  await writeFile(path.join(specDir, "phase1.md"), [
    "# Phase 1: Core Extension",
    "",
    "### Item 1.1: A1 - First item",
    "",
    "spec.md section: A1",
    "",
    "- [ ] implemented",
    "- [ ] reviewed",
    "",
    "### Item 1.2: A2 - Second item",
    "",
    "spec.md section: A2",
    "",
    "- [ ] implemented",
    "- [ ] reviewed",
    "",
    "### Item 1.3: A3 - Third item",
    "",
    "spec.md section: A3",
    "",
    "- [ ] implemented",
    "- [ ] reviewed",
    "",
  ].join("\n"), "utf8");

  await writeFile(path.join(specDir, "phase2.md"), [
    "# Phase 2: Rich UI",
    "",
    "### Item 2.1: B1 - Fourth item",
    "",
    "spec.md section: B1",
    "",
    "- [ ] implemented",
    "- [ ] reviewed",
    "",
    "### Item 2.2: B2 - Fifth item",
    "",
    "spec.md section: B2",
    "",
    "- [ ] implemented",
    "- [ ] reviewed",
    "",
  ].join("\n"), "utf8");
}

async function writeConductorArtifacts(
  workspaceDir: string,
  transcripts: Array<{ timestamp: string; fileName: string }> = [],
): Promise<void> {
  const conductorDir = path.join(workspaceDir, ".conductor");

  await mkdir(conductorDir, { recursive: true });
  await writeFile(path.join(conductorDir, "audit.md"), "# Audit\n", "utf8");

  for (const transcript of transcripts) {
    const runDir = path.join(conductorDir, "runs", transcript.timestamp);
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, transcript.fileName), "{}\n", "utf8");
  }
}

async function createProviderHarness(itemStatuses: OrchestratorState["itemStatuses"]) {
  const workspaceDir = await createWorkspace();
  const specDir = path.join(workspaceDir, ".docs", "conductor");
  const stateEmitter = new TestEventEmitter<OrchestratorState>();

  await writePhaseFixtures(specDir);
  await writeConductorArtifacts(workspaceDir);

  const state: OrchestratorState = {
    specDir,
    currentPhase: 1,
    currentItemIndex: 1,
    consecutivePasses: {},
    specStep: "done",
    specConsecutivePasses: 0,
    specPhaseFileIndex: 0,
    clarificationQuestions: [],
    status: "running",
    modelAssignments: MODEL_ASSIGNMENTS,
    itemStatuses,
    startedBy: "tester",
  };

  const provider = new ConductorTreeProvider(() => state, {
    createFileUri: (filePath) => new TestUri(filePath) as unknown as vscode.Uri,
    onStateChange: stateEmitter.event,
    workspaceRoot: workspaceDir,
  });

  return { provider, state, stateEmitter };
}

async function createProviderHarnessWithArtifacts(
  itemStatuses: OrchestratorState["itemStatuses"],
  transcripts: Array<{ timestamp: string; fileName: string }>,
) {
  const workspaceDir = await createWorkspace();
  const specDir = path.join(workspaceDir, ".docs", "conductor");

  await writePhaseFixtures(specDir);
  await writeConductorArtifacts(workspaceDir, transcripts);

  const state: OrchestratorState = {
    specDir,
    currentPhase: 1,
    currentItemIndex: 1,
    consecutivePasses: {},
    specStep: "done",
    specConsecutivePasses: 0,
    specPhaseFileIndex: 0,
    clarificationQuestions: [],
    status: "running",
    modelAssignments: MODEL_ASSIGNMENTS,
    itemStatuses,
    startedBy: "tester",
  };

  const provider = new ConductorTreeProvider(() => state, {
    createFileUri: (filePath) => new TestUri(filePath) as unknown as vscode.Uri,
  });

  return { provider, state, workspaceDir };
}

async function createProviderHarnessWithRelativeSpecDir(itemStatuses: OrchestratorState["itemStatuses"]) {
  const workspaceDir = await createWorkspace();
  const specDir = path.join(workspaceDir, ".docs", "conductor");

  await writePhaseFixtures(specDir);
  await writeConductorArtifacts(workspaceDir);

  const state: OrchestratorState = {
    specDir: path.join(".docs", "conductor"),
    currentPhase: 1,
    currentItemIndex: 1,
    consecutivePasses: {},
    specStep: "done",
    specConsecutivePasses: 0,
    specPhaseFileIndex: 0,
    clarificationQuestions: [],
    status: "running",
    modelAssignments: MODEL_ASSIGNMENTS,
    itemStatuses,
    startedBy: "tester",
  };

  const provider = new ConductorTreeProvider(() => state, {
    createFileUri: (filePath) => new TestUri(filePath) as unknown as vscode.Uri,
    workspaceRoot: workspaceDir,
  });

  return { provider, workspaceDir };
}

describe("ConductorTreeProvider F1", () => {
  it("returns one root node per phase", async () => {
    const { provider } = await createProviderHarness({
      A1: "pending",
      A2: "in-progress",
      A3: "pass",
      B1: "pending",
      B2: "pending",
    });

    const rootNodes = provider.getChildren();

    expect(rootNodes).toHaveLength(2);
    expect(rootNodes.map((node) => node.type)).toEqual(["phase", "phase"]);
    expect(rootNodes.map((node) => node.phaseNumber)).toEqual([1, 2]);
  });

  it("returns one child item per phase item", async () => {
    const { provider } = await createProviderHarness({
      A1: "pending",
      A2: "in-progress",
      A3: "pass",
      B1: "pending",
      B2: "pending",
    });

    const phaseNode = provider.getChildren()[0];
    const itemNodes = provider.getChildren(phaseNode);

    expect(itemNodes).toHaveLength(3);
    expect(itemNodes.map((node) => node.itemId)).toEqual(["A1", "A2", "A3"]);
    expect(itemNodes.map((node) => node.type)).toEqual(["item", "item", "item"]);
  });

  it("maps pass status to the check icon and reviewer tooltip", async () => {
    const { provider } = await createProviderHarness({
      A1: "pending",
      A2: "pass",
      A3: "pending",
      B1: "pending",
      B2: "pending",
    });

    const phaseNode = provider.getChildren()[0];
    const itemNode = provider.getChildren(phaseNode)[1];
    const treeItem = provider.getTreeItem(itemNode);

    expect((treeItem.iconPath as { id: string }).id).toBe("check");
    expect(String(treeItem.tooltip)).toContain("reviewer: gpt-4.1");
  });

  it("maps fail status to the error icon and reviewer tooltip", async () => {
    const { provider } = await createProviderHarness({
      A1: "pending",
      A2: "fail",
      A3: "pending",
      B1: "pending",
      B2: "pending",
    });

    const phaseNode = provider.getChildren()[0];
    const itemNode = provider.getChildren(phaseNode)[1];
    const treeItem = provider.getTreeItem(itemNode);

    expect((treeItem.iconPath as { id: string }).id).toBe("error");
    expect(String(treeItem.tooltip)).toContain("reviewer: gpt-4.1");
  });

  it("uses the required icons for pending, in-progress, and pending-approval statuses", async () => {
    const { provider } = await createProviderHarness({
      A1: "pending",
      A2: "in-progress",
      A3: "pending-approval",
      B1: "pending",
      B2: "pending",
    });

    const phaseNode = provider.getChildren()[0];
    const itemNodes = provider.getChildren(phaseNode);
    const pendingTreeItem = provider.getTreeItem(itemNodes[0]);
    const inProgressTreeItem = provider.getTreeItem(itemNodes[1]);
    const pendingApprovalTreeItem = provider.getTreeItem(itemNodes[2]);

    expect((pendingTreeItem.iconPath as { id: string }).id).toBe("circle");
    expect((inProgressTreeItem.iconPath as { id: string }).id).toBe("sync");
    expect((pendingApprovalTreeItem.iconPath as { id: string }).id).toBe("eye");
  });

  it("opens the latest transcript for an item when one exists", async () => {
    const { provider, workspaceDir } = await createProviderHarnessWithArtifacts(
      {
        A1: "pass",
        A2: "pending",
        A3: "pending",
        B1: "pending",
        B2: "pending",
      },
      [
        { timestamp: "2026-03-18T10:00:00.000Z", fileName: "implementor-A1.json" },
        { timestamp: "2026-03-19T12:00:00.000Z", fileName: "reviewer-A1.json" },
      ],
    );

    const phaseNode = provider.getChildren()[0];
    const itemNode = provider.getChildren(phaseNode)[0];
    const treeItem = provider.getTreeItem(itemNode) as {
      command: { command: string; arguments: unknown[] };
      resourceUri: TestUri;
    };

    const expectedTranscriptPath = path.join(
      workspaceDir,
      ".conductor",
      "runs",
      "2026-03-19T12:00:00.000Z",
      "reviewer-A1.json",
    );
    const openTarget = treeItem.command.arguments[0];

    expect(treeItem.command.command).toBe("vscode.open");
    expect(openTarget).toBeInstanceOf(TestUri);
    expect(openTarget).toBe(treeItem.resourceUri);
    expect((openTarget as TestUri).fsPath).toBe(expectedTranscriptPath);
    expect(treeItem.resourceUri.fsPath).toBe(expectedTranscriptPath);
  });

  it("falls back to audit.md when no transcript exists for an item", async () => {
    const { provider, workspaceDir } = await createProviderHarnessWithArtifacts(
      {
        A1: "pending",
        A2: "pending",
        A3: "pending",
        B1: "pending",
        B2: "pending",
      },
      [],
    );

    const phaseNode = provider.getChildren()[0];
    const itemNode = provider.getChildren(phaseNode)[0];
    const treeItem = provider.getTreeItem(itemNode) as {
      command: { command: string; arguments: unknown[] };
      resourceUri: TestUri;
    };

    const expectedAuditPath = path.join(workspaceDir, ".conductor", "audit.md");
    const openTarget = treeItem.command.arguments[0];

    expect(treeItem.command.command).toBe("vscode.open");
    expect(openTarget).toBeInstanceOf(TestUri);
    expect(openTarget).toBe(treeItem.resourceUri);
    expect((openTarget as TestUri).fsPath).toBe(expectedAuditPath);
    expect(treeItem.resourceUri.fsPath).toBe(expectedAuditPath);
  });

  it("resolves relative specDir from the workspace root instead of process cwd", async () => {
    const { provider, workspaceDir } = await createProviderHarnessWithRelativeSpecDir({
      A1: "pending",
      A2: "pending",
      A3: "pending",
      B1: "pending",
      B2: "pending",
    });
    const originalCwd = process.cwd();
    const unrelatedDir = await mkdtemp(path.join(os.tmpdir(), "conductor-cwd-"));
    workspacesToCleanup.push(unrelatedDir);

    try {
      process.chdir(unrelatedDir);

      const phaseNode = provider.getChildren()[0];
      const itemNode = provider.getChildren(phaseNode)[0];
      const treeItem = provider.getTreeItem(itemNode) as {
        command: { command: string; arguments: unknown[] };
        resourceUri: TestUri;
      };
      const openTarget = treeItem.command.arguments[0];

      expect(phaseNode?.label).toBe("Phase 1: Core Extension");
      expect(treeItem.command.command).toBe("vscode.open");
      expect(openTarget).toBeInstanceOf(TestUri);
      expect(openTarget).toBe(treeItem.resourceUri);
      expect((openTarget as TestUri).fsPath).toBe(path.join(workspaceDir, ".conductor", "audit.md"));
      expect(treeItem.resourceUri.fsPath).toBe(path.join(workspaceDir, ".conductor", "audit.md"));
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("fires change events on refresh and onStateChange", async () => {
    const { provider, state, stateEmitter } = await createProviderHarness({
      A1: "pending",
      A2: "in-progress",
      A3: "pending",
      B1: "pending",
      B2: "pending",
    });

    const events: Array<unknown> = [];
    provider.onDidChangeTreeData((value) => {
      events.push(value);
    });

    provider.refresh();
    stateEmitter.fire(state);

    expect(events).toEqual([undefined, undefined]);
  });
});
