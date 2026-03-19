import { readFile, readdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type * as vscode from "vscode";

import { assembleSystemPrompt } from "../llm/prompts";
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
  AuditEntry,
  InvocationResult,
  OrchestratorConfig,
  OrchestratorState,
  Phase,
  PhaseItem,
  Role,
  RunTranscript,
  TranscriptMessage,
} from "../types";

const CONDUCTOR_DIR = ".conductor";

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
    status: "idle",
    modelAssignments: config.modelAssignments.map((assignment) => ({ ...assignment })),
    itemStatuses: {},
  };
}

function cloneState(state: OrchestratorState): OrchestratorState {
  return {
    ...state,
    consecutivePasses: { ...state.consecutivePasses },
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
  if (normalized.startsWith("FAIL")) {
    return "FAIL";
  }
  return "error";
}

function truncatePromptSummary(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > 160 ? `${collapsed.slice(0, 157)}...` : collapsed;
}

function buildTranscript(
  timestamp: string,
  role: Role,
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
  role: Role,
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
  const itemFeedback = new Map<string, string>();
  const approvalResolvers = new Map<string, (action: ApprovalAction) => void>();
  const approvalGroups = new Map<string, string[]>();
  const fallbackToken = createFallbackToken();

  const emitState = () => {
    stateEmitter.fire(cloneState(state));
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

    cachedPhase = parsePhaseFile(await deps.readFile(phasePath, "utf8"));
    cachedPhaseNumber = phaseNumber;
    cachedPhasePath = phasePath;
  };

  const persistState = async () => {
    const snapshot = cloneState(state);
    persistChain = persistChain.then(async () => {
      await deps.saveState(conductorDir, snapshot);
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
    const persistedState = loaded.specDir ? loaded : defaultState;
    const currentHasAssignmentOverrides = !haveSameModelAssignments(state.modelAssignments, defaultState.modelAssignments);
    const currentHasConsecutivePasses = Object.keys(state.consecutivePasses).length > 0;
    const currentHasItemStatuses = Object.keys(state.itemStatuses).length > 0;
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
      itemStatuses: currentHasItemStatuses
        ? { ...state.itemStatuses }
        : { ...(persistedState.itemStatuses ?? {}) },
      startedBy: persistedState.startedBy ?? defaultState.startedBy,
    };

    await ensurePhaseLoaded();
    cachedSpecContent = await deps.readFile(specPath, "utf8");
    initialized = true;
  };

  const getItemIndex = (itemId: string): number => cachedPhase?.items.findIndex((item) => item.id === itemId) ?? -1;

  const setItemStatus = async (itemId: string, nextStatus: OrchestratorState["itemStatuses"][string]) => {
    state.itemStatuses[itemId] = nextStatus;
    await persistState();
  };

  const invokeRole = async (
    role: Role,
    itemId: string,
    itemContext: string,
    userPrompt: string,
    token: vscode.CancellationToken,
  ): Promise<InvocationResult> => {
    const model = await deps.selectModelForRole(role, state.modelAssignments);
    const modelLabel = `${role}:${String((model as { family?: string }).family ?? "unknown")}`;
    const systemPrompt = await deps.assembleSystemPrompt(
      role,
      config.skillsDir,
      config.conventionsSkill,
      itemContext,
      getToolDefinitions(),
    );
    const timestamp = deps.now();
    const result = await deps.invokeWithToolLoop(model, systemPrompt, userPrompt, config.projectDir, {
      maxTurns: config.maxTurns,
      token,
    });

    const transcript = buildTranscript(timestamp, role, modelLabel, itemId, systemPrompt, userPrompt, result.messages);
    const auditEntry = buildAuditEntry(timestamp, role, modelLabel, itemId, userPrompt, result);

    await deps.saveTranscript(conductorDir, transcript);
    emitTranscript(transcript);
    await deps.appendAudit(conductorDir, auditEntry);
    emitAudit(auditEntry);

    if (role === "reviewer" && result.addendum) {
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
      if (existing) {
        existing.vendor = vendor;
        existing.family = family;
      } else {
        state.modelAssignments.push({ role, vendor, family });
      }
      void persistState();
    },

    approve(itemId: string): void {
      const itemIds = getApprovalItemIds(itemId);
      const resolver = itemIds.map((candidate) => approvalResolvers.get(candidate)).find((candidate) => candidate !== undefined);
      if (resolver) {
        clearApprovalTracking(itemIds);
        resolver({ type: "approve" });
      }
    },

    reject(itemId: string, feedback: string): void {
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

    addNote(itemId: string, text: string, author?: string): void {
      void (async () => {
        const entry = buildManualAddendumEntry(deps.now(), itemId, text, author);
        await deps.appendAddendum(conductorDir, entry);
        emitAddendum(entry);
      })();
    },

    getState(): OrchestratorState {
      return cloneState(state);
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