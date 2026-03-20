export type Role =
  | "implementor"
  | "reviewer"
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

export type RunStatus = "idle" | "running" | "paused" | "pending-approval" | "done" | "error";

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
  specDir: string;
  projectDir: string;
  skillsDir: string;
  conventionsSkill: string;
  modelAssignments: ModelAssignment[];
  maxTurns: number;
  maxRetries: number;
  testCommand: string;
  requireApproval: boolean;
}

export interface OrchestratorState {
  specDir: string;
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

export type ClientMessage =
  | { type: "pause" }
  | { type: "resume" }
  | { type: "skip"; itemId: string }
  | { type: "retry"; itemId: string }
  | { type: "changeModel"; role: Role; vendor: string; family: string }
  | { type: "approve"; itemId: string }
  | { type: "reject"; itemId: string; feedback: string }
  | { type: "addNote"; itemId: string; text: string }
  | { type: "submit-clarification"; answers: ClarificationAnswer[] };

export type ServerMessage =
  | { type: "state"; data: OrchestratorState }
  | { type: "phase"; data: Phase }
  | { type: "audit"; entry: AuditEntry }
  | { type: "addendum"; entry: AddendumEntry }
  | { type: "transcript"; entry: RunTranscript };

export interface DisposableLike {
  dispose(): void;
}

export interface CommandRegistry {
  registerCommand(command: string, callback: (...args: unknown[]) => unknown): DisposableLike;
}

export interface WindowLike {
  showInformationMessage(message: string, ...items: string[]): Promise<string | undefined>;
  showErrorMessage?(message: string, ...items: string[]): Promise<string | undefined>;
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
