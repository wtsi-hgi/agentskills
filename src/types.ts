export type Role =
  | "implementor"
  | "reviewer"
  | "pr-reviewer"
  | "spec-author"
  | "spec-reviewer"
  | "spec-proofreader"
  | "phase-creator"
  | "phase-reviewer";

export type AuditRole = Role | "clarifier";

export type ItemStatus =
  | "pending"
  | "in-progress"
  | "pass"
  | "fail"
  | "skipped"
  | "pending-approval";

export type RunStatus = "idle" | "running" | "paused" | "pending-approval" | "abandoned" | "done" | "error";

export interface CommandExtraction {
  testCommand: string;
  lintCommand: string;
}

export interface ClarificationQuestion {
  question: string;
  suggestedOptions: string[];
}

export interface ClarificationAnswer {
  question: string;
  answer: string;
}

export type SpecStep =
  | "clarifying"
  | "authoring"
  | "reviewing"
  | "proofreading"
  | "creating-phases"
  | "reviewing-phases"
  | "done";

export type BugStep = "fixing" | "reviewing" | "approving" | "committing" | "done";

export interface BugIssue {
  title: string;
  description: string;
}

export type PrReviewStep = "spec-aware" | "spec-free" | "done";

export interface PrReviewFinding {
  file: string;
  line: number;
  description: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
}

export type TrustedExecutor = (
  command: string,
  projectDir: string,
  timeoutMs?: number,
) => Promise<ToolResult>;

export interface PhaseItem {
  id: string;
  title: string;
  specSection: string;
  implemented: boolean;
  reviewed: boolean;
  batch?: number;
}

export interface Phase {
  number: number;
  title: string;
  items: PhaseItem[];
  batches: PhaseItem[][];
}

export interface ModelAssignment {
  role: Role;
  vendor: string;
  family: string;
}

export interface OrchestratorConfig {
  projectDir: string;
  skillsDir: string;
  docsDir: string;
  modelAssignments: ModelAssignment[];
  maxTurns: number;
  maxRetries: number;
  requireApproval: boolean;
}

export interface OrchestratorState {
  specDir: string;
  conventionsSkill: string;
  testCommand: string;
  lintCommand: string;
  bugStep?: BugStep;
  bugIndex?: number;
  bugFixCycle?: number;
  bugIssues?: BugIssue[];
  currentPhase: number;
  currentItemIndex: number;
  consecutivePasses: Record<string, number>;
  specStep: SpecStep;
  specConsecutivePasses: number;
  specPhaseFileIndex: number;
  clarificationQuestions: ClarificationQuestion[];
  status: RunStatus;
  modelAssignments: ModelAssignment[];
  itemStatuses: Record<string, ItemStatus>;
  prReviewStep?: PrReviewStep;
  prReviewConsecutivePasses?: number;
  startedBy?: string;
}

export interface AuditEntry {
  timestamp: string;
  role: AuditRole;
  model: string;
  itemId: string;
  promptSummary: string;
  result: "PASS" | "FAIL" | "error";
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
}

export interface AddendumEntry {
  timestamp: string;
  itemId: string;
  deviation: string;
  rationale: string;
  author?: string;
}

export interface TranscriptMessage {
  role: string;
  content: string;
}

export interface RunTranscript {
  timestamp: string;
  role: AuditRole;
  model: string;
  itemId: string;
  messages: TranscriptMessage[];
}

export interface InvocationResult {
  response: string;
  totalTokensIn: number;
  totalTokensOut: number;
  messages: TranscriptMessage[];
  turns: number;
  done: boolean;
  addendum?: string | null;
  error?: string;
}

export interface BugfixStatus {
  bugIndex: number;
  bugCount: number;
  fixCycle: number;
  bugStep: NonNullable<OrchestratorState["bugStep"]>;
}

export interface PrReviewStatus {
  step: PrReviewStep;
  consecutivePasses: number;
}

export interface DashboardControlOptions {
  conventionsSkills: string[];
}

export interface InlineRunRequest {
  prompt: string;
  conventionsSkill: string;
  testCommand: string;
  lintCommand: string;
}

export interface DashboardControlBridge {
  getControlOptions(): Promise<DashboardControlOptions> | DashboardControlOptions;
  startRun(request: InlineRunRequest): Promise<void> | void;
  fixBugs(request: InlineRunRequest): Promise<void> | void;
  abandonRun(): Promise<void> | void;
}

export type ClientMessage =
  | { type: "pause" }
  | { type: "resume" }
  | { type: "abandon" }
  | { type: "copilot-rereview" }
  | ({ type: "start-feature" } & InlineRunRequest)
  | ({ type: "start-bugfix" } & InlineRunRequest)
  | { type: "skip"; itemId: string }
  | { type: "retry"; itemId: string }
  | { type: "changeModel"; role: Role; vendor: string; family: string }
  | { type: "override-commands"; testCommand: string; lintCommand: string }
  | { type: "approve"; itemId: string }
  | { type: "reject"; itemId: string; feedback: string }
  | { type: "addNote"; itemId: string; text: string }
  | { type: "submit-clarification"; answers: ClarificationAnswer[] };

export type ServerMessage =
  | { type: "state"; data: OrchestratorState }
  | { type: "bugfix-status"; data: BugfixStatus | null }
  | { type: "pr-review-status"; data: PrReviewStatus }
  | { type: "control-options"; data: DashboardControlOptions }
  | { type: "phase"; data: Phase }
  | { type: "audit"; entry: AuditEntry }
  | { type: "addendum"; entry: AddendumEntry }
  | { type: "transcript"; entry: RunTranscript };

export interface DisposableLike {
  dispose(): void;
}

export interface TextDocumentLike {
  uri: {
    fsPath?: string;
    path?: string;
    scheme?: string;
    toString?(): string;
  };
  getText(): string;
}

export interface TextDocumentShowOptions {
  preview?: boolean;
}

export interface TextDocumentOpenOptions {
  content?: string;
  language?: string;
}

export interface CommandRegistry {
  registerCommand(command: string, callback: (...args: unknown[]) => unknown): DisposableLike;
}

export interface WindowLike {
  showInformationMessage(message: string, ...items: string[]): Promise<string | undefined>;
  showErrorMessage?(message: string, ...items: string[]): Promise<string | undefined>;
  showInputBox?(
    options?: {
      prompt?: string;
      placeHolder?: string;
      value?: string;
    },
  ): Promise<string | undefined>;
  showQuickPick?(
    items: readonly string[],
    options?: {
      placeHolder?: string;
      activeItem?: string;
    },
  ): Promise<string | undefined>;
  showTextDocument?(document: TextDocumentLike, options?: TextDocumentShowOptions): Promise<unknown>;
  registerTreeDataProvider?<T>(viewId: string, treeDataProvider: T): DisposableLike;
}

export interface WorkspaceFolderLike {
  uri: {
    fsPath: string;
  };
}

export interface ConfigurationLike {
  get<T>(section: string, defaultValue: T): T;
}

export interface WorkspaceLike {
  workspaceFolders?: WorkspaceFolderLike[];
  getConfiguration(section?: string): ConfigurationLike;
  openTextDocument?(options?: TextDocumentOpenOptions): Promise<TextDocumentLike>;
  onDidCloseTextDocument?(listener: (document: TextDocumentLike) => void): DisposableLike;
  onDidSaveTextDocument?(listener: (document: TextDocumentLike) => void): DisposableLike;
}

export interface ExtensionContextLike {
  subscriptions: DisposableLike[];
}

export interface VscodeApiLike {
  commands: CommandRegistry;
  window: WindowLike;
  workspace: WorkspaceLike;
}

export interface ExtensionDependencies {
  vscode: VscodeApiLike;
  fs: {
    mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>;
    readdir(path: string): Promise<string[]>;
    readFile(path: string, encoding: BufferEncoding): Promise<string>;
    writeFile(path: string, data: string, encoding: BufferEncoding): Promise<void>;
    access(path: string): Promise<void>;
  };
  os: {
    userInfo(): {
      username: string;
    };
  };
  path: {
    join(...parts: string[]): string;
    isAbsolute(path: string): boolean;
  };
}
