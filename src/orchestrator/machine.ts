import { readFile, readdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type * as vscode from "vscode";

import { assembleSystemPrompt, buildClarificationSystemPrompt } from "../llm/prompts";
import { invokeWithToolLoop } from "../llm/invoke";
import { selectModelForRole } from "../llm/select";
import { parsePhaseFile } from "./parser";
import { appendAddendum, readAddenda } from "../state/addendum";
import { appendAudit, readAudit } from "../state/audit";
import { loadState, saveState } from "../state/persistence";
import { loadTranscripts, saveTranscript } from "../state/transcript";
import { executeBash } from "../tools/bash";
import { getToolDefinitions } from "../tools/schema";
import type {
  AddendumEntry,
  AuditRole,
  AuditEntry,
  ClarificationAnswer,
  ClarificationQuestion,
  InvocationResult,
  OrchestratorConfig,
  OrchestratorState,
  Phase,
  PhaseItem,
  Role,
  RunTranscript,
  SpecStep,
  TranscriptMessage,
} from "../types";

const CONDUCTOR_DIR = ".conductor";

const SPEC_APPROVAL_SENTINEL = "__spec__";

type ApprovalAction =
  | { type: "approve" }
  | { type: "reject"; feedback: string }
  | { type: "skip" };

type ProcessingOutcome = "completed" | "interrupted";

type OrchestratorDependencies = {
  readFile: typeof readFile;
  readDirectory: typeof readdir;
  writeFile: typeof writeFile;
  loadState: typeof loadState;
  saveState: typeof saveState;
  appendAudit: typeof appendAudit;
  readAudit: typeof readAudit;
  appendAddendum: typeof appendAddendum;
  readAddenda: typeof readAddenda;
  saveTranscript: typeof saveTranscript;
  loadTranscripts: typeof loadTranscripts;
  selectModelForRole: typeof selectModelForRole;
  assembleSystemPrompt: typeof assembleSystemPrompt;
  invokeWithToolLoop: typeof invokeWithToolLoop;
  executeBash: typeof executeBash;
  now: () => string;
  getDiff: (itemIds: string[]) => Promise<string>;
};

export interface Orchestrator {
  run(token: vscode.CancellationToken): Promise<void>;
  pause(): void;
  resume(): void;
  skip(itemId: string): void;
  retry(itemId: string): void;
  changeModel(role: Role, vendor: string, family: string): void;
  approve(itemId: string): void;
  reject(itemId: string, feedback: string): void;
  submitClarification(answers: ClarificationAnswer[]): void;
  addNote(itemId: string, text: string, author?: string): void;
  getState(): OrchestratorState;
  getPhase(): Promise<Phase>;
  getPhases(): Promise<Phase[]>;
  getAuditEntries(): Promise<AuditEntry[]>;
  getAddendumEntries(): Promise<AddendumEntry[]>;
  getTranscripts(): Promise<RunTranscript[]>;
  onStateChange: vscode.Event<OrchestratorState>;
  onAuditEntry: vscode.Event<AuditEntry>;
  onAddendum: vscode.Event<AddendumEntry>;
  onTranscript: vscode.Event<RunTranscript>;
}

class SimpleEventEmitter<T> {
  private readonly listeners = new Set<(value: T) => void>();

  public readonly event = (listener: (value: T) => void): { dispose(): void } => {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  };

  public fire(value: T): void {
    for (const listener of [...this.listeners]) {
      listener(value);
    }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createDefaultState(config: OrchestratorConfig): OrchestratorState {
  return {
    specDir: config.specDir,
    currentPhase: 1,
    currentItemIndex: 0,
    consecutivePasses: {},
    specStep: "done",
    specConsecutivePasses: 0,
    specPhaseFileIndex: 0,
    clarificationQuestions: [],
    status: "idle",
    modelAssignments: config.modelAssignments.map((assignment) => ({ ...assignment })),
    itemStatuses: {},
  };
}

function cloneState(state: OrchestratorState): OrchestratorState {
  return {
    ...state,
    consecutivePasses: { ...state.consecutivePasses },
    clarificationQuestions: state.clarificationQuestions.map((question) => ({
      question: question.question,
      suggestedOptions: [...question.suggestedOptions],
    })),
    modelAssignments: state.modelAssignments.map((assignment) => ({ ...assignment })),
    itemStatuses: { ...state.itemStatuses },
  };
}

function clonePhase(phase: Phase): Phase {
  return {
    number: phase.number,
    title: phase.title,
    items: phase.items.map((item) => ({ ...item })),
    batches: phase.batches.map((batch) => batch.map((item) => ({ ...item }))),
  };
}

function haveSameModelAssignments(left: OrchestratorState["modelAssignments"], right: OrchestratorState["modelAssignments"]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((assignment, index) => {
    const candidate = right[index];
    return assignment.role === candidate?.role
      && assignment.vendor === candidate.vendor
      && assignment.family === candidate.family;
  });
}

function getVerdict(result: InvocationResult): "PASS" | "FAIL" | "error" {
  const normalized = result.response.trim().toUpperCase();
  if (normalized.startsWith("PASS")) {
    return "PASS";
  }
  if (normalized.startsWith("FAIL") || normalized.startsWith("FIXED")) {
    return "FAIL";
  }
  return "error";
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR");
}

function normalizeSpecStep(step: unknown): SpecStep {
  if (
    step === "clarifying"
    || step === "authoring"
    || step === "reviewing"
    || step === "proofreading"
    || step === "creating-phases"
    || step === "reviewing-phases"
    || step === "done"
  ) {
    return step;
  }

  return "done";
}

function deriveImplementationSkillName(role: "implementor" | "reviewer", conventionsSkill: string): string {
  if (!conventionsSkill.endsWith("-conventions")) {
    return role;
  }

  return `${conventionsSkill.slice(0, -"-conventions".length)}-${role}`;
}

function parseSpecStepResult(response: string): "PASS" | "FAIL" | "FIXED" | "NONE" | "error" {
  const normalized = response.trim().toUpperCase();
  if (normalized.startsWith("PASS")) {
    return "PASS";
  }
  if (normalized.startsWith("FAIL")) {
    return "FAIL";
  }
  if (normalized.startsWith("FIXED")) {
    return "FIXED";
  }
  if (normalized === "NONE" || normalized.startsWith("NONE")) {
    return "NONE";
  }
  return "error";
}

function extractClarificationQuestions(response: string): ClarificationQuestion[] | null {
  const trimmed = response.trim();
  if (trimmed.length === 0 || parseSpecStepResult(trimmed) === "NONE") {
    return [];
  }

  const candidates = [trimmed];
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/u);
  if (fencedMatch?.[1]) {
    candidates.push(fencedMatch[1].trim());
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (!Array.isArray(parsed)) {
        continue;
      }

      return parsed
        .filter((entry): entry is { question: string; suggestedOptions?: unknown } => {
          return typeof entry === "object" && entry !== null && typeof entry.question === "string";
        })
        .map((entry) => ({
          question: entry.question,
          suggestedOptions: Array.isArray(entry.suggestedOptions)
            ? entry.suggestedOptions.filter((option): option is string => typeof option === "string")
            : [],
        }));
    } catch {
      continue;
    }
  }

  return null;
}

function truncatePromptSummary(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > 160 ? `${collapsed.slice(0, 157)}...` : collapsed;
}

function normalizeMarkdownSpacing(text: string): string {
  return text.replace(/\s+$/u, "");
}

function formatClarificationNote(answer: ClarificationAnswer): string {
  const question = answer.question.trim().replace(/\s+/gu, " ");
  const normalizedAnswer = answer.answer.trim().replace(/\s+/gu, " ");
  return `- \`Clarification: ${question} => ${normalizedAnswer}\``;
}

function appendNotesSection(promptContent: string, noteLines: string[]): string {
  const normalizedPrompt = normalizeMarkdownSpacing(promptContent);
  const notesBlock = noteLines.join("\n");
  const notesHeadingPattern = /^## Notes\s*$/mu;
  const headingMatch = notesHeadingPattern.exec(normalizedPrompt);

  if (!headingMatch || headingMatch.index === undefined) {
    const separator = normalizedPrompt.length === 0 ? "" : "\n\n";
    return `${normalizedPrompt}${separator}## Notes\n\n${notesBlock}\n`;
  }

  const insertStart = headingMatch.index + headingMatch[0].length;
  const remainder = normalizedPrompt.slice(insertStart);
  const nextHeadingOffset = remainder.search(/^##\s/mu);

  if (nextHeadingOffset < 0) {
    const suffix = remainder.trim().length === 0 ? "\n\n" : "\n";
    return `${normalizedPrompt}${suffix}${notesBlock}\n`;
  }

  const beforeNextHeading = remainder.slice(0, nextHeadingOffset).replace(/\s*$/u, "");
  const afterNextHeading = remainder.slice(nextHeadingOffset).replace(/^\n*/u, "");
  return `${normalizedPrompt.slice(0, insertStart)}\n\n${beforeNextHeading}${beforeNextHeading.length > 0 ? "\n" : ""}${notesBlock}\n\n${afterNextHeading}`;
}

function buildTranscript(
  timestamp: string,
  role: AuditRole,
  model: string,
  itemId: string,
  systemPrompt: string,
  userPrompt: string,
  resultMessages: TranscriptMessage[],
): RunTranscript {
  return {
    timestamp,
    role,
    model,
    itemId,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
      ...resultMessages,
    ],
  };
}

function buildAuditEntry(
  timestamp: string,
  role: AuditRole,
  model: string,
  itemId: string,
  promptSummary: string,
  result: InvocationResult,
): AuditEntry {
  return {
    timestamp,
    role,
    model,
    itemId,
    promptSummary: truncatePromptSummary(promptSummary),
    result: getVerdict(result),
    tokensIn: result.totalTokensIn,
    tokensOut: result.totalTokensOut,
    durationMs: 0,
  };
}

function buildManualAddendumEntry(timestamp: string, itemId: string, text: string, author?: string): AddendumEntry {
  return {
    timestamp,
    itemId,
    deviation: text,
    rationale: text,
    author,
  };
}

function extractSpecSection(specContent: string, section: string): string {
  const headingPattern = new RegExp(`^### ${escapeRegExp(section)}:.*$`, "m");
  const match = specContent.match(headingPattern);
  if (!match || match.index === undefined) {
    return "";
  }

  const start = match.index;
  const remainder = specContent.slice(start);
  const nextHeadingOffset = remainder.slice(match[0].length).search(/^###\s/m);
  if (nextHeadingOffset < 0) {
    return remainder.trim();
  }

  return remainder.slice(0, match[0].length + nextHeadingOffset).trim();
}

async function updatePhaseFileCheckboxes(
  deps: OrchestratorDependencies,
  phasePath: string,
  itemId: string,
): Promise<void> {
  const content = await deps.readFile(phasePath, "utf8");
  const lines = content.split(/\r?\n/);
  const itemHeaderPattern = new RegExp(`^(###|####) Item .*: ${escapeRegExp(itemId)} - `);
  let inItem = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (itemHeaderPattern.test(line)) {
      inItem = true;
      continue;
    }

    if (inItem && /^#{3,4}\s/.test(line)) {
      inItem = false;
    }

    if (!inItem) {
      continue;
    }

    if (/^- \[[ xX]\] implemented$/.test(line)) {
      lines[index] = "- [x] implemented";
      continue;
    }

    if (/^- \[[ xX]\] reviewed$/.test(line)) {
      lines[index] = "- [x] reviewed";
    }
  }

  await deps.writeFile(phasePath, `${lines.join("\n")}${content.endsWith("\n") ? "" : "\n"}`, "utf8");
}

function getBatchItems(phase: Phase, item: PhaseItem): PhaseItem[] {
  if (item.batch === undefined) {
    return [item];
  }

  return phase.batches.find((batch) => batch.some((candidate) => candidate.id === item.id)) ?? [item];
}

function createFallbackToken(): vscode.CancellationToken {
  return {
    isCancellationRequested: false,
    onCancellationRequested: () => ({
      dispose() {
      },
    }),
  };
}

export function createOrchestrator(
  config: OrchestratorConfig,
  _context: vscode.ExtensionContext,
  overrides: Partial<OrchestratorDependencies> = {},
): Orchestrator {
  const conductorDir = path.join(config.projectDir, CONDUCTOR_DIR);
  const promptPath = path.join(config.specDir, "prompt.md");
  const specPath = path.join(config.specDir, "spec.md");
  const stateEmitter = new SimpleEventEmitter<OrchestratorState>();
  const auditEmitter = new SimpleEventEmitter<AuditEntry>();
  const addendumEmitter = new SimpleEventEmitter<AddendumEntry>();
  const transcriptEmitter = new SimpleEventEmitter<RunTranscript>();
  const deps: OrchestratorDependencies = {
    readFile,
    readDirectory: readdir,
    writeFile,
    loadState,
    saveState,
    appendAudit,
    readAudit,
    appendAddendum,
    readAddenda,
    saveTranscript,
    loadTranscripts,
    selectModelForRole,
    assembleSystemPrompt,
    invokeWithToolLoop,
    executeBash,
    now: () => new Date().toISOString(),
    getDiff: async (itemIds) => {
      const diffResult = await executeBash("git diff -- .", config.projectDir);
      const sections = [`Items: ${itemIds.join(", ")}`];

      if (diffResult.output.trim().length > 0) {
        sections.push(diffResult.output.trim());
      }

      if (diffResult.error) {
        sections.push(`diff error: ${diffResult.error}`);
      }

      return sections.join("\n\n");
    },
    ...overrides,
  };

  let state = createDefaultState(config);
  let initialized = false;
  let activeRun: Promise<void> | undefined;
  let lastToken: vscode.CancellationToken | undefined;
  let cachedPhase: Phase | undefined;
  let cachedPhaseNumber: number | undefined;
  let cachedPhasePath: string | undefined;
  let cachedSpecContent = "";
  let pauseRequested = false;
  let persistChain = Promise.resolve();
  let visibleState = cloneState(state);
  const itemFeedback = new Map<string, string>();
  const specFeedback = new Map<SpecStep, string>();
  const approvalResolvers = new Map<string, (action: ApprovalAction) => void>();
  const approvalGroups = new Map<string, string[]>();
  let specApprovalResolver: ((action: ApprovalAction) => void) | undefined;
  let pendingSpecApprovalStep: SpecStep | undefined;
  const fallbackToken = createFallbackToken();

  const emitState = () => {
    stateEmitter.fire(cloneState(visibleState));
  };

  const emitAudit = (entry: AuditEntry) => {
    auditEmitter.fire(entry);
  };

  const emitAddendum = (entry: AddendumEntry) => {
    addendumEmitter.fire(entry);
  };

  const emitTranscript = (transcript: RunTranscript) => {
    transcriptEmitter.fire(transcript);
  };

  const pathExists = async (filePath: string): Promise<boolean> => {
    try {
      await deps.readFile(filePath, "utf8");
      return true;
    } catch (error) {
      if (isMissingPathError(error)) {
        return false;
      }
      throw error;
    }
  };

  const readOptionalFile = async (filePath: string): Promise<string | undefined> => {
    try {
      return await deps.readFile(filePath, "utf8");
    } catch (error) {
      if (isMissingPathError(error)) {
        return undefined;
      }
      throw error;
    }
  };

  const invalidatePhaseCache = () => {
    cachedPhase = undefined;
    cachedPhaseNumber = undefined;
    cachedPhasePath = undefined;
  };

  const getSortedPhaseFiles = async (): Promise<string[]> => {
    const entries = await deps.readDirectory(config.specDir);
    return entries
      .filter((entry) => /^phase\d+\.md$/i.test(entry))
      .sort((left, right) => {
        const leftNumber = Number.parseInt(left.replace(/\D+/g, ""), 10);
        const rightNumber = Number.parseInt(right.replace(/\D+/g, ""), 10);
        return leftNumber - rightNumber;
      })
      .map((entry) => path.join(config.specDir, entry));
  };

  const getPhasePath = (phaseNumber: number): string => path.join(config.specDir, `phase${phaseNumber}.md`);

  const loadAllPhases = async (): Promise<Phase[]> => {
    const entries = await deps.readDirectory(config.specDir);
    const phaseFiles = entries
      .filter((entry) => /^phase\d+\.md$/i.test(entry))
      .sort((left, right) => {
        const leftNumber = Number.parseInt(left.replace(/\D+/g, ""), 10);
        const rightNumber = Number.parseInt(right.replace(/\D+/g, ""), 10);
        return leftNumber - rightNumber;
      });

    const phases = await Promise.all(phaseFiles.map(async (entry) => {
      return parsePhaseFile(await deps.readFile(path.join(config.specDir, entry), "utf8"));
    }));

    return phases.filter((phase) => phase.number > 0);
  };

  const ensurePhaseLoaded = async () => {
    const phaseNumber = state.currentPhase > 0 ? state.currentPhase : 1;
    const phasePath = getPhasePath(phaseNumber);
    if (cachedPhase && cachedPhaseNumber === phaseNumber && cachedPhasePath === phasePath) {
      return;
    }

    const phaseContent = await readOptionalFile(phasePath);
    cachedPhase = phaseContent ? parsePhaseFile(phaseContent) : undefined;
    cachedPhaseNumber = phaseNumber;
    cachedPhasePath = phasePath;
  };

  const persistState = async () => {
    const snapshot = cloneState(state);
    persistChain = persistChain.then(async () => {
      await deps.saveState(conductorDir, snapshot);
      visibleState = cloneState(snapshot);
      emitState();
    });
    await persistChain;
  };

  const ensureInitialized = async () => {
    if (initialized) {
      return;
    }

    const loaded = await deps.loadState(conductorDir);
    const defaultState = createDefaultState(config);
    const hasPersistedState = loaded.specDir.length > 0;
    const persistedState = hasPersistedState ? loaded : defaultState;
    const hasPersistedSpecStep = hasPersistedState && Object.prototype.hasOwnProperty.call(loaded, "specStep");
    const currentHasAssignmentOverrides = !haveSameModelAssignments(state.modelAssignments, defaultState.modelAssignments);
    const currentHasConsecutivePasses = Object.keys(state.consecutivePasses).length > 0;
    const currentHasItemStatuses = Object.keys(state.itemStatuses).length > 0;
    const specExists = await pathExists(specPath);
    const promptExists = await pathExists(promptPath);
    state = {
      ...defaultState,
      ...persistedState,
      specDir: persistedState.specDir || defaultState.specDir,
      currentPhase: persistedState.currentPhase > 0 ? persistedState.currentPhase : defaultState.currentPhase,
      currentItemIndex: typeof persistedState.currentItemIndex === "number"
        ? persistedState.currentItemIndex
        : defaultState.currentItemIndex,
      status: persistedState.status ?? defaultState.status,
      modelAssignments: (currentHasAssignmentOverrides
        ? state.modelAssignments
        : persistedState.modelAssignments.length > 0
        ? persistedState.modelAssignments
        : defaultState.modelAssignments).map((assignment) => ({ ...assignment })),
      consecutivePasses: currentHasConsecutivePasses
        ? { ...state.consecutivePasses }
        : { ...(persistedState.consecutivePasses ?? {}) },
      specStep: hasPersistedSpecStep
        ? normalizeSpecStep(persistedState.specStep)
        : specExists
        ? "done"
        : promptExists
        ? "clarifying"
        : defaultState.specStep,
      specConsecutivePasses: typeof persistedState.specConsecutivePasses === "number"
        ? persistedState.specConsecutivePasses
        : defaultState.specConsecutivePasses,
      specPhaseFileIndex: typeof persistedState.specPhaseFileIndex === "number"
        ? persistedState.specPhaseFileIndex
        : defaultState.specPhaseFileIndex,
      clarificationQuestions: Array.isArray(persistedState.clarificationQuestions)
        ? persistedState.clarificationQuestions.map((question) => ({
          question: typeof question?.question === "string" ? question.question : "",
          suggestedOptions: Array.isArray(question?.suggestedOptions)
            ? question.suggestedOptions.filter((option): option is string => typeof option === "string")
            : [],
        })).filter((question) => question.question.length > 0)
        : [],
      itemStatuses: currentHasItemStatuses
        ? { ...state.itemStatuses }
        : { ...(persistedState.itemStatuses ?? {}) },
      startedBy: persistedState.startedBy ?? defaultState.startedBy,
    };

    cachedSpecContent = (await readOptionalFile(specPath)) ?? "";
    if (state.specStep === "done" && specExists) {
      await ensurePhaseLoaded();
    } else {
      invalidatePhaseCache();
    }
    visibleState = cloneState(state);
    initialized = true;
  };

  const getItemIndex = (itemId: string): number => cachedPhase?.items.findIndex((item) => item.id === itemId) ?? -1;

  const setItemStatus = async (itemId: string, nextStatus: OrchestratorState["itemStatuses"][string]) => {
    state.itemStatuses[itemId] = nextStatus;
    await persistState();
  };

  const invokePreparedPrompt = async (
    selectionRole: Role,
    auditRole: AuditRole,
    itemId: string,
    systemPrompt: string,
    userPrompt: string,
    token: vscode.CancellationToken,
  ): Promise<InvocationResult> => {
    const model = await deps.selectModelForRole(selectionRole, state.modelAssignments);
    const modelLabel = `${auditRole}:${String((model as { family?: string }).family ?? "unknown")}`;
    const timestamp = deps.now();
    const result = await deps.invokeWithToolLoop(model, systemPrompt, userPrompt, config.projectDir, {
      maxTurns: config.maxTurns,
      token,
    });

    const transcript = buildTranscript(timestamp, auditRole, modelLabel, itemId, systemPrompt, userPrompt, result.messages);
    const auditEntry = buildAuditEntry(timestamp, auditRole, modelLabel, itemId, userPrompt, result);

    await deps.saveTranscript(conductorDir, transcript);
    emitTranscript(transcript);
    await deps.appendAudit(conductorDir, auditEntry);
    emitAudit(auditEntry);

    if (auditRole === "reviewer" && result.addendum) {
      const addendumEntry = {
        timestamp,
        itemId,
        deviation: result.addendum,
        rationale: result.addendum,
        author: "reviewer",
      } satisfies AddendumEntry;

      await deps.appendAddendum(conductorDir, addendumEntry);
      emitAddendum(addendumEntry);
    }

    return result;
  };

  const invokeRole = async (
    role: Role,
    itemId: string,
    itemContext: string,
    userPrompt: string,
    token: vscode.CancellationToken,
  ): Promise<InvocationResult> => {
    const systemPrompt = await deps.assembleSystemPrompt(
      role,
      config.skillsDir,
      config.conventionsSkill,
      itemContext,
      getToolDefinitions(),
    );

    return await invokePreparedPrompt(role, role, itemId, systemPrompt, userPrompt, token);
  };

  const failSpecStep = async (step: SpecStep, role: Role, message: string) => {
    state.specStep = step;
    state.status = "error";
    await persistState();

    const auditEntry = {
      timestamp: deps.now(),
      role,
      model: "system",
      itemId: `phase0:${step}`,
      promptSummary: truncatePromptSummary(message),
      result: "error",
      tokensIn: 0,
      tokensOut: 0,
      durationMs: 0,
    } satisfies AuditEntry;

    await deps.appendAudit(conductorDir, auditEntry);
    emitAudit(auditEntry);
  };

  const waitForSpecApproval = async (step: SpecStep): Promise<ApprovalAction> => {
    pendingSpecApprovalStep = step;
    state.status = "pending-approval";
    await persistState();

    return await new Promise<ApprovalAction>((resolve) => {
      specApprovalResolver = resolve;
    });
  };

  const handleSpecApproval = async (step: SpecStep, nextStep: SpecStep): Promise<"approved" | "rejected" | "skipped"> => {
    const action = await waitForSpecApproval(step);
    specApprovalResolver = undefined;
    pendingSpecApprovalStep = undefined;
    state.status = "running";

    if (action.type === "approve") {
      state.specConsecutivePasses = 0;
      state.specStep = nextStep;
      await persistState();
      return "approved";
    }

    if (action.type === "skip") {
      state.specConsecutivePasses = 0;
      state.specStep = "done";
      await persistState();
      return "skipped";
    }

    state.specConsecutivePasses = 0;
    specFeedback.set(step, action.feedback);

    if (step === "reviewing") {
      specFeedback.set("authoring", action.feedback);
      state.specStep = "authoring";
    } else {
      state.specStep = step;
    }

    if (step === "reviewing-phases") {
      state.specPhaseFileIndex = 0;
    }

    await persistState();
    return "rejected";
  };

  const submitClarificationAnswersInternal = async (answers: ClarificationAnswer[]) => {
    await ensureInitialized();
    const validAnswers = answers
      .map((answer) => ({
        question: answer.question.trim(),
        answer: answer.answer.trim(),
      }))
      .filter((answer) => answer.question.length > 0 && answer.answer.length > 0);

    if (state.specStep !== "clarifying" || state.clarificationQuestions.length === 0 || validAnswers.length === 0) {
      emitState();
      return;
    }

    const promptContent = await readOptionalFile(promptPath);
    if (!promptContent) {
      await failSpecStep("clarifying", "spec-author", "prompt.md is required for clarification answers.");
      return;
    }

    const updatedPrompt = appendNotesSection(promptContent, validAnswers.map(formatClarificationNote));
    await deps.writeFile(promptPath, updatedPrompt, "utf8");

    state.clarificationQuestions = [];
    state.status = "running";
    await persistState();
    await startRun(lastToken ?? fallbackToken);
  };

  const runClarifyingStep = async (token: vscode.CancellationToken): Promise<ProcessingOutcome> => {
    if (state.clarificationQuestions.length > 0) {
      state.status = "paused";
      await persistState();
      return "interrupted";
    }

    const promptContent = await readOptionalFile(promptPath);
    if (!promptContent) {
      await failSpecStep("clarifying", "spec-author", "No spec.md or prompt.md found in specDir.");
      return "completed";
    }

    let retriesUsed = 0;

    while (retriesUsed < config.maxRetries) {
      try {
        const result = await invokePreparedPrompt(
          "spec-author",
          "clarifier",
          "phase0:clarifying",
          await buildClarificationSystemPrompt(config.skillsDir, config.conventionsSkill, getToolDefinitions()),
          promptContent,
          token,
        );

        if (pauseRequested || token.isCancellationRequested) {
          return "interrupted";
        }

        const parsedQuestions = extractClarificationQuestions(result.response);
        if (parsedQuestions === null || parsedQuestions.length === 0) {
          state.clarificationQuestions = [];
          state.specStep = "authoring";
          await persistState();
          return "completed";
        }

        state.clarificationQuestions = parsedQuestions;
        state.status = "paused";
        await persistState();
        return "interrupted";
      } catch (error) {
        retriesUsed += 1;
        if (retriesUsed >= config.maxRetries) {
          const message = error instanceof Error ? error.message : String(error);
          await failSpecStep("clarifying", "spec-author", `Clarification failed: ${message}`);
          return "completed";
        }
      }
    }

    return "completed";
  };

  const runAuthoringStep = async (token: vscode.CancellationToken): Promise<ProcessingOutcome> => {
    const promptContent = await readOptionalFile(promptPath);
    if (!promptContent) {
      await failSpecStep("authoring", "spec-author", "prompt.md is required for spec authoring.");
      return "completed";
    }

    let retriesUsed = 0;

    while (retriesUsed < config.maxRetries) {
      if (pauseRequested || token.isCancellationRequested) {
        return "interrupted";
      }

      const feedback = specFeedback.get("authoring");
      const result = await invokeRole(
        "spec-author",
        "phase0:authoring",
        "Spec writing phase 0 authoring.",
        [
          "Write the requested spec file.",
          `Target spec path: ${specPath}`,
          `Conventions skill: ${config.conventionsSkill}`,
          "Requirements from prompt.md:",
          promptContent,
          feedback ? `Feedback:\n${feedback}` : "",
        ].filter(Boolean).join("\n\n"),
        token,
      );

      if (parseSpecStepResult(result.response) === "PASS") {
        specFeedback.delete("authoring");
        state.specConsecutivePasses = 0;
        state.specStep = "reviewing";
        cachedSpecContent = (await readOptionalFile(specPath)) ?? cachedSpecContent;
        await persistState();
        return "completed";
      }

      retriesUsed += 1;
      if (retriesUsed >= config.maxRetries) {
        await failSpecStep("authoring", "spec-author", `Spec authoring failed: ${result.response}`);
        return "completed";
      }
    }

    return "completed";
  };

  const runReviewingStep = async (token: vscode.CancellationToken): Promise<ProcessingOutcome> => {
    const promptContent = (await readOptionalFile(promptPath)) ?? "";
    let retriesUsed = 0;

    while (retriesUsed < config.maxRetries) {
      if (pauseRequested || token.isCancellationRequested) {
        return "interrupted";
      }

      const authorFeedback = specFeedback.get("authoring");
      if (authorFeedback) {
        const authorResult = await invokeRole(
          "spec-author",
          "phase0:authoring",
          "Spec writing phase 0 authoring.",
          [
            "Update the spec in response to reviewer feedback.",
            `Target spec path: ${specPath}`,
            `Conventions skill: ${config.conventionsSkill}`,
            "Requirements from prompt.md:",
            promptContent,
            `Feedback:\n${authorFeedback}`,
          ].join("\n\n"),
          token,
        );

        if (parseSpecStepResult(authorResult.response) !== "PASS") {
          retriesUsed += 1;
          if (retriesUsed >= config.maxRetries) {
            await failSpecStep("reviewing", "spec-author", `Spec rewrite failed: ${authorResult.response}`);
            return "completed";
          }

          continue;
        }

        specFeedback.delete("authoring");
        cachedSpecContent = (await readOptionalFile(specPath)) ?? cachedSpecContent;
      }

      const reviewerResult = await invokeRole(
        "spec-reviewer",
        "phase0:reviewing",
        "Spec writing phase 0 review.",
        [
          `Review spec file: ${specPath}`,
          "Feature description from prompt.md:",
          promptContent,
        ].join("\n\n"),
        token,
      );

      const verdict = parseSpecStepResult(reviewerResult.response);
      if (verdict === "PASS") {
        state.specConsecutivePasses += 1;
        await persistState();

        if (state.specConsecutivePasses < 2) {
          continue;
        }

        if (config.requireApproval) {
          const approval = await handleSpecApproval("reviewing", "proofreading");
          if (approval === "approved" || approval === "skipped") {
            return "completed";
          }
          continue;
        }

        state.specConsecutivePasses = 0;
        state.specStep = "proofreading";
        await persistState();
        return "completed";
      }

      state.specConsecutivePasses = 0;
      await persistState();
      retriesUsed += 1;

      if (retriesUsed >= config.maxRetries) {
        await failSpecStep("reviewing", "spec-reviewer", `Spec review failed after ${config.maxRetries} retries.`);
        return "completed";
      }

      specFeedback.set("authoring", reviewerResult.response);
    }

    return "completed";
  };

  const runProofreadingStep = async (token: vscode.CancellationToken): Promise<ProcessingOutcome> => {
    let retriesUsed = 0;

    while (retriesUsed < config.maxRetries) {
      if (pauseRequested || token.isCancellationRequested) {
        return "interrupted";
      }

      const feedback = specFeedback.get("proofreading");
      const proofreaderResult = await invokeRole(
        "spec-proofreader",
        "phase0:proofreading",
        "Spec writing phase 0 proofreading.",
        [
          `Proofread spec file: ${specPath}`,
          feedback ? `Feedback:\n${feedback}` : "",
        ].filter(Boolean).join("\n\n"),
        token,
      );

      const verdict = parseSpecStepResult(proofreaderResult.response);
      if (verdict === "PASS") {
        specFeedback.delete("proofreading");
        state.specConsecutivePasses += 1;
        await persistState();

        if (state.specConsecutivePasses < 2) {
          continue;
        }

        if (config.requireApproval) {
          const approval = await handleSpecApproval("proofreading", "creating-phases");
          if (approval === "approved" || approval === "skipped") {
            return "completed";
          }
          continue;
        }

        state.specConsecutivePasses = 0;
        state.specStep = "creating-phases";
        await persistState();
        return "completed";
      }

      if (verdict !== "FIXED") {
        retriesUsed += 1;
        if (retriesUsed >= config.maxRetries) {
          await failSpecStep("proofreading", "spec-proofreader", `Spec proofreading failed: ${proofreaderResult.response}`);
          return "completed";
        }
      } else {
        retriesUsed += 1;
        if (retriesUsed >= config.maxRetries) {
          await failSpecStep("proofreading", "spec-proofreader", `Spec proofreading exhausted retries: ${proofreaderResult.response}`);
          return "completed";
        }
      }

      state.specConsecutivePasses = 0;
      await persistState();
    }

    return "completed";
  };

  const runCreatingPhasesStep = async (token: vscode.CancellationToken): Promise<ProcessingOutcome> => {
    let retriesUsed = 0;

    while (retriesUsed < config.maxRetries) {
      if (pauseRequested || token.isCancellationRequested) {
        return "interrupted";
      }

      const feedback = specFeedback.get("reviewing-phases");

      const result = await invokeRole(
        "phase-creator",
        "phase0:creating-phases",
        "Spec writing phase 0 phase creation.",
        [
          `Read spec from: ${specPath}`,
          `Write phase files to: ${config.specDir}`,
          `Implementor skill: ${deriveImplementationSkillName("implementor", config.conventionsSkill)}`,
          `Reviewer skill: ${deriveImplementationSkillName("reviewer", config.conventionsSkill)}`,
          feedback ? `Feedback:\n${feedback}` : "",
        ].join("\n\n"),
        token,
      );

      if (parseSpecStepResult(result.response) === "PASS") {
        specFeedback.delete("reviewing-phases");
        invalidatePhaseCache();
        state.specPhaseFileIndex = 0;
        state.specStep = "reviewing-phases";
        await persistState();
        return "completed";
      }

      retriesUsed += 1;
      if (retriesUsed >= config.maxRetries) {
        await failSpecStep("creating-phases", "phase-creator", `Phase creation failed: ${result.response}`);
        return "completed";
      }
    }

    return "completed";
  };

  const runReviewingPhasesStep = async (token: vscode.CancellationToken): Promise<ProcessingOutcome> => {
    const phaseFiles = await getSortedPhaseFiles();
    let retriesUsed = 0;

    while (state.specPhaseFileIndex < phaseFiles.length) {
      if (pauseRequested || token.isCancellationRequested) {
        return "interrupted";
      }

      const feedback = specFeedback.get("reviewing-phases");
      const phasePath = phaseFiles[state.specPhaseFileIndex];
      const result = await invokeRole(
        "phase-reviewer",
        `phase0:reviewing-phases:${state.specPhaseFileIndex}`,
        "Spec writing phase 0 phase review.",
        [
          `Review phase file: ${phasePath}`,
          `Spec file: ${specPath}`,
          feedback ? `Feedback:\n${feedback}` : "",
        ].filter(Boolean).join("\n\n"),
        token,
      );

      const verdict = parseSpecStepResult(result.response);
      if (verdict === "PASS") {
        specFeedback.delete("reviewing-phases");
        state.specPhaseFileIndex += 1;
        await persistState();
        continue;
      }

      retriesUsed += 1;
      if (retriesUsed >= config.maxRetries) {
        await failSpecStep("reviewing-phases", "phase-reviewer", `Phase review failed: ${result.response}`);
        return "completed";
      }

      if (verdict === "FIXED") {
        continue;
      }

      specFeedback.set("reviewing-phases", result.response);
      state.specPhaseFileIndex = 0;
      state.specStep = "creating-phases";
      await persistState();
      return "completed";
    }

    if (config.requireApproval) {
      const approval = await handleSpecApproval("reviewing-phases", "done");
      if (approval === "approved" || approval === "skipped") {
        return "completed";
      }

      return await runReviewingPhasesStep(token);
    }

    state.specStep = "done";
    state.specPhaseFileIndex = phaseFiles.length;
    await persistState();
    return "completed";
  };

  const runSpecWritingLoop = async (token: vscode.CancellationToken): Promise<ProcessingOutcome> => {
    const specExists = await pathExists(specPath);
    const promptExists = await pathExists(promptPath);

    if (!specExists && !promptExists) {
      await failSpecStep(state.specStep === "done" ? "clarifying" : state.specStep, "spec-author", "No spec.md or prompt.md found in specDir.");
      return "completed";
    }

    if (specExists && state.specStep === "done") {
      cachedSpecContent = (await readOptionalFile(specPath)) ?? "";
      return "completed";
    }

    while (state.specStep !== "done") {
      if (pauseRequested || token.isCancellationRequested) {
        state.status = "paused";
        await persistState();
        return "interrupted";
      }

      let outcome: ProcessingOutcome;

      switch (state.specStep) {
        case "clarifying":
          outcome = await runClarifyingStep(token);
          break;
        case "authoring":
          outcome = await runAuthoringStep(token);
          break;
        case "reviewing":
          outcome = await runReviewingStep(token);
          break;
        case "proofreading":
          outcome = await runProofreadingStep(token);
          break;
        case "creating-phases":
          outcome = await runCreatingPhasesStep(token);
          break;
        case "reviewing-phases":
          outcome = await runReviewingPhasesStep(token);
          break;
      }

      if (outcome === "interrupted" || state.status === "error") {
        return outcome;
      }
    }

    cachedSpecContent = (await readOptionalFile(specPath)) ?? cachedSpecContent;
    await ensurePhaseLoaded();
    return "completed";
  };

  const markItemFailed = async (itemId: string, message?: string, result: AuditEntry["result"] = "FAIL") => {
    state.consecutivePasses[itemId] = 0;
    state.itemStatuses[itemId] = "fail";
    await persistState();

    if (message) {
      const auditEntry = {
        timestamp: deps.now(),
        role: "reviewer",
        model: "system",
        itemId,
        promptSummary: truncatePromptSummary(message),
        result,
        tokensIn: 0,
        tokensOut: 0,
        durationMs: 0,
      } satisfies AuditEntry;
      await deps.appendAudit(conductorDir, auditEntry);
      emitAudit(auditEntry);
    }
  };

  const runTests = async (itemId: string): Promise<{ kind: "pass" | "retry" | "timeout"; feedback?: string }> => {
    const result = await deps.executeBash(config.testCommand, config.projectDir);
    if (result.success) {
      return { kind: "pass" };
    }

    const message = [result.output, result.error].filter(Boolean).join("\n");
    if ((result.error ?? "").toLowerCase().includes("timeout")) {
      await markItemFailed(itemId, `test timeout: ${message}`, "error");
      return { kind: "timeout" };
    }

    return {
      kind: "retry",
      feedback: `Test command failed:\n${message}`,
    };
  };

  const clearApprovalTracking = (itemIds: string[]) => {
    for (const itemId of itemIds) {
      approvalResolvers.delete(itemId);
      approvalGroups.delete(itemId);
    }
  };

  const getApprovalItemIds = (itemId: string): string[] => {
    const trackedGroup = approvalGroups.get(itemId);
    if (trackedGroup) {
      return [...trackedGroup];
    }

    const item = cachedPhase?.items.find((candidate) => candidate.id === itemId);
    if (!cachedPhase || !item) {
      return [itemId];
    }

    const batchItems = getBatchItems(cachedPhase, item).map((candidate) => candidate.id);
    if (batchItems.length > 1 && batchItems.every((candidate) => state.itemStatuses[candidate] === "pending-approval")) {
      return batchItems;
    }

    return [itemId];
  };

  const waitForApproval = async (itemIds: string[]): Promise<ApprovalAction> => {
    return await new Promise<ApprovalAction>((resolve) => {
      for (const itemId of itemIds) {
        approvalResolvers.set(itemId, resolve);
        approvalGroups.set(itemId, [...itemIds]);
      }
    });
  };

  const awaitApprovalDecision = async (itemIds: string[]): Promise<ApprovalAction> => {
    if (!itemIds.every((itemId) => state.itemStatuses[itemId] === "pending-approval")) {
      for (const itemId of itemIds) {
        state.itemStatuses[itemId] = "pending-approval";
      }
      await persistState();
    }

    return await waitForApproval(itemIds);
  };

  const handleApprovalAction = async (itemIds: string[], action: ApprovalAction): Promise<"approved" | "rejected" | "skipped"> => {
    clearApprovalTracking(itemIds);

    if (action.type === "approve") {
      await finalizePass(itemIds);
      return "approved";
    }

    if (action.type === "skip") {
      for (const itemId of itemIds) {
        state.itemStatuses[itemId] = "skipped";
      }
      await persistState();
      return "skipped";
    }

    for (const itemId of itemIds) {
      state.consecutivePasses[itemId] = 0;
      state.itemStatuses[itemId] = "pending";
      itemFeedback.set(itemId, action.feedback);
    }
    await persistState();
    return "rejected";
  };

  const finalizePass = async (itemIds: string[]) => {
    await ensurePhaseLoaded();
    const phasePath = cachedPhasePath ?? getPhasePath(state.currentPhase > 0 ? state.currentPhase : 1);

    for (const itemId of itemIds) {
      state.itemStatuses[itemId] = "pass";
      state.consecutivePasses[itemId] = 2;
      await updatePhaseFileCheckboxes(deps, phasePath, itemId);
    }
    await persistState();
  };

  const buildItemContext = (item: PhaseItem): string => {
    const sectionText = extractSpecSection(cachedSpecContent, item.specSection);
    return [
      `Item ID: ${item.id}`,
      `Title: ${item.title}`,
      `Spec section: ${item.specSection}`,
      sectionText,
    ].filter(Boolean).join("\n\n");
  };

  const processSequentialItem = async (item: PhaseItem, token: vscode.CancellationToken): Promise<ProcessingOutcome> => {
    let retriesUsed = 0;

    while (retriesUsed < config.maxRetries) {
      if (pauseRequested || token.isCancellationRequested) {
        return "interrupted";
      }
      if (state.itemStatuses[item.id] === "skipped") {
        return "completed";
      }

      if (config.requireApproval && state.itemStatuses[item.id] === "pending-approval") {
        const action = await awaitApprovalDecision([item.id]);
        const outcome = await handleApprovalAction([item.id], action);
        if (outcome !== "rejected") {
          return "completed";
        }
        continue;
      }

      state.itemStatuses[item.id] = "in-progress";
      await persistState();

      const feedback = itemFeedback.get(item.id);
      const implementPrompt = [
        `Implement item ${item.id}.`,
        feedback ? `Feedback:\n${feedback}` : "",
      ].filter(Boolean).join("\n\n");
      await invokeRole("implementor", item.id, buildItemContext(item), implementPrompt, token);

      if (pauseRequested || token.isCancellationRequested) {
        return "interrupted";
      }

      const testOutcome = await runTests(item.id);
      if (testOutcome.kind === "timeout") {
        return "completed";
      }
      if (pauseRequested || token.isCancellationRequested) {
        return "interrupted";
      }
      if (testOutcome.kind === "retry") {
        retriesUsed += 1;
        itemFeedback.set(item.id, testOutcome.feedback ?? "Test command failed.");
        state.consecutivePasses[item.id] = 0;
        await persistState();
        if (retriesUsed >= config.maxRetries) {
          await markItemFailed(item.id);
          return "completed";
        }
        if (pauseRequested || token.isCancellationRequested) {
          return "interrupted";
        }
        continue;
      }

      while ((state.consecutivePasses[item.id] ?? 0) < 2) {
        const reviewerPrompt = [
          `Review item ${item.id}.`,
          `Diff:\n${await deps.getDiff([item.id])}`,
        ].join("\n\n");
        const reviewerResult = await invokeRole("reviewer", item.id, buildItemContext(item), reviewerPrompt, token);
        const verdict = getVerdict(reviewerResult);

        if (verdict === "PASS") {
          state.consecutivePasses[item.id] = (state.consecutivePasses[item.id] ?? 0) + 1;
          await persistState();
          if (pauseRequested || token.isCancellationRequested) {
            return "interrupted";
          }
          continue;
        }

        state.consecutivePasses[item.id] = 0;
        await persistState();
        retriesUsed += 1;
        itemFeedback.set(item.id, reviewerResult.response);
        if (retriesUsed >= config.maxRetries) {
          await markItemFailed(item.id);
          return "completed";
        }
        if (pauseRequested || token.isCancellationRequested) {
          return "interrupted";
        }
        break;
      }

      if ((state.consecutivePasses[item.id] ?? 0) < 2) {
        continue;
      }

      if (config.requireApproval) {
        const action = await awaitApprovalDecision([item.id]);
        const outcome = await handleApprovalAction([item.id], action);
        if (outcome !== "rejected") {
          return "completed";
        }
        continue;
      }

      await finalizePass([item.id]);
      return "completed";
    }

    await markItemFailed(item.id);
    return "completed";
  };

  const processBatch = async (items: PhaseItem[], token: vscode.CancellationToken): Promise<ProcessingOutcome> => {
    let retriesUsed = 0;
    const itemIds = items.map((item) => item.id);

    while (retriesUsed < config.maxRetries) {
      if (pauseRequested || token.isCancellationRequested) {
        return "interrupted";
      }

      if (config.requireApproval && itemIds.every((itemId) => state.itemStatuses[itemId] === "pending-approval")) {
        const action = await awaitApprovalDecision(itemIds);
        const outcome = await handleApprovalAction(itemIds, action);
        if (outcome !== "rejected") {
          return "completed";
        }
        continue;
      }

      for (const item of items) {
        if (state.itemStatuses[item.id] !== "skipped") {
          state.itemStatuses[item.id] = "in-progress";
        }
      }
      await persistState();

      await Promise.all(items.map(async (item) => {
        if (state.itemStatuses[item.id] === "skipped") {
          return;
        }

        const feedback = itemFeedback.get(item.id);
        const implementPrompt = [
          `Implement batch item ${item.id}.`,
          feedback ? `Feedback:\n${feedback}` : "",
        ].filter(Boolean).join("\n\n");
        await invokeRole("implementor", item.id, buildItemContext(item), implementPrompt, token);
      }));

      if (pauseRequested || token.isCancellationRequested) {
        return "interrupted";
      }

      const testOutcomes = await Promise.all(items.map(async (item) => ({ item, result: await runTests(item.id) })));
      const timedOut = testOutcomes.find((entry) => entry.result.kind === "timeout");
      if (timedOut) {
        return "completed";
      }
      if (pauseRequested || token.isCancellationRequested) {
        return "interrupted";
      }

      const failedTests = testOutcomes.filter((entry) => entry.result.kind === "retry");
      if (failedTests.length > 0) {
        retriesUsed += 1;
        for (const { item, result } of failedTests) {
          state.consecutivePasses[item.id] = 0;
          itemFeedback.set(item.id, result.feedback ?? "Test command failed.");
        }
        await persistState();
        if (retriesUsed >= config.maxRetries) {
          for (const item of items) {
            await markItemFailed(item.id);
          }
          return "completed";
        }
        if (pauseRequested || token.isCancellationRequested) {
          return "interrupted";
        }
        continue;
      }

      const reviewerPrompt = [
        `Review batch items: ${itemIds.join(", ")}.`,
        `Diff:\n${await deps.getDiff(itemIds)}`,
      ].join("\n\n");

      if (pauseRequested || token.isCancellationRequested) {
        return "interrupted";
      }

      const batchResult = await invokeRole(
        "reviewer",
        itemIds.join(","),
        items.map((item) => buildItemContext(item)).join("\n\n"),
        reviewerPrompt,
        token,
      );

      if (getVerdict(batchResult) === "PASS") {
        for (const item of items) {
          state.consecutivePasses[item.id] = 2;
        }
        await persistState();

        if (pauseRequested || token.isCancellationRequested) {
          return "interrupted";
        }

        if (config.requireApproval) {
          const action = await awaitApprovalDecision(itemIds);
          const outcome = await handleApprovalAction(itemIds, action);
          if (outcome === "rejected") {
            continue;
          }
          return "completed";
        }

        await finalizePass(itemIds);
        return "completed";
      }

      retriesUsed += 1;
      for (const item of items) {
        state.consecutivePasses[item.id] = 0;
        itemFeedback.set(item.id, batchResult.response);
      }
      await persistState();

      if (retriesUsed >= config.maxRetries) {
        for (const item of items) {
          await markItemFailed(item.id);
        }
        return "completed";
      }

      if (pauseRequested || token.isCancellationRequested) {
        return "interrupted";
      }
    }

    return "completed";
  };

  const advanceIndex = async (itemsProcessed: number) => {
    state.currentItemIndex += itemsProcessed;
    await persistState();
  };

  const runLoop = async (token: vscode.CancellationToken) => {
    await ensureInitialized();

    if (state.status === "paused" && !pauseRequested) {
      return;
    }

    pauseRequested = false;
    state.status = "running";
    await persistState();

    const specWritingOutcome = await runSpecWritingLoop(token);
    if (specWritingOutcome === "interrupted" || state.status !== "running") {
      return;
    }

    while (true) {
      await ensurePhaseLoaded();
      if (!cachedPhase || state.currentItemIndex >= cachedPhase.items.length) {
        break;
      }

      if (pauseRequested || token.isCancellationRequested) {
        state.status = "paused";
        await persistState();
        return;
      }

      const item = cachedPhase.items[state.currentItemIndex];
      const status = state.itemStatuses[item.id];
      if (status === "pass" || status === "skipped") {
        await advanceIndex(1);
        continue;
      }

      if (item.batch !== undefined) {
        const batchItems = getBatchItems(cachedPhase, item);
        const firstBatchIndex = getItemIndex(batchItems[0].id);
        if (state.currentItemIndex !== firstBatchIndex) {
          await advanceIndex(1);
          continue;
        }

        const outcome = await processBatch(batchItems, token);
        if (outcome === "completed") {
          await advanceIndex(batchItems.length);
        }
        continue;
      }

      const outcome = await processSequentialItem(item, token);
      if (outcome === "completed") {
        await advanceIndex(1);
      }
    }

    if (!pauseRequested) {
      state.status = "done";
      await persistState();
    }
  };

  const startRun = (token: vscode.CancellationToken): Promise<void> => {
    lastToken = token;
    if (!activeRun) {
      activeRun = runLoop(token).finally(() => {
        activeRun = undefined;
      });
    }

    return activeRun;
  };

  const runDetached = (operation: () => Promise<void>) => {
    void operation().catch(() => {
      state.status = "error";
      emitState();
    });
  };

  const resumeInternal = () => {
    runDetached(async () => {
      await ensureInitialized();
      pauseRequested = false;
      if (state.status === "done") {
        emitState();
        return;
      }

      state.status = "running";
      await persistState();
      await startRun(lastToken ?? fallbackToken);
    });
  };

  const retryInternal = (itemId: string) => {
    runDetached(async () => {
      await ensureInitialized();
      pauseRequested = false;
      state.itemStatuses[itemId] = "pending";
      state.consecutivePasses[itemId] = 0;

      const itemIndex = getItemIndex(itemId);
      if (itemIndex >= 0) {
        state.currentItemIndex = Math.min(state.currentItemIndex, itemIndex);
      }

      itemFeedback.delete(itemId);
      await persistState();
      await startRun(lastToken ?? fallbackToken);
    });
  };

  return {
    async run(token: vscode.CancellationToken): Promise<void> {
      await startRun(token);
    },

    pause(): void {
      pauseRequested = true;
      state.status = "paused";
      void persistState();
    },

    resume(): void {
      resumeInternal();
    },

    skip(itemId: string): void {
      if (specApprovalResolver) {
        const resolver = specApprovalResolver;
        specApprovalResolver = undefined;
        pendingSpecApprovalStep = undefined;
        resolver({ type: "skip" });
        return;
      }

      state.itemStatuses[itemId] = "skipped";
      const itemIds = getApprovalItemIds(itemId);
      const resolver = itemIds.map((candidate) => approvalResolvers.get(candidate)).find((candidate) => candidate !== undefined);
      if (resolver) {
        clearApprovalTracking(itemIds);
        resolver({ type: "skip" });
      }
      void persistState();
    },

    retry(itemId: string): void {
      retryInternal(itemId);
    },

    changeModel(role: Role, vendor: string, family: string): void {
      const existing = state.modelAssignments.find((assignment) => assignment.role === role);
      if (!existing) {
        return;
      }

      existing.vendor = vendor;
      existing.family = family;
      void persistState();
    },

    approve(itemId: string): void {
      if (specApprovalResolver && pendingSpecApprovalStep) {
        const resolver = specApprovalResolver;
        specApprovalResolver = undefined;
        pendingSpecApprovalStep = undefined;
        resolver({ type: "approve" });
        return;
      }

      const itemIds = getApprovalItemIds(itemId);
      const resolver = itemIds.map((candidate) => approvalResolvers.get(candidate)).find((candidate) => candidate !== undefined);
      if (resolver) {
        clearApprovalTracking(itemIds);
        resolver({ type: "approve" });
      }
    },

    reject(itemId: string, feedback: string): void {
      if (specApprovalResolver && pendingSpecApprovalStep) {
        const resolver = specApprovalResolver;
        specApprovalResolver = undefined;
        pendingSpecApprovalStep = undefined;
        resolver({ type: "reject", feedback });
        return;
      }

      const itemIds = getApprovalItemIds(itemId);
      for (const candidate of itemIds) {
        itemFeedback.set(candidate, feedback);
        state.itemStatuses[candidate] = "pending";
        state.consecutivePasses[candidate] = 0;
      }
      const resolver = itemIds.map((candidate) => approvalResolvers.get(candidate)).find((candidate) => candidate !== undefined);
      if (resolver) {
        clearApprovalTracking(itemIds);
        resolver({ type: "reject", feedback });
      }
      void persistState();
    },

    submitClarification(answers: ClarificationAnswer[]): void {
      runDetached(async () => {
        await submitClarificationAnswersInternal(answers);
      });
    },

    addNote(itemId: string, text: string, author?: string): void {
      void (async () => {
        const entry = buildManualAddendumEntry(deps.now(), itemId, text, author);
        await deps.appendAddendum(conductorDir, entry);
        emitAddendum(entry);
      })();
    },

    getState(): OrchestratorState {
      return cloneState(visibleState);
    },

    async getPhase(): Promise<Phase> {
      await ensureInitialized();
      await ensurePhaseLoaded();

      return clonePhase({
        number: cachedPhase?.number ?? state.currentPhase,
        title: cachedPhase?.title ?? "",
        items: cachedPhase?.items ?? [],
        batches: cachedPhase?.batches ?? [],
      });
    },

    async getPhases(): Promise<Phase[]> {
      await ensureInitialized();
      return (await loadAllPhases()).map(clonePhase);
    },

    async getAuditEntries(): Promise<AuditEntry[]> {
      return await deps.readAudit(conductorDir);
    },

    async getAddendumEntries(): Promise<AddendumEntry[]> {
      return await deps.readAddenda(conductorDir);
    },

    async getTranscripts(): Promise<RunTranscript[]> {
      return await deps.loadTranscripts(conductorDir);
    },

    onStateChange: stateEmitter.event as vscode.Event<OrchestratorState>,
    onAuditEntry: auditEmitter.event as vscode.Event<AuditEntry>,
    onAddendum: addendumEmitter.event as vscode.Event<AddendumEntry>,
    onTranscript: transcriptEmitter.event as vscode.Event<RunTranscript>,
  };
}
