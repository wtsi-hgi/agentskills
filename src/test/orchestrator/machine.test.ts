import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  checkBranchSafety,
  createOrchestrator,
  parseBugDescription,
  parseCommandExtraction,
} from "../../orchestrator/machine";
import { readAudit } from "../../state/audit";
import { loadState, saveState } from "../../state/persistence";
import type {
  ClarificationAnswer,
  InvocationResult,
  ModelAssignment,
  OrchestratorConfig,
  OrchestratorState,
  Role,
  RunTranscript,
  TranscriptMessage,
} from "../../types";

type ScriptedInvocation = {
  response: string;
  addendum?: string | null;
  messages?: TranscriptMessage[];
  waitFor?: Promise<void>;
  error?: Error;
};

type TestCommandResult = {
  success: boolean;
  output: string;
  error?: string;
};

type InvocationRecord = {
  role: Role;
  modelFamily: string;
  systemPrompt: string;
  userPrompt: string;
};

type DirectRequestRecord = {
  role: Role;
  modelFamily: string;
  messages: Array<{ role: string; content: string }>;
};

type AddendumRecord = {
  itemId: string;
  deviation: string;
  rationale: string;
  author?: string;
};

type MachineHarness = {
  workspaceDir: string;
  specDirName: string;
  config: OrchestratorConfig;
  invocationRecords: InvocationRecord[];
  directRequestRecords: DirectRequestRecord[];
  addendumRecords: AddendumRecord[];
  testCommandCalls: string[];
  trustedCommandCalls: string[];
  selectCalls: Array<{ role: Role; family: string }>;
  orchestrator: ReturnType<typeof createOrchestrator>;
  run: () => Promise<void>;
  submitClarification: (answers: ClarificationAnswer[]) => void;
  loadPersistedState: () => Promise<OrchestratorState>;
  readPhaseFile: (phaseNumber?: number) => Promise<string>;
  readPromptFile: () => Promise<string>;
};

type HarnessRuntime = {
  invocationRecords: InvocationRecord[];
  directRequestRecords: DirectRequestRecord[];
  addendumRecords: AddendumRecord[];
  testCommandCalls: string[];
  trustedCommandCalls: string[];
  selectCalls: Array<{ role: Role; family: string }>;
};

const dirsToCleanup: string[] = [];

const DEFAULT_ASSIGNMENTS: ModelAssignment[] = [
  { role: "implementor", vendor: "copilot", family: "gpt-5.4" },
  { role: "reviewer", vendor: "copilot", family: "gpt-4.1" },
  { role: "pr-reviewer", vendor: "copilot", family: "o3" },
  { role: "spec-author", vendor: "copilot", family: "gpt-4.1" },
  { role: "spec-reviewer", vendor: "copilot", family: "gpt-4.1-mini" },
  { role: "spec-proofreader", vendor: "copilot", family: "o3" },
  { role: "phase-creator", vendor: "copilot", family: "gpt-4.1" },
  { role: "phase-reviewer", vendor: "copilot", family: "o3-mini" },
];

function createToken() {
  return {
    isCancellationRequested: false,
    onCancellationRequested() {
      return { dispose() {} };
    },
  };
}

function createInvocationResult(script: ScriptedInvocation): InvocationResult {
  return {
    response: script.response,
    totalTokensIn: 10,
    totalTokensOut: 5,
    turns: 1,
    done: true,
    addendum: script.addendum ?? null,
    messages: script.messages ?? [
      { role: "assistant", content: `<done>${script.response}</done>` },
    ],
  };
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const timeoutAt = Date.now() + 3_000;

  while (Date.now() < timeoutAt) {
    if (await predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("Timed out waiting for condition");
}

async function waitForValue<T>(predicate: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const timeoutAt = Date.now() + 3_000;

  while (Date.now() < timeoutAt) {
    const value = await predicate();
    if (value !== undefined) {
      return value;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("Timed out waiting for condition");
}

async function createWorkspace(): Promise<string> {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "conductor-d2-"));
  dirsToCleanup.push(workspaceDir);
  return workspaceDir;
}

async function writeFixtureFiles(
  workspaceDir: string,
  options?: {
    specDirName?: string;
    phaseContent?: string;
    phaseFiles?: Record<number, string>;
    createSpec?: boolean;
    createPrompt?: boolean;
    promptContent?: string;
    conventionsSkillContent?: string;
  },
): Promise<void> {
  const specDir = path.join(workspaceDir, ".docs", options?.specDirName ?? "conductor");
  const skillsDir = path.join(workspaceDir, "skills");

  await mkdir(specDir, { recursive: true });
  await mkdir(path.join(skillsDir, "test-conventions"), { recursive: true });
  await mkdir(path.join(skillsDir, "test-implementor"), { recursive: true });
  await mkdir(path.join(skillsDir, "test-reviewer"), { recursive: true });

  if (options?.createSpec ?? true) {
    await writeFile(path.join(specDir, "spec.md"), [
      "# Spec",
      "",
      "### A1: Item A1",
      "Implement A1.",
      "",
      "### A2: Item A2",
      "Implement A2.",
      "",
      "### B1: Batch item B1",
      "Implement B1.",
      "",
      "### B2: Batch item B2",
      "Implement B2.",
      "",
      "### B3: Batch item B3",
      "Implement B3.",
      "",
    ].join("\n"), "utf8");
  }

  if (options?.createPrompt) {
    await writeFile(path.join(specDir, "prompt.md"), options.promptContent ?? [
      "# Prompt",
      "",
      "Build the requested feature.",
      "",
      "Respect the repository architecture.",
    ].join("\n"), "utf8");
  }

  const phaseFiles = options?.phaseFiles ?? {
    1: options?.phaseContent ?? [
      "# Phase 1: Core Extension",
      "",
      "### Item 1.1: A1 - Item A1",
      "",
      "spec.md section: A1",
      "",
      "- [ ] implemented",
      "- [ ] reviewed",
      "",
    ].join("\n"),
  };

  await Promise.all(Object.entries(phaseFiles).map(async ([phaseNumber, content]) => {
    await writeFile(path.join(specDir, `phase${phaseNumber}.md`), content, "utf8");
  }));

  await writeFile(
    path.join(skillsDir, "test-conventions", "SKILL.md"),
    options?.conventionsSkillContent ?? "# test conventions\n",
    "utf8",
  );
  await writeFile(path.join(skillsDir, "test-implementor", "SKILL.md"), "# implementor skill\n", "utf8");
  await writeFile(path.join(skillsDir, "test-reviewer", "SKILL.md"), "# reviewer skill\n", "utf8");
}

function createHarnessRuntime(): HarnessRuntime {
  return {
    invocationRecords: [],
    directRequestRecords: [],
    addendumRecords: [],
    testCommandCalls: [],
    trustedCommandCalls: [],
    selectCalls: [],
  };
}

function createOrchestratorOverrides(
  runtime: HarnessRuntime,
  options?: {
    invocationScripts?: Partial<Record<Role, ScriptedInvocation[]>>;
    directRequestResponses?: Partial<Record<Role, string[]>>;
    executeResults?: TestCommandResult[];
    trustedExecuteResults?: TestCommandResult[];
    trustedCommandResponses?: Record<string, TestCommandResult[]>;
    diffResults?: TestCommandResult[];
    persistTranscripts?: boolean;
  },
): Parameters<typeof createOrchestrator>[2] {
  const invocationQueues = {
    implementor: [...(options?.invocationScripts?.implementor ?? [])],
    reviewer: [...(options?.invocationScripts?.reviewer ?? [])],
    "pr-reviewer": [...(options?.invocationScripts?.["pr-reviewer"] ?? [])],
    "spec-author": [...(options?.invocationScripts?.["spec-author"] ?? [])],
    "spec-reviewer": [...(options?.invocationScripts?.["spec-reviewer"] ?? [])],
    "spec-proofreader": [...(options?.invocationScripts?.["spec-proofreader"] ?? [])],
    "phase-creator": [...(options?.invocationScripts?.["phase-creator"] ?? [])],
    "phase-reviewer": [...(options?.invocationScripts?.["phase-reviewer"] ?? [])],
  } satisfies Record<Role, ScriptedInvocation[]>;
  const directRequestQueues = {
    implementor: [...(options?.directRequestResponses?.implementor ?? [])],
    reviewer: [...(options?.directRequestResponses?.reviewer ?? [])],
    "pr-reviewer": [...(options?.directRequestResponses?.["pr-reviewer"] ?? [])],
    "spec-author": [...(options?.directRequestResponses?.["spec-author"] ?? [])],
    "spec-reviewer": [...(options?.directRequestResponses?.["spec-reviewer"] ?? [])],
    "spec-proofreader": [...(options?.directRequestResponses?.["spec-proofreader"] ?? [])],
    "phase-creator": [...(options?.directRequestResponses?.["phase-creator"] ?? [])],
    "phase-reviewer": [...(options?.directRequestResponses?.["phase-reviewer"] ?? [])],
  } satisfies Record<Role, string[]>;

  const executeResults = [...(options?.executeResults ?? [])];
  const trustedExecuteResults = [...(options?.trustedExecuteResults ?? [])];
  const trustedCommandResponses = new Map(
    Object.entries(options?.trustedCommandResponses ?? {}).map(([command, responses]) => [command, [...responses]]),
  );
  const diffResults = [...(options?.diffResults ?? [])];

  const overrides: Parameters<typeof createOrchestrator>[2] = {
    async selectModelForRole(role, assignments) {
      const family = assignments.find((assignment) => assignment.role === role)?.family ?? "unknown";
      runtime.selectCalls.push({ role, family });
      return {
        family,
        role,
        async sendRequest(messages: unknown[]) {
          runtime.directRequestRecords.push({
            role,
            modelFamily: family,
            messages: (messages as Array<{ role: string; content: string }>).map((message) => ({
              role: message.role,
              content: message.content,
            })),
          });

          const next = directRequestQueues[role].shift();
          if (next === undefined) {
            throw new Error(`No scripted direct request left for ${role}`);
          }

          return {
            text: (async function* () {
              yield next;
            })(),
          };
        },
      } as never;
    },
    async assembleSystemPrompt(role, _skillsDir, _conventionsSkill, itemContext) {
      return `${role}::${itemContext}`;
    },
    async invokeWithToolLoop(model, systemPrompt, userPrompt) {
      const role = (model as unknown as { role: Role }).role;
      runtime.invocationRecords.push({
        role,
        modelFamily: String((model as { family: string }).family),
        systemPrompt,
        userPrompt,
      });

      const next = invocationQueues[role].shift();
      if (!next) {
        throw new Error(`No scripted invocation left for ${role}`);
      }

      if (next.waitFor) {
        await next.waitFor;
      }

      if (next.error) {
        throw next.error;
      }

      return createInvocationResult(next);
    },
    async executeBash(command) {
      if (command === "git diff -- .") {
        return diffResults.shift() ?? { success: true, output: "stdout:\n\nexit code: 0" };
      }

      runtime.testCommandCalls.push(command);
      return executeResults.shift() ?? { success: true, output: "stdout:\npass\nexit code: 0" };
    },
    async executeTrusted(command) {
      runtime.trustedCommandCalls.push(command);

      const scriptedResponses = trustedCommandResponses.get(command);
      if (scriptedResponses && scriptedResponses.length > 0) {
        return scriptedResponses.shift() as TestCommandResult;
      }

      const scripted = trustedExecuteResults.shift();
      if (scripted) {
        return scripted;
      }

      if (command === "command -v gh") {
        return { success: true, output: "stdout:\n/usr/bin/gh\nexit code: 0" };
      }

      if (command === "git rev-parse --abbrev-ref HEAD") {
        return { success: true, output: "stdout:\nfeature/test\nexit code: 0" };
      }

      if (command === "git rev-parse HEAD") {
        return { success: true, output: "stdout:\nabc123\nexit code: 0" };
      }

      if (command === "git ls-remote origin 'refs/heads/feature/test'") {
        return { success: true, output: "stdout:\nabc123\trefs/heads/feature/test\nexit code: 0" };
      }

      if (command === "git remote show origin | grep 'HEAD branch'") {
        return { success: true, output: "stdout:\n  HEAD branch: main\nexit code: 0" };
      }

      if (command === "gh repo view --json owner,name") {
        return { success: true, output: "stdout:\n{\"owner\":{\"login\":\"wtsi-hgi\"},\"name\":\"copilot-conductor\"}\nexit code: 0" };
      }

      if (command === "gh pr view --json number") {
        return { success: true, output: "stdout:\n{\"number\":42}\nexit code: 0" };
      }

      if (command === "gh api repos/wtsi-hgi/copilot-conductor/pulls/42/requested_reviewers -f reviewers[]=copilot") {
        return { success: true, output: "stdout:\n{}\nexit code: 0" };
      }

      if (command === "gh api repos/wtsi-hgi/copilot-conductor/pulls/42/reviews") {
        return {
          success: true,
          output: "stdout:\n[{\"id\":700,\"submitted_at\":\"2026-03-19T10:11:13.000Z\",\"user\":{\"login\":\"copilot\"}}]\nexit code: 0",
        };
      }

      if (command === "gh api repos/wtsi-hgi/copilot-conductor/pulls/42/comments") {
        return { success: true, output: "stdout:\n[]\nexit code: 0" };
      }

      if (command === "git status --porcelain") {
        return {
          success: true,
          output: "stdout:\n M src/foo.ts\n?? test/foo.test.ts\nexit code: 0",
        };
      }

      return { success: true, output: "stdout:\ntrusted ok\nexit code: 0" };
    },
    async sleep() {
    },
    async getDiff(itemIds) {
      return `Combined diff for items: ${itemIds.join(", ")}`;
    },
    async appendAddendum(_conductorDir, entry) {
      runtime.addendumRecords.push({
        itemId: entry.itemId,
        deviation: entry.deviation,
        rationale: entry.rationale,
        author: entry.author,
      });
    },
    now() {
      return "2026-03-19T10:11:12.000Z";
    },
  };

  if (!options?.persistTranscripts) {
    overrides.saveTranscript = async (_conductorDir, _transcript: RunTranscript) => {
    };
  }

  return overrides;
}

async function createHarness(options?: {
  specDirName?: string;
  phaseContent?: string;
  phaseFiles?: Record<number, string>;
  createSpec?: boolean;
  createPrompt?: boolean;
  promptContent?: string;
  conventionsSkillContent?: string;
  invocationScripts?: Partial<Record<Role, ScriptedInvocation[]>>;
  directRequestResponses?: Partial<Record<Role, string[]>>;
  executeResults?: TestCommandResult[];
  trustedExecuteResults?: TestCommandResult[];
  trustedCommandResponses?: Record<string, TestCommandResult[]>;
  diffResults?: TestCommandResult[];
  initialState?: Partial<OrchestratorState>;
  modelAssignments?: ModelAssignment[];
  persistTranscripts?: boolean;
}): Promise<MachineHarness> {
  const workspaceDir = await createWorkspace();
  const specDirName = options?.specDirName ?? "conductor";
  await writeFixtureFiles(workspaceDir, {
    specDirName,
    phaseContent: options?.phaseContent,
    phaseFiles: options?.phaseFiles,
    createSpec: options?.createSpec,
    createPrompt: options?.createPrompt,
    promptContent: options?.promptContent,
    conventionsSkillContent: options?.conventionsSkillContent,
  });

  const config: OrchestratorConfig = {
    projectDir: workspaceDir,
    docsDir: path.join(workspaceDir, ".docs"),
    skillsDir: path.join(workspaceDir, "skills"),
    modelAssignments: (options?.modelAssignments ?? DEFAULT_ASSIGNMENTS)
      .map((assignment) => ({ ...assignment })),
    maxTurns: 5,
    maxRetries: 2,
    requireApproval: false,
  };

  if (options?.initialState) {
    await saveState(path.join(workspaceDir, ".conductor"), {
      specDir: path.join(config.docsDir, specDirName),
      conventionsSkill: "test-conventions",
      testCommand: "npm test",
      lintCommand: "",
      currentPhase: 1,
      currentItemIndex: 0,
      consecutivePasses: {},
      specStep: "done",
      specConsecutivePasses: 0,
      specPhaseFileIndex: 0,
      clarificationQuestions: [],
      status: "idle",
      modelAssignments: config.modelAssignments,
      itemStatuses: {},
      ...options.initialState,
    });
  }

  const runtime = createHarnessRuntime();

  const orchestrator = createOrchestrator(
    config,
    { subscriptions: [] } as never,
    createOrchestratorOverrides(runtime, options),
  );

  return {
    workspaceDir,
    specDirName,
    config,
    invocationRecords: runtime.invocationRecords,
    directRequestRecords: runtime.directRequestRecords,
    addendumRecords: runtime.addendumRecords,
    testCommandCalls: runtime.testCommandCalls,
    trustedCommandCalls: runtime.trustedCommandCalls,
    selectCalls: runtime.selectCalls,
    orchestrator,
    run: () => orchestrator.run(createToken() as never),
    submitClarification: (answers) => orchestrator.submitClarification(answers),
    loadPersistedState: () => loadState(path.join(workspaceDir, ".conductor")),
    readPhaseFile: (phaseNumber = 1) => readFile(path.join(workspaceDir, ".docs", specDirName, `phase${phaseNumber}.md`), "utf8"),
    readPromptFile: () => readFile(path.join(workspaceDir, ".docs", specDirName, "prompt.md"), "utf8"),
  };
}

afterEach(async () => {
  await Promise.all(dirsToCleanup.splice(0).map(async (dirPath) => rm(dirPath, { recursive: true, force: true })));
});

function captureStateSnapshots(harness: MachineHarness): OrchestratorState[] {
  const snapshots: OrchestratorState[] = [];
  harness.orchestrator.onStateChange((state) => {
    snapshots.push(JSON.parse(JSON.stringify(state)) as OrchestratorState);
  });
  return snapshots;
}

describe("createOrchestrator", () => {
  it("returns safe true for a feature branch", async () => {
    const result = await checkBranchSafety("/repo", async (command) => {
      if (command === "git rev-parse --abbrev-ref HEAD") {
        return { success: true, output: "stdout:\nfeature/foo\nexit code: 0" };
      }

      return { success: true, output: "stdout:\n  HEAD branch: main\nexit code: 0" };
    });

    expect(result).toEqual({ safe: true, branch: "feature/foo" });
  });

  it("returns a protected-branch failure for main", async () => {
    const result = await checkBranchSafety("/repo", async (command) => {
      if (command === "git rev-parse --abbrev-ref HEAD") {
        return { success: true, output: "stdout:\nmain\nexit code: 0" };
      }

      return { success: true, output: "stdout:\n  HEAD branch: develop\nexit code: 0" };
    });

    expect(result.safe).toBe(false);
    expect(result.branch).toBe("main");
    expect(result.reason).toContain("Cannot run Conductor on protected branch 'main'.");
  });

  it("returns a protected-branch failure for master", async () => {
    const result = await checkBranchSafety("/repo", async (command) => {
      if (command === "git rev-parse --abbrev-ref HEAD") {
        return { success: true, output: "stdout:\nmaster\nexit code: 0" };
      }

      return { success: true, output: "stdout:\n  HEAD branch: main\nexit code: 0" };
    });

    expect(result.safe).toBe(false);
    expect(result.branch).toBe("master");
    expect(result.reason).toContain("protected branch 'master'");
  });

  it("returns a protected-branch failure when current branch matches origin default", async () => {
    const result = await checkBranchSafety("/repo", async (command) => {
      if (command === "git rev-parse --abbrev-ref HEAD") {
        return { success: true, output: "stdout:\ndevelop\nexit code: 0" };
      }

      return { success: true, output: "stdout:\n  HEAD branch: develop\nexit code: 0" };
    });

    expect(result.safe).toBe(false);
    expect(result.branch).toBe("develop");
    expect(result.reason).toContain("protected branch 'develop'");
  });

  it("allows a non-default branch even when the default branch is protected", async () => {
    const result = await checkBranchSafety("/repo", async (command) => {
      if (command === "git rev-parse --abbrev-ref HEAD") {
        return { success: true, output: "stdout:\ndevelop\nexit code: 0" };
      }

      return { success: true, output: "stdout:\n  HEAD branch: main\nexit code: 0" };
    });

    expect(result).toEqual({ safe: true, branch: "develop" });
  });

  it("skips default-branch detection when git remote show origin fails", async () => {
    const result = await checkBranchSafety("/repo", async (command) => {
      if (command === "git rev-parse --abbrev-ref HEAD") {
        return { success: true, output: "stdout:\ndevelop\nexit code: 0" };
      }

      return {
        success: false,
        output: "stderr:\nfatal: 'origin' does not appear to be a git repository\nexit code: 1",
        error: "command exited with code 1",
      };
    });

    expect(result).toEqual({ safe: true, branch: "develop" });
  });

  it("hard-stops the orchestrator before work starts on a protected branch", async () => {
    const harness = await createHarness({
      trustedExecuteResults: [
        { success: true, output: "stdout:\nmain\nexit code: 0" },
        { success: true, output: "stdout:\n  HEAD branch: main\nexit code: 0" },
      ],
      invocationScripts: {
        implementor: [{ response: "should not run" }],
        reviewer: [{ response: "PASS" }, { response: "PASS" }],
      },
    });

    await harness.run();

    const persistedState = await harness.loadPersistedState();
    const auditEntries = await readAudit(path.join(harness.workspaceDir, ".conductor"));

    expect(harness.invocationRecords).toHaveLength(0);
    expect(harness.testCommandCalls).toHaveLength(0);
    expect(harness.trustedCommandCalls).toEqual([
      "git rev-parse --abbrev-ref HEAD",
      "git remote show origin | grep 'HEAD branch'",
    ]);
    expect(persistedState.status).toBe("error");
    expect(auditEntries.some((entry) => entry.promptSummary.includes("Cannot run Conductor on protected branch 'main'."))).toBe(true);
  });

  it("commits and pushes .conductor after a bugfix commit checkpoint", async () => {
    const harness = await createHarness({
      initialState: {
        conventionsSkill: "",
        currentItemIndex: 1,
        consecutivePasses: { A1: 2 },
        itemStatuses: { A1: "pass" },
        prReviewStep: "spec-aware",
        prReviewConsecutivePasses: 0,
        status: "idle",
      },
      invocationScripts: {
        implementor: [{ response: "fixed finding" }],
        "pr-reviewer": [
          { response: `FAIL${JSON.stringify([{ file: "src/foo.ts", line: 10, description: "Fix the edge case" }])}` },
          { response: "PASS" },
          { response: "PASS" },
          { response: "PASS" },
          { response: "PASS" },
        ],
      },
    });

    await harness.run();

    const bugfixCommitIndex = harness.trustedCommandCalls.indexOf("git commit -m 'Fix PR review findings'");
    const bugfixPushIndex = harness.trustedCommandCalls.findIndex(
      (command, index) => command === "git push" && index > bugfixCommitIndex,
    );
    const checkpointAddIndex = harness.trustedCommandCalls.findIndex(
      (command, index) => command === "git add .conductor/" && index > bugfixPushIndex,
    );
    const checkpointCommitIndex = harness.trustedCommandCalls.findIndex(
      (command, index) => command === "git commit -m 'conductor: update state'" && index > checkpointAddIndex,
    );
    const checkpointPushIndex = harness.trustedCommandCalls.findIndex(
      (command, index) => command === "git push" && index > checkpointCommitIndex,
    );

    expect(bugfixCommitIndex).toBeGreaterThanOrEqual(0);
    expect(bugfixPushIndex).toBeGreaterThan(bugfixCommitIndex);
    expect(checkpointAddIndex).toBeGreaterThan(bugfixPushIndex);
    expect(checkpointCommitIndex).toBeGreaterThan(checkpointAddIndex);
    expect(checkpointPushIndex).toBeGreaterThan(checkpointCommitIndex);
  });

  it("progresses a bugfix through fixing reviewing and approving before requesting approval", async () => {
    const harness = await createHarness({
      specDirName: "bugs1",
      createSpec: false,
      createPrompt: true,
      promptContent: "The parser crashes on empty input.",
      directRequestResponses: {
        "spec-author": [JSON.stringify([
          { title: "Parser crash", description: "Empty input triggers a null dereference." },
        ])],
      },
      invocationScripts: {
        implementor: [{ response: "implemented bug fix" }],
        reviewer: [{ response: "PASS" }],
      },
      initialState: {
        status: "idle",
        specStep: "clarifying",
        conventionsSkill: "",
      },
    });

    const snapshots = captureStateSnapshots(harness);
    const runPromise = harness.run();

    await waitFor(() => {
      const state = harness.orchestrator.getState();
      return state.status === "pending-approval" && state.bugStep === "approving";
    });

    const persistedState = await harness.loadPersistedState();

    expect(harness.directRequestRecords).toHaveLength(1);
    expect(harness.directRequestRecords[0]).toMatchObject({
      role: "spec-author",
      modelFamily: "gpt-4.1",
    });
    expect(harness.directRequestRecords[0]?.messages[0]?.content).toContain("Do not call tools.");
    expect(harness.directRequestRecords[0]?.messages[1]?.content).toContain("parser crashes on empty input");
    expect(harness.invocationRecords.map((record) => record.role)).toEqual(["implementor", "reviewer"]);
    expect(harness.invocationRecords[0]?.userPrompt).toContain("failing regression test");
    expect(harness.invocationRecords[0]?.userPrompt).toContain("Issue title: Parser crash");
    expect(persistedState.bugIssues).toEqual([
      { title: "Parser crash", description: "Empty input triggers a null dereference." },
    ]);
    expect(persistedState.bugIndex).toBe(0);
    expect(persistedState.bugFixCycle).toBe(1);
    expect(persistedState.bugStep).toBe("approving");
    expect(persistedState.status).toBe("pending-approval");
    expect(snapshots.some((snapshot) => snapshot.bugStep === "fixing")).toBe(true);
    expect(snapshots.some((snapshot) => snapshot.bugStep === "reviewing")).toBe(true);
    expect(snapshots.some((snapshot) => snapshot.bugStep === "approving" && snapshot.status === "pending-approval")).toBe(true);

    harness.orchestrator.approve("bugfix");
    await runPromise;
  });

  it("re-invokes implementor with reviewer feedback and increments bugFixCycle", async () => {
    const harness = await createHarness({
      specDirName: "bugs1",
      createSpec: false,
      createPrompt: true,
      promptContent: "The parser crashes on empty input.",
      directRequestResponses: {
        "spec-author": [JSON.stringify([
          { title: "Parser crash", description: "Empty input triggers a null dereference." },
        ])],
      },
      invocationScripts: {
        implementor: [{ response: "first fix" }, { response: "second fix" }],
        reviewer: [{ response: "FAIL add a focused regression test" }, { response: "PASS" }],
      },
      initialState: {
        status: "idle",
        specStep: "clarifying",
        conventionsSkill: "",
      },
    });

    const runPromise = harness.run();

    await waitFor(() => {
      const state = harness.orchestrator.getState();
      return state.status === "pending-approval" && state.bugFixCycle === 2;
    });

    const persistedState = await harness.loadPersistedState();

    expect(harness.invocationRecords.map((record) => record.role)).toEqual([
      "implementor",
      "reviewer",
      "implementor",
      "reviewer",
    ]);
    expect(harness.invocationRecords[2]?.userPrompt).toContain("FAIL add a focused regression test");
    expect(persistedState.bugFixCycle).toBe(2);
    expect(persistedState.bugStep).toBe("approving");

    harness.orchestrator.approve("bugfix");
    await runPromise;
  });

  it("marks a bug failed after 5 failed review cycles and advances to the next bug", async () => {
    const harness = await createHarness({
      specDirName: "bugs1",
      createSpec: false,
      createPrompt: true,
      promptContent: "Multiple regressions are present.",
      directRequestResponses: {
        "spec-author": [JSON.stringify([
          { title: "Parser crash", description: "Empty input triggers a null dereference." },
          { title: "Line counter", description: "EOF reports one extra line." },
        ])],
      },
      invocationScripts: {
        implementor: [
          { response: "fix cycle 1" },
          { response: "fix cycle 2" },
          { response: "fix cycle 3" },
          { response: "fix cycle 4" },
          { response: "fix cycle 5" },
          { response: "second bug fix" },
        ],
        reviewer: [
          { response: "FAIL still broken 1" },
          { response: "FAIL still broken 2" },
          { response: "FAIL still broken 3" },
          { response: "FAIL still broken 4" },
          { response: "FAIL still broken 5" },
          { response: "PASS" },
        ],
      },
      initialState: {
        status: "idle",
        specStep: "clarifying",
        conventionsSkill: "",
      },
    });

    const runPromise = harness.run();

    await waitFor(() => {
      const state = harness.orchestrator.getState();
      return state.status === "pending-approval" && state.bugIndex === 1;
    });

    const persistedState = await harness.loadPersistedState();
    const auditEntries = await readAudit(path.join(harness.workspaceDir, ".conductor"));

    expect(harness.invocationRecords.filter((record) => record.role === "implementor")).toHaveLength(6);
    expect(harness.invocationRecords.filter((record) => record.role === "reviewer")).toHaveLength(6);
    expect(persistedState.bugIndex).toBe(1);
    expect(persistedState.bugFixCycle).toBe(1);
    expect(auditEntries.some((entry) => entry.itemId === "bugfix:1" && entry.result === "FAIL")).toBe(true);

    harness.orchestrator.approve("bugfix:2");
    await runPromise;
  });

  it("creates a short imperative bugfix commit and pushes after approval", async () => {
    const harness = await createHarness({
      specDirName: "bugs1",
      createSpec: false,
      createPrompt: true,
      promptContent: "The parser crashes on empty input.",
      directRequestResponses: {
        "spec-author": [JSON.stringify([
          { title: "Parser crash", description: "Empty input triggers a null dereference." },
        ])],
      },
      invocationScripts: {
        implementor: [{ response: "implemented bug fix" }],
        reviewer: [{ response: "PASS" }],
      },
      initialState: {
        status: "idle",
        specStep: "clarifying",
        conventionsSkill: "",
      },
    });

    const runPromise = harness.run();
    await waitFor(() => harness.orchestrator.getState().status === "pending-approval");

    harness.orchestrator.approve("bugfix");
    await runPromise;

    const addCommand = harness.trustedCommandCalls.find((command) => command.startsWith("git add -- "));
    const commitCommand = harness.trustedCommandCalls.find((command) => command.startsWith("git commit -m "));
    const commitIndex = harness.trustedCommandCalls.indexOf(String(commitCommand));
    const pushIndex = harness.trustedCommandCalls.findIndex((command, index) => command === "git push" && index > commitIndex);

    expect(addCommand).toBe("git add -- 'src/foo.ts' 'test/foo.test.ts'");
    expect(commitCommand).toBe("git commit -m 'Fix Parser crash'");
    expect("Fix Parser crash".length).toBeLessThanOrEqual(72);
    expect(pushIndex).toBeGreaterThan(commitIndex);
  });

  it("returns to fixing with appended human feedback when approval requests changes", async () => {
    const harness = await createHarness({
      specDirName: "bugs1",
      createSpec: false,
      createPrompt: true,
      promptContent: "The websocket reconnect path is unreliable.",
      directRequestResponses: {
        "spec-author": [JSON.stringify([
          { title: "Reconnect websocket", description: "Reconnect leaves stale listeners behind." },
        ])],
      },
      invocationScripts: {
        implementor: [{ response: "first fix" }, { response: "second fix" }],
        reviewer: [{ response: "PASS" }, { response: "PASS" }],
      },
      initialState: {
        status: "idle",
        specStep: "clarifying",
        conventionsSkill: "",
      },
    });

    const runPromise = harness.run();
    await waitFor(() => harness.orchestrator.getState().status === "pending-approval");

    harness.orchestrator.reject("bugfix", "Add coverage for the reconnect path.");

    await waitFor(() => harness.invocationRecords.filter((record) => record.role === "implementor").length === 2);
    expect(harness.invocationRecords[2]?.userPrompt).toContain("Add coverage for the reconnect path.");

    await waitFor(() => harness.orchestrator.getState().status === "pending-approval");
    harness.orchestrator.approve("bugfix");
    await runPromise;
  });

  it("creates separate commits for three approved bugs and finishes with bugStep done", async () => {
    const harness = await createHarness({
      specDirName: "bugs1",
      createSpec: false,
      createPrompt: true,
      promptContent: "Three unrelated regressions are present.",
      directRequestResponses: {
        "spec-author": [JSON.stringify([
          { title: "Parser crash", description: "Empty input triggers a null dereference." },
          { title: "Line counter", description: "EOF reports one extra line." },
          { title: "Socket leak", description: "Reconnect leaks websocket listeners." },
        ])],
      },
      invocationScripts: {
        implementor: [
          { response: "fix parser crash" },
          { response: "fix line counter" },
          { response: "fix socket leak" },
        ],
        reviewer: [{ response: "PASS" }, { response: "PASS" }, { response: "PASS" }],
      },
      initialState: {
        status: "idle",
        specStep: "clarifying",
        conventionsSkill: "",
      },
    });

    const runPromise = harness.run();

    await waitFor(() => harness.orchestrator.getState().status === "pending-approval" && harness.orchestrator.getState().bugIndex === 0);
    harness.orchestrator.approve("bugfix:1");
    await waitFor(() => harness.orchestrator.getState().status === "pending-approval" && harness.orchestrator.getState().bugIndex === 1);
    harness.orchestrator.approve("bugfix:2");
    await waitFor(() => harness.orchestrator.getState().status === "pending-approval" && harness.orchestrator.getState().bugIndex === 2);
    harness.orchestrator.approve("bugfix:3");
    await runPromise;

    expect(harness.trustedCommandCalls.filter((command) => command.startsWith("git commit -m "))).toEqual([
      "git commit -m 'Fix Parser crash'",
      "git commit -m 'Fix Line counter'",
      "git commit -m 'Fix Socket leak'",
    ]);
    expect(harness.orchestrator.getState().bugStep).toBe("done");
    expect(harness.orchestrator.getState().status).toBe("done");
  });

  it("records audit entries and transcripts for bugfix implementor and reviewer invocations", async () => {
    const harness = await createHarness({
      specDirName: "bugs1",
      createSpec: false,
      createPrompt: true,
      promptContent: "The parser crashes on empty input.",
      directRequestResponses: {
        "spec-author": [JSON.stringify([
          { title: "Parser crash", description: "Empty input triggers a null dereference." },
        ])],
      },
      invocationScripts: {
        implementor: [{ response: "implemented bug fix" }],
        reviewer: [{ response: "PASS" }],
      },
      initialState: {
        status: "idle",
        specStep: "clarifying",
        conventionsSkill: "",
      },
      persistTranscripts: true,
    });

    const runPromise = harness.run();
    await waitFor(() => harness.orchestrator.getState().status === "pending-approval");

    const auditEntries = await readAudit(path.join(harness.workspaceDir, ".conductor"));
    const transcripts = await harness.orchestrator.getTranscripts();

    expect(auditEntries.some((entry) => entry.role === "implementor" && entry.itemId === "bugfix:1:fix:1")).toBe(true);
    expect(auditEntries.some((entry) => entry.role === "reviewer" && entry.itemId === "bugfix:1:review:1")).toBe(true);
    expect(transcripts.some((entry) => entry.role === "implementor" && entry.itemId === "bugfix:1:fix:1")).toBe(true);
    expect(transcripts.some((entry) => entry.role === "reviewer" && entry.itemId === "bugfix:1:review:1")).toBe(true);

    harness.orchestrator.approve("bugfix");
    await runPromise;
  });

  it("persists reviewing bug state on pause and resumes from that state", async () => {
    let releaseReviewer!: () => void;
    const waitForReviewer = new Promise<void>((resolve) => {
      releaseReviewer = resolve;
    });
    const harness = await createHarness({
      specDirName: "bugs1",
      createSpec: false,
      createPrompt: true,
      promptContent: "The parser crashes on empty input.",
      directRequestResponses: {
        "spec-author": [JSON.stringify([
          { title: "Parser crash", description: "Empty input triggers a null dereference." },
        ])],
      },
      invocationScripts: {
        implementor: [{ response: "implemented bug fix" }],
        reviewer: [{ response: "PASS", waitFor: waitForReviewer }, { response: "PASS" }],
      },
      initialState: {
        status: "idle",
        specStep: "clarifying",
        conventionsSkill: "",
      },
    });

    const runPromise = harness.run();

    await waitFor(() => harness.invocationRecords.filter((record) => record.role === "reviewer").length === 1);
    await waitFor(() => harness.orchestrator.getState().bugStep === "reviewing");

    harness.orchestrator.pause();
    const persistedState = await waitForValue(async () => {
      const state = await harness.loadPersistedState();
      return state.status === "paused" ? state : undefined;
    });

    expect(persistedState.bugStep).toBe("reviewing");
    expect(persistedState.bugIndex).toBe(0);
    expect(persistedState.bugFixCycle).toBe(1);

    releaseReviewer();
    await runPromise;

    harness.orchestrator.resume();
    await waitFor(() => harness.orchestrator.getState().status === "pending-approval");
    expect(harness.invocationRecords.filter((record) => record.role === "reviewer")).toHaveLength(2);

    harness.orchestrator.approve("bugfix");
    await waitFor(() => harness.orchestrator.getState().status === "done");
  });

  it("emits bugfix status through state updates while approval is pending", async () => {
    const harness = await createHarness({
      specDirName: "bugs1",
      createSpec: false,
      createPrompt: true,
      promptContent: "The parser crashes on empty input.",
      directRequestResponses: {
        "spec-author": [JSON.stringify([
          { title: "Parser crash", description: "Empty input triggers a null dereference." },
        ])],
      },
      invocationScripts: {
        implementor: [{ response: "implemented bug fix" }],
        reviewer: [{ response: "PASS" }],
      },
      initialState: {
        status: "idle",
        specStep: "clarifying",
        conventionsSkill: "",
      },
    });

    const snapshots = captureStateSnapshots(harness);
    const runPromise = harness.run();

    await waitFor(() => harness.orchestrator.getState().status === "pending-approval");

    expect(snapshots.some((snapshot) => {
      return snapshot.status === "pending-approval"
        && snapshot.bugStep === "approving"
        && snapshot.bugIndex === 0
        && snapshot.bugFixCycle === 1
        && snapshot.bugIssues?.length === 1;
    })).toBe(true);

    harness.orchestrator.approve("bugfix");
    await runPromise;
  });

  it("emits a done bugfix status through state updates after all bugs complete", async () => {
    const harness = await createHarness({
      specDirName: "bugs1",
      createSpec: false,
      createPrompt: true,
      promptContent: "The parser crashes on empty input.",
      directRequestResponses: {
        "spec-author": [JSON.stringify([
          { title: "Parser crash", description: "Empty input triggers a null dereference." },
        ])],
      },
      invocationScripts: {
        implementor: [{ response: "implemented bug fix" }],
        reviewer: [{ response: "PASS" }],
      },
      initialState: {
        status: "idle",
        specStep: "clarifying",
        conventionsSkill: "",
      },
    });

    const snapshots = captureStateSnapshots(harness);
    const runPromise = harness.run();

    await waitFor(() => harness.orchestrator.getState().status === "pending-approval");
    harness.orchestrator.approve("bugfix");
    await runPromise;

    expect(snapshots.some((snapshot) => {
      return snapshot.status === "done"
        && snapshot.bugStep === "done"
        && snapshot.bugIndex === 1
        && snapshot.bugIssues?.length === 1;
    })).toBe(true);
  });

  it("starts in clarifying mode from prompt.md and invokes the clarification prompt", async () => {
    const promptContent = [
      "# Prompt",
      "",
      "Add the requested orchestration feature.",
      "",
      "Keep the repository architecture intact.",
    ].join("\n");
    const harness = await createHarness({
      createSpec: false,
      createPrompt: true,
      promptContent,
      phaseContent: ["# Phase 1: Empty", ""].join("\n"),
      invocationScripts: {
        "spec-author": [{ response: "NONE" }, { response: "PASS" }],
        "spec-reviewer": [{ response: "PASS" }, { response: "PASS" }],
        "spec-proofreader": [{ response: "PASS" }, { response: "PASS" }],
        "phase-creator": [{ response: "PASS" }],
        "phase-reviewer": [{ response: "PASS" }],
      },
    });

    await harness.run();

    expect(harness.invocationRecords[0]?.role).toBe("spec-author");
    expect(harness.invocationRecords[0]?.systemPrompt).toContain("# Tool Definitions");
    expect(harness.invocationRecords[0]?.systemPrompt).toContain("Read prompt.md. Research the codebase to understand what exists.");
    expect(harness.invocationRecords[0]?.userPrompt).toContain("Add the requested orchestration feature.");
    expect(harness.orchestrator.getState().specStep).toBe("done");
  });

  it("commits and pushes .conductor when spec authoring completes", async () => {
    let releaseReviewer!: () => void;
    const waitForReviewer = new Promise<void>((resolve) => {
      releaseReviewer = resolve;
    });
    const harness = await createHarness({
      createSpec: false,
      createPrompt: true,
      initialState: {
        conventionsSkill: "",
        specStep: "authoring",
      },
      phaseContent: ["# Phase 1: Empty", ""].join("\n"),
      invocationScripts: {
        "spec-author": [{ response: "PASS" }],
        "spec-reviewer": [{ response: "PASS", waitFor: waitForReviewer }],
      },
    });

    const runPromise = harness.run();
    await waitFor(() => harness.invocationRecords.filter((record) => record.role === "spec-reviewer").length === 1);

    const stateAddIndex = harness.trustedCommandCalls.indexOf("git add .conductor/");
    const stateCommitIndex = harness.trustedCommandCalls.indexOf("git commit -m 'conductor: update state'");
    const statePushIndex = harness.trustedCommandCalls.findIndex((command, index) => command === "git push" && index > stateCommitIndex);

    expect(stateAddIndex).toBeGreaterThanOrEqual(0);
    expect(stateCommitIndex).toBeGreaterThan(stateAddIndex);
    expect(statePushIndex).toBeGreaterThan(stateCommitIndex);
    expect(harness.trustedCommandCalls.filter((command) => command === "git commit -m 'conductor: update state'")).toHaveLength(1);

    harness.orchestrator.pause();
    releaseReviewer();
    await runPromise;
  });

  it("stages spec.md and phase*.md and commits them with the spec-writing message when spec-writing completes", async () => {
    const harness = await createHarness({
      initialState: {
        conventionsSkill: "",
        specStep: "reviewing-phases",
        specPhaseFileIndex: 0,
      },
      invocationScripts: {
        "phase-reviewer": [{ response: "PASS" }],
        implementor: [{ response: "implemented" }],
        reviewer: [{ response: "PASS" }, { response: "PASS" }],
        "pr-reviewer": [{ response: "PASS" }, { response: "PASS" }, { response: "PASS" }, { response: "PASS" }],
      },
    });

    const expectedSpecDir = path.relative(harness.workspaceDir, path.join(harness.config.docsDir, "conductor")).split(path.sep).join("/");
    const expectedAddCommand = `git add -- '${expectedSpecDir}/spec.md' ':(glob)${expectedSpecDir}/phase*.md'`;

    await harness.run();

    const addIndex = harness.trustedCommandCalls.indexOf(expectedAddCommand);
    const commitIndex = harness.trustedCommandCalls.indexOf("git commit -m 'conductor: write spec'");

    expect(addIndex).toBeGreaterThanOrEqual(0);
    expect(commitIndex).toBeGreaterThan(addIndex);
  });

  it("pushes after the spec-writing commit succeeds", async () => {
    const harness = await createHarness({
      initialState: {
        conventionsSkill: "",
        specStep: "reviewing-phases",
        specPhaseFileIndex: 0,
      },
      invocationScripts: {
        "phase-reviewer": [{ response: "PASS" }],
        implementor: [{ response: "implemented" }],
        reviewer: [{ response: "PASS" }, { response: "PASS" }],
        "pr-reviewer": [{ response: "PASS" }, { response: "PASS" }, { response: "PASS" }, { response: "PASS" }],
      },
    });

    await harness.run();

    const commitIndex = harness.trustedCommandCalls.indexOf("git commit -m 'conductor: write spec'");
    const pushIndex = harness.trustedCommandCalls.findIndex((command, index) => command === "git push" && index > commitIndex);

    expect(commitIndex).toBeGreaterThanOrEqual(0);
    expect(pushIndex).toBeGreaterThan(commitIndex);
  });

  it("uses the spec-author model for clarification while auditing the invocation as clarifier", async () => {
    const harness = await createHarness({
      createSpec: false,
      createPrompt: true,
      phaseContent: ["# Phase 1: Empty", ""].join("\n"),
      persistTranscripts: true,
      invocationScripts: {
        "spec-author": [{ response: "NONE" }, { response: "PASS" }],
        "spec-reviewer": [{ response: "PASS" }, { response: "PASS" }],
        "spec-proofreader": [{ response: "PASS" }, { response: "PASS" }],
        "phase-creator": [{ response: "PASS" }],
        "phase-reviewer": [{ response: "PASS" }],
      },
    });

    await harness.run();

    const auditEntries = await readAudit(path.join(harness.workspaceDir, ".conductor"));
    const transcripts = await harness.orchestrator.getTranscripts();
    const clarificationAudit = auditEntries.find((entry) => entry.itemId === "phase0:clarifying");
    const clarificationTranscript = transcripts.find((entry) => entry.itemId === "phase0:clarifying");

    expect(harness.selectCalls[0]).toMatchObject({ role: "spec-author", family: "gpt-4.1" });
    expect(clarificationAudit).toMatchObject({
      role: "clarifier",
      model: "clarifier:gpt-4.1",
      itemId: "phase0:clarifying",
    });
    expect(clarificationTranscript).toMatchObject({
      role: "clarifier",
      model: "clarifier:gpt-4.1",
      itemId: "phase0:clarifying",
    });
  });

  it("stores parsed clarification questions and pauses for user answers", async () => {
    const harness = await createHarness({
      createSpec: false,
      createPrompt: true,
      phaseContent: ["# Phase 1: Empty", ""].join("\n"),
      invocationScripts: {
        "spec-author": [{ response: JSON.stringify([
          { question: "Which API should this extend?", suggestedOptions: ["REST", "GraphQL"] },
          { question: "Should this include UI work?", suggestedOptions: ["yes", "no"] },
          { question: "What is out of scope?", suggestedOptions: ["migration", "none"] },
        ]) }],
      },
    });

    await harness.run();

    expect(harness.orchestrator.getState().status).toBe("paused");
    expect(harness.orchestrator.getState().specStep).toBe("clarifying");
    expect(harness.orchestrator.getState().clarificationQuestions).toHaveLength(3);
    expect(harness.orchestrator.getState().clarificationQuestions[0]).toMatchObject({
      question: "Which API should this extend?",
      suggestedOptions: ["REST", "GraphQL"],
    });
  });

  it("appends submitted clarification answers under notes, clears questions, and re-invokes clarification with the updated prompt", async () => {
    const harness = await createHarness({
      createSpec: false,
      createPrompt: true,
      promptContent: [
        "# Prompt",
        "",
        "Build the orchestration layer.",
        "",
        "## Notes",
        "",
        "- `Existing note: keep extension settings stable.`",
        "",
      ].join("\n"),
      phaseContent: ["# Phase 1: Empty", ""].join("\n"),
      invocationScripts: {
        "spec-author": [
          { response: JSON.stringify([
            { question: "Which transport should be supported?", suggestedOptions: ["webview", "server"] },
            { question: "Should this include UI work?", suggestedOptions: ["yes", "no"] },
          ]) },
          { response: "NONE" },
          { response: "PASS" },
        ],
        "spec-reviewer": [{ response: "PASS" }, { response: "PASS" }],
        "spec-proofreader": [{ response: "PASS" }, { response: "PASS" }],
        "phase-creator": [{ response: "PASS" }],
        "phase-reviewer": [{ response: "PASS" }],
      },
    });

    await harness.run();

    harness.submitClarification([
      { question: "Which transport should be supported?", answer: "webview only for this item" },
      { question: "Should this include UI work?", answer: "no, keep UI for a later item" },
    ]);

    await waitFor(() => harness.orchestrator.getState().specStep === "done");

    const updatedPrompt = await harness.readPromptFile();
    const clarificationCalls = harness.invocationRecords.filter((record) => record.role === "spec-author");

    expect(updatedPrompt).toContain("## Notes");
    expect(updatedPrompt).toContain("Existing note: keep extension settings stable.");
    expect(updatedPrompt).toContain("Clarification: Which transport should be supported? => webview only for this item");
    expect(updatedPrompt).toContain("Clarification: Should this include UI work? => no, keep UI for a later item");
    expect(harness.orchestrator.getState().clarificationQuestions).toHaveLength(0);
    expect(clarificationCalls[1]?.userPrompt).toContain("Clarification: Which transport should be supported? => webview only for this item");
  });

  it("creates a notes section when clarification answers are submitted to a prompt without notes", async () => {
    const harness = await createHarness({
      createSpec: false,
      createPrompt: true,
      promptContent: ["# Prompt", "", "Capture the requirements.", ""].join("\n"),
      phaseContent: ["# Phase 1: Empty", ""].join("\n"),
      invocationScripts: {
        "spec-author": [
          {
            response: JSON.stringify([
              { question: "What should the first draft cover?", suggestedOptions: ["scope", "tests"] },
            ]),
          },
          { response: "NONE" },
          { response: "PASS" },
        ],
        "spec-reviewer": [{ response: "PASS" }, { response: "PASS" }],
        "spec-proofreader": [{ response: "PASS" }, { response: "PASS" }],
        "phase-creator": [{ response: "PASS" }],
        "phase-reviewer": [{ response: "PASS" }],
      },
    });

    await harness.run();
    harness.submitClarification([
      { question: "What should the first draft cover?", answer: "scope only" },
    ]);

    await waitFor(() => harness.orchestrator.getState().specStep === "done");

    const updatedPrompt = await harness.readPromptFile();
    expect(updatedPrompt).toContain("## Notes");
    expect(updatedPrompt).toContain("Clarification: What should the first draft cover? => scope only");
  });

  it("treats malformed clarification JSON as NONE and proceeds without an approval pause", async () => {
    const harness = await createHarness({
      createSpec: false,
      createPrompt: true,
      phaseContent: ["# Phase 1: Empty", ""].join("\n"),
      invocationScripts: {
        "spec-author": [{ response: "{not valid json" }, { response: "PASS" }],
        "spec-reviewer": [{ response: "PASS" }, { response: "PASS" }],
        "spec-proofreader": [{ response: "PASS" }, { response: "PASS" }],
        "phase-creator": [{ response: "PASS" }],
        "phase-reviewer": [{ response: "PASS" }],
      },
    });
    harness.config.requireApproval = true;

    const runPromise = harness.run();
    await waitFor(() => harness.invocationRecords.some((record) => record.role === "spec-reviewer"));
    await waitFor(() => harness.orchestrator.getState().status === "pending-approval" && harness.orchestrator.getState().specStep === "reviewing");
    harness.orchestrator.skip("spec-review");
    await runPromise;

    expect(harness.orchestrator.getState().clarificationQuestions).toHaveLength(0);
    expect(harness.invocationRecords.filter((record) => record.role === "spec-author")).toHaveLength(2);
    expect(harness.invocationRecords.some((record) => record.role === "spec-reviewer")).toBe(true);
  });

  it("restores pending clarification questions across pause and resume without re-asking them", async () => {
    const harness = await createHarness({
      createSpec: false,
      createPrompt: true,
      phaseContent: ["# Phase 1: Empty", ""].join("\n"),
      invocationScripts: {
        "spec-author": [{ response: JSON.stringify([
          { question: "Which runtime should own this?", suggestedOptions: ["extension", "server"] },
        ]) }],
      },
    });

    await harness.run();

    const pausedState = await waitForValue(async () => {
      try {
        const persistedState = await harness.loadPersistedState();
        return persistedState.clarificationQuestions.length === 1 ? persistedState : undefined;
      } catch {
        return undefined;
      }
    });

    harness.orchestrator.resume();

    const resumedState = await waitForValue(async () => {
      try {
        const persistedState = await harness.loadPersistedState();
        return persistedState.status === "paused" && persistedState.clarificationQuestions.length === 1
          ? persistedState
          : undefined;
      } catch {
        return undefined;
      }
    });

    expect(pausedState.clarificationQuestions).toHaveLength(1);
    expect(resumedState.clarificationQuestions).toHaveLength(1);
    expect(harness.invocationRecords.filter((record) => record.role === "spec-author")).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it("fails clarification after exhausting retries on invocation errors", async () => {
    const harness = await createHarness({
      createSpec: false,
      createPrompt: true,
      phaseContent: ["# Phase 1: Empty", ""].join("\n"),
      invocationScripts: {
        "spec-author": [
          { response: "unused", error: new Error("tool error") },
          { response: "unused", error: new Error("tool error") },
        ],
      },
    });

    await harness.run();

    expect(harness.orchestrator.getState().status).toBe("error");
    expect(harness.orchestrator.getState().specStep).toBe("clarifying");
  });

  it("skips phase 0 when spec.md already exists and proceeds directly to implementation", async () => {
    const harness = await createHarness({
      createPrompt: true,
      invocationScripts: {
        implementor: [{ response: "implemented" }],
        reviewer: [{ response: "PASS" }, { response: "PASS" }],
      },
    });

    await harness.run();

    expect(harness.orchestrator.getState().specStep).toBe("done");
    expect(harness.invocationRecords[0]?.role).toBe("implementor");
  });

  it("errors when neither spec.md nor prompt.md exists", async () => {
    const harness = await createHarness({
      createSpec: false,
      createPrompt: false,
      phaseContent: ["# Phase 1: Empty", ""].join("\n"),
    });

    await harness.run();

    expect(harness.orchestrator.getState().status).toBe("error");
    expect(harness.invocationRecords).toHaveLength(0);
  });

  it("moves from clarification to authoring and reviewing with prompt.md content in the reviewer prompt", async () => {
    const promptContent = ["# Prompt", "", "Need a stronger spec review loop.", ""].join("\n");
    const harness = await createHarness({
      createSpec: false,
      createPrompt: true,
      promptContent,
      phaseContent: ["# Phase 1: Empty", ""].join("\n"),
      invocationScripts: {
        "spec-author": [{ response: "NONE" }, { response: "PASS" }],
        "spec-reviewer": [{ response: "PASS" }, { response: "PASS" }],
        "spec-proofreader": [{ response: "PASS" }, { response: "PASS" }],
        "phase-creator": [{ response: "PASS" }],
        "phase-reviewer": [{ response: "PASS" }],
      },
    });

    await harness.run();

    const reviewerCall = harness.invocationRecords.find((record) => record.role === "spec-reviewer");
    expect(reviewerCall?.userPrompt).toContain("Need a stronger spec review loop.");
  });

  it("requires two spec review PASSes before proofreading and excludes prompt.md contents from proofreading prompts", async () => {
    const promptContent = ["# Prompt", "", "This text should not appear in proofreading.", ""].join("\n");
    const harness = await createHarness({
      createSpec: false,
      createPrompt: true,
      promptContent,
      phaseContent: ["# Phase 1: Empty", ""].join("\n"),
      invocationScripts: {
        "spec-author": [{ response: "NONE" }, { response: "PASS" }],
        "spec-reviewer": [{ response: "PASS" }, { response: "PASS" }],
        "spec-proofreader": [{ response: "PASS" }, { response: "PASS" }],
        "phase-creator": [{ response: "PASS" }],
        "phase-reviewer": [{ response: "PASS" }],
      },
    });

    await harness.run();

    expect(harness.invocationRecords.filter((record) => record.role === "spec-reviewer")).toHaveLength(2);
    const proofreaderCall = harness.invocationRecords.find((record) => record.role === "spec-proofreader");
    expect(proofreaderCall?.userPrompt).toContain(`${path.join(harness.config.docsDir, "conductor")}/spec.md`);
    expect(proofreaderCall?.userPrompt).not.toContain("This text should not appear in proofreading.");
  });

  it("advances phase review by file index and retries the same phase file after FIXED", async () => {
    const harness = await createHarness({
      phaseFiles: {
        1: ["# Phase 1: Empty", ""].join("\n"),
        2: ["# Phase 2: Empty", ""].join("\n"),
      },
      initialState: {
        status: "paused",
        specStep: "reviewing-phases",
        specPhaseFileIndex: 0,
      },
      invocationScripts: {
        "phase-reviewer": [{ response: "FIXED" }, { response: "PASS" }, { response: "PASS" }],
      },
    });

    await harness.run();
    harness.orchestrator.resume();
    await waitFor(() => harness.orchestrator.getState().specStep === "done");

    const phaseReviewerCalls = harness.invocationRecords.filter((record) => record.role === "phase-reviewer");
    expect(phaseReviewerCalls).toHaveLength(3);
    expect(phaseReviewerCalls[0]?.userPrompt).toContain("phase1.md");
    expect(phaseReviewerCalls[1]?.userPrompt).toContain("phase1.md");
    expect(phaseReviewerCalls[2]?.userPrompt).toContain("phase2.md");
    expect(harness.orchestrator.getState().specPhaseFileIndex).toBe(2);
  });

  it("routes failed phase review feedback back through phase creation before retrying review", async () => {
    const harness = await createHarness({
      phaseFiles: {
        1: ["# Phase 1: Empty", ""].join("\n"),
        2: ["# Phase 2: Empty", ""].join("\n"),
      },
      initialState: {
        status: "paused",
        specStep: "reviewing-phases",
        specPhaseFileIndex: 0,
      },
      invocationScripts: {
        "phase-reviewer": [{ response: "FAIL tighten phase scope" }, { response: "PASS" }, { response: "PASS" }],
        "phase-creator": [{ response: "PASS" }],
      },
    });

    await harness.run();
    harness.orchestrator.resume();
    await waitFor(() => harness.orchestrator.getState().specStep === "done");

    const phaseCreatorCalls = harness.invocationRecords.filter((record) => record.role === "phase-creator");
    const phaseReviewerCalls = harness.invocationRecords.filter((record) => record.role === "phase-reviewer");

    expect(phaseCreatorCalls).toHaveLength(1);
    expect(phaseCreatorCalls[0]?.userPrompt).toContain("Feedback:\nFAIL tighten phase scope");
    expect(phaseReviewerCalls).toHaveLength(3);
    expect(phaseReviewerCalls[0]?.userPrompt).toContain("phase1.md");
    expect(phaseReviewerCalls[1]?.userPrompt).toContain("phase1.md");
    expect(phaseReviewerCalls[2]?.userPrompt).toContain("phase2.md");
  });

  it("waits for approval after spec review and resumes into proofreading when approved", async () => {
    const harness = await createHarness({
      createSpec: false,
      createPrompt: true,
      phaseContent: ["# Phase 1: Empty", ""].join("\n"),
      invocationScripts: {
        "spec-author": [{ response: "NONE" }, { response: "PASS" }],
        "spec-reviewer": [{ response: "PASS" }, { response: "PASS" }],
        "spec-proofreader": [{ response: "PASS" }, { response: "PASS" }],
        "phase-creator": [{ response: "PASS" }],
        "phase-reviewer": [{ response: "PASS" }],
      },
    });
    harness.config.requireApproval = true;

    const runPromise = harness.run();
    await waitFor(() => harness.orchestrator.getState().status === "pending-approval");
    expect(harness.orchestrator.getState().specStep).toBe("reviewing");
    harness.orchestrator.approve("spec-review");
    await waitFor(() => harness.invocationRecords.some((record) => record.role === "spec-proofreader"));
    await waitFor(() => harness.orchestrator.getState().status === "pending-approval" && harness.orchestrator.getState().specStep === "proofreading");
    harness.orchestrator.skip("spec-proofreading");
    await runPromise;
  });

  it("re-enters authoring with rejection feedback after spec review approval is rejected", async () => {
    const harness = await createHarness({
      createSpec: false,
      createPrompt: true,
      phaseContent: ["# Phase 1: Empty", ""].join("\n"),
      invocationScripts: {
        "spec-author": [{ response: "NONE" }, { response: "PASS" }, { response: "PASS" }],
        "spec-reviewer": [{ response: "PASS" }, { response: "PASS" }, { response: "PASS" }, { response: "PASS" }],
        "spec-proofreader": [{ response: "PASS" }, { response: "PASS" }],
        "phase-creator": [{ response: "PASS" }],
        "phase-reviewer": [{ response: "PASS" }],
      },
    });
    harness.config.requireApproval = true;

    const runPromise = harness.run();
    await waitFor(() => harness.orchestrator.getState().status === "pending-approval");
    harness.orchestrator.reject("spec-review", "narrow the scope");
    await waitFor(() => harness.invocationRecords.filter((record) => record.role === "spec-author").length === 3);
    expect(harness.invocationRecords.filter((record) => record.role === "spec-author").at(-1)?.userPrompt).toContain("narrow the scope");
    await waitFor(() => harness.orchestrator.getState().status === "pending-approval");
    harness.orchestrator.approve("spec-review");
    await waitFor(() => harness.orchestrator.getState().status === "pending-approval" && harness.orchestrator.getState().specStep === "proofreading");
    harness.orchestrator.skip("spec-proofreading");
    await runPromise;
  });

  it("stops with error after exhausting spec review retries and records reviewer FAIL audits", async () => {
    const harness = await createHarness({
      createSpec: false,
      createPrompt: true,
      phaseContent: ["# Phase 1: Empty", ""].join("\n"),
      invocationScripts: {
        "spec-author": [{ response: "NONE" }, { response: "PASS" }, { response: "PASS" }],
        "spec-reviewer": [{ response: "FAIL once" }, { response: "FAIL twice" }],
      },
    });

    await harness.run();

    const auditEntries = await readAudit(path.join(harness.workspaceDir, ".conductor"));
    expect(harness.orchestrator.getState().status).toBe("error");
    expect(harness.orchestrator.getState().specStep).toBe("reviewing");
    expect(auditEntries.filter((entry) => entry.role === "spec-reviewer" && entry.result === "FAIL")).toHaveLength(2);
  });

  it("persists spec-writing progress across pause and resume and writes spec author transcripts and audits", async () => {
    let releaseReview!: () => void;
    const waitForReview = new Promise<void>((resolve) => {
      releaseReview = resolve;
    });
    const harness = await createHarness({
      createSpec: false,
      createPrompt: true,
      phaseFiles: {
        1: ["# Phase 1: Empty", ""].join("\n"),
        2: ["# Phase 2: Empty", ""].join("\n"),
      },
      persistTranscripts: true,
      invocationScripts: {
        "spec-author": [{ response: "NONE" }, { response: "PASS" }],
        "spec-reviewer": [{ response: "PASS", waitFor: waitForReview }, { response: "PASS" }],
        "spec-proofreader": [{ response: "PASS" }, { response: "PASS" }],
        "phase-creator": [{ response: "PASS" }],
        "phase-reviewer": [{ response: "PASS" }, { response: "PASS" }],
      },
    });

    const runPromise = harness.run();
    await waitFor(() => harness.invocationRecords.filter((record) => record.role === "spec-reviewer").length === 1);
    harness.orchestrator.pause();
    releaseReview();
    await runPromise;

    const pausedState = await harness.loadPersistedState();
    expect(pausedState.specStep).toBe("reviewing");
    expect(pausedState.specConsecutivePasses).toBe(1);

    harness.orchestrator.resume();
    await waitFor(() => harness.orchestrator.getState().specPhaseFileIndex === 2);

    const auditEntries = await readAudit(path.join(harness.workspaceDir, ".conductor"));
    const transcripts = await harness.orchestrator.getTranscripts();

    expect(auditEntries.some((entry) => entry.role === "spec-author")).toBe(true);
    expect(auditEntries.some((entry) => entry.role === "spec-reviewer" && entry.result === "PASS")).toBe(true);
    expect(transcripts.some((entry) => entry.role === "spec-author")).toBe(true);
  });

  it("marks an item pass after two consecutive PASS reviews", async () => {
    const harness = await createHarness({
      invocationScripts: {
        implementor: [{ response: "implemented" }],
        reviewer: [{ response: "PASS" }, { response: "PASS" }],
      },
    });

    await harness.run();

    expect(harness.orchestrator.getState().consecutivePasses.A1).toBe(2);
    expect(harness.orchestrator.getState().itemStatuses.A1).toBe("pass");
  });

  it("resets consecutive passes and retries implementation after a FAIL then PASS PASS", async () => {
    const harness = await createHarness({
      invocationScripts: {
        implementor: [{ response: "first impl" }, { response: "second impl" }],
        reviewer: [{ response: "FAIL reviewer fix this" }, { response: "PASS" }, { response: "PASS" }],
      },
    });

    await harness.run();

    expect(harness.invocationRecords.filter((record) => record.role === "implementor")).toHaveLength(2);
    expect(harness.orchestrator.getState().consecutivePasses.A1).toBe(2);
  });

  it("marks an item fail after max retries and writes two FAIL audit entries", async () => {
    const harness = await createHarness({
      invocationScripts: {
        implementor: [{ response: "impl 1" }, { response: "impl 2" }],
        reviewer: [{ response: "FAIL once" }, { response: "FAIL twice" }],
      },
    });

    await harness.run();

    const auditEntries = await readAudit(path.join(harness.workspaceDir, ".conductor"));

    expect(harness.orchestrator.getState().itemStatuses.A1).toBe("fail");
    expect(auditEntries.filter((entry) => entry.result === "FAIL")).toHaveLength(2);
  });

  it("starts all parallel implementor invocations before any review invocation", async () => {
    const harness = await createHarness({
      phaseContent: [
        "# Phase 1: Core Extension",
        "",
        "### Batch 1 (parallel)",
        "",
        "#### Item 1.2: B1 - Batch item B1 [parallel]",
        "",
        "spec.md section: B1",
        "",
        "- [ ] implemented",
        "- [ ] reviewed",
        "",
        "#### Item 1.3: B2 - Batch item B2 [parallel]",
        "",
        "spec.md section: B2",
        "",
        "- [ ] implemented",
        "- [ ] reviewed",
        "",
        "#### Item 1.4: B3 - Batch item B3 [parallel]",
        "",
        "spec.md section: B3",
        "",
        "- [ ] implemented",
        "- [ ] reviewed",
        "",
      ].join("\n"),
      invocationScripts: {
        implementor: [{ response: "impl b1" }, { response: "impl b2" }, { response: "impl b3" }],
        reviewer: [{ response: "PASS batch" }],
      },
    });

    await harness.run();

    const firstReviewIndex = harness.invocationRecords.findIndex((record) => record.role === "reviewer");
    expect(firstReviewIndex).toBeGreaterThanOrEqual(3);
    expect(harness.invocationRecords.slice(0, 3).every((record) => record.role === "implementor")).toBe(true);
  });

  it("writes paused state and stops the loop when pause is called", async () => {
    let releaseImplementation!: () => void;
    const waitForImplementation = new Promise<void>((resolve) => {
      releaseImplementation = resolve;
    });
    const harness = await createHarness({
      invocationScripts: {
        implementor: [{ response: "slow impl", waitFor: waitForImplementation }],
        reviewer: [{ response: "PASS" }, { response: "PASS" }],
      },
    });

    const runPromise = harness.run();
    await waitFor(() => harness.invocationRecords.filter((record) => record.role === "implementor").length === 1);
    harness.orchestrator.pause();
    releaseImplementation();
    await runPromise;

    const persistedState = await harness.loadPersistedState();
    expect(persistedState.status).toBe("paused");
    expect(persistedState.currentItemIndex).toBe(0);
    expect(harness.orchestrator.getState().status).toBe("paused");
    expect(harness.orchestrator.getState().currentItemIndex).toBe(0);
  });

  it("does not advance currentItemIndex when pause interrupts a parallel batch", async () => {
    let releaseBatch!: () => void;
    const waitForBatchImplementation = new Promise<void>((resolve) => {
      releaseBatch = resolve;
    });
    const harness = await createHarness({
      phaseContent: [
        "# Phase 1: Core Extension",
        "",
        "### Batch 1 (parallel)",
        "",
        "#### Item 1.2: B1 - Batch item B1 [parallel]",
        "",
        "spec.md section: B1",
        "",
        "- [ ] implemented",
        "- [ ] reviewed",
        "",
        "#### Item 1.3: B2 - Batch item B2 [parallel]",
        "",
        "spec.md section: B2",
        "",
        "- [ ] implemented",
        "- [ ] reviewed",
        "",
        "#### Item 1.4: B3 - Batch item B3 [parallel]",
        "",
        "spec.md section: B3",
        "",
        "- [ ] implemented",
        "- [ ] reviewed",
        "",
      ].join("\n"),
      invocationScripts: {
        implementor: [
          { response: "impl b1", waitFor: waitForBatchImplementation },
          { response: "impl b2", waitFor: waitForBatchImplementation },
          { response: "impl b3", waitFor: waitForBatchImplementation },
        ],
        reviewer: [{ response: "PASS batch" }],
      },
    });

    const runPromise = harness.run();
    await waitFor(() => harness.invocationRecords.filter((record) => record.role === "implementor").length === 3);
    harness.orchestrator.pause();
    releaseBatch();
    await runPromise;

    const persistedState = await harness.loadPersistedState();
    expect(persistedState.status).toBe("paused");
    expect(persistedState.currentItemIndex).toBe(0);
    expect(harness.orchestrator.getState().currentItemIndex).toBe(0);
    expect(harness.invocationRecords.some((record) => record.role === "reviewer")).toBe(false);
  });

  it("resumes from the saved currentItemIndex", async () => {
    const phaseContent = [
      "# Phase 1: Core Extension",
      "",
      "### Item 1.1: A1 - Item A1",
      "",
      "spec.md section: A1",
      "",
      "- [ ] implemented",
      "- [ ] reviewed",
      "",
      "### Item 1.2: A2 - Item A2",
      "",
      "spec.md section: A2",
      "",
      "- [ ] implemented",
      "- [ ] reviewed",
      "",
    ].join("\n");

    const harness = await createHarness({
      phaseContent,
      initialState: {
        currentPhase: 1,
        currentItemIndex: 1,
        status: "paused",
        itemStatuses: { A1: "pass" },
      },
      invocationScripts: {
        implementor: [{ response: "impl a2" }],
        reviewer: [{ response: "PASS" }, { response: "PASS" }],
      },
    });

    await harness.run();
    harness.orchestrator.resume();
    await waitFor(() => harness.orchestrator.getState().itemStatuses.A2 === "pass");

    expect(harness.invocationRecords[0]?.userPrompt).toContain("A2");
  });

  it("loads the persisted currentPhase file and updates that phase file when work passes", async () => {
    const harness = await createHarness({
      phaseFiles: {
        1: [
          "# Phase 1: Core Extension",
          "",
          "### Item 1.1: A1 - Item A1",
          "",
          "spec.md section: A1",
          "",
          "- [ ] implemented",
          "- [ ] reviewed",
          "",
        ].join("\n"),
        2: [
          "# Phase 2: Follow-up",
          "",
          "### Item 2.1: A2 - Item A2",
          "",
          "spec.md section: A2",
          "",
          "- [ ] implemented",
          "- [ ] reviewed",
          "",
        ].join("\n"),
      },
      initialState: {
        currentPhase: 2,
        currentItemIndex: 0,
        status: "paused",
      },
      invocationScripts: {
        implementor: [{ response: "impl a2" }],
        reviewer: [{ response: "PASS" }, { response: "PASS" }],
      },
    });

    await harness.run();
    harness.orchestrator.resume();
    await waitFor(() => harness.orchestrator.getState().itemStatuses.A2 === "pass");

    const phase1Content = await harness.readPhaseFile(1);
    const phase2Content = await harness.readPhaseFile(2);

    expect(harness.invocationRecords[0]?.userPrompt).toContain("A2");
    expect(phase1Content).toContain("- [ ] implemented");
    expect(phase2Content).toContain("- [x] implemented");
    expect(phase2Content).toContain("- [x] reviewed");
  });

  it("prefers persisted model assignments and uses the saved reviewer model after resume", async () => {
    const phaseContent = [
      "# Phase 1: Core Extension",
      "",
      "### Item 1.1: A1 - Item A1",
      "",
      "spec.md section: A1",
      "",
      "- [ ] implemented",
      "- [ ] reviewed",
      "",
      "### Item 1.2: A2 - Item A2",
      "",
      "spec.md section: A2",
      "",
      "- [ ] implemented",
      "- [ ] reviewed",
      "",
    ].join("\n");

    const harness = await createHarness({
      phaseContent,
      initialState: {
        currentPhase: 1,
        currentItemIndex: 1,
        status: "paused",
        consecutivePasses: { A1: 2 },
        itemStatuses: { A1: "pass" },
        modelAssignments: [
          { role: "implementor", vendor: "copilot", family: "gpt-5.4" },
          { role: "reviewer", vendor: "copilot", family: "o3" },
          { role: "spec-author", vendor: "copilot", family: "gpt-4.1" },
          { role: "spec-reviewer", vendor: "copilot", family: "gpt-4.1-mini" },
          { role: "spec-proofreader", vendor: "copilot", family: "o3" },
          { role: "phase-creator", vendor: "copilot", family: "gpt-4.1" },
          { role: "phase-reviewer", vendor: "copilot", family: "o3-mini" },
        ],
      },
      invocationScripts: {
        implementor: [{ response: "impl a2" }],
        reviewer: [{ response: "PASS" }, { response: "PASS" }],
      },
    });

    await harness.run();
    harness.orchestrator.resume();
    await waitFor(() => harness.orchestrator.getState().itemStatuses.A2 === "pass");

    expect(harness.orchestrator.getState().modelAssignments.find((entry) => entry.role === "reviewer")).toMatchObject({
      vendor: "copilot",
      family: "o3",
    });
    expect(harness.selectCalls.filter((call) => call.role === "reviewer").every((call) => call.family === "o3")).toBe(true);
  });

  it("updates phase file checkboxes after an item passes", async () => {
    const harness = await createHarness({
      invocationScripts: {
        implementor: [{ response: "implemented" }],
        reviewer: [{ response: "PASS" }, { response: "PASS" }],
      },
    });

    await harness.run();

    const phaseContent = await harness.readPhaseFile();
    expect(phaseContent).toContain("- [x] implemented");
    expect(phaseContent).toContain("- [x] reviewed");
  });

  it("waits in pending-approval until approve is called", async () => {
    const harness = await createHarness({
      invocationScripts: {
        implementor: [{ response: "implemented" }],
        reviewer: [{ response: "PASS" }, { response: "PASS" }],
      },
    });
    harness.config.requireApproval = true;

    const runPromise = harness.run();
    await waitFor(() => harness.orchestrator.getState().itemStatuses.A1 === "pending-approval");
    harness.orchestrator.approve("A1");
    await runPromise;

    expect(harness.orchestrator.getState().itemStatuses.A1).toBe("pass");
  });

  it("holds parallel batch items in pending-approval until one batch item is approved", async () => {
    const harness = await createHarness({
      phaseContent: [
        "# Phase 1: Core Extension",
        "",
        "### Batch 1 (parallel)",
        "",
        "#### Item 1.2: B1 - Batch item B1 [parallel]",
        "",
        "spec.md section: B1",
        "",
        "- [ ] implemented",
        "- [ ] reviewed",
        "",
        "#### Item 1.3: B2 - Batch item B2 [parallel]",
        "",
        "spec.md section: B2",
        "",
        "- [ ] implemented",
        "- [ ] reviewed",
        "",
        "#### Item 1.4: B3 - Batch item B3 [parallel]",
        "",
        "spec.md section: B3",
        "",
        "- [ ] implemented",
        "- [ ] reviewed",
        "",
      ].join("\n"),
      invocationScripts: {
        implementor: [{ response: "impl b1" }, { response: "impl b2" }, { response: "impl b3" }],
        reviewer: [{ response: "PASS batch" }],
      },
    });
    harness.config.requireApproval = true;

    const runPromise = harness.run();
    await waitFor(() => ["B1", "B2", "B3"].every((itemId) => harness.orchestrator.getState().itemStatuses[itemId] === "pending-approval"));
    harness.orchestrator.approve("B2");
    await runPromise;

    expect(harness.orchestrator.getState().itemStatuses.B1).toBe("pass");
    expect(harness.orchestrator.getState().itemStatuses.B2).toBe("pass");
    expect(harness.orchestrator.getState().itemStatuses.B3).toBe("pass");
  }, 10_000);

  it("re-enters the implement cycle with reject feedback", async () => {
    const harness = await createHarness({
      invocationScripts: {
        implementor: [{ response: "implemented" }, { response: "implemented again" }],
        reviewer: [{ response: "PASS" }, { response: "PASS" }, { response: "PASS" }, { response: "PASS" }],
      },
    });
    harness.config.requireApproval = true;

    const runPromise = harness.run();
    await waitFor(() => harness.orchestrator.getState().itemStatuses.A1 === "pending-approval");
    harness.orchestrator.reject("A1", "fix X");
    await waitFor(() => harness.invocationRecords.filter((record) => record.role === "implementor").length === 2);
    await waitFor(() => harness.orchestrator.getState().itemStatuses.A1 === "pending-approval");
    harness.orchestrator.approve("A1");
    await runPromise;

    const implementPrompts = harness.invocationRecords
      .filter((record) => record.role === "implementor")
      .map((record) => record.userPrompt);
    expect(implementPrompts.at(-1)).toContain("fix X");
  });

  it("re-enters the parallel batch implement cycle after approval rejection", async () => {
    const harness = await createHarness({
      phaseContent: [
        "# Phase 1: Core Extension",
        "",
        "### Batch 1 (parallel)",
        "",
        "#### Item 1.2: B1 - Batch item B1 [parallel]",
        "",
        "spec.md section: B1",
        "",
        "- [ ] implemented",
        "- [ ] reviewed",
        "",
        "#### Item 1.3: B2 - Batch item B2 [parallel]",
        "",
        "spec.md section: B2",
        "",
        "- [ ] implemented",
        "- [ ] reviewed",
        "",
      ].join("\n"),
      invocationScripts: {
        implementor: [
          { response: "impl b1 cycle 1" },
          { response: "impl b2 cycle 1" },
          { response: "impl b1 cycle 2" },
          { response: "impl b2 cycle 2" },
        ],
        reviewer: [{ response: "PASS batch" }, { response: "PASS batch second cycle" }],
      },
    });
    harness.config.requireApproval = true;

    const runPromise = harness.run();
    await waitFor(() => ["B1", "B2"].every((itemId) => harness.orchestrator.getState().itemStatuses[itemId] === "pending-approval"));
    harness.orchestrator.reject("B2", "fix batch X");
    await waitFor(() => harness.invocationRecords.filter((record) => record.role === "implementor").length === 4);
    await waitFor(() => ["B1", "B2"].every((itemId) => harness.orchestrator.getState().itemStatuses[itemId] === "pending-approval"));
    harness.orchestrator.approve("B1");
    await runPromise;

    const secondCyclePrompts = harness.invocationRecords
      .filter((record) => record.role === "implementor")
      .slice(-2)
      .map((record) => record.userPrompt);
    expect(secondCyclePrompts.every((prompt) => prompt.includes("fix batch X"))).toBe(true);
  });

  it("skips a pending item and advances to the next item", async () => {
    const phaseContent = [
      "# Phase 1: Core Extension",
      "",
      "### Item 1.1: A1 - Item A1",
      "",
      "spec.md section: A1",
      "",
      "- [ ] implemented",
      "- [ ] reviewed",
      "",
      "### Item 1.2: A2 - Item A2",
      "",
      "spec.md section: A2",
      "",
      "- [ ] implemented",
      "- [ ] reviewed",
      "",
    ].join("\n");
    const harness = await createHarness({
      phaseContent,
      invocationScripts: {
        implementor: [{ response: "impl a2" }],
        reviewer: [{ response: "PASS" }, { response: "PASS" }],
      },
    });

    harness.orchestrator.skip("A1");
    await harness.run();

    expect(harness.orchestrator.getState().itemStatuses.A1).toBe("skipped");
    expect(harness.orchestrator.getState().itemStatuses.A2).toBe("pass");
  });

  it("retries a failed item and resets consecutive passes to zero", async () => {
    const harness = await createHarness({
      invocationScripts: {
        implementor: [{ response: "impl 1" }, { response: "impl 2" }, { response: "impl 3" }, { response: "impl 4" }],
        reviewer: [{ response: "FAIL one" }, { response: "FAIL two" }, { response: "PASS" }, { response: "PASS" }],
      },
    });

    await harness.run();
    expect(harness.orchestrator.getState().itemStatuses.A1).toBe("fail");

    harness.orchestrator.retry("A1");
    await waitFor(() => harness.orchestrator.getState().itemStatuses.A1 === "pass");

    expect(harness.orchestrator.getState().consecutivePasses.A1).toBe(2);
  });

  it("retries work from persisted failed state on a fresh orchestrator instance without calling run first", async () => {
    const harness = await createHarness({
      initialState: {
        currentPhase: 1,
        currentItemIndex: 0,
        status: "error",
        consecutivePasses: { A1: 0 },
        itemStatuses: { A1: "fail" },
      },
      invocationScripts: {
        implementor: [{ response: "impl retry" }],
        reviewer: [{ response: "PASS" }, { response: "PASS" }],
      },
    });

    harness.orchestrator.retry("A1");
    await waitFor(() => harness.orchestrator.getState().itemStatuses.A1 === "pass");

    expect(harness.invocationRecords.filter((record) => record.role === "implementor")).toHaveLength(1);
    expect(harness.orchestrator.getState().consecutivePasses.A1).toBe(2);
  });

  it("resumes work from persisted paused state on a fresh orchestrator instance without calling run first", async () => {
    const workspaceDir = await createWorkspace();
    const phaseContent = [
      "# Phase 1: Core Extension",
      "",
      "### Item 1.1: A1 - Item A1",
      "",
      "spec.md section: A1",
      "",
      "- [ ] implemented",
      "- [ ] reviewed",
      "",
      "### Item 1.2: A2 - Item A2",
      "",
      "spec.md section: A2",
      "",
      "- [ ] implemented",
      "- [ ] reviewed",
      "",
    ].join("\n");
    await writeFixtureFiles(workspaceDir, { phaseContent });

    const config: OrchestratorConfig = {
      docsDir: path.join(workspaceDir, ".docs"),
      projectDir: workspaceDir,
      skillsDir: path.join(workspaceDir, "skills"),
      modelAssignments: DEFAULT_ASSIGNMENTS.map((assignment) => ({ ...assignment })),
      maxTurns: 5,
      maxRetries: 2,
      requireApproval: false,
    };

    await saveState(path.join(workspaceDir, ".conductor"), {
      specDir: path.join(config.docsDir, "conductor"),
      conventionsSkill: "test-conventions",
      testCommand: "npm test",
      lintCommand: "",
      currentPhase: 1,
      currentItemIndex: 1,
      consecutivePasses: { A1: 2 },
      specStep: "done",
      specConsecutivePasses: 0,
      specPhaseFileIndex: 0,
      clarificationQuestions: [],
      status: "paused",
      modelAssignments: config.modelAssignments,
      itemStatuses: { A1: "pass" },
    });

    const runtime = createHarnessRuntime();
    const orchestrator = createOrchestrator(
      config,
      { subscriptions: [] } as never,
      createOrchestratorOverrides(runtime, {
        invocationScripts: {
          implementor: [{ response: "impl a2" }],
          reviewer: [{ response: "PASS" }, { response: "PASS" }],
          "pr-reviewer": [{ response: "PASS" }, { response: "PASS" }, { response: "PASS" }, { response: "PASS" }],
        },
      }),
    );

    orchestrator.resume();
    await waitFor(() => orchestrator.getState().status === "done");

    expect(runtime.invocationRecords[0]?.userPrompt).toContain("A2");
    expect(orchestrator.getState().status).toBe("done");
  });

  it("updates reviewer model assignments and uses the changed model on the next reviewer invocation", async () => {
    const harness = await createHarness({
      invocationScripts: {
        implementor: [{ response: "implemented" }],
        reviewer: [{ response: "PASS" }, { response: "PASS" }],
      },
    });

    harness.orchestrator.changeModel("reviewer", "copilot", "o3");
    await harness.run();

    expect(harness.orchestrator.getState().modelAssignments.find((entry) => entry.role === "reviewer")).toMatchObject({
      vendor: "copilot",
      family: "o3",
    });
    expect(harness.selectCalls.find((call) => call.role === "reviewer")?.family).toBe("o3");
  });

  it("ignores changeModel requests for roles without configured assignments", async () => {
    const harness = await createHarness({
      modelAssignments: DEFAULT_ASSIGNMENTS.filter((assignment) => assignment.role !== "phase-reviewer"),
    });
    const before = harness.orchestrator.getState().modelAssignments;

    harness.orchestrator.changeModel("phase-reviewer", "copilot", "o3");

    expect(harness.orchestrator.getState().modelAssignments).toEqual(before);
  });

  it("parses direct JSON command extraction responses", () => {
    expect(parseCommandExtraction('{"testCommand":"go test ./...","lintCommand":"golangci-lint run --fix"}')).toEqual({
      testCommand: "go test ./...",
      lintCommand: "golangci-lint run --fix",
    });
  });

  it("parses direct JSON bug descriptions", () => {
    expect(parseBugDescription('[{"title":"NPE in parser","description":"Null pointer when parsing empty input"},{"title":"Off-by-one","description":"Index error at end of file"}]')).toEqual([
      {
        title: "NPE in parser",
        description: "Null pointer when parsing empty input",
      },
      {
        title: "Off-by-one",
        description: "Index error at end of file",
      },
    ]);
  });

  it("falls back to a single bug issue when bug description JSON is invalid", () => {
    const response = "not valid json";

    expect(parseBugDescription(response)).toEqual([
      {
        title: "Bug fix",
        description: response,
      },
    ]);
  });

  it("falls back to a single bug issue when bug description JSON is empty", () => {
    expect(parseBugDescription("[]")).toEqual([
      {
        title: "Bug fix",
        description: "[]",
      },
    ]);
  });

  it("parses fenced JSON bug descriptions", () => {
    expect(parseBugDescription([
      "```json",
      '[{"title":"Race condition","description":"Concurrent writes corrupt state"}]',
      "```",
    ].join("\n"))).toEqual([
      {
        title: "Race condition",
        description: "Concurrent writes corrupt state",
      },
    ]);
  });

  it("parses fenced JSON command extraction responses", () => {
    expect(parseCommandExtraction([
      "```json",
      '{"testCommand":"pnpm test","lintCommand":"pnpm lint --fix && pnpm format"}',
      "```",
    ].join("\n"))).toEqual({
      testCommand: "pnpm test",
      lintCommand: "pnpm lint --fix && pnpm format",
    });
  });

  it("falls back to default commands on invalid command extraction JSON", () => {
    expect(parseCommandExtraction("not valid json")).toEqual({
      testCommand: "npm test",
      lintCommand: "",
    });
  });

  it("stores extracted commands from the conventions skill before running tests", async () => {
    const harness = await createHarness({
      initialState: {
        conventionsSkill: "test-conventions",
      },
      conventionsSkillContent: [
        "# test conventions",
        "",
        "Run tests with `pnpm test`.",
        "Run lint with `pnpm lint --fix && pnpm format`.",
      ].join("\n"),
      invocationScripts: {
        "spec-author": [
          { response: '{"testCommand":"pnpm test","lintCommand":"pnpm lint --fix && pnpm format"}' },
        ],
        implementor: [{ response: "implemented" }],
        reviewer: [{ response: "PASS" }, { response: "PASS" }],
      },
    });

    await harness.run();

    expect(harness.testCommandCalls).toContain("pnpm test");
    expect(harness.orchestrator.getState()).toMatchObject({
      testCommand: "pnpm test",
      lintCommand: "pnpm lint --fix && pnpm format",
    });
    expect(harness.selectCalls.find((call) => call.role === "spec-author")?.family).toBe("gpt-4.1");
  });

  it("updates state commands when overrideCommands is called", async () => {
    const harness = await createHarness();

    harness.orchestrator.overrideCommands("pnpm test", "pnpm lint --fix");
    await waitFor(() => harness.orchestrator.getState().testCommand === "pnpm test");

    expect(harness.orchestrator.getState()).toMatchObject({
      testCommand: "pnpm test",
      lintCommand: "pnpm lint --fix",
    });
    expect(await harness.loadPersistedState()).toMatchObject({
      testCommand: "pnpm test",
      lintCommand: "pnpm lint --fix",
    });
  });

  it("retries implementation when the test command exits non-zero and appends failure output to feedback", async () => {
    const harness = await createHarness({
      invocationScripts: {
        implementor: [{ response: "impl 1" }, { response: "impl 2" }],
        reviewer: [{ response: "PASS" }, { response: "PASS" }],
      },
      executeResults: [
        { success: false, output: "stderr:\nboom\nexit code: 1", error: "command exited with code 1" },
        { success: true, output: "stdout:\nok\nexit code: 0" },
      ],
    });

    await harness.run();

    expect(harness.invocationRecords.filter((record) => record.role === "implementor")).toHaveLength(2);
    expect(harness.invocationRecords.filter((record) => record.role === "implementor").at(-1)?.userPrompt).toContain("boom");
  });

  it("marks the item fail and writes an error audit entry when tests time out", async () => {
    const harness = await createHarness({
      invocationScripts: {
        implementor: [{ response: "impl" }],
      },
      executeResults: [
        { success: false, output: "signal: SIGKILL", error: "command timeout after 100ms" },
      ],
    });

    await harness.run();

    const auditEntries = await readAudit(path.join(harness.workspaceDir, ".conductor"));
    expect(harness.orchestrator.getState().itemStatuses.A1).toBe("fail");
    expect(auditEntries.some((entry) => entry.result === "error" && entry.promptSummary.includes("test timeout"))).toBe(true);
  });

  it("runs lint with trusted execution after tests pass and proceeds to review when lint makes no changes", async () => {
    const harness = await createHarness({
      initialState: {
        lintCommand: "ruff check --fix && ruff format",
      },
      invocationScripts: {
        implementor: [{ response: "impl" }],
        reviewer: [{ response: "PASS" }, { response: "PASS" }],
      },
      trustedExecuteResults: [
        { success: true, output: "stdout:\nfeature/test\nexit code: 0" },
        { success: true, output: "stdout:\n  HEAD branch: main\nexit code: 0" },
        { success: true, output: "stdout:\nlint ok\nexit code: 0" },
      ],
      diffResults: [
        { success: true, output: "stdout:\nsrc/orchestrator/machine.ts\nexit code: 0" },
        { success: true, output: "stdout:\nsrc/orchestrator/machine.ts\nexit code: 0" },
      ],
    });

    await harness.run();

    expect(harness.testCommandCalls).toEqual(["npm test"]);
    expect(harness.trustedCommandCalls).toContain("ruff check --fix && ruff format");
    expect(harness.invocationRecords.filter((record) => record.role === "reviewer")).toHaveLength(2);
    expect(harness.orchestrator.getState().itemStatuses.A1).toBe("pass");
  });

  it("retries implementation when lint exits non-zero and appends lint output to feedback", async () => {
    const harness = await createHarness({
      initialState: {
        lintCommand: "ruff check --fix && ruff format",
      },
      invocationScripts: {
        implementor: [{ response: "impl 1" }, { response: "impl 2" }],
        reviewer: [{ response: "PASS" }, { response: "PASS" }],
      },
      trustedExecuteResults: [
        { success: true, output: "stdout:\nfeature/test\nexit code: 0" },
        { success: true, output: "stdout:\n  HEAD branch: main\nexit code: 0" },
        { success: false, output: "stderr:\nE501 line too long\nexit code: 1", error: "command exited with code 1" },
        { success: true, output: "stdout:\nlint ok\nexit code: 0" },
      ],
      diffResults: [
        { success: true, output: "stdout:\n\nexit code: 0" },
        { success: true, output: "stdout:\n\nexit code: 0" },
        { success: true, output: "stdout:\n\nexit code: 0" },
        { success: true, output: "stdout:\n\nexit code: 0" },
      ],
    });

    await harness.run();

    expect(harness.invocationRecords.filter((record) => record.role === "implementor")).toHaveLength(2);
    expect(harness.invocationRecords.filter((record) => record.role === "implementor").at(-1)?.userPrompt).toContain("E501 line too long");
  });

  it("re-runs tests when lint modifies files", async () => {
    const harness = await createHarness({
      initialState: {
        lintCommand: "ruff check --fix && ruff format",
      },
      invocationScripts: {
        implementor: [{ response: "impl" }],
        reviewer: [{ response: "PASS" }, { response: "PASS" }],
      },
      trustedExecuteResults: [
        { success: true, output: "stdout:\nfeature/test\nexit code: 0" },
        { success: true, output: "stdout:\n  HEAD branch: main\nexit code: 0" },
        { success: true, output: "stdout:\nformatted\nexit code: 0" },
      ],
      executeResults: [
        { success: true, output: "stdout:\nfirst pass\nexit code: 0" },
        { success: true, output: "stdout:\nsecond pass\nexit code: 0" },
      ],
      diffResults: [
        { success: true, output: "stdout:\nsrc/orchestrator/machine.ts\nexit code: 0" },
        { success: true, output: "stdout:\nsrc/orchestrator/machine.ts\nsrc/test/orchestrator/machine.test.ts\nexit code: 0" },
      ],
    });

    await harness.run();

    expect(harness.testCommandCalls).toEqual(["npm test", "npm test"]);
  });

  it("re-runs tests when lint changes an already-dirty file without changing the dirty path set", async () => {
    const harness = await createHarness({
      initialState: {
        lintCommand: "ruff check --fix && ruff format",
      },
      invocationScripts: {
        implementor: [{ response: "impl" }],
        reviewer: [{ response: "PASS" }, { response: "PASS" }],
      },
      trustedExecuteResults: [
        { success: true, output: "stdout:\nfeature/test\nexit code: 0" },
        { success: true, output: "stdout:\n  HEAD branch: main\nexit code: 0" },
        { success: true, output: "stdout:\nformatted\nexit code: 0" },
      ],
      executeResults: [
        { success: true, output: "stdout:\nfirst pass\nexit code: 0" },
        { success: true, output: "stdout:\nsecond pass\nexit code: 0" },
      ],
      diffResults: [
        {
          success: true,
          output: [
            "stdout:",
            "diff --git a/src/orchestrator/machine.ts b/src/orchestrator/machine.ts",
            "@@",
            "-const value = 'before';",
            "+const value = 'before';",
            "exit code: 0",
          ].join("\n"),
        },
        {
          success: true,
          output: [
            "stdout:",
            "diff --git a/src/orchestrator/machine.ts b/src/orchestrator/machine.ts",
            "@@",
            "-const value = 'before';",
            "+const value = 'after';",
            "exit code: 0",
          ].join("\n"),
        },
      ],
    });

    await harness.run();

    expect(harness.testCommandCalls).toEqual(["npm test", "npm test"]);
  });

  it("retries implementation with test feedback when re-test after lint modifications fails", async () => {
    const harness = await createHarness({
      initialState: {
        lintCommand: "ruff check --fix && ruff format",
      },
      invocationScripts: {
        implementor: [{ response: "impl 1" }, { response: "impl 2" }],
        reviewer: [{ response: "PASS" }, { response: "PASS" }],
      },
      trustedExecuteResults: [
        { success: true, output: "stdout:\nfeature/test\nexit code: 0" },
        { success: true, output: "stdout:\n  HEAD branch: main\nexit code: 0" },
        { success: true, output: "stdout:\nformatted\nexit code: 0" },
        { success: true, output: "stdout:\nlint ok\nexit code: 0" },
      ],
      executeResults: [
        { success: true, output: "stdout:\nfirst pass\nexit code: 0" },
        { success: false, output: "stderr:\npost-lint regression\nexit code: 1", error: "command exited with code 1" },
        { success: true, output: "stdout:\nretry pass\nexit code: 0" },
      ],
      diffResults: [
        { success: true, output: "stdout:\nsrc/orchestrator/machine.ts\nexit code: 0" },
        { success: true, output: "stdout:\nsrc/orchestrator/machine.ts\nsrc/test/orchestrator/machine.test.ts\nexit code: 0" },
        { success: true, output: "stdout:\nsrc/orchestrator/machine.ts\nsrc/test/orchestrator/machine.test.ts\nexit code: 0" },
        { success: true, output: "stdout:\nsrc/orchestrator/machine.ts\nsrc/test/orchestrator/machine.test.ts\nexit code: 0" },
      ],
    });

    await harness.run();

    expect(harness.invocationRecords.filter((record) => record.role === "implementor")).toHaveLength(2);
    expect(harness.invocationRecords.filter((record) => record.role === "implementor").at(-1)?.userPrompt).toContain("post-lint regression");
  });

  it("skips lint entirely when lintCommand is empty", async () => {
    const harness = await createHarness({
      invocationScripts: {
        implementor: [{ response: "impl" }],
        reviewer: [{ response: "PASS" }, { response: "PASS" }],
        "spec-author": [{ response: '{"testCommand":"npm test","lintCommand":""}' }],
      },
    });

    await harness.run();

    expect(harness.trustedCommandCalls).not.toContain("");
    expect(harness.trustedCommandCalls.slice(0, 2)).toEqual([
      "git rev-parse --abbrev-ref HEAD",
      "git remote show origin | grep 'HEAD branch'",
    ]);
    expect(harness.testCommandCalls).toEqual(["npm test"]);
  });

  it("marks the item fail and writes an error audit entry when lint times out", async () => {
    const harness = await createHarness({
      initialState: {
        lintCommand: "ruff check --fix && ruff format",
      },
      invocationScripts: {
        implementor: [{ response: "impl" }],
      },
      trustedExecuteResults: [
        { success: true, output: "stdout:\nfeature/test\nexit code: 0" },
        { success: true, output: "stdout:\n  HEAD branch: main\nexit code: 0" },
        { success: false, output: "signal: SIGKILL", error: "command timeout after 100ms" },
      ],
      diffResults: [
        { success: true, output: "stdout:\n\nexit code: 0" },
      ],
    });

    await harness.run();

    const auditEntries = await readAudit(path.join(harness.workspaceDir, ".conductor"));
    expect(harness.orchestrator.getState().itemStatuses.A1).toBe("fail");
    expect(auditEntries.some((entry) => entry.result === "error" && entry.promptSummary.includes("lint timeout"))).toBe(true);
  });

  it("appends reviewer addendum text to addendum storage", async () => {
    const harness = await createHarness({
      invocationScripts: {
        implementor: [{ response: "implemented" }],
        reviewer: [{ response: "PASS", addendum: "deviation text" }, { response: "PASS" }],
      },
    });

    await harness.run();

    expect(harness.addendumRecords).toContainEqual(expect.objectContaining({
      itemId: "A1",
      deviation: "deviation text",
    }));
  });

  it("invokes the batch reviewer exactly once with a combined diff for all items", async () => {
    const harness = await createHarness({
      phaseContent: [
        "# Phase 1: Core Extension",
        "",
        "### Batch 1 (parallel)",
        "",
        "#### Item 1.2: B1 - Batch item B1 [parallel]",
        "",
        "spec.md section: B1",
        "",
        "- [ ] implemented",
        "- [ ] reviewed",
        "",
        "#### Item 1.3: B2 - Batch item B2 [parallel]",
        "",
        "spec.md section: B2",
        "",
        "- [ ] implemented",
        "- [ ] reviewed",
        "",
        "#### Item 1.4: B3 - Batch item B3 [parallel]",
        "",
        "spec.md section: B3",
        "",
        "- [ ] implemented",
        "- [ ] reviewed",
        "",
      ].join("\n"),
      invocationScripts: {
        implementor: [{ response: "impl b1" }, { response: "impl b2" }, { response: "impl b3" }],
        reviewer: [{ response: "PASS batch" }],
      },
    });

    await harness.run();

    const reviewerCalls = harness.invocationRecords.filter((record) => record.role === "reviewer");
    expect(reviewerCalls).toHaveLength(1);
    expect(reviewerCalls[0]?.userPrompt).toContain("B1");
    expect(reviewerCalls[0]?.userPrompt).toContain("B2");
    expect(reviewerCalls[0]?.userPrompt).toContain("B3");
  });

  it("retries all batch items and resets their consecutive passes after a batch FAIL before a single combined PASS review", async () => {
    const harness = await createHarness({
      phaseContent: [
        "# Phase 1: Core Extension",
        "",
        "### Batch 1 (parallel)",
        "",
        "#### Item 1.2: B1 - Batch item B1 [parallel]",
        "",
        "spec.md section: B1",
        "",
        "- [ ] implemented",
        "- [ ] reviewed",
        "",
        "#### Item 1.3: B2 - Batch item B2 [parallel]",
        "",
        "spec.md section: B2",
        "",
        "- [ ] implemented",
        "- [ ] reviewed",
        "",
        "#### Item 1.4: B3 - Batch item B3 [parallel]",
        "",
        "spec.md section: B3",
        "",
        "- [ ] implemented",
        "- [ ] reviewed",
        "",
      ].join("\n"),
      invocationScripts: {
        implementor: [
          { response: "impl b1 cycle 1" },
          { response: "impl b2 cycle 1" },
          { response: "impl b3 cycle 1" },
          { response: "impl b1 cycle 2" },
          { response: "impl b2 cycle 2" },
          { response: "impl b3 cycle 2" },
        ],
        reviewer: [{ response: "FAIL batch" }, { response: "PASS batch" }],
      },
    });

    await harness.run();

    expect(harness.invocationRecords.filter((record) => record.role === "implementor")).toHaveLength(6);
    expect(harness.orchestrator.getState().consecutivePasses.B1).toBe(2);
    expect(harness.orchestrator.getState().consecutivePasses.B2).toBe(2);
    expect(harness.orchestrator.getState().consecutivePasses.B3).toBe(2);
  });

  it("adds a manual note entry through addNote", async () => {
    const harness = await createHarness();

    harness.orchestrator.addNote("A1", "needs fix");
    await waitFor(() => harness.addendumRecords.length === 1);

    expect(harness.addendumRecords[0]).toMatchObject({
      itemId: "A1",
      deviation: "needs fix",
    });
  });

  it("stages and commits the completed phase with an Implement phase message", async () => {
    const harness = await createHarness({
      phaseFiles: {
        2: [
          "# Phase 2: Core Extension",
          "",
          "### Item 2.1: A1 - Item A1",
          "",
          "spec.md section: A1",
          "",
          "- [ ] implemented",
          "- [ ] reviewed",
          "",
        ].join("\n"),
      },
      initialState: {
        currentPhase: 2,
      },
      invocationScripts: {
        "spec-author": [{ response: '{"testCommand":"npm test","lintCommand":""}' }],
        implementor: [{ response: "implemented" }],
        reviewer: [{ response: "PASS" }, { response: "PASS" }],
        "pr-reviewer": [{ response: "PASS" }, { response: "PASS" }, { response: "PASS" }, { response: "PASS" }],
      },
    });

    await harness.run();

    const addIndex = harness.trustedCommandCalls.indexOf("git add .");
    const commitIndex = harness.trustedCommandCalls.indexOf("git commit -m 'Implement phase 2'");
    expect(addIndex).toBeGreaterThanOrEqual(0);
    expect(commitIndex).toBeGreaterThan(addIndex);
  });

  it("pushes after committing a completed phase", async () => {
    const harness = await createHarness({
      phaseFiles: {
        2: [
          "# Phase 2: Core Extension",
          "",
          "### Item 2.1: A1 - Item A1",
          "",
          "spec.md section: A1",
          "",
          "- [ ] implemented",
          "- [ ] reviewed",
          "",
        ].join("\n"),
      },
      initialState: {
        currentPhase: 2,
      },
      invocationScripts: {
        "spec-author": [{ response: '{"testCommand":"npm test","lintCommand":""}' }],
        implementor: [{ response: "implemented" }],
        reviewer: [{ response: "PASS" }, { response: "PASS" }],
        "pr-reviewer": [{ response: "PASS" }, { response: "PASS" }, { response: "PASS" }, { response: "PASS" }],
      },
    });

    await harness.run();

    const commitIndex = harness.trustedCommandCalls.indexOf("git commit -m 'Implement phase 2'");
    const pushIndex = harness.trustedCommandCalls.indexOf("git push");
    expect(commitIndex).toBeGreaterThanOrEqual(0);
    expect(pushIndex).toBeGreaterThan(commitIndex);
  });

  it("commits and pushes .conductor after phase completion", async () => {
    let releaseReview!: () => void;
    const waitForReview = new Promise<void>((resolve) => {
      releaseReview = resolve;
    });
    const harness = await createHarness({
      invocationScripts: {
        implementor: [{ response: "implemented" }],
        reviewer: [{ response: "PASS" }, { response: "PASS" }],
        "pr-reviewer": [
          { response: "PASS", waitFor: waitForReview },
          { response: "PASS" },
          { response: "PASS" },
          { response: "PASS" },
        ],
      },
    });

    const runPromise = harness.run();
    await waitFor(() => harness.invocationRecords.filter((record) => record.role === "pr-reviewer").length === 1);

    const phaseCommitIndex = harness.trustedCommandCalls.indexOf("git commit -m 'Implement phase 1'");
    const phasePushIndex = harness.trustedCommandCalls.findIndex((command, index) => command === "git push" && index > phaseCommitIndex);
    const stateAddIndex = harness.trustedCommandCalls.findIndex((command, index) => command === "git add .conductor/" && index > phasePushIndex);
    const stateCommitIndex = harness.trustedCommandCalls.findIndex((command, index) => command === "git commit -m 'conductor: update state'" && index > stateAddIndex);
    const statePushIndex = harness.trustedCommandCalls.findIndex((command, index) => command === "git push" && index > stateCommitIndex);

    expect(phaseCommitIndex).toBeGreaterThanOrEqual(0);
    expect(phasePushIndex).toBeGreaterThan(phaseCommitIndex);
    expect(stateAddIndex).toBeGreaterThan(phasePushIndex);
    expect(stateCommitIndex).toBeGreaterThan(stateAddIndex);
    expect(statePushIndex).toBeGreaterThan(stateCommitIndex);
    expect(harness.trustedCommandCalls.filter((command) => command === "git commit -m 'conductor: update state'")).toHaveLength(1);

    harness.orchestrator.pause();
    releaseReview();
    await runPromise;
  });

  it("logs a non-fatal audit error when phase push fails and continues into PR review", async () => {
    const harness = await createHarness({
      phaseFiles: {
        2: [
          "# Phase 2: Core Extension",
          "",
          "### Item 2.1: A1 - Item A1",
          "",
          "spec.md section: A1",
          "",
          "- [ ] implemented",
          "- [ ] reviewed",
          "",
        ].join("\n"),
      },
      initialState: {
        currentPhase: 2,
      },
      invocationScripts: {
        "spec-author": [{ response: '{"testCommand":"npm test","lintCommand":""}' }],
        implementor: [{ response: "implemented" }],
        reviewer: [{ response: "PASS" }, { response: "PASS" }],
        "pr-reviewer": [{ response: "PASS" }, { response: "PASS" }, { response: "PASS" }, { response: "PASS" }],
      },
      trustedExecuteResults: [
        { success: true, output: "stdout:\nfeature/test\nexit code: 0" },
        { success: true, output: "stdout:\n  HEAD branch: main\nexit code: 0" },
        { success: true, output: "stdout:\nstaged\nexit code: 0" },
        { success: true, output: "stdout:\n[feature/test abc123] Implement phase 2\nexit code: 0" },
        { success: false, output: "stderr:\nremote rejected\nexit code: 1", error: "command exited with code 1" },
      ],
    });

    await harness.run();

    const auditEntries = await readAudit(path.join(harness.workspaceDir, ".conductor"));
    expect(harness.orchestrator.getState().status).toBe("done");
    expect(harness.invocationRecords.filter((record) => record.role === "pr-reviewer")).toHaveLength(4);
    expect(auditEntries.some((entry) => entry.itemId === "phase2:commit" && entry.result === "error" && entry.promptSummary.includes("Failed to push phase 2"))).toBe(true);
  });

  it("still commits a completed phase when the phase includes skipped items", async () => {
    const harness = await createHarness({
      phaseFiles: {
        2: [
          "# Phase 2: Core Extension",
          "",
          "### Item 2.1: A1 - Item A1",
          "",
          "spec.md section: A1",
          "",
          "- [ ] implemented",
          "- [ ] reviewed",
          "",
          "### Item 2.2: A2 - Item A2",
          "",
          "spec.md section: A2",
          "",
          "- [ ] implemented",
          "- [ ] reviewed",
          "",
        ].join("\n"),
      },
      initialState: {
        currentPhase: 2,
        itemStatuses: {
          A1: "skipped",
        },
      },
      invocationScripts: {
        "spec-author": [{ response: '{"testCommand":"npm test","lintCommand":""}' }],
        implementor: [{ response: "implemented" }],
        reviewer: [{ response: "PASS" }, { response: "PASS" }],
        "pr-reviewer": [{ response: "PASS" }, { response: "PASS" }, { response: "PASS" }, { response: "PASS" }],
      },
    });

    await harness.run();

    expect(harness.orchestrator.getState().itemStatuses.A1).toBe("skipped");
    expect(harness.orchestrator.getState().itemStatuses.A2).toBe("pass");
    expect(harness.trustedCommandCalls).toContain("git commit -m 'Implement phase 2'");
  });

  it("enters spec-aware PR review after all phase items pass", async () => {
    let releaseReview!: () => void;
    const waitForReview = new Promise<void>((resolve) => {
      releaseReview = resolve;
    });
    const harness = await createHarness({
      invocationScripts: {
        implementor: [{ response: "implemented" }],
        reviewer: [{ response: "PASS" }, { response: "PASS" }],
        "pr-reviewer": [
          { response: "PASS", waitFor: waitForReview },
          { response: "PASS" },
          { response: "PASS" },
          { response: "PASS" },
        ],
      },
      trustedExecuteResults: [
        { success: true, output: "stdout:\nfeature/test\nexit code: 0" },
        { success: true, output: "stdout:\n  HEAD branch: main\nexit code: 0" },
        { success: true, output: "stdout:\nstaged\nexit code: 0" },
        { success: true, output: "stdout:\n[feature/test abc123] Implement phase 1\nexit code: 0" },
        { success: true, output: "stdout:\npushed\nexit code: 0" },
        { success: true, output: "stdout:\nfeature/test\nexit code: 0" },
        { success: true, output: "stdout:\n  HEAD branch: main\nexit code: 0" },
        { success: true, output: "stdout:\nabc123\nexit code: 0" },
        { success: true, output: "stdout:\ndiff --git a/src/foo.ts b/src/foo.ts\nexit code: 0" },
      ],
    });

    const runPromise = harness.run();
    await waitFor(() => harness.invocationRecords.filter((record) => record.role === "pr-reviewer").length === 1);

    const firstPrReview = harness.invocationRecords.find((record) => record.role === "pr-reviewer");
    expect(harness.orchestrator.getState().prReviewStep).toBe("spec-aware");
    expect(firstPrReview?.userPrompt).toContain(path.join(harness.config.docsDir, "conductor", "spec.md"));
    expect(firstPrReview?.userPrompt).toContain("diff --git a/src/foo.ts b/src/foo.ts");

    harness.orchestrator.pause();
    releaseReview();
    await runPromise;
  });

  it("advances from spec-aware to spec-free after two consecutive PR review PASS results", async () => {
    let releaseReview!: () => void;
    const waitForReview = new Promise<void>((resolve) => {
      releaseReview = resolve;
    });
    const harness = await createHarness({
      invocationScripts: {
        implementor: [{ response: "implemented" }],
        reviewer: [{ response: "PASS" }, { response: "PASS" }],
        "pr-reviewer": [
          { response: "PASS" },
          { response: "PASS" },
          { response: "PASS", waitFor: waitForReview },
          { response: "PASS" },
        ],
      },
    });

    const runPromise = harness.run();
    await waitFor(() => harness.invocationRecords.filter((record) => record.role === "pr-reviewer").length === 3);

    expect(harness.orchestrator.getState().prReviewStep).toBe("spec-free");

    harness.orchestrator.pause();
    releaseReview();
    await runPromise;
  });

  it("fixes each structured PR review finding once, reruns tests, and invokes pr-reviewer again", async () => {
    const findings = JSON.stringify([
      { file: "src/foo.ts", line: 10, description: "Guard the undefined branch" },
      { file: "src/bar.ts", line: 22, description: "Handle the timeout path" },
    ]);
    const harness = await createHarness({
      invocationScripts: {
        implementor: [
          { response: "implemented" },
          { response: "fixed finding 1" },
          { response: "fixed finding 2" },
        ],
        reviewer: [{ response: "PASS" }, { response: "PASS" }],
        "pr-reviewer": [
          { response: `FAIL${findings}` },
          { response: "PASS" },
          { response: "PASS" },
          { response: "PASS" },
          { response: "PASS" },
        ],
      },
    });

    await harness.run();

    expect(harness.invocationRecords.filter((record) => record.role === "implementor")).toHaveLength(3);
    expect(harness.invocationRecords.some((record) => record.userPrompt.includes("Guard the undefined branch"))).toBe(true);
    expect(harness.invocationRecords.some((record) => record.userPrompt.includes("Handle the timeout path"))).toBe(true);
    expect(harness.testCommandCalls).toEqual(["npm test", "npm test"]);
    expect(harness.invocationRecords.filter((record) => record.role === "pr-reviewer").length).toBeGreaterThan(1);
  });

  it("finishes with done after two clean spec-free PR reviews", async () => {
    const harness = await createHarness({
      invocationScripts: {
        implementor: [{ response: "implemented" }],
        reviewer: [{ response: "PASS" }, { response: "PASS" }],
        "pr-reviewer": [{ response: "PASS" }, { response: "PASS" }, { response: "PASS" }, { response: "PASS" }],
      },
    });

    await harness.run();

    expect(harness.orchestrator.getState().status).toBe("done");
    expect(harness.orchestrator.getState().prReviewStep).toBe("done");
  });

  it("waits for approval after both PR review steps pass and completes on approve", async () => {
    const harness = await createHarness({
      initialState: {
        currentItemIndex: 1,
        consecutivePasses: { A1: 2 },
        itemStatuses: { A1: "pass" },
        prReviewStep: "spec-aware",
        prReviewConsecutivePasses: 0,
        status: "paused",
      },
      invocationScripts: {
        "pr-reviewer": [{ response: "PASS" }, { response: "PASS" }, { response: "PASS" }, { response: "PASS" }],
      },
    });
    harness.config.requireApproval = true;

    await harness.run();
    harness.orchestrator.resume();
    await waitFor(() => harness.orchestrator.getState().status === "pending-approval");

    expect(harness.orchestrator.getState().prReviewStep).toBe("spec-free");

    harness.orchestrator.approve("pr-review");
    await waitFor(() => harness.orchestrator.getState().status === "done");

    expect(harness.orchestrator.getState().status).toBe("done");
    expect(harness.orchestrator.getState().prReviewStep).toBe("done");
  });

  it("includes the spec path and branch diff output in the spec-aware PR review prompt", async () => {
    const harness = await createHarness({
      invocationScripts: {
        implementor: [{ response: "implemented" }],
        reviewer: [{ response: "PASS" }, { response: "PASS" }],
        "pr-reviewer": [{ response: "PASS" }, { response: "PASS" }, { response: "PASS" }, { response: "PASS" }],
      },
      trustedExecuteResults: [
        { success: true, output: "stdout:\nfeature/test\nexit code: 0" },
        { success: true, output: "stdout:\n  HEAD branch: main\nexit code: 0" },
        { success: true, output: "stdout:\nstaged\nexit code: 0" },
        { success: true, output: "stdout:\n[feature/test abc123] Implement phase 1\nexit code: 0" },
        { success: true, output: "stdout:\npushed\nexit code: 0" },
        { success: true, output: "stdout:\nfeature/test\nexit code: 0" },
        { success: true, output: "stdout:\n  HEAD branch: main\nexit code: 0" },
        { success: true, output: "stdout:\nabc123\nexit code: 0" },
        { success: true, output: "stdout:\nPR DIFF OUTPUT\nexit code: 0" },
      ],
    });

    await harness.run();

    const firstPrReview = harness.invocationRecords.find((record) => record.role === "pr-reviewer");
    expect(firstPrReview?.userPrompt).toContain(path.join(harness.config.docsDir, "conductor", "spec.md"));
    expect(firstPrReview?.userPrompt).toContain("PR DIFF OUTPUT");
  });

  it("omits the spec path from the spec-free PR review prompt", async () => {
    const harness = await createHarness({
      invocationScripts: {
        implementor: [{ response: "implemented" }],
        reviewer: [{ response: "PASS" }, { response: "PASS" }],
        "pr-reviewer": [{ response: "PASS" }, { response: "PASS" }, { response: "PASS" }, { response: "PASS" }],
      },
    });

    await harness.run();

    const prReviewCalls = harness.invocationRecords.filter((record) => record.role === "pr-reviewer");
    expect(prReviewCalls[2]?.userPrompt).not.toContain(path.join(harness.config.docsDir, "conductor", "spec.md"));
  });

  it("uses an imperative PR review commit message no longer than 72 characters", async () => {
    const harness = await createHarness({
      invocationScripts: {
        implementor: [{ response: "implemented" }, { response: "fixed finding" }],
        reviewer: [{ response: "PASS" }, { response: "PASS" }],
        "pr-reviewer": [
          { response: `FAIL${JSON.stringify([{ file: "src/foo.ts", line: 10, description: "Fix the edge case" }])}` },
          { response: "PASS" },
          { response: "PASS" },
          { response: "PASS" },
          { response: "PASS" },
        ],
      },
    });

    await harness.run();

    const commitCommand = harness.trustedCommandCalls.find((command) => command === "git commit -m 'Fix PR review findings'");
    expect(commitCommand).toBe("git commit -m 'Fix PR review findings'");
    expect("Fix PR review findings".length).toBeLessThanOrEqual(72);
  });

  it("pushes PR review fixes after committing them", async () => {
    const harness = await createHarness({
      invocationScripts: {
        implementor: [{ response: "implemented" }, { response: "fixed finding" }],
        reviewer: [{ response: "PASS" }, { response: "PASS" }],
        "pr-reviewer": [
          { response: `FAIL${JSON.stringify([{ file: "src/foo.ts", line: 10, description: "Fix the edge case" }])}` },
          { response: "PASS" },
          { response: "PASS" },
          { response: "PASS" },
          { response: "PASS" },
        ],
      },
    });

    await harness.run();

    const commitIndex = harness.trustedCommandCalls.indexOf("git commit -m 'Fix PR review findings'");
    const pushIndex = harness.trustedCommandCalls.findIndex((command, index) => command === "git push" && index > commitIndex);
    expect(commitIndex).toBeGreaterThanOrEqual(0);
    expect(pushIndex).toBeGreaterThan(commitIndex);
  });

  it("batches rapid PR review state transitions into one .conductor checkpoint commit", async () => {
    const harness = await createHarness({
      initialState: {
        conventionsSkill: "",
        currentItemIndex: 1,
        consecutivePasses: { A1: 2 },
        itemStatuses: { A1: "pass" },
        prReviewStep: "spec-free",
        prReviewConsecutivePasses: 1,
        status: "idle",
      },
      invocationScripts: {
        "pr-reviewer": [{ response: "PASS" }],
      },
    });

    await harness.run();

    expect(harness.trustedCommandCalls.filter((command) => command === "git add .conductor/")).toHaveLength(1);
    expect(harness.trustedCommandCalls.filter((command) => command === "git commit -m 'conductor: update state'")).toHaveLength(1);
    expect(harness.trustedCommandCalls.filter((command) => command === "git push").length).toBeGreaterThanOrEqual(1);
    expect(harness.orchestrator.getState().prReviewStep).toBe("done");
    expect(harness.orchestrator.getState().status).toBe("done");
  });

  it("persists spec-aware PR review progress across pause and resume", async () => {
    let releaseReview!: () => void;
    const waitForReview = new Promise<void>((resolve) => {
      releaseReview = resolve;
    });
    const harness = await createHarness({
      invocationScripts: {
        implementor: [{ response: "implemented" }],
        reviewer: [{ response: "PASS" }, { response: "PASS" }],
        "pr-reviewer": [
          { response: "PASS", waitFor: waitForReview },
          { response: "PASS" },
          { response: "PASS" },
          { response: "PASS" },
        ],
      },
    });

    const runPromise = harness.run();
    await waitFor(() => harness.invocationRecords.filter((record) => record.role === "pr-reviewer").length === 1);
    harness.orchestrator.pause();
    releaseReview();
    await runPromise;

    const pausedState = await harness.loadPersistedState();
    expect(pausedState.prReviewStep).toBe("spec-aware");
    expect(pausedState.prReviewConsecutivePasses).toBe(1);

    harness.orchestrator.resume();
    await waitFor(() => harness.orchestrator.getState().status === "done");
  });

  it("writes pr-reviewer audit entries and transcripts", async () => {
    const harness = await createHarness({
      persistTranscripts: true,
      invocationScripts: {
        implementor: [{ response: "implemented" }],
        reviewer: [{ response: "PASS" }, { response: "PASS" }],
        "pr-reviewer": [{ response: "PASS" }, { response: "PASS" }, { response: "PASS" }, { response: "PASS" }],
      },
    });

    await harness.run();

    const auditEntries = await readAudit(path.join(harness.workspaceDir, ".conductor"));
    const transcripts = await harness.orchestrator.getTranscripts();

    expect(auditEntries.some((entry) => entry.role === "pr-reviewer")).toBe(true);
    expect(transcripts.some((entry) => entry.role === "pr-reviewer")).toBe(true);
  });

  it("errors after max PR review retry cycles and records an error audit for pr-reviewer", async () => {
    const alwaysFail = `FAIL${JSON.stringify([{ file: "src/foo.ts", line: 10, description: "Still broken" }])}`;
    const harness = await createHarness({
      invocationScripts: {
        implementor: [
          { response: "implemented" },
          { response: "fix cycle 1" },
          { response: "fix cycle 2" },
          { response: "fix cycle 3" },
        ],
        reviewer: [{ response: "PASS" }, { response: "PASS" }],
        "pr-reviewer": [{ response: alwaysFail }, { response: alwaysFail }, { response: alwaysFail }],
      },
    });
    harness.config.maxRetries = 3;

    await harness.run();

    const auditEntries = await readAudit(path.join(harness.workspaceDir, ".conductor"));
    expect(harness.orchestrator.getState().status).toBe("error");
    expect(auditEntries.some((entry) => entry.role === "pr-reviewer" && entry.result === "error")).toBe(true);
  });

  it("pushes, requests Copilot re-review, and succeeds when the new review has no comments", async () => {
    const harness = await createHarness();

    harness.orchestrator.startCopilotReReview();

    await waitFor(async () => {
      const auditEntries = await readAudit(path.join(harness.workspaceDir, ".conductor"));
      return auditEntries.some((entry) => {
        return entry.itemId === "copilot-rereview"
          && entry.result === "PASS"
          && entry.promptSummary.includes("no unresolved Copilot comments");
      });
    });

    expect(harness.trustedCommandCalls).toContain("git push");
    expect(harness.trustedCommandCalls).toContain("gh api repos/wtsi-hgi/copilot-conductor/pulls/42/requested_reviewers -f reviewers[]=copilot");
    expect(harness.trustedCommandCalls).toContain("gh api repos/wtsi-hgi/copilot-conductor/pulls/42/reviews");
    expect(harness.trustedCommandCalls).toContain("gh api repos/wtsi-hgi/copilot-conductor/pulls/42/comments");
    expect(harness.invocationRecords).toHaveLength(0);
  });

  it("ignores resolved Copilot comments when deciding whether re-review work remains", async () => {
    const harness = await createHarness({
      trustedCommandResponses: {
        "gh api repos/wtsi-hgi/copilot-conductor/pulls/42/comments": [{
          success: true,
          output: "stdout:\n["
            + "{\"path\":\"src/foo.ts\",\"line\":10,\"body\":\"Already addressed\",\"pull_request_review_id\":700,\"resolved\":true,\"user\":{\"login\":\"copilot\"}}"
            + "]\nexit code: 0",
        }],
      },
    });

    harness.orchestrator.startCopilotReReview();

    await waitFor(async () => {
      const auditEntries = await readAudit(path.join(harness.workspaceDir, ".conductor"));
      return auditEntries.some((entry) => {
        return entry.itemId === "copilot-rereview"
          && entry.result === "PASS"
          && entry.promptSummary.includes("no unresolved Copilot comments");
      });
    });

    expect(harness.invocationRecords).toHaveLength(0);
  });

  it("dispatches implementor once per Copilot finding, commits fixes, and returns to the push step", async () => {
    const findings = JSON.stringify([
      { file: "src/foo.ts", line: 10, description: "Guard the undefined branch" },
      { file: "src/bar.ts", line: 22, description: "Handle the timeout path" },
    ]);
    const harness = await createHarness({
      invocationScripts: {
        implementor: [{ response: "fix finding 1" }, { response: "fix finding 2" }],
        "pr-reviewer": [{ response: `FAIL${findings}` }],
      },
      trustedCommandResponses: {
        "gh api repos/wtsi-hgi/copilot-conductor/pulls/42/comments": [
          {
            success: true,
            output: "stdout:\n["
              + "{\"path\":\"src/foo.ts\",\"line\":10,\"body\":\"Guard the undefined branch\",\"pull_request_review_id\":700,\"user\":{\"login\":\"copilot\"}}"
              + ","
              + "{\"path\":\"src/bar.ts\",\"line\":22,\"body\":\"Handle the timeout path\",\"pull_request_review_id\":700,\"user\":{\"login\":\"copilot\"}}"
              + "]\nexit code: 0",
          },
          { success: true, output: "stdout:\n[]\nexit code: 0" },
        ],
      },
    });

    harness.orchestrator.startCopilotReReview();

    await waitFor(async () => {
      const auditEntries = await readAudit(path.join(harness.workspaceDir, ".conductor"));
      return auditEntries.some((entry) => entry.itemId === "copilot-rereview" && entry.result === "PASS");
    });

    expect(harness.invocationRecords.filter((record) => record.role === "implementor")).toHaveLength(2);
    expect(harness.invocationRecords.some((record) => record.userPrompt.includes("Guard the undefined branch"))).toBe(true);
    expect(harness.invocationRecords.some((record) => record.userPrompt.includes("Handle the timeout path"))).toBe(true);
    expect(harness.trustedCommandCalls).toContain("git commit -m 'Fix PR review findings'");
    expect(harness.trustedCommandCalls.filter((command) => command === "git push").length).toBeGreaterThanOrEqual(3);
  });

  it("stages only Copilot re-review files and excludes unrelated dirty work", async () => {
    const harness = await createHarness({
      invocationScripts: {
        implementor: [{ response: "fix finding" }],
        "pr-reviewer": [{ response: `FAIL${JSON.stringify([{ file: "src/foo.ts", line: 10, description: "Guard the undefined branch" }])}` }],
      },
      trustedCommandResponses: {
        "gh api repos/wtsi-hgi/copilot-conductor/pulls/42/comments": [
          { success: true, output: "stdout:\n[{\"path\":\"src/foo.ts\",\"line\":10,\"body\":\"Guard the undefined branch\",\"pull_request_review_id\":700,\"user\":{\"login\":\"copilot\"}}]\nexit code: 0" },
          { success: true, output: "stdout:\n[]\nexit code: 0" },
        ],
        "git status --porcelain": [
          { success: true, output: "stdout:\n M src/main-pipeline.ts\nexit code: 0" },
          { success: true, output: "stdout:\n M src/main-pipeline.ts\n M src/foo.ts\n?? src/bar.ts\nexit code: 0" },
        ],
      },
    });

    harness.orchestrator.startCopilotReReview();

    await waitFor(async () => {
      const auditEntries = await readAudit(path.join(harness.workspaceDir, ".conductor"));
      return auditEntries.some((entry) => entry.itemId === "copilot-rereview" && entry.result === "PASS");
    });

    const stageCommand = harness.trustedCommandCalls.find((command) => command.startsWith("git add -- "));
    expect(stageCommand).toBeDefined();
    expect(stageCommand).toContain("'src/foo.ts'");
    expect(stageCommand).toContain("'src/bar.ts'");
    expect(stageCommand).not.toContain("src/main-pipeline.ts");
  });

  it("adds the holistic refactor instruction starting at cycle 3", async () => {
    const harness = await createHarness({
      invocationScripts: {
        implementor: [
          { response: "cycle 1 fix" },
          { response: "cycle 2 fix" },
          { response: "cycle 3 fix" },
        ],
        "pr-reviewer": [
          { response: `FAIL${JSON.stringify([{ file: "src/foo.ts", line: 10, description: "Issue 1" }])}` },
          { response: `FAIL${JSON.stringify([{ file: "src/foo.ts", line: 11, description: "Issue 2" }])}` },
          { response: `FAIL${JSON.stringify([{ file: "src/foo.ts", line: 12, description: "Issue 3" }])}` },
        ],
      },
      trustedCommandResponses: {
        "gh api repos/wtsi-hgi/copilot-conductor/pulls/42/comments": [
          { success: true, output: "stdout:\n[{\"path\":\"src/foo.ts\",\"line\":10,\"body\":\"Issue 1\",\"pull_request_review_id\":700,\"user\":{\"login\":\"copilot\"}}]\nexit code: 0" },
          { success: true, output: "stdout:\n[{\"path\":\"src/foo.ts\",\"line\":11,\"body\":\"Issue 2\",\"pull_request_review_id\":700,\"user\":{\"login\":\"copilot\"}}]\nexit code: 0" },
          { success: true, output: "stdout:\n[{\"path\":\"src/foo.ts\",\"line\":12,\"body\":\"Issue 3\",\"pull_request_review_id\":700,\"user\":{\"login\":\"copilot\"}}]\nexit code: 0" },
          { success: true, output: "stdout:\n[]\nexit code: 0" },
        ],
      },
    });

    harness.orchestrator.startCopilotReReview();

    await waitFor(() => harness.invocationRecords.filter((record) => record.role === "implementor").length === 3);

    const implementorCalls = harness.invocationRecords.filter((record) => record.role === "implementor");
    expect(implementorCalls[2]?.userPrompt).toContain("Consider the problem holistically.");
  });

  it("stops after 20 cycles and reports manual review needed", async () => {
    const commentResponses = Array.from({ length: 20 }, (_, index) => ({
      success: true,
      output: `stdout:\n[{\"path\":\"src/foo.ts\",\"line\":${index + 1},\"body\":\"Repeat issue ${index + 1}\",\"pull_request_review_id\":700,\"user\":{\"login\":\"copilot\"}}]\nexit code: 0`,
    }));
    const harness = await createHarness({
      invocationScripts: {
        implementor: Array.from({ length: 20 }, (_, index) => ({ response: `fix cycle ${index + 1}` })),
        "pr-reviewer": Array.from({ length: 20 }, (_, index) => ({
          response: `FAIL${JSON.stringify([{ file: "src/foo.ts", line: index + 1, description: `Repeat issue ${index + 1}` }])}`,
        })),
      },
      trustedCommandResponses: {
        "gh api repos/wtsi-hgi/copilot-conductor/pulls/42/comments": commentResponses,
      },
    });

    harness.orchestrator.startCopilotReReview();

    await waitFor(async () => {
      const auditEntries = await readAudit(path.join(harness.workspaceDir, ".conductor"));
      return auditEntries.some((entry) => {
        return entry.itemId === "copilot-rereview"
          && entry.result === "FAIL"
          && entry.promptSummary.includes("manual review needed");
      });
    });

    expect(harness.invocationRecords.filter((record) => record.role === "implementor")).toHaveLength(20);
  });

  it("reports a push verification timeout when the remote branch never reaches local HEAD", async () => {
    const harness = await createHarness({
      trustedCommandResponses: {
        "git ls-remote origin 'refs/heads/feature/test'": Array.from({ length: 11 }, () => ({
          success: true,
          output: "stdout:\ndef456\trefs/heads/feature/test\nexit code: 0",
        })),
      },
    });

    harness.orchestrator.startCopilotReReview();

    await waitFor(async () => {
      const auditEntries = await readAudit(path.join(harness.workspaceDir, ".conductor"));
      return auditEntries.some((entry) => entry.promptSummary.includes("push verification timeout"));
    });

    expect(harness.trustedCommandCalls).not.toContain("gh api repos/wtsi-hgi/copilot-conductor/pulls/42/requested_reviewers -f reviewers[]=copilot");
  });

  it("reports a review wait timeout when Copilot never submits a new review", async () => {
    const harness = await createHarness({
      trustedCommandResponses: {
        "gh api repos/wtsi-hgi/copilot-conductor/pulls/42/reviews": Array.from({ length: 41 }, () => ({
          success: true,
          output: "stdout:\n[]\nexit code: 0",
        })),
      },
    });

    harness.orchestrator.startCopilotReReview();

    await waitFor(async () => {
      const auditEntries = await readAudit(path.join(harness.workspaceDir, ".conductor"));
      return auditEntries.some((entry) => entry.promptSummary.includes("review wait timeout"));
    });
  });

  it("reports gh CLI not found when gh is unavailable", async () => {
    const harness = await createHarness({
      trustedCommandResponses: {
        "command -v gh": [{
          success: false,
          output: "stderr:\ngh: command not found\nexit code: 127",
          error: "command exited with code 127",
        }],
      },
    });

    harness.orchestrator.startCopilotReReview();

    await waitFor(async () => {
      const auditEntries = await readAudit(path.join(harness.workspaceDir, ".conductor"));
      return auditEntries.some((entry) => entry.promptSummary === "gh CLI not found");
    });
  });

  it("runs independently of the main pipeline when triggered during an active run", async () => {
    let releaseImplementor!: () => void;
    const waitForImplementor = new Promise<void>((resolve) => {
      releaseImplementor = resolve;
    });
    const harness = await createHarness({
      invocationScripts: {
        implementor: [{ response: "implemented", waitFor: waitForImplementor }],
        reviewer: [{ response: "PASS" }, { response: "PASS" }],
        "pr-reviewer": [{ response: "PASS" }, { response: "PASS" }, { response: "PASS" }, { response: "PASS" }],
      },
    });

    const runPromise = harness.run();
    await waitFor(() => harness.invocationRecords.filter((record) => record.role === "implementor").length === 1);

    harness.orchestrator.startCopilotReReview();

    await waitFor(async () => {
      const auditEntries = await readAudit(path.join(harness.workspaceDir, ".conductor"));
      return auditEntries.some((entry) => entry.itemId === "copilot-rereview" && entry.result === "PASS");
    });

    expect(harness.orchestrator.getState().status).toBe("running");

    releaseImplementor();
    await runPromise;
  });

  it("writes pr-reviewer audit entries for the Copilot re-review loop", async () => {
    const harness = await createHarness({
      invocationScripts: {
        implementor: [{ response: "fix finding" }],
        "pr-reviewer": [{ response: `FAIL${JSON.stringify([{ file: "src/foo.ts", line: 10, description: "Fix the branch guard" }])}` }],
      },
      trustedCommandResponses: {
        "gh api repos/wtsi-hgi/copilot-conductor/pulls/42/comments": [
          { success: true, output: "stdout:\n[{\"path\":\"src/foo.ts\",\"line\":10,\"body\":\"Fix the branch guard\",\"pull_request_review_id\":700,\"user\":{\"login\":\"copilot\"}}]\nexit code: 0" },
          { success: true, output: "stdout:\n[]\nexit code: 0" },
        ],
      },
    });

    harness.orchestrator.startCopilotReReview();

    await waitFor(async () => {
      const auditEntries = await readAudit(path.join(harness.workspaceDir, ".conductor"));
      return auditEntries.some((entry) => entry.itemId === "copilot-rereview" && entry.result === "PASS");
    });

    const auditEntries = await readAudit(path.join(harness.workspaceDir, ".conductor"));
    expect(auditEntries.some((entry) => entry.role === "pr-reviewer" && entry.itemId.startsWith("copilot-rereview"))).toBe(true);
  });
});
