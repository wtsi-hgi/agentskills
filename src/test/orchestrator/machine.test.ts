import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createOrchestrator } from "../../orchestrator/machine";
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

type AddendumRecord = {
  itemId: string;
  deviation: string;
  rationale: string;
  author?: string;
};

type MachineHarness = {
  workspaceDir: string;
  config: OrchestratorConfig;
  invocationRecords: InvocationRecord[];
  addendumRecords: AddendumRecord[];
  testCommandCalls: string[];
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
  addendumRecords: AddendumRecord[];
  testCommandCalls: string[];
  selectCalls: Array<{ role: Role; family: string }>;
};

const dirsToCleanup: string[] = [];

const DEFAULT_ASSIGNMENTS: ModelAssignment[] = [
  { role: "implementor", vendor: "copilot", family: "gpt-5.4" },
  { role: "reviewer", vendor: "copilot", family: "gpt-4.1" },
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
    phaseContent?: string;
    phaseFiles?: Record<number, string>;
    createSpec?: boolean;
    createPrompt?: boolean;
    promptContent?: string;
  },
): Promise<void> {
  const specDir = path.join(workspaceDir, ".docs", "conductor");
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

  await writeFile(path.join(skillsDir, "test-conventions", "SKILL.md"), "# test conventions\n", "utf8");
  await writeFile(path.join(skillsDir, "test-implementor", "SKILL.md"), "# implementor skill\n", "utf8");
  await writeFile(path.join(skillsDir, "test-reviewer", "SKILL.md"), "# reviewer skill\n", "utf8");
}

function createHarnessRuntime(): HarnessRuntime {
  return {
    invocationRecords: [],
    addendumRecords: [],
    testCommandCalls: [],
    selectCalls: [],
  };
}

function createOrchestratorOverrides(
  runtime: HarnessRuntime,
  options?: {
    invocationScripts?: Partial<Record<Role, ScriptedInvocation[]>>;
    executeResults?: TestCommandResult[];
    persistTranscripts?: boolean;
  },
): Parameters<typeof createOrchestrator>[2] {
  const invocationQueues = {
    implementor: [...(options?.invocationScripts?.implementor ?? [])],
    reviewer: [...(options?.invocationScripts?.reviewer ?? [])],
    "spec-author": [...(options?.invocationScripts?.["spec-author"] ?? [])],
    "spec-reviewer": [...(options?.invocationScripts?.["spec-reviewer"] ?? [])],
    "spec-proofreader": [...(options?.invocationScripts?.["spec-proofreader"] ?? [])],
    "phase-creator": [...(options?.invocationScripts?.["phase-creator"] ?? [])],
    "phase-reviewer": [...(options?.invocationScripts?.["phase-reviewer"] ?? [])],
  } satisfies Record<Role, ScriptedInvocation[]>;

  const executeResults = [...(options?.executeResults ?? [])];

  const overrides: Parameters<typeof createOrchestrator>[2] = {
    async selectModelForRole(role, assignments) {
      const family = assignments.find((assignment) => assignment.role === role)?.family ?? "unknown";
      runtime.selectCalls.push({ role, family });
      return { family, role } as never;
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
      runtime.testCommandCalls.push(command);
      return executeResults.shift() ?? { success: true, output: "stdout:\npass\nexit code: 0" };
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
  phaseContent?: string;
  phaseFiles?: Record<number, string>;
  createSpec?: boolean;
  createPrompt?: boolean;
  promptContent?: string;
  invocationScripts?: Partial<Record<Role, ScriptedInvocation[]>>;
  executeResults?: TestCommandResult[];
  initialState?: Partial<OrchestratorState>;
  modelAssignments?: ModelAssignment[];
  persistTranscripts?: boolean;
}): Promise<MachineHarness> {
  const workspaceDir = await createWorkspace();
  await writeFixtureFiles(workspaceDir, {
    phaseContent: options?.phaseContent,
    phaseFiles: options?.phaseFiles,
    createSpec: options?.createSpec,
    createPrompt: options?.createPrompt,
    promptContent: options?.promptContent,
  });

  const config: OrchestratorConfig = {
    specDir: path.join(workspaceDir, ".docs", "conductor"),
    projectDir: workspaceDir,
    skillsDir: path.join(workspaceDir, "skills"),
    conventionsSkill: "test-conventions",
    modelAssignments: (options?.modelAssignments ?? DEFAULT_ASSIGNMENTS)
      .map((assignment) => ({ ...assignment })),
    maxTurns: 5,
    maxRetries: 2,
    testCommand: "npm test",
    requireApproval: false,
  };

  if (options?.initialState) {
    await saveState(path.join(workspaceDir, ".conductor"), {
      specDir: config.specDir,
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
    config,
    invocationRecords: runtime.invocationRecords,
    addendumRecords: runtime.addendumRecords,
    testCommandCalls: runtime.testCommandCalls,
    selectCalls: runtime.selectCalls,
    orchestrator,
    run: () => orchestrator.run(createToken() as never),
    submitClarification: (answers) => orchestrator.submitClarification(answers),
    loadPersistedState: () => loadState(path.join(workspaceDir, ".conductor")),
    readPhaseFile: (phaseNumber = 1) => readFile(path.join(workspaceDir, ".docs", "conductor", `phase${phaseNumber}.md`), "utf8"),
    readPromptFile: () => readFile(path.join(workspaceDir, ".docs", "conductor", "prompt.md"), "utf8"),
  };
}

afterEach(async () => {
  await Promise.all(dirsToCleanup.splice(0).map(async (dirPath) => rm(dirPath, { recursive: true, force: true })));
});

describe("createOrchestrator", () => {
  it("starts in clarifying mode from prompt.md and invokes the clarification prompt with conventions context", async () => {
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
    expect(harness.invocationRecords[0]?.systemPrompt).toContain("# test conventions");
    expect(harness.invocationRecords[0]?.userPrompt).toContain("Add the requested orchestration feature.");
    expect(harness.orchestrator.getState().specStep).toBe("done");
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
    expect(proofreaderCall?.userPrompt).toContain(`${harness.config.specDir}/spec.md`);
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
      specDir: path.join(workspaceDir, ".docs", "conductor"),
      projectDir: workspaceDir,
      skillsDir: path.join(workspaceDir, "skills"),
      conventionsSkill: "test-conventions",
      modelAssignments: DEFAULT_ASSIGNMENTS.map((assignment) => ({ ...assignment })),
      maxTurns: 5,
      maxRetries: 2,
      testCommand: "npm test",
      requireApproval: false,
    };

    await saveState(path.join(workspaceDir, ".conductor"), {
      specDir: config.specDir,
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
        },
      }),
    );

    orchestrator.resume();
    await waitFor(() => orchestrator.getState().itemStatuses.A2 === "pass");

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
});
