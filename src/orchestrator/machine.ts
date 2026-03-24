import { readFile, readdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type * as vscode from "vscode";

import { assembleSystemPrompt, buildClarificationSystemPrompt } from "../llm/prompts";
import { buildLanguageModelChatMessages, invokeWithToolLoop, readResponseText } from "../llm/invoke";
import { selectModelForRole } from "../llm/select";
import { parsePhaseFile } from "./parser";
import { appendAddendum, readAddenda } from "../state/addendum";
import { appendAudit, readAudit } from "../state/audit";
import { loadState, saveState } from "../state/persistence";
import { loadTranscripts, saveTranscript } from "../state/transcript";
import { executeBash, executeTrusted } from "../tools/bash";
import { getToolDefinitions } from "../tools/schema";
import type {
  AddendumEntry,
  AuditRole,
  AuditEntry,
  BugIssue,
  BugStep,
  ClarificationAnswer,
  ClarificationQuestion,
  CommandExtraction,
  InvocationResult,
  ModelAssignment,
  OrchestratorConfig,
  OrchestratorState,
  Phase,
  PhaseItem,
  PrReviewFinding,
  PrReviewStep,
  Role,
  RunTranscript,
  SpecStep,
  TrustedExecutor,
  TranscriptMessage,
} from "../types";

const CONDUCTOR_DIR = ".conductor";

const SPEC_APPROVAL_SENTINEL = "__spec__";
const BUGFIX_APPROVAL_SENTINEL = "bugfix";
const PR_REVIEW_APPROVAL_SENTINEL = "pr-review";
const DEFAULT_TEST_COMMAND = "npm test";
const DEFAULT_LINT_COMMAND = "";
const BUGFIX_MAX_CYCLES = 5;
const PR_REVIEW_COMMIT_MESSAGE = "Fix PR review findings";
const STATE_CHECKPOINT_COMMIT_MESSAGE = "conductor: update state";
const SPEC_WRITING_COMMIT_MESSAGE = "conductor: write spec";
const COPILOT_REREVIEW_ITEM_ID = "copilot-rereview";
const COPILOT_REREVIEW_MAX_CYCLES = 20;
const COPILOT_REREVIEW_POLL_INTERVAL_MS = 30_000;
const COPILOT_REREVIEW_PUSH_TIMEOUT_MS = 5 * 60_000;
const COPILOT_REREVIEW_REVIEW_TIMEOUT_MS = 20 * 60_000;
const HOLISTIC_REFACTOR_PROMPT = [
  "Consider the problem holistically. The same area",
  "has attracted repeated reviewer findings across",
  "multiple fix cycles. Rather than patching individual",
  "comments, refactor the surrounding code so that",
  "reviewers do not keep finding issues.",
].join("\n");
const BUILD_FILE_NAMES = new Set([
  "build.gradle",
  "build.gradle.kts",
  "Cargo.toml",
  "composer.json",
  "Dockerfile",
  "Gemfile",
  "go.mod",
  "Makefile",
  "package.json",
  "pom.xml",
  "pyproject.toml",
  "requirements.txt",
  "setup.py",
]);
const LOCK_FILE_NAMES = new Set([
  "bun.lockb",
  "Cargo.lock",
  "composer.lock",
  "Gemfile.lock",
  "go.sum",
  "package-lock.json",
  "Pipfile.lock",
  "pnpm-lock.yaml",
  "poetry.lock",
  "uv.lock",
  "yarn.lock",
]);
const PROMPT_REFERENCED_FILES_SECTION_TITLE = "Referenced repository files mentioned in prompt.md:";
const MAX_REFERENCED_FILE_CONTENT_CHARS = 12_000;
const SPEC_AUTHOR_COMPLETION_CONTRACT = [
  "Use tools to write or update the spec at the target spec path.",
  "Do not report success until the file changes are complete.",
  "When finished, return exactly <done>PASS</done>.",
].join("\n");

type ApprovalAction =
  | { type: "approve" }
  | { type: "reject"; feedback: string }
  | { type: "skip" }
  | { type: "abandon" };

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
  executeTrusted: TrustedExecutor;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => string;
  getDiff: (itemIds: string[]) => Promise<string>;
};

export interface Orchestrator {
  run(token: vscode.CancellationToken): Promise<void>;
  startCopilotReReview(): void;
  abandon(): void;
  pause(): void;
  resume(): void;
  skip(itemId: string): void;
  retry(itemId: string): void;
  changeModel(role: Role, vendor: string, family: string): void;
  overrideCommands(testCommand: string, lintCommand: string): void;
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

function quoteShellArgument(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

function toGitRelativePath(projectDir: string, targetPath: string): string {
  const relativePath = path.relative(projectDir, targetPath);
  return relativePath.split(path.sep).join("/");
}

function createDefaultState(config: OrchestratorConfig): OrchestratorState {
  return {
    specDir: path.join(config.docsDir, "conductor"),
    conventionsSkill: "",
    testCommand: DEFAULT_TEST_COMMAND,
    lintCommand: DEFAULT_LINT_COMMAND,
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
    prReviewStep: undefined,
    prReviewConsecutivePasses: undefined,
  };
}

function cloneState(state: OrchestratorState): OrchestratorState {
  return {
    ...state,
    bugIssues: state.bugIssues?.map((issue) => ({ ...issue })),
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

function normalizePrReviewStep(step: unknown): PrReviewStep | undefined {
  if (step === "spec-aware" || step === "spec-free" || step === "done") {
    return step;
  }

  return undefined;
}

function normalizeBugStep(step: unknown): BugStep | undefined {
  if (
    step === "fixing"
    || step === "reviewing"
    || step === "approving"
    || step === "committing"
    || step === "done"
  ) {
    return step;
  }

  return undefined;
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

function getInvocationFailureDetail(result: InvocationResult): string {
  const response = result.response.trim();
  if (response.length > 0) {
    return response;
  }

  const error = result.error?.trim();
  if (error && error.length > 0) {
    return error;
  }

  return "Invocation returned no response.";
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

export function parseCommandExtraction(response: string): CommandExtraction {
  const defaults: CommandExtraction = {
    testCommand: DEFAULT_TEST_COMMAND,
    lintCommand: DEFAULT_LINT_COMMAND,
  };
  const trimmed = response.trim();

  if (trimmed.length === 0) {
    return defaults;
  }

  const candidates = [trimmed];
  const fencedMatches = trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gu);
  for (const match of fencedMatches) {
    if (match[1]?.trim()) {
      candidates.push(match[1].trim());
    }
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Partial<CommandExtraction>;
      if (typeof parsed !== "object" || parsed === null) {
        continue;
      }

      return {
        testCommand: typeof parsed.testCommand === "string" && parsed.testCommand.trim().length > 0
          ? parsed.testCommand.trim()
          : defaults.testCommand,
        lintCommand: typeof parsed.lintCommand === "string"
          ? parsed.lintCommand.trim()
          : defaults.lintCommand,
      };
    } catch {
      continue;
    }
  }

  return defaults;
}

export function parseBugDescription(response: string): BugIssue[] {
  const fallback = (): BugIssue[] => [{
    title: "Bug fix",
    description: response,
  }];

  const trimmed = response.trim();
  if (trimmed.length === 0) {
    return fallback();
  }

  const candidates = [trimmed];
  const fencedMatches = trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gu);
  for (const match of fencedMatches) {
    if (match[1]?.trim()) {
      candidates.push(match[1].trim());
    }
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (!Array.isArray(parsed)) {
        continue;
      }

      const issues = parsed
        .filter((entry): entry is BugIssue => {
          return typeof entry === "object"
            && entry !== null
            && typeof (entry as { title?: unknown }).title === "string"
            && typeof (entry as { description?: unknown }).description === "string";
        })
        .map((entry) => ({
          title: entry.title,
          description: entry.description,
        }));

      if (issues.length > 0) {
        return issues;
      }
    } catch {
      continue;
    }
  }

  return fallback();
}

async function splitBugPromptIntoIssues(
  text: string,
  modelAssignments: ModelAssignment[],
  token: vscode.CancellationToken,
  selectModel: typeof selectModelForRole,
): Promise<BugIssue[]> {
  try {
    const model = await selectModel("spec-author", modelAssignments);
    const response = await model.sendRequest(
      buildLanguageModelChatMessages([
        {
          role: "system",
          content: [
            "Split the bug report into a JSON array of bug issues.",
            "Return only JSON with the shape [{\"title\":\"...\",\"description\":\"...\"}].",
            "If there is only one issue, return a single-element array.",
            "Do not call tools.",
          ].join("\n"),
        },
        {
          role: "user",
          content: text,
        },
      ]) as unknown as vscode.LanguageModelChatMessage[],
      undefined,
      token,
    );

    return parseBugDescription(await readSingleResponseText(response));
  } catch {
    return parseBugDescription(text);
  }
}

function truncatePromptSummary(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > 160 ? `${collapsed.slice(0, 157)}...` : collapsed;
}

function normalizeMarkdownSpacing(text: string): string {
  return text.replace(/\s+$/u, "");
}

function extractCommandStdout(output: string): string {
  const match = output.match(/stdout:\n([\s\S]*?)(?:\nstderr:\n|\nexit code: |\nsignal: |$)/u);
  if (match?.[1]) {
    return match[1].replace(/\r?\n$/u, "");
  }

  return output.trim();
}

function extractCommandFailure(result: { output: string; error?: string }): string {
  const message = [result.error, result.output.trim()].filter(Boolean).join("\n");
  return message.length > 0 ? message : "Unknown command failure.";
}

function isMissingUpstreamPushFailure(result: { output: string; error?: string }): boolean {
  return /\bhas no upstream branch\b/u.test(extractCommandFailure(result));
}

async function pushWithOptionalUpstream(
  projectDir: string,
  trustedExecution: TrustedExecutor,
  failurePrefix: string,
): Promise<boolean> {
  const result = await trustedExecution("git push", projectDir);
  if (result.success) {
    return true;
  }

  if (isMissingUpstreamPushFailure(result)) {
    return false;
  }

  throw new Error(`${failurePrefix}: ${extractCommandFailure(result)}`);
}

function listChangedPathsFromStatus(output: string): string[] {
  const changedPaths = new Set<string>();

  for (const rawLine of output.split(/\r?\n/u)) {
    if (rawLine.trim().length === 0 || rawLine.length < 4 || !/^[ MARCUD?!]{2} /u.test(rawLine)) {
      continue;
    }

    const pathPart = rawLine.slice(3).trim();
    if (pathPart.length === 0) {
      continue;
    }

    const paths = pathPart.includes(" -> ")
      ? pathPart.split(" -> ").map((entry) => entry.trim())
      : [pathPart];

    for (const candidate of paths) {
      if (candidate.length === 0 || candidate === ".conductor" || candidate.startsWith(".conductor/")) {
        continue;
      }
      changedPaths.add(candidate);
    }
  }

  return [...changedPaths];
}

function buildBugfixCommitMessage(issue: BugIssue): string {
  const normalizedTitle = issue.title.replace(/\s+/gu, " ").trim();
  const baseMessage = normalizedTitle.length > 0 ? `Fix ${normalizedTitle}` : "Fix bug";
  return baseMessage.slice(0, 72).trimEnd();
}

function unwrapDoneTag(text: string): string {
  const match = text.match(/<done>([\s\S]*?)<\/done>/iu);
  return match?.[1]?.trim() ?? text.trim();
}

function parsePrReviewResponse(response: string): { verdict: "PASS" | "FAIL" | "error"; findings: PrReviewFinding[] } {
  const normalized = unwrapDoneTag(response);
  if (/^PASS\b/iu.test(normalized)) {
    return { verdict: "PASS", findings: [] };
  }

  if (!/^FAIL\b/iu.test(normalized)) {
    return { verdict: "error", findings: [] };
  }

  const trailing = normalized.replace(/^FAIL\b/iu, "").trim();
  if (trailing.length === 0) {
    return { verdict: "FAIL", findings: [] };
  }

  const candidates = [trailing];
  const fencedMatch = trailing.match(/```(?:json)?\s*([\s\S]*?)```/iu);
  if (fencedMatch?.[1]) {
    candidates.push(fencedMatch[1].trim());
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (!Array.isArray(parsed)) {
        continue;
      }

      const findings = parsed
        .filter((entry): entry is PrReviewFinding => {
          return typeof entry === "object"
            && entry !== null
            && typeof (entry as { file?: unknown }).file === "string"
            && typeof (entry as { line?: unknown }).line === "number"
            && typeof (entry as { description?: unknown }).description === "string";
        })
        .map((entry) => ({
          file: entry.file,
          line: entry.line,
          description: entry.description,
        }));

      return { verdict: "FAIL", findings };
    } catch {
      continue;
    }
  }

  return { verdict: "FAIL", findings: [] };
}

type PullRequestReference = {
  owner: string;
  repo: string;
  number: number;
};

type CopilotReviewRecord = {
  id: number;
  submittedAt: string;
  userLogin: string;
};

type CopilotCommentRecord = {
  path: string;
  line: number;
  body: string;
  url?: string;
};

type GithubReviewCommentPayload = {
  path?: unknown;
  line?: unknown;
  original_line?: unknown;
  body?: unknown;
  html_url?: unknown;
  created_at?: unknown;
  pull_request_review_id?: unknown;
  resolved?: unknown;
  isResolved?: unknown;
  thread_resolved?: unknown;
  state?: unknown;
  user?: { login?: unknown };
};

function parseJsonValue(response: string): unknown {
  try {
    return JSON.parse(response) as unknown;
  } catch {
    return undefined;
  }
}

function extractGithubOwnerLogin(owner: unknown): string | undefined {
  if (typeof owner === "string" && owner.trim().length > 0) {
    return owner.trim();
  }

  if (typeof owner === "object" && owner !== null) {
    const login = (owner as { login?: unknown }).login;
    if (typeof login === "string" && login.trim().length > 0) {
      return login.trim();
    }
  }

  return undefined;
}

function parsePullRequestReference(repoResponse: string, prResponse: string): PullRequestReference | undefined {
  const repoPayload = parseJsonValue(repoResponse);
  const prPayload = parseJsonValue(prResponse);

  if (typeof repoPayload !== "object" || repoPayload === null) {
    return undefined;
  }

  if (typeof prPayload !== "object" || prPayload === null) {
    return undefined;
  }

  const repo = (repoPayload as { name?: unknown }).name;
  const owner = extractGithubOwnerLogin((repoPayload as { owner?: unknown }).owner);
  const number = (prPayload as { number?: unknown }).number;

  if (typeof repo !== "string" || repo.trim().length === 0 || !owner || typeof number !== "number") {
    return undefined;
  }

  return {
    owner,
    repo: repo.trim(),
    number,
  };
}

function isCopilotReviewerLogin(login: string): boolean {
  const normalized = login.trim().toLowerCase();
  return normalized === "copilot"
    || normalized === "github-copilot[bot]"
    || normalized === "copilot-pull-request-reviewer[bot]";
}

function parseCopilotReviews(response: string, pushedAt: string): CopilotReviewRecord[] {
  const payload = parseJsonValue(response);
  if (!Array.isArray(payload)) {
    return [];
  }

  return payload
    .filter((entry): entry is {
      id?: unknown;
      submitted_at?: unknown;
      user?: { login?: unknown };
    } => typeof entry === "object" && entry !== null)
    .map((entry) => ({
      id: typeof entry.id === "number" ? entry.id : NaN,
      submittedAt: typeof entry.submitted_at === "string" ? entry.submitted_at : "",
      userLogin: typeof entry.user?.login === "string" ? entry.user.login : "",
    }))
    .filter((entry) => Number.isFinite(entry.id)
      && entry.submittedAt.length > 0
      && Date.parse(entry.submittedAt) > Date.parse(pushedAt)
      && isCopilotReviewerLogin(entry.userLogin))
    .sort((left, right) => Date.parse(right.submittedAt) - Date.parse(left.submittedAt));
}

function isResolvedReviewComment(entry: GithubReviewCommentPayload): boolean {
  if (entry.resolved === true || entry.isResolved === true || entry.thread_resolved === true) {
    return true;
  }

  return typeof entry.state === "string" && entry.state.trim().toLowerCase() === "resolved";
}

function parseCopilotComments(response: string, review: CopilotReviewRecord): CopilotCommentRecord[] {
  const payload = parseJsonValue(response);
  if (!Array.isArray(payload)) {
    return [];
  }

  return payload
    .filter((entry): entry is GithubReviewCommentPayload => typeof entry === "object" && entry !== null)
    .filter((entry) => {
      const createdAt = typeof entry.created_at === "string" ? entry.created_at : "";
      const reviewId = typeof entry.pull_request_review_id === "number" ? entry.pull_request_review_id : undefined;
      const userLogin = typeof entry.user?.login === "string" ? entry.user.login : "";

      if (!isCopilotReviewerLogin(userLogin) || isResolvedReviewComment(entry)) {
        return false;
      }

      if (reviewId !== undefined) {
        return reviewId === review.id;
      }

      return createdAt.length > 0 && Date.parse(createdAt) >= Date.parse(review.submittedAt);
    })
    .map((entry) => ({
      path: typeof entry.path === "string" ? entry.path : "unknown",
      line: typeof entry.line === "number"
        ? entry.line
        : typeof entry.original_line === "number"
          ? entry.original_line
          : 1,
      body: typeof entry.body === "string" ? entry.body : "",
      url: typeof entry.html_url === "string" ? entry.html_url : undefined,
    }))
    .filter((entry) => entry.body.trim().length > 0);
}

function diffChangedPaths(before: string[], after: string[]): string[] {
  const previous = new Set(before);
  return after.filter((candidate) => !previous.has(candidate));
}

function summarizeProjectRootForConventions(fileNames: string[], availableSkills: string[]): string {
  const extensions = new Set<string>();
  const buildFiles: string[] = [];
  const lockFiles: string[] = [];

  for (const fileName of [...fileNames].sort((left, right) => left.localeCompare(right))) {
    const extension = path.extname(fileName).trim();
    if (extension.length > 0) {
      extensions.add(extension);
    }

    if (BUILD_FILE_NAMES.has(fileName)) {
      buildFiles.push(fileName);
    }

    if (LOCK_FILE_NAMES.has(fileName)) {
      lockFiles.push(fileName);
    }
  }

  return [
    "Project root summary:",
    `File extensions: ${extensions.size > 0 ? [...extensions].sort((left, right) => left.localeCompare(right)).join(", ") : "none"}`,
    `Build files: ${buildFiles.length > 0 ? buildFiles.join(", ") : "none"}`,
    `Lock files: ${lockFiles.length > 0 ? lockFiles.join(", ") : "none"}`,
    "Available conventions skills:",
    ...availableSkills.map((skillName) => `- ${skillName}`),
  ].join("\n");
}

async function readSingleResponseText(response: vscode.LanguageModelChatResponse): Promise<string> {
  return readResponseText(response);
}

function parseFeatureSlugResponse(response: string): string | undefined {
  const trimmed = response.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const candidates = [trimmed];
  const fencedMatches = trimmed.matchAll(/```(?:text|markdown)?\s*([\s\S]*?)```/gu);
  for (const match of fencedMatches) {
    if (match[1]?.trim()) {
      candidates.push(match[1].trim());
    }
  }

  for (const candidate of candidates) {
    const slugMatch = candidate.match(/[a-z0-9]+(?:-[a-z0-9]+)*/u);
    if (slugMatch) {
      return slugMatch[0];
    }
  }

  return undefined;
}

export async function deriveFeatureSlug(
  text: string,
  modelAssignments: ModelAssignment[] = [],
  token: vscode.CancellationToken = createFallbackToken(),
  selectModel: typeof selectModelForRole = selectModelForRole,
): Promise<string> {
  try {
    const model = await selectModel("spec-author", modelAssignments);
    const response = await model.sendRequest(
      buildLanguageModelChatMessages([
        {
          role: "system",
          content: [
            "Return a concise kebab-case slug for the feature prompt.",
            "Use only lowercase letters, numbers, and hyphens.",
            "Return only the slug.",
            "Do not call tools.",
          ].join("\n"),
        },
        {
          role: "user",
          content: text,
        },
      ]) as unknown as vscode.LanguageModelChatMessage[],
      undefined,
      token,
    );

    return parseFeatureSlugResponse(await readSingleResponseText(response)) ?? "";
  } catch {
    return "";
  }
}

export function parseConventionsSkillGuess(response: string, availableSkills: string[]): string | undefined {
  const normalizedSkills = new Map(availableSkills.map((skillName) => [skillName.toLowerCase(), skillName]));
  const trimmed = response.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const candidates = [trimmed];
  const fencedMatches = trimmed.matchAll(/```(?:text|markdown)?\s*([\s\S]*?)```/gu);
  for (const match of fencedMatches) {
    if (match[1]?.trim()) {
      candidates.push(match[1].trim());
    }
  }

  for (const candidate of candidates) {
    const directMatch = normalizedSkills.get(candidate.toLowerCase());
    if (directMatch) {
      return directMatch;
    }

    const skillMatches = candidate.match(/[a-z0-9-]+-conventions/giu) ?? [];
    for (const skillMatch of skillMatches) {
      const resolved = normalizedSkills.get(skillMatch.toLowerCase());
      if (resolved) {
        return resolved;
      }
    }

    const normalizedCandidate = candidate.toLowerCase();
    for (const [normalizedSkill, originalSkill] of normalizedSkills.entries()) {
      if (normalizedCandidate.includes(normalizedSkill)) {
        return originalSkill;
      }
    }
  }

  return undefined;
}

export async function guessConventionsSkill(
  projectDir: string,
  availableSkills: string[],
  modelAssignments: ModelAssignment[],
  token: vscode.CancellationToken,
): Promise<string | undefined> {
  if (availableSkills.length === 0) {
    return undefined;
  }

  try {
    const rootEntries = await readdir(projectDir, { withFileTypes: true });
    const rootFiles = rootEntries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
    const prompt = summarizeProjectRootForConventions(rootFiles, availableSkills);
    const model = await selectModelForRole("spec-author", modelAssignments);
    const response = await model.sendRequest(
      buildLanguageModelChatMessages([
        {
          role: "system",
          content: [
            "Choose the single best conventions skill for the repository.",
            "Return only one exact skill name from the provided list.",
            "If the evidence is insufficient or ambiguous, return UNKNOWN.",
            "Do not call tools.",
          ].join("\n"),
        },
        {
          role: "user",
          content: prompt,
        },
      ]) as unknown as vscode.LanguageModelChatMessage[],
      undefined,
      token,
    );

    return parseConventionsSkillGuess(await readSingleResponseText(response), availableSkills);
  } catch {
    return undefined;
  }
}

export async function checkBranchSafety(
  projectDir: string,
  trustedExecution: TrustedExecutor,
): Promise<{ safe: boolean; branch: string; reason?: string }> {
  const currentBranchResult = await trustedExecution("git rev-parse --abbrev-ref HEAD", projectDir);
  if (!currentBranchResult.success) {
    return {
      safe: false,
      branch: "unknown",
      reason: `Failed to determine current branch: ${extractCommandFailure(currentBranchResult)}`,
    };
  }

  const branch = extractCommandStdout(currentBranchResult.output).split(/\r?\n/u)[0]?.trim() || "unknown";
  const protectedBranches = new Set(["main", "master"]);

  const defaultBranchResult = await trustedExecution("git remote show origin | grep 'HEAD branch'", projectDir);
  if (defaultBranchResult.success) {
    const match = defaultBranchResult.output.match(/HEAD branch:\s*(\S+)/u);
    if (match?.[1]) {
      protectedBranches.add(match[1]);
    }
  }

  if (protectedBranches.has(branch)) {
    return {
      safe: false,
      branch,
      reason: `Cannot run Conductor on protected branch '${branch}'. Switch to a feature branch first.`,
    };
  }

  return { safe: true, branch };
}

export async function commitAndPushConductorState(
  projectDir: string,
  trustedExecution: TrustedExecutor,
): Promise<void> {
  const commands: Array<{ command: string; failurePrefix: string }> = [
    { command: "git add .conductor/", failurePrefix: "Failed to stage Conductor state" },
    {
      command: `git commit -m '${STATE_CHECKPOINT_COMMIT_MESSAGE}'`,
      failurePrefix: "Failed to commit Conductor state",
    },
  ];

  for (const { command, failurePrefix } of commands) {
    const result = await trustedExecution(command, projectDir);
    if (!result.success) {
      throw new Error(`${failurePrefix}: ${extractCommandFailure(result)}`);
    }
  }

  await pushWithOptionalUpstream(projectDir, trustedExecution, "Failed to push Conductor state");
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

function extractRepoRelativePromptPaths(promptContent: string): string[] {
  const references = new Set<string>();
  const pathPattern = /(^|[\s`"'([{<])(\.(?:[A-Za-z0-9._-]*\/[A-Za-z0-9._-]+)+)(?=$|[\s`"'.,:;!?()[\]{}<>])/gu;

  for (const match of promptContent.matchAll(pathPattern)) {
    const candidate = match[2]?.trim().replace(/[.,:;!?]+$/u, "");
    if (!candidate || candidate === "." || candidate === "..") {
      continue;
    }

    references.add(candidate);
  }

  return [...references];
}

function truncateReferencedFileContent(content: string): { content: string; truncated: boolean } {
  if (content.length <= MAX_REFERENCED_FILE_CONTENT_CHARS) {
    return { content, truncated: false };
  }

  return {
    content: `${content.slice(0, MAX_REFERENCED_FILE_CONTENT_CHARS)}\n[truncated]`,
    truncated: true,
  };
}

function formatReferencedFilesSection(files: Array<{ path: string; content: string; truncated: boolean }>): string {
  if (files.length === 0) {
    return "";
  }

  return [
    PROMPT_REFERENCED_FILES_SECTION_TITLE,
    ...files.flatMap((file) => [
      `Path: ${file.path}`,
      "Contents:",
      file.content.length > 0 ? file.content : "[empty file]",
    ]),
  ].join("\n\n").trimEnd();
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
    executeTrusted,
    sleep: async (milliseconds: number) => {
      await new Promise((resolve) => setTimeout(resolve, milliseconds));
    },
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
  let activeCopilotReReview: Promise<void> | undefined;
  let lastToken: vscode.CancellationToken | undefined;
  let cachedPhase: Phase | undefined;
  let cachedPhaseNumber: number | undefined;
  let cachedPhasePath: string | undefined;
  let cachedSpecContent = "";
  let pauseRequested = false;
  let abandonRequested = false;
  let persistChain = Promise.resolve();
  let visibleState = cloneState(state);
  const itemFeedback = new Map<string, string>();
  const specFeedback = new Map<SpecStep, string>();
  const approvalResolvers = new Map<string, (action: ApprovalAction) => void>();
  const approvalGroups = new Map<string, string[]>();
  let specApprovalResolver: ((action: ApprovalAction) => void) | undefined;
  let pendingSpecApprovalStep: SpecStep | undefined;
  let bugfixApprovalResolver: ((action: ApprovalAction) => void) | undefined;
  let prReviewApprovalResolver: ((action: ApprovalAction) => void) | undefined;
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

  const isAbandoned = (): boolean => abandonRequested || state.status === "abandoned";

  const getSpecDir = (): string => state.specDir;
  const getPromptPath = (): string => path.join(getSpecDir(), "prompt.md");
  const getSpecPath = (): string => path.join(getSpecDir(), "spec.md");
  const getConventionsSkill = (): string => state.conventionsSkill;
  const getTestCommand = (): string => state.testCommand;
  const getLintCommand = (): string => state.lintCommand;
  const isBugfixRun = (): boolean => /^bugs\d+$/u.test(path.basename(getSpecDir()));

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

  const buildPromptWithReferencedFiles = async (promptContent: string): Promise<string> => {
    const referencedFiles: Array<{ path: string; content: string; truncated: boolean }> = [];

    for (const referencedPath of extractRepoRelativePromptPaths(promptContent)) {
      const resolvedPath = path.resolve(config.projectDir, referencedPath);
      const relativeToProject = path.relative(config.projectDir, resolvedPath);

      if (relativeToProject.length === 0 || relativeToProject.startsWith("..") || path.isAbsolute(relativeToProject)) {
        continue;
      }

      const fileContent = await readOptionalFile(resolvedPath);
      if (fileContent === undefined) {
        continue;
      }

      const truncated = truncateReferencedFileContent(fileContent);
      referencedFiles.push({
        path: toGitRelativePath(config.projectDir, resolvedPath),
        content: truncated.content,
        truncated: truncated.truncated,
      });
    }

    if (referencedFiles.length === 0) {
      return promptContent;
    }

    return `${promptContent}\n\n${formatReferencedFilesSection(referencedFiles)}`;
  };

  const invalidatePhaseCache = () => {
    cachedPhase = undefined;
    cachedPhaseNumber = undefined;
    cachedPhasePath = undefined;
  };

  const getSortedPhaseFiles = async (): Promise<string[]> => {
    const entries = await deps.readDirectory(getSpecDir());
    return entries
      .filter((entry) => /^phase\d+\.md$/i.test(entry))
      .sort((left, right) => {
        const leftNumber = Number.parseInt(left.replace(/\D+/g, ""), 10);
        const rightNumber = Number.parseInt(right.replace(/\D+/g, ""), 10);
        return leftNumber - rightNumber;
      })
      .map((entry) => path.join(getSpecDir(), entry));
  };

  const getPhasePath = (phaseNumber: number): string => path.join(getSpecDir(), `phase${phaseNumber}.md`);

  const loadAllPhases = async (): Promise<Phase[]> => {
    const entries = await deps.readDirectory(getSpecDir());
    const phaseFiles = entries
      .filter((entry) => /^phase\d+\.md$/i.test(entry))
      .sort((left, right) => {
        const leftNumber = Number.parseInt(left.replace(/\D+/g, ""), 10);
        const rightNumber = Number.parseInt(right.replace(/\D+/g, ""), 10);
        return leftNumber - rightNumber;
      });

    const phases = await Promise.all(phaseFiles.map(async (entry) => {
      return parsePhaseFile(await deps.readFile(path.join(getSpecDir(), entry), "utf8"));
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
    const specExists = await pathExists(getSpecPath());
    const promptExists = await pathExists(getPromptPath());
    state = {
      ...defaultState,
      ...persistedState,
      specDir: persistedState.specDir || defaultState.specDir,
      conventionsSkill: typeof persistedState.conventionsSkill === "string"
        ? persistedState.conventionsSkill
        : defaultState.conventionsSkill,
      testCommand: typeof persistedState.testCommand === "string"
        ? persistedState.testCommand
        : defaultState.testCommand,
      lintCommand: typeof persistedState.lintCommand === "string"
        ? persistedState.lintCommand
        : defaultState.lintCommand,
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
      bugStep: normalizeBugStep(persistedState.bugStep),
      bugIndex: typeof persistedState.bugIndex === "number"
        ? persistedState.bugIndex
        : defaultState.bugIndex,
      bugFixCycle: typeof persistedState.bugFixCycle === "number"
        ? persistedState.bugFixCycle
        : defaultState.bugFixCycle,
      bugIssues: Array.isArray(persistedState.bugIssues)
        ? persistedState.bugIssues
          .filter((issue): issue is BugIssue => {
            return typeof issue === "object"
              && issue !== null
              && typeof issue.title === "string"
              && typeof issue.description === "string";
          })
          .map((issue) => ({ title: issue.title, description: issue.description }))
        : defaultState.bugIssues,
      prReviewStep: normalizePrReviewStep(persistedState.prReviewStep),
      prReviewConsecutivePasses: typeof persistedState.prReviewConsecutivePasses === "number"
        ? persistedState.prReviewConsecutivePasses
        : defaultState.prReviewConsecutivePasses,
      startedBy: persistedState.startedBy ?? defaultState.startedBy,
    };

    cachedSpecContent = (await readOptionalFile(getSpecPath())) ?? "";
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
      getConventionsSkill(),
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

  const failRunStart = async (message: string) => {
    state.status = "error";
    await persistState();

    const auditEntry = {
      timestamp: deps.now(),
      role: "spec-author",
      model: "system",
      itemId: "phase0:start",
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

    if (action.type === "abandon") {
      state.status = "abandoned";
      await persistState();
      return "skipped";
    }

    state.status = "running";

    if (action.type === "approve") {
      state.specConsecutivePasses = 0;
      state.specStep = nextStep;
      await persistSpecCheckpoint(step, "spec-author");
      return "approved";
    }

    if (action.type === "skip") {
      state.specConsecutivePasses = 0;
      state.specStep = "done";
      await persistSpecCheckpoint(step, "spec-author");
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

    const promptContent = await readOptionalFile(getPromptPath());
    if (!promptContent) {
      await failSpecStep("clarifying", "spec-author", "prompt.md is required for clarification answers.");
      return;
    }

    const updatedPrompt = appendNotesSection(promptContent, validAnswers.map(formatClarificationNote));
    await deps.writeFile(getPromptPath(), updatedPrompt, "utf8");

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

    const promptContent = await readOptionalFile(getPromptPath());
    if (!promptContent) {
      await failSpecStep("clarifying", "spec-author", "No spec.md or prompt.md found in specDir.");
      return "completed";
    }

    const promptWithReferencedFiles = await buildPromptWithReferencedFiles(promptContent);

    let retriesUsed = 0;

    while (retriesUsed < config.maxRetries) {
      try {
        const result = await invokePreparedPrompt(
          "spec-author",
          "clarifier",
          "phase0:clarifying",
          await buildClarificationSystemPrompt(config.skillsDir, getConventionsSkill(), getToolDefinitions()),
          promptWithReferencedFiles,
          token,
        );

        if (pauseRequested || token.isCancellationRequested) {
          return "interrupted";
        }

        const parsedQuestions = extractClarificationQuestions(result.response);
        if (parsedQuestions === null || parsedQuestions.length === 0) {
          state.clarificationQuestions = [];
          state.specStep = "authoring";
          if (!(await persistSpecCheckpoint("clarifying", "spec-author"))) {
            return "completed";
          }
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

  const populateCommandsFromConventionsSkill = async (token: vscode.CancellationToken): Promise<void> => {
    const conventionsSkill = getConventionsSkill().trim();
    if (conventionsSkill.length === 0) {
      return;
    }

    if (getTestCommand() !== DEFAULT_TEST_COMMAND || getLintCommand() !== DEFAULT_LINT_COMMAND) {
      return;
    }

    const skillPath = path.join(config.skillsDir, conventionsSkill, "SKILL.md");
    const skillText = await readOptionalFile(skillPath);
    if (!skillText) {
      return;
    }

    const model = await deps.selectModelForRole("spec-author", state.modelAssignments);
    const result = await deps.invokeWithToolLoop(
      model,
      [
        "Extract the test command and lint command(s) from the provided conventions skill text.",
        "Return the result inside <done></done> tags as JSON with the shape {\"testCommand\":\"...\",\"lintCommand\":\"...\"}.",
        "The lintCommand may be a compound command using &&.",
        "Do not call tools.",
      ].join("\n"),
      skillText,
      config.projectDir,
      {
        maxTurns: 1,
        token,
      },
    );

    const extracted = parseCommandExtraction(result.response);
    state.testCommand = extracted.testCommand;
    state.lintCommand = extracted.lintCommand;
    await persistState();
  };

  const runAuthoringStep = async (token: vscode.CancellationToken): Promise<ProcessingOutcome> => {
    const promptContent = await readOptionalFile(getPromptPath());
    if (!promptContent) {
      await failSpecStep("authoring", "spec-author", "prompt.md is required for spec authoring.");
      return "completed";
    }

    const promptWithReferencedFiles = await buildPromptWithReferencedFiles(promptContent);

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
          SPEC_AUTHOR_COMPLETION_CONTRACT,
          `Target spec path: ${getSpecPath()}`,
          `Conventions skill: ${getConventionsSkill()}`,
          "Requirements from prompt.md:",
          promptWithReferencedFiles,
          feedback ? `Feedback:\n${feedback}` : "",
        ].filter(Boolean).join("\n\n"),
        token,
      );

      if (parseSpecStepResult(result.response) === "PASS") {
        specFeedback.delete("authoring");
        state.specConsecutivePasses = 0;
        state.specStep = "reviewing";
        cachedSpecContent = (await readOptionalFile(getSpecPath())) ?? cachedSpecContent;
        if (!(await persistSpecCheckpoint("authoring", "spec-author"))) {
          return "completed";
        }
        return "completed";
      }

      retriesUsed += 1;
      if (retriesUsed >= config.maxRetries) {
        await failSpecStep("authoring", "spec-author", `Spec authoring failed: ${getInvocationFailureDetail(result)}`);
        return "completed";
      }
    }

    return "completed";
  };

  const runReviewingStep = async (token: vscode.CancellationToken): Promise<ProcessingOutcome> => {
    const promptContent = (await readOptionalFile(getPromptPath())) ?? "";
    const promptWithReferencedFiles = promptContent.length > 0
      ? await buildPromptWithReferencedFiles(promptContent)
      : "";
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
            SPEC_AUTHOR_COMPLETION_CONTRACT,
            `Target spec path: ${getSpecPath()}`,
            `Conventions skill: ${getConventionsSkill()}`,
            "Requirements from prompt.md:",
            promptWithReferencedFiles,
            `Feedback:\n${authorFeedback}`,
          ].join("\n\n"),
          token,
        );

        if (parseSpecStepResult(authorResult.response) !== "PASS") {
          retriesUsed += 1;
          if (retriesUsed >= config.maxRetries) {
            await failSpecStep("reviewing", "spec-author", `Spec rewrite failed: ${getInvocationFailureDetail(authorResult)}`);
            return "completed";
          }

          continue;
        }

        specFeedback.delete("authoring");
        cachedSpecContent = (await readOptionalFile(getSpecPath())) ?? cachedSpecContent;
      }

      const reviewerResult = await invokeRole(
        "spec-reviewer",
        "phase0:reviewing",
        "Spec writing phase 0 review.",
        [
          `Review spec file: ${getSpecPath()}`,
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
        if (!(await persistSpecCheckpoint("reviewing", "spec-reviewer"))) {
          return "completed";
        }
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
          `Proofread spec file: ${getSpecPath()}`,
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
        if (!(await persistSpecCheckpoint("proofreading", "spec-proofreader"))) {
          return "completed";
        }
        return "completed";
      }

      if (verdict !== "FIXED") {
        retriesUsed += 1;
        if (retriesUsed >= config.maxRetries) {
          await failSpecStep("proofreading", "spec-proofreader", `Spec proofreading failed: ${getInvocationFailureDetail(proofreaderResult)}`);
          return "completed";
        }
      } else {
        retriesUsed += 1;
        if (retriesUsed >= config.maxRetries) {
          await failSpecStep("proofreading", "spec-proofreader", `Spec proofreading exhausted retries: ${getInvocationFailureDetail(proofreaderResult)}`);
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
          `Read spec from: ${getSpecPath()}`,
          `Write phase files to: ${getSpecDir()}`,
          `Implementor skill: ${deriveImplementationSkillName("implementor", getConventionsSkill())}`,
          `Reviewer skill: ${deriveImplementationSkillName("reviewer", getConventionsSkill())}`,
          feedback ? `Feedback:\n${feedback}` : "",
        ].join("\n\n"),
        token,
      );

      if (parseSpecStepResult(result.response) === "PASS") {
        specFeedback.delete("reviewing-phases");
        invalidatePhaseCache();
        state.specPhaseFileIndex = 0;
        state.specStep = "reviewing-phases";
        if (!(await persistSpecCheckpoint("creating-phases", "phase-creator"))) {
          return "completed";
        }
        return "completed";
      }

      retriesUsed += 1;
      if (retriesUsed >= config.maxRetries) {
        await failSpecStep("creating-phases", "phase-creator", `Phase creation failed: ${getInvocationFailureDetail(result)}`);
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
          `Spec file: ${getSpecPath()}`,
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
        await failSpecStep("reviewing-phases", "phase-reviewer", `Phase review failed: ${getInvocationFailureDetail(result)}`);
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
    if (!(await persistSpecCheckpoint("reviewing-phases", "phase-reviewer"))) {
      return "completed";
    }
    return "completed";
  };

  const runSpecWritingLoop = async (token: vscode.CancellationToken): Promise<ProcessingOutcome> => {
    const specExists = await pathExists(getSpecPath());
    const promptExists = await pathExists(getPromptPath());

    if (!specExists && !promptExists) {
      await failSpecStep(state.specStep === "done" ? "clarifying" : state.specStep, "spec-author", "No spec.md or prompt.md found in specDir.");
      return "completed";
    }

    if (specExists && state.specStep === "done") {
      cachedSpecContent = (await readOptionalFile(getSpecPath())) ?? "";
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

    cachedSpecContent = (await readOptionalFile(getSpecPath())) ?? cachedSpecContent;
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
    const result = await deps.executeBash(getTestCommand(), config.projectDir);
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

  const readModifiedFilesSnapshot = async (): Promise<string> => {
    const result = await deps.executeBash("git diff -- .", config.projectDir);
    if (!result.success) {
      return "";
    }

    return extractCommandStdout(result.output);
  };

  const runLint = async (
    itemIds: string[],
  ): Promise<{ kind: "pass" | "retry" | "timeout"; feedback?: string; modifiedFiles?: boolean }> => {
    const lintCommand = getLintCommand().trim();
    if (lintCommand.length === 0) {
      return { kind: "pass", modifiedFiles: false };
    }

    const beforeSnapshot = await readModifiedFilesSnapshot();
    const result = await deps.executeTrusted(lintCommand, config.projectDir);
    if (!result.success) {
      const message = extractCommandFailure(result);
      if ((result.error ?? "").toLowerCase().includes("timeout")) {
        await Promise.all(itemIds.map(async (itemId) => markItemFailed(itemId, `lint timeout: ${message}`, "error")));
        return { kind: "timeout" };
      }

      return {
        kind: "retry",
        feedback: `Lint command failed:\n${message}`,
      };
    }

    const afterSnapshot = await readModifiedFilesSnapshot();
    return {
      kind: "pass",
      modifiedFiles: beforeSnapshot !== afterSnapshot,
    };
  };

  const runQualityGate = async (itemId: string): Promise<{ kind: "pass" | "retry" | "timeout"; feedback?: string }> => {
    const testOutcome = await runTests(itemId);
    if (testOutcome.kind !== "pass") {
      return testOutcome;
    }

    const lintOutcome = await runLint([itemId]);
    if (lintOutcome.kind !== "pass") {
      return lintOutcome;
    }

    if (!lintOutcome.modifiedFiles) {
      return { kind: "pass" };
    }

    return await runTests(itemId);
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

    if (action.type === "abandon") {
      state.status = "abandoned";
      await persistState();
      return "skipped";
    }

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

  const initializeBugfixState = async (token: vscode.CancellationToken): Promise<boolean> => {
    if ((state.bugIssues?.length ?? 0) > 0 && typeof state.bugIndex === "number" && state.bugStep) {
      return true;
    }

    const promptContent = await readOptionalFile(getPromptPath());
    if (!promptContent) {
      await failRunStart("prompt.md is required for bugfix orchestration.");
      return false;
    }

    state.bugIssues = await splitBugPromptIntoIssues(
      promptContent,
      state.modelAssignments,
      token,
      deps.selectModelForRole,
    );
    state.bugIndex = 0;
    state.bugFixCycle = 1;
    state.bugStep = "fixing";
    await persistState();
    return true;
  };

  const failBugfix = async (message: string, bugIndex = state.bugIndex ?? 0) => {
    state.status = "error";
    await persistState();

    const auditEntry = {
      timestamp: deps.now(),
      role: "reviewer",
      model: "system",
      itemId: `bugfix:${bugIndex + 1}`,
      promptSummary: truncatePromptSummary(message),
      result: "error",
      tokensIn: 0,
      tokensOut: 0,
      durationMs: 0,
    } satisfies AuditEntry;

    await deps.appendAudit(conductorDir, auditEntry);
    emitAudit(auditEntry);
  };

  const getBugIssueKey = (bugIndex: number): string => `bugfix:${bugIndex + 1}`;

  const getBugContext = (bugIndex: number, issue: BugIssue): string => {
    const cycle = state.bugFixCycle ?? 1;
    const bugCount = state.bugIssues?.length ?? 0;
    return [
      `Bug issue ${bugIndex + 1} of ${bugCount}`,
      `Cycle: ${cycle} of ${BUGFIX_MAX_CYCLES}`,
      `Title: ${issue.title}`,
      `Description: ${issue.description}`,
    ].join("\n\n");
  };

  const getBugFeedback = (bugIndex: number): string | undefined => {
    return itemFeedback.get(getBugIssueKey(bugIndex));
  };

  const setBugFeedback = (bugIndex: number, feedback: string): void => {
    itemFeedback.set(getBugIssueKey(bugIndex), feedback);
  };

  const appendBugFeedback = (bugIndex: number, feedback: string): void => {
    const current = getBugFeedback(bugIndex);
    setBugFeedback(bugIndex, current ? `${current}\n\n${feedback}` : feedback);
  };

  const clearBugFeedback = (bugIndex: number): void => {
    itemFeedback.delete(getBugIssueKey(bugIndex));
  };

  const getBugfixChangedFiles = async (): Promise<string[]> => {
    const statusOutput = await runTrustedCommand(
      "git status --porcelain",
      "Failed to list changed files for bugfix commit",
    );
    return listChangedPathsFromStatus(statusOutput);
  };

  const runBugfixTests = async (): Promise<{ kind: "pass" | "retry" | "timeout"; feedback?: string }> => {
    const result = await deps.executeBash(getTestCommand(), config.projectDir);
    if (result.success) {
      return { kind: "pass" };
    }

    const message = [result.output, result.error].filter(Boolean).join("\n");
    if ((result.error ?? "").toLowerCase().includes("timeout")) {
      return {
        kind: "timeout",
        feedback: `Test command timed out:\n${message}`,
      };
    }

    return {
      kind: "retry",
      feedback: `Test command failed:\n${message}`,
    };
  };

  const runBugfixLint = async (): Promise<{ kind: "pass" | "retry" | "timeout"; feedback?: string; modifiedFiles?: boolean }> => {
    const lintCommand = getLintCommand().trim();
    if (lintCommand.length === 0) {
      return { kind: "pass", modifiedFiles: false };
    }

    const beforeSnapshot = await readModifiedFilesSnapshot();
    const result = await deps.executeTrusted(lintCommand, config.projectDir);
    if (!result.success) {
      const message = extractCommandFailure(result);
      if ((result.error ?? "").toLowerCase().includes("timeout")) {
        return {
          kind: "timeout",
          feedback: `Lint command timed out:\n${message}`,
        };
      }

      return {
        kind: "retry",
        feedback: `Lint command failed:\n${message}`,
      };
    }

    const afterSnapshot = await readModifiedFilesSnapshot();
    return {
      kind: "pass",
      modifiedFiles: beforeSnapshot !== afterSnapshot,
    };
  };

  const runBugfixQualityGate = async (): Promise<{ kind: "pass" | "retry" | "timeout"; feedback?: string }> => {
    const testOutcome = await runBugfixTests();
    if (testOutcome.kind !== "pass") {
      return testOutcome;
    }

    const lintOutcome = await runBugfixLint();
    if (lintOutcome.kind !== "pass") {
      return lintOutcome;
    }

    if (!lintOutcome.modifiedFiles) {
      return { kind: "pass" };
    }

    return await runBugfixTests();
  };

  const advanceBugfixState = async (): Promise<ProcessingOutcome> => {
    const currentBugIndex = state.bugIndex ?? 0;
    const nextBugIndex = currentBugIndex + 1;
    clearBugFeedback(currentBugIndex);
    state.bugIndex = nextBugIndex;
    state.bugFixCycle = 1;

    if (nextBugIndex >= (state.bugIssues?.length ?? 0)) {
      state.bugStep = "done";
      state.status = "done";
      await persistState();
      return "completed";
    }

    state.bugStep = "fixing";
    await persistState();
    return "completed";
  };

  const markBugfixFailedAndAdvance = async (feedback: string): Promise<ProcessingOutcome> => {
    const bugIndex = state.bugIndex ?? 0;
    const auditEntry = {
      timestamp: deps.now(),
      role: "reviewer",
      model: "system",
      itemId: getBugIssueKey(bugIndex),
      promptSummary: truncatePromptSummary(feedback),
      result: "FAIL",
      tokensIn: 0,
      tokensOut: 0,
      durationMs: 0,
    } satisfies AuditEntry;

    await deps.appendAudit(conductorDir, auditEntry);
    emitAudit(auditEntry);
    return await advanceBugfixState();
  };

  const waitForBugfixApproval = async (): Promise<ApprovalAction> => {
    state.status = "pending-approval";
    await persistState();

    return await new Promise<ApprovalAction>((resolve) => {
      bugfixApprovalResolver = resolve;
    });
  };

  const handleBugfixApproval = async (): Promise<"approved" | "rejected" | "skipped"> => {
    const bugIndex = state.bugIndex ?? 0;
    const action = await waitForBugfixApproval();
    bugfixApprovalResolver = undefined;

    if (action.type === "abandon") {
      state.status = "abandoned";
      await persistState();
      return "skipped";
    }

    state.status = "running";

    if (action.type === "approve" || action.type === "skip") {
      state.bugStep = "committing";
      await persistState();
      return action.type === "approve" ? "approved" : "skipped";
    }

    appendBugFeedback(bugIndex, action.feedback);
    state.bugStep = "fixing";
    await persistState();
    return "rejected";
  };

  const commitAndPushBugfix = async (issue: BugIssue): Promise<void> => {
    const changedFiles = await getBugfixChangedFiles();
    if (changedFiles.length === 0) {
      throw new Error("No changed files found for bugfix commit.");
    }

    const quotedPaths = changedFiles.map((filePath) => quoteShellArgument(filePath)).join(" ");
    await runTrustedCommand(`git add -- ${quotedPaths}`, "Failed to stage bugfix changes");
    await runTrustedCommand(
      `git commit -m ${quoteShellArgument(buildBugfixCommitMessage(issue))}`,
      "Failed to commit bugfix changes",
    );
    await pushCurrentBranchIfUpstreamExists("Failed to push bugfix changes");
  };

  const runBugfixLoop = async (token: vscode.CancellationToken): Promise<ProcessingOutcome> => {
    if (!(await initializeBugfixState(token))) {
      return "completed";
    }

    while (true) {
      if (pauseRequested || token.isCancellationRequested) {
        state.status = "paused";
        await persistState();
        return "interrupted";
      }

      const bugIndex = state.bugIndex ?? 0;
      const bugIssues = state.bugIssues ?? [];
      const currentIssue = bugIssues[bugIndex];

      if (!currentIssue) {
        state.bugStep = "done";
        state.status = "done";
        await persistState();
        return "completed";
      }

      const bugCycle = state.bugFixCycle ?? 1;
      const bugItemId = getBugIssueKey(bugIndex);
      const bugStep = state.bugStep ?? "fixing";

      try {
        if (bugStep === "fixing") {
          const feedback = getBugFeedback(bugIndex);
          await invokeRole(
            "implementor",
            `${bugItemId}:fix:${bugCycle}`,
            getBugContext(bugIndex, currentIssue),
            [
              "Fix the reported bug.",
              "First write or update a failing regression test that reproduces the bug.",
              "Then fix the code so the regression test passes.",
              `Issue title: ${currentIssue.title}`,
              `Issue description:\n${currentIssue.description}`,
              feedback ? `Feedback:\n${feedback}` : "",
              "Keep scope limited to this issue.",
            ].filter(Boolean).join("\n\n"),
            token,
          );

          if (pauseRequested || token.isCancellationRequested) {
            state.status = "paused";
            await persistState();
            return "interrupted";
          }

          state.bugStep = "reviewing";
          await persistState();
          continue;
        }

        if (bugStep === "reviewing") {
          const qualityOutcome = await runBugfixQualityGate();
          if (qualityOutcome.kind !== "pass") {
            if (bugCycle >= BUGFIX_MAX_CYCLES) {
              const outcome = await markBugfixFailedAndAdvance(
                qualityOutcome.feedback ?? `Bugfix quality gate failed for ${currentIssue.title}.`,
              );
              if (outcome === "completed" && state.bugStep === "done") {
                return "completed";
              }
              continue;
            }

            setBugFeedback(bugIndex, qualityOutcome.feedback ?? "Bugfix quality gate failed.");
            state.bugFixCycle = bugCycle + 1;
            state.bugStep = "fixing";
            await persistState();
            continue;
          }

          const changedFiles = await getBugfixChangedFiles();
          const reviewerResult = await invokeRole(
            "reviewer",
            `${bugItemId}:review:${bugCycle}`,
            getBugContext(bugIndex, currentIssue),
            [
              "Review the bugfix implementation.",
              "Confirm a regression test exists for the bug.",
              "Confirm the fix is correct, minimal, and scoped to the issue.",
              "Confirm tests pass and lint is clean.",
              `Issue title: ${currentIssue.title}`,
              `Issue description:\n${currentIssue.description}`,
              `Changed files: ${changedFiles.length > 0 ? changedFiles.join(", ") : "<none>"}`,
              `Diff:\n${await readModifiedFilesSnapshot()}`,
              `Test command: ${getTestCommand()}`,
              `Lint command: ${getLintCommand().trim().length > 0 ? getLintCommand() : "<none>"}`,
              "Return PASS when the bugfix is acceptable, otherwise return FAIL with actionable feedback.",
            ].join("\n\n"),
            token,
          );

          if (pauseRequested || token.isCancellationRequested) {
            state.status = "paused";
            await persistState();
            return "interrupted";
          }

          if (getVerdict(reviewerResult) === "PASS") {
            clearBugFeedback(bugIndex);
            state.bugStep = "approving";
            await persistState();
            continue;
          }

          if (bugCycle >= BUGFIX_MAX_CYCLES) {
            const outcome = await markBugfixFailedAndAdvance(reviewerResult.response);
            if (outcome === "completed" && state.bugStep === "done") {
              return "completed";
            }
            continue;
          }

          setBugFeedback(bugIndex, reviewerResult.response);
          state.bugFixCycle = bugCycle + 1;
          state.bugStep = "fixing";
          await persistState();
          continue;
        }

        if (bugStep === "approving") {
          const approval = await handleBugfixApproval();
          if (approval === "rejected") {
            continue;
          }
          continue;
        }

        if (bugStep === "committing") {
          await commitAndPushBugfix(currentIssue);
          const outcome = await advanceBugfixState();
          if (outcome === "completed" && state.bugStep === "done") {
            return "completed";
          }
          continue;
        }

        state.status = "done";
        await persistState();
        return "completed";
      } catch (error) {
        await failBugfix(
          `Bugfix orchestration failed: ${error instanceof Error ? error.message : String(error)}`,
          bugIndex,
        );
        return "completed";
      }
    }
  };

  const failPrReview = async (message: string) => {
    state.status = "error";
    await persistState();

    const auditEntry = {
      timestamp: deps.now(),
      role: "pr-reviewer",
      model: "system",
      itemId: "pr-review",
      promptSummary: truncatePromptSummary(message),
      result: "error",
      tokensIn: 0,
      tokensOut: 0,
      durationMs: 0,
    } satisfies AuditEntry;

    await deps.appendAudit(conductorDir, auditEntry);
    emitAudit(auditEntry);
  };

  const logCopilotReReviewAudit = async (message: string, result: AuditEntry["result"]): Promise<void> => {
    const auditEntry = {
      timestamp: deps.now(),
      role: "pr-reviewer",
      model: "system",
      itemId: COPILOT_REREVIEW_ITEM_ID,
      promptSummary: truncatePromptSummary(message),
      result,
      tokensIn: 0,
      tokensOut: 0,
      durationMs: 0,
    } satisfies AuditEntry;

    await deps.appendAudit(conductorDir, auditEntry);
    emitAudit(auditEntry);
  };

  const logPhaseCommitAudit = async (phaseNumber: number, message: string, result: AuditEntry["result"] = "error") => {
    const auditEntry = {
      timestamp: deps.now(),
      role: "reviewer",
      model: "system",
      itemId: `phase${phaseNumber}:commit`,
      promptSummary: truncatePromptSummary(message),
      result,
      tokensIn: 0,
      tokensOut: 0,
      durationMs: 0,
    } satisfies AuditEntry;

    await deps.appendAudit(conductorDir, auditEntry);
    emitAudit(auditEntry);
  };

  const failPhaseCommit = async (phaseNumber: number, message: string) => {
    state.status = "error";
    await persistState();
    await logPhaseCommitAudit(phaseNumber, message, "error");
  };

  const runTrustedCommand = async (command: string, failurePrefix: string): Promise<string> => {
    const result = await deps.executeTrusted(command, config.projectDir);
    if (!result.success) {
      throw new Error(`${failurePrefix}: ${extractCommandFailure(result)}`);
    }

    return extractCommandStdout(result.output);
  };

  const pushCurrentBranchIfUpstreamExists = async (failurePrefix: string): Promise<boolean> => {
    return pushWithOptionalUpstream(config.projectDir, deps.executeTrusted, failurePrefix);
  };

  const pollWithTimeout = async <T>(
    timeoutMs: number,
    intervalMs: number,
    poller: () => Promise<T | undefined>,
  ): Promise<T | undefined> => {
    let elapsedMs = 0;

    while (true) {
      const value = await poller();
      if (value !== undefined) {
        return value;
      }

      if (elapsedMs >= timeoutMs) {
        return undefined;
      }

      await deps.sleep(intervalMs);
      elapsedMs += intervalMs;
    }
  };

  const commitAndPushCheckpointState = async (): Promise<void> => {
    await commitAndPushConductorState(config.projectDir, deps.executeTrusted);
  };

  const commitAndPushSpecWritingArtifacts = async (): Promise<void> => {
    const specDir = toGitRelativePath(config.projectDir, getSpecDir());
    const specPath = `${specDir}/spec.md`;
    const phaseGlob = `:(glob)${specDir}/phase*.md`;

    await runTrustedCommand(
      `git add -- ${quoteShellArgument(specPath)} ${quoteShellArgument(phaseGlob)}`,
      "Failed to stage spec-writing artifacts",
    );
    await runTrustedCommand(
      `git commit -m '${SPEC_WRITING_COMMIT_MESSAGE}'`,
      "Failed to commit spec-writing artifacts",
    );
    await pushCurrentBranchIfUpstreamExists("Failed to push spec-writing artifacts");
  };

  const persistSpecCheckpoint = async (step: SpecStep, role: Role): Promise<boolean> => {
    await persistState();

    try {
      await commitAndPushCheckpointState();
      return true;
    } catch (error) {
      await failSpecStep(step, role, `State checkpoint failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };

  const persistPrReviewCheckpoint = async (messagePrefix: string): Promise<boolean> => {
    await persistState();

    try {
      await commitAndPushCheckpointState();
      return true;
    } catch (error) {
      await failPrReview(`${messagePrefix}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };

  const buildPrReviewDiff = async (): Promise<string> => {
    const currentBranch = (await runTrustedCommand("git rev-parse --abbrev-ref HEAD", "Failed to determine current branch"))
      .split(/\r?\n/u)[0]?.trim() || "unknown";
    const defaultBranchOutput = await runTrustedCommand(
      "git remote show origin | grep 'HEAD branch'",
      "Failed to determine default branch",
    );
    const defaultBranch = defaultBranchOutput.match(/HEAD branch:\s*(\S+)/u)?.[1] ?? "main";
    const mergeBase = (await runTrustedCommand(
      `git merge-base HEAD ${defaultBranch}`,
      "Failed to compute merge base",
    )).split(/\r?\n/u)[0]?.trim() || "unknown";
    const diff = await runTrustedCommand(`git diff ${mergeBase}..HEAD`, "Failed to collect branch diff");

    return [
      `Current branch: ${currentBranch}`,
      `Default branch: ${defaultBranch}`,
      `Merge base: ${mergeBase}`,
      "Branch diff:",
      diff.length > 0 ? diff : "<empty diff>",
    ].join("\n");
  };

  const buildPrReviewPrompt = async (step: Exclude<PrReviewStep, "done">): Promise<string> => {
    const branchDiff = await buildPrReviewDiff();
    return [
      "Review all changes on the current branch versus its base branch.",
      step === "spec-aware"
        ? "This is the spec-aware PR review. Evaluate correctness against the spec, code quality, regressions, and usability."
        : "This is the spec-free PR review. Evaluate code quality, regressions, and usability only. Do not rely on the spec.",
      step === "spec-aware" ? `Spec path: ${getSpecPath()}` : "",
      branchDiff,
      "Return either <done>PASS</done> or <done>FAIL[{\"file\":\"...\",\"line\":1,\"description\":\"...\"}]</done>.",
      "When returning FAIL, include one structured finding object per actionable issue.",
    ].filter(Boolean).join("\n\n");
  };

  const runPrReviewQualityGate = async (): Promise<void> => {
    const testResult = await deps.executeBash(getTestCommand(), config.projectDir);
    if (!testResult.success) {
      throw new Error(`PR review test command failed: ${extractCommandFailure(testResult)}`);
    }

    const lintCommand = getLintCommand().trim();
    if (lintCommand.length === 0) {
      return;
    }

    const beforeSnapshot = await readModifiedFilesSnapshot();
    const lintResult = await deps.executeTrusted(lintCommand, config.projectDir);
    if (!lintResult.success) {
      throw new Error(`PR review lint command failed: ${extractCommandFailure(lintResult)}`);
    }

    const afterSnapshot = await readModifiedFilesSnapshot();
    if (beforeSnapshot !== afterSnapshot) {
      const retestResult = await deps.executeBash(getTestCommand(), config.projectDir);
      if (!retestResult.success) {
        throw new Error(`PR review test command failed after lint changes: ${extractCommandFailure(retestResult)}`);
      }
    }
  };

  const commitAndPushPrReviewFixes = async (changedFiles: string[]): Promise<void> => {
    const uniquePaths = [...new Set(changedFiles.filter((filePath) => filePath.trim().length > 0))];
    if (uniquePaths.length === 0) {
      throw new Error("No changed files found for PR review fixes.");
    }

    const quotedPaths = uniquePaths.map((filePath) => quoteShellArgument(filePath)).join(" ");
    await runTrustedCommand(`git add -- ${quotedPaths}`, "Failed to stage PR review fixes");
    await runTrustedCommand(
      `git commit -m '${PR_REVIEW_COMMIT_MESSAGE}'`,
      "Failed to commit PR review fixes",
    );
    await runTrustedCommand("git push", "Failed to push PR review fixes");
  };

  const persistBugfixCheckpoint = async (): Promise<void> => {
    await persistState();

    try {
      await commitAndPushCheckpointState();
    } catch (error) {
      throw new Error(`Bugfix checkpoint failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const commitAndPushCompletedPhase = async (): Promise<void> => {
    const phaseNumber = state.currentPhase > 0 ? state.currentPhase : 1;
    await runTrustedCommand("git add .", `Failed to stage phase ${phaseNumber}`);
    await runTrustedCommand(
      `git commit -m 'Implement phase ${phaseNumber}'`,
      `Failed to commit phase ${phaseNumber}`,
    );

    try {
      await pushCurrentBranchIfUpstreamExists(`Failed to push phase ${phaseNumber}`);
    } catch (error) {
      await logPhaseCommitAudit(
        phaseNumber,
        error instanceof Error ? error.message : String(error),
        "error",
      );
    }
  };

  const resolveActivePullRequest = async (): Promise<PullRequestReference> => {
    const repoResponse = await runTrustedCommand(
      "gh repo view --json owner,name",
      "Failed to determine GitHub repository",
    );
    const prResponse = await runTrustedCommand(
      "gh pr view --json number",
      "Failed to determine active pull request",
    );
    const reference = parsePullRequestReference(repoResponse, prResponse);

    if (!reference) {
      throw new Error("Failed to parse active pull request metadata.");
    }

    return reference;
  };

  const waitForRemoteHead = async (branchName: string, localHeadSha: string): Promise<void> => {
    const branchRef = quoteShellArgument(`refs/heads/${branchName}`);
    const matchedHead = await pollWithTimeout(
      COPILOT_REREVIEW_PUSH_TIMEOUT_MS,
      COPILOT_REREVIEW_POLL_INTERVAL_MS,
      async () => {
        const remoteHeadOutput = await runTrustedCommand(
          `git ls-remote origin ${branchRef}`,
          "Failed to verify remote branch HEAD",
        );
        const remoteHeadSha = remoteHeadOutput.split(/\s+/u)[0]?.trim();
        return remoteHeadSha === localHeadSha ? remoteHeadSha : undefined;
      },
    );

    if (!matchedHead) {
      throw new Error("Copilot re-review push verification timeout.");
    }
  };

  const waitForCopilotReview = async (
    pullRequest: PullRequestReference,
    pushedAt: string,
  ): Promise<CopilotReviewRecord> => {
    const command = `gh api repos/${pullRequest.owner}/${pullRequest.repo}/pulls/${pullRequest.number}/reviews`;
    const review = await pollWithTimeout(
      COPILOT_REREVIEW_REVIEW_TIMEOUT_MS,
      COPILOT_REREVIEW_POLL_INTERVAL_MS,
      async () => {
        const response = await runTrustedCommand(command, "Failed to fetch Copilot reviews");
        return parseCopilotReviews(response, pushedAt)[0];
      },
    );

    if (!review) {
      throw new Error("Copilot re-review review wait timeout.");
    }

    return review;
  };

  const fetchCopilotComments = async (
    pullRequest: PullRequestReference,
    review: CopilotReviewRecord,
  ): Promise<CopilotCommentRecord[]> => {
    const response = await runTrustedCommand(
      `gh api repos/${pullRequest.owner}/${pullRequest.repo}/pulls/${pullRequest.number}/comments`,
      "Failed to fetch Copilot review comments",
    );

    return parseCopilotComments(response, review);
  };

  const remediateCopilotFindings = async (
    pullRequest: PullRequestReference,
    cycle: number,
    findings: PrReviewFinding[],
    token: vscode.CancellationToken,
  ): Promise<void> => {
    const changedFilesBefore = await getBugfixChangedFiles();

    for (const [index, finding] of findings.entries()) {
      await invokeRole(
        "implementor",
        `${COPILOT_REREVIEW_ITEM_ID}:fix:${cycle}:${index + 1}`,
        [
          `Copilot re-review cycle ${cycle}`,
          `Pull request: ${pullRequest.owner}/${pullRequest.repo}#${pullRequest.number}`,
          `Finding ${index + 1} of ${findings.length}`,
          `File: ${finding.file}`,
          `Line: ${finding.line}`,
          `Description: ${finding.description}`,
        ].join("\n\n"),
        [
          cycle >= 3 ? HOLISTIC_REFACTOR_PROMPT : "",
          "Fix the GitHub Copilot re-review finding.",
          `Pull request: ${pullRequest.owner}/${pullRequest.repo}#${pullRequest.number}`,
          `File: ${finding.file}`,
          `Line: ${finding.line}`,
          `Description: ${finding.description}`,
          "Address the underlying issue and leave the branch ready for another Copilot re-review.",
        ].filter(Boolean).join("\n\n"),
        token,
      );
    }

    await runPrReviewQualityGate();

    const changedFilesAfter = await getBugfixChangedFiles();
    const filesToStage = [
      ...findings.map((finding) => finding.file),
      ...diffChangedPaths(changedFilesBefore, changedFilesAfter),
    ];

    await commitAndPushPrReviewFixes(filesToStage);
  };

  const runCopilotReReviewLoop = async (): Promise<void> => {
    await ensureInitialized();

    const ghAvailability = await deps.executeTrusted("command -v gh", config.projectDir);
    if (!ghAvailability.success) {
      await logCopilotReReviewAudit("gh CLI not found", "error");
      return;
    }

    const token = createFallbackToken();

    for (let cycle = 1; cycle <= COPILOT_REREVIEW_MAX_CYCLES; cycle += 1) {
      try {
        await runTrustedCommand("git push", "Failed to push branch for Copilot re-review");

        const branchName = (await runTrustedCommand(
          "git rev-parse --abbrev-ref HEAD",
          "Failed to determine current branch for Copilot re-review",
        )).split(/\r?\n/u)[0]?.trim() || "HEAD";
        const localHeadSha = (await runTrustedCommand(
          "git rev-parse HEAD",
          "Failed to determine local HEAD for Copilot re-review",
        )).split(/\r?\n/u)[0]?.trim() || "";
        const pushedAt = deps.now();

        await waitForRemoteHead(branchName, localHeadSha);

        const pullRequest = await resolveActivePullRequest();
        await runTrustedCommand(
          `gh api repos/${pullRequest.owner}/${pullRequest.repo}/pulls/${pullRequest.number}/requested_reviewers -f reviewers[]=copilot`,
          "Failed to request Copilot re-review",
        );

        const review = await waitForCopilotReview(pullRequest, pushedAt);
        const comments = await fetchCopilotComments(pullRequest, review);

        if (comments.length === 0) {
          await logCopilotReReviewAudit(
            "Copilot re-review completed successfully with no unresolved Copilot comments.",
            "PASS",
          );
          return;
        }

        const reviewResult = await invokeRole(
          "pr-reviewer",
          `${COPILOT_REREVIEW_ITEM_ID}:review:${cycle}`,
          [
            `Copilot re-review cycle ${cycle}`,
            `Pull request: ${pullRequest.owner}/${pullRequest.repo}#${pullRequest.number}`,
            `Review id: ${review.id}`,
            `Submitted at: ${review.submittedAt}`,
          ].join("\n\n"),
          [
            "Evaluate the latest GitHub Copilot review comments.",
            "Return <done>PASS</done> if there are no actionable fixes remaining.",
            "Otherwise return <done>FAIL[{\"file\":\"...\",\"line\":1,\"description\":\"...\"}]</done>.",
            "Only include actionable findings that require code changes.",
            `Pull request: ${pullRequest.owner}/${pullRequest.repo}#${pullRequest.number}`,
            `Review id: ${review.id}`,
            `Comments JSON:\n${JSON.stringify(comments, null, 2)}`,
          ].join("\n\n"),
          token,
        );

        const parsed = parsePrReviewResponse(reviewResult.response);
        if (parsed.verdict === "PASS") {
          await logCopilotReReviewAudit(
            "Copilot re-review completed successfully with no actionable findings.",
            "PASS",
          );
          return;
        }

        if (parsed.verdict !== "FAIL" || parsed.findings.length === 0) {
          await logCopilotReReviewAudit(
            `Copilot re-review returned an invalid response: ${reviewResult.response}`,
            "error",
          );
          return;
        }

        await remediateCopilotFindings(pullRequest, cycle, parsed.findings, token);

        if (cycle >= COPILOT_REREVIEW_MAX_CYCLES) {
          await logCopilotReReviewAudit(
            "Copilot re-review reached 20 cycles; manual review needed.",
            "FAIL",
          );
          return;
        }
      } catch (error) {
        await logCopilotReReviewAudit(
          error instanceof Error ? error.message : String(error),
          "error",
        );
        return;
      }
    }
  };

  const applyPrReviewFindings = async (
    step: Exclude<PrReviewStep, "done">,
    findings: PrReviewFinding[],
    token: vscode.CancellationToken,
  ): Promise<void> => {
    const changedFilesBefore = await getBugfixChangedFiles();

    for (const [index, finding] of findings.entries()) {
      await invokeRole(
        "implementor",
        `pr-review:${step}:${index + 1}`,
        [
          `PR review step: ${step}`,
          `Finding ${index + 1} of ${findings.length}`,
          `File: ${finding.file}`,
          `Line: ${finding.line}`,
          `Description: ${finding.description}`,
        ].join("\n"),
        [
          `Fix the PR review finding in ${finding.file}:${finding.line}.`,
          `Description: ${finding.description}`,
          step === "spec-aware" ? `Spec path: ${getSpecPath()}` : "",
        ].filter(Boolean).join("\n\n"),
        token,
      );
    }

    await runPrReviewQualityGate();

    const changedFilesAfter = await getBugfixChangedFiles();
    const filesToStage = [
      ...findings.map((finding) => finding.file),
      ...diffChangedPaths(changedFilesBefore, changedFilesAfter),
    ];

    await commitAndPushPrReviewFixes(filesToStage);
    await persistBugfixCheckpoint();
  };

  const waitForPrReviewApproval = async (): Promise<ApprovalAction> => {
    state.status = "pending-approval";
    await persistState();

    return await new Promise<ApprovalAction>((resolve) => {
      prReviewApprovalResolver = resolve;
    });
  };

  const handlePrReviewApproval = async (): Promise<"approved" | "rejected" | "skipped"> => {
    const action = await waitForPrReviewApproval();
    prReviewApprovalResolver = undefined;

    if (action.type === "abandon") {
      state.status = "abandoned";
      await persistState();
      return "skipped";
    }

    if (action.type === "approve" || action.type === "skip") {
      state.prReviewStep = "done";
      state.status = "done";
      await persistPrReviewCheckpoint("PR review checkpoint failed");
      return action.type === "approve" ? "approved" : "skipped";
    }

    state.prReviewConsecutivePasses = 0;
    state.status = "paused";
    await persistState();
    return "rejected";
  };

  const runPrReviewLoop = async (token: vscode.CancellationToken): Promise<ProcessingOutcome> => {
    if (state.prReviewStep === "done") {
      if (state.status === "running") {
        state.status = "done";
        await persistState();
      }
      return "completed";
    }

    if (!state.prReviewStep) {
      state.prReviewStep = "spec-aware";
      state.prReviewConsecutivePasses = 0;
      await persistState();
    }

    let fixCycles = 0;

    while (state.prReviewStep === "spec-aware" || state.prReviewStep === "spec-free") {
      if (pauseRequested || token.isCancellationRequested) {
        state.status = "paused";
        await persistState();
        return "interrupted";
      }

      const step = state.prReviewStep;
      const prompt = await buildPrReviewPrompt(step);
      let result: InvocationResult;

      try {
        result = await invokeRole(
          "pr-reviewer",
          `pr-review:${step}`,
          `Post-implementation PR review (${step}).`,
          prompt,
          token,
        );
      } catch (error) {
        await failPrReview(`PR review invocation failed: ${error instanceof Error ? error.message : String(error)}`);
        return "completed";
      }

      const parsed = parsePrReviewResponse(result.response);
      if (parsed.verdict === "PASS") {
        state.prReviewConsecutivePasses = (state.prReviewConsecutivePasses ?? 0) + 1;
        await persistState();

        if ((state.prReviewConsecutivePasses ?? 0) < 2) {
          continue;
        }

        state.prReviewConsecutivePasses = 0;
        if (step === "spec-aware") {
          state.prReviewStep = "spec-free";
          if (!(await persistPrReviewCheckpoint("PR review checkpoint failed"))) {
            return "completed";
          }
          continue;
        }

        if (config.requireApproval) {
          await persistState();
          const approval = await handlePrReviewApproval();
          if (approval === "rejected") {
            return "interrupted";
          }
          return "completed";
        }

        state.prReviewStep = "done";
        state.status = "done";
        if (!(await persistPrReviewCheckpoint("PR review checkpoint failed"))) {
          return "completed";
        }
        return "completed";
      }

      if (parsed.verdict !== "FAIL" || parsed.findings.length === 0) {
        await failPrReview(`PR review returned an invalid response: ${result.response}`);
        return "completed";
      }

      state.prReviewConsecutivePasses = 0;
      await persistState();

      try {
        await applyPrReviewFindings(step, parsed.findings, token);
      } catch (error) {
        await failPrReview(`PR review remediation failed: ${error instanceof Error ? error.message : String(error)}`);
        return "completed";
      }

      fixCycles += 1;
      if (fixCycles >= config.maxRetries) {
        await failPrReview(`PR review exceeded max retries during ${step}.`);
        return "completed";
      }
    }

    return "completed";
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

      const qualityOutcome = await runQualityGate(item.id);
      if (qualityOutcome.kind === "timeout") {
        return "completed";
      }
      if (pauseRequested || token.isCancellationRequested) {
        return "interrupted";
      }
      if (qualityOutcome.kind === "retry") {
        retriesUsed += 1;
        itemFeedback.set(item.id, qualityOutcome.feedback ?? "Quality gate failed.");
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

      const lintOutcome = await runLint(itemIds);
      if (lintOutcome.kind === "timeout") {
        return "completed";
      }
      if (pauseRequested || token.isCancellationRequested) {
        return "interrupted";
      }
      if (lintOutcome.kind === "retry") {
        retriesUsed += 1;
        for (const item of items) {
          state.consecutivePasses[item.id] = 0;
          itemFeedback.set(item.id, lintOutcome.feedback ?? "Lint command failed.");
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

      if (lintOutcome.modifiedFiles) {
        const retestOutcomes = await Promise.all(items.map(async (item) => ({ item, result: await runTests(item.id) })));
        const retestTimedOut = retestOutcomes.find((entry) => entry.result.kind === "timeout");
        if (retestTimedOut) {
          return "completed";
        }
        if (pauseRequested || token.isCancellationRequested) {
          return "interrupted";
        }

        const failedRetests = retestOutcomes.filter((entry) => entry.result.kind === "retry");
        if (failedRetests.length > 0) {
          retriesUsed += 1;
          for (const { item, result } of failedRetests) {
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
    const shouldPopulateCommands = state.status === "idle";

    if (state.status === "paused" && !pauseRequested) {
      return;
    }

    if (state.status === "idle") {
      const branchSafety = await checkBranchSafety(config.projectDir, deps.executeTrusted);
      if (!branchSafety.safe) {
        await failRunStart(
          branchSafety.reason
          ?? `Cannot run Conductor on protected branch '${branchSafety.branch}'. Switch to a feature branch first.`,
        );
        return;
      }
    }

    pauseRequested = false;
    state.status = "running";
    await persistState();

    if (shouldPopulateCommands) {
      await populateCommandsFromConventionsSkill(token);
    }
    if (pauseRequested || token.isCancellationRequested || state.status !== "running") {
      return;
    }

    if (isBugfixRun()) {
      await runBugfixLoop(token);
      return;
    }

    const specWritingWasIncomplete = state.specStep !== "done";
    const specWritingOutcome = await runSpecWritingLoop(token);
    if (specWritingOutcome === "interrupted" || state.status !== "running") {
      return;
    }

    if (specWritingWasIncomplete && state.specStep === "done") {
      try {
        await commitAndPushSpecWritingArtifacts();
      } catch (error) {
        await failSpecStep(
          "reviewing-phases",
          "phase-reviewer",
          `Spec-writing artifact checkpoint failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
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

    const allPhaseItemsPassed = cachedPhase?.items.every((candidate) => {
      const itemStatus = state.itemStatuses[candidate.id];
      return itemStatus === "pass" || itemStatus === "skipped";
    }) ?? false;

    if (!pauseRequested && allPhaseItemsPassed) {
      if (!state.prReviewStep) {
        const phaseNumber = state.currentPhase > 0 ? state.currentPhase : 1;
        try {
          await commitAndPushCompletedPhase();
          await commitAndPushCheckpointState();
        } catch (error) {
          await failPhaseCommit(
            phaseNumber,
            `Phase completion checkpoint failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          return;
        }
      }

      await runPrReviewLoop(token);
      return;
    }

    if (!pauseRequested) {
      state.status = "done";
      await persistState();
    }
  };

  const startRun = (token: vscode.CancellationToken): Promise<void> => {
    if (isAbandoned()) {
      return Promise.resolve();
    }

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
      if (state.status === "done" || state.status === "abandoned") {
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

    startCopilotReReview(): void {
      if (activeCopilotReReview) {
        return;
      }

      activeCopilotReReview = runCopilotReReviewLoop().finally(() => {
        activeCopilotReReview = undefined;
      });
    },

    abandon(): void {
      abandonRequested = true;
      pauseRequested = false;
      state.status = "abandoned";

      if (specApprovalResolver) {
        const resolver = specApprovalResolver;
        specApprovalResolver = undefined;
        pendingSpecApprovalStep = undefined;
        resolver({ type: "abandon" });
      }

      if (bugfixApprovalResolver) {
        const resolver = bugfixApprovalResolver;
        bugfixApprovalResolver = undefined;
        resolver({ type: "abandon" });
      }

      if (prReviewApprovalResolver) {
        const resolver = prReviewApprovalResolver;
        prReviewApprovalResolver = undefined;
        resolver({ type: "abandon" });
      }

      for (const resolver of approvalResolvers.values()) {
        resolver({ type: "abandon" });
      }
      approvalResolvers.clear();
      approvalGroups.clear();

      void persistState();
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

      if (bugfixApprovalResolver && isBugfixRun()) {
        const resolver = bugfixApprovalResolver;
        bugfixApprovalResolver = undefined;
        resolver({ type: "skip" });
        return;
      }

      if (prReviewApprovalResolver) {
        const resolver = prReviewApprovalResolver;
        prReviewApprovalResolver = undefined;
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

    overrideCommands(testCommand: string, lintCommand: string): void {
      state.testCommand = testCommand.trim().length > 0 ? testCommand.trim() : DEFAULT_TEST_COMMAND;
      state.lintCommand = lintCommand.trim();
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

      if (bugfixApprovalResolver && isBugfixRun() && (itemId === BUGFIX_APPROVAL_SENTINEL || itemId.startsWith("bugfix:"))) {
        const resolver = bugfixApprovalResolver;
        bugfixApprovalResolver = undefined;
        resolver({ type: "approve" });
        return;
      }

      if (prReviewApprovalResolver && itemId === PR_REVIEW_APPROVAL_SENTINEL) {
        const resolver = prReviewApprovalResolver;
        prReviewApprovalResolver = undefined;
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

      if (bugfixApprovalResolver && isBugfixRun() && (itemId === BUGFIX_APPROVAL_SENTINEL || itemId.startsWith("bugfix:"))) {
        const resolver = bugfixApprovalResolver;
        bugfixApprovalResolver = undefined;
        resolver({ type: "reject", feedback });
        return;
      }

      if (prReviewApprovalResolver && itemId === PR_REVIEW_APPROVAL_SENTINEL) {
        const resolver = prReviewApprovalResolver;
        prReviewApprovalResolver = undefined;
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
