# Copilot Conductor Specification

## Overview

Copilot Conductor (`wtsi-hgi.copilot-conductor`) is a VS Code
extension that deterministically orchestrates multi-model AI
coding workflows via the `vscode.lm` Language Model API. It
replaces prompt-based orchestration with code-driven state
machines ensuring every implement-review-retry cycle executes
reliably.

The extension reads phase files and spec.md, selects Copilot
models per role (implementor, reviewer, spec-writer), runs a
tool loop (Read, Edit, Write, Bash, Grep, Glob), and enforces
2-consecutive-PASS review gates. All state persists to
`.conductor/` files for pause/resume and team visibility.

Three phases: (1) core extension with tool loop, LLM
invocation, state machine, persistence, TreeView; (2) rich
Webview dashboard; (3) embedded HTTP/WebSocket team server.

## Architecture

### Directory Layout

```text
src/
  extension.ts           entry point
  types.ts               shared types/interfaces
  tools/
    schema.ts            tool definitions + prompt formatting
    dispatch.ts          tool dispatch engine
    bash.ts              Bash tool + security validation
  llm/
    select.ts            model selection per role
    prompts.ts           skill loading + prompt assembly
    invoke.ts            tool-loop invocation engine
  skills/
    loader.ts            skill file loading + discovery
  orchestrator/
    parser.ts            phase file parser
    machine.ts           state machine + parallel batches
  state/
    persistence.ts       state.json read/write
    audit.ts             audit.md management
    addendum.ts          addendum.md management
    transcript.ts        run transcript storage
  views/
    treeProvider.ts      TreeView sidebar
  webview/
    panel.ts             Webview panel manager
    dashboard.html       dashboard markup + client JS
  server/
    http.ts              HTTP server + static serving
    ws.ts                WebSocket handler
    auth.ts              shared-secret auth
    app/
      index.html         browser dashboard SPA
  test/                  mirrors src/ structure
```

### Shared Types (`src/types.ts`)

```typescript
export type Role =
  | "implementor" | "reviewer" | "spec-writer";
export type ItemStatus =
  | "pending" | "in-progress" | "pass" | "fail"
  | "skipped" | "pending-approval";
export type RunStatus =
  | "idle" | "running" | "paused" | "done" | "error";

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
  currentPhase: number;
  currentItemIndex: number;
  consecutivePasses: Record<string, number>;
  status: RunStatus;
  modelAssignments: ModelAssignment[];
  itemStatuses: Record<string, ItemStatus>;
  startedBy?: string;
}

export interface AuditEntry {
  timestamp: string;
  role: Role;
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
export interface RunTranscript {
  timestamp: string;
  role: Role;
  model: string;
  itemId: string;
  messages: Array<{ role: string; content: string }>;
}

export interface InvocationResult {
  response: string;
  totalTokensIn: number;
  totalTokensOut: number;
  turns: number;
  done: boolean;
  error?: string;
}

// Phase 3 WebSocket protocol
export type ClientMessage =
  | { type: "pause" }
  | { type: "resume" }
  | { type: "skip"; itemId: string }
  | { type: "retry"; itemId: string }
  | { type: "changeModel"; role: Role;
      vendor: string; family: string }
  | { type: "approve"; itemId: string }
  | { type: "reject"; itemId: string; feedback: string }
  | { type: "addNote"; itemId: string; text: string };
export type ServerMessage =
  | { type: "state"; data: OrchestratorState }
  | { type: "audit"; entry: AuditEntry }
  | { type: "addendum"; entry: AddendumEntry };
```

### Tool Call Wire Format

Models emit tool calls and done signals in text output:

```text
<tool_call>
{"name":"Read","arguments":{"path":"src/foo.ts"}}
</tool_call>
```

```text
<done>
PASS|FAIL|result text
</done>
```

Reviewer deviation notes use addendum tags:

```text
<addendum>
deviation text with rationale
</addendum>
```

Both formats injected via system prompt; parsed by
invocation engine.

### State Files (`.conductor/`)

- `state.json` -- serialised `OrchestratorState`.
- `audit.md` -- Markdown table of `AuditEntry` rows.
- `addendum.md` -- Markdown list of `AddendumEntry` items.
- `runs/<ISO-timestamp>/<role>-<itemId>.json` -- per-invocation
  JSON transcripts.

### Error Handling

- Tool errors: `ToolResult.success=false`; model may retry.
- LLM API errors: retry with backoff, max 3 attempts.
- Item failure after `maxRetries`: mark `fail`, log audit,
  continue to next item.
- VS Code restart: load `state.json` on activation, prompt
  user to resume if `status=paused`.

---

## A -- Extension Core

### A1: Extension Activation and Commands

As an extension user, I want Conductor commands and settings
registered on activation, so that I can start and control
orchestration runs.

- Activates via `onCommand:conductor.*` events.
- Commands: Start, Pause, Resume, Status, Dashboard.
- Dashboard is a no-op until Phase 2 provides the panel.
- Start creates `.conductor/` dir if absent, initialises
  `state.json`, begins orchestration.
- Pause sets `status=paused`; Resume sets `status=running`.
- Status shows info message with current phase/item/status.
- On activation with `state.json` where `status` is
  `"paused"` or `"running"` (crash recovery), prompts
  user to resume.

**Package:** `src/`
**File:** `src/extension.ts`
**Test file:** `src/test/extension.test.ts`

```typescript
export function activate(
  context: vscode.ExtensionContext
): Promise<void>;
export function deactivate(): void;
```

Configuration (`contributes.configuration`):

- `conductor.docsDir`: string, default `.docs/`
- `conductor.skillsDir`: string, default `~/.agents/skills/`
- `conductor.maxTurns`: number, default `50`
- `conductor.maxRetries`: number, default `3`
- `conductor.requireApproval`: boolean, default `false`
- `conductor.models.implementor`: `{vendor,family}` object
- `conductor.models.reviewer`: `{vendor,family}` object
- `conductor.models.specWriter`: `{vendor,family}` object

Per-feature state persists `specDir`, `conventionsSkill`,
`testCommand`, and `lintCommand` in `state.json`.

- `conductor.server.port`: number, default `8484`
- `conductor.server.authToken`: string, default `""`

**Acceptance tests:**

1. Given fresh workspace, when `Conductor: Start` executes,
   then `.conductor/` dir exists and `state.json` contains
   `status: "running"`.
2. Given running state, when `Conductor: Pause` executes,
   then `state.json` has `status: "paused"`.
3. Given paused state, when `Conductor: Resume` executes,
   then `state.json` has `status: "running"`.
4. Given no `state.json`, when extension activates, then no
   resume prompt shown.
5. Given `state.json` with `status: "paused"`, when extension
   activates, then info message shows with Yes/No options.
6. Given `state.json` with `status: "running"`, when
   extension activates, then info message prompts user
   to resume.
7. Given default settings, `conductor.maxTurns` is `50` and
   `conductor.maxRetries` is `3`.
8. Given fresh workspace, when `Conductor: Start` executes,
   then `state.json` contains `startedBy` matching the
   current OS username (`os.userInfo().username`).
9. When `Conductor: Dashboard` executes before Phase 2,
   then an info message `"Dashboard not yet available"`
   is shown and no panel is created.

---

## B -- Tool System

### B1: Tool Schema and Dispatch

As an LLM invocation engine, I want tool definitions and a
dispatch function, so that model tool calls execute against
the filesystem and shell.

Tools with parameters:

- **Read**: `path` (string), `startLine?` (number),
  `endLine?` (number). Returns file contents via
  `fs.readFile`.
- **Edit**: `path` (string), `oldString` (string),
  `newString` (string). Replaces first occurrence in file.
- **Write**: `path` (string), `content` (string). Creates
  or overwrites file via `fs.writeFile`.
- **Grep**: `pattern` (string), `path?` (string),
  `isRegex?` (boolean). Searches via ripgrep; returns
  `file:line:match` lines.
- **Glob**: `pattern` (string). Returns matching paths via
  fast-glob.

All paths resolved relative to `projectDir`. Paths outside
`projectDir` rejected with `success: false`.

**Package:** `src/tools/`
**File:** `src/tools/schema.ts`, `src/tools/dispatch.ts`
**Test file:** `src/test/tools/dispatch.test.ts`

```typescript
// schema.ts
export function getToolDefinitions(): ToolDefinition[];
export function formatToolsForPrompt(
  tools: ToolDefinition[]
): string;

// dispatch.ts
export function dispatchTool(
  call: ToolCall,
  projectDir: string
): Promise<ToolResult>;
```

**Acceptance tests:**

1. Given file `f.ts` containing `hello\nworld\n`, when
   `dispatchTool({name:"Read", arguments:{path:"f.ts"}},
   dir)`, then `success` is `true` and `output` is
   `"hello\nworld\n"`.
2. Given file `f.ts` containing 3 lines, when Read called
   with `startLine:2, endLine:2`, then `output` is line 2
   only.
3. Given file `f.ts` with content `aXb`, when Edit called
   with `oldString:"X", newString:"Y"`, then file contains
   `aYb`.
4. When Write called with `path:"new.ts", content:"hi"`,
   then file `new.ts` exists with content `"hi"`.
5. Given file `f.ts` containing `TODO: fix`, when Grep
   called with `pattern:"TODO"`, then output contains
   `f.ts:1:TODO: fix`.
6. Given files `a.ts` and `b.ts`, when Glob called with
   `pattern:"*.ts"`, then output contains both filenames.
7. When `dispatchTool` called with `name:"Unknown"`, then
   `success` is `false` and `error` contains
   `"unknown tool"`.
8. When Read called with `path:"../../etc/passwd"` and
   `projectDir` is `/proj`, then `success` is `false` and
   `error` contains `"outside project"`.
9. `getToolDefinitions()` returns array of 6 definitions;
   each has `name`, `description`, non-empty `parameters`.
10. `formatToolsForPrompt(defs)` returns string containing
    all 6 tool names and their parameter descriptions.

### B2: Bash Tool with Security Enforcement

As the orchestrator, I want Bash execution with strict
security rules, so that models cannot escape the project
boundary or run dangerous commands.

- Validates command before execution.
- Rejected patterns: `sudo`, `git push`, `git push --force`,
  interactive commands (`ssh`, `less`, `vi`, `vim`, `nano`),
  paths outside `projectDir`.
- Timeout enforcement: kills process after `timeoutMs`
  (default 30000).
- Stdout + stderr captured; exit code in `output`.

**Package:** `src/tools/`
**File:** `src/tools/bash.ts`
**Test file:** `src/test/tools/bash.test.ts`

```typescript
export function executeBash(
  command: string,
  projectDir: string,
  timeoutMs?: number
): Promise<ToolResult>;
export function validateBashCommand(
  command: string,
  projectDir: string
): { valid: boolean; reason?: string };
```

**Acceptance tests:**

1. Given command `echo hello` in valid `projectDir`, when
   `executeBash` called, then `success` is `true` and
   `output` contains `"hello"`.
2. Given command `sudo apt install foo`, when
   `validateBashCommand` called, then result is
   `{valid: false, reason: "sudo is prohibited"}`.
3. Given command `git push origin main`, when validated,
   then `valid` is `false` with reason containing
   `"git push"`.
4. Given command `ssh user@host`, when validated, then
   `valid` is `false` with reason containing
   `"interactive"`.
5. Given command `cd /etc && cat passwd`, when validated
   with `projectDir: "/proj"`, then `valid` is `false`
   with reason containing `"outside project"`.
6. Given command `sleep 60` with `timeoutMs: 100`, when
   `executeBash` called, then `success` is `false` and
   `error` contains `"timeout"`.
7. Given command `exit 1`, when `executeBash` called, then
   `success` is `false` and `output` contains exit code
   `1`.

---

## C -- LLM Invocation

### C1: Model Selection and Prompt Assembly

As the orchestrator, I want to select models per role and
assemble system prompts from skills, so that each invocation
uses the right model with appropriate context.

- `selectModelForRole` calls
  `vscode.lm.selectChatModels({vendor, family})` from
  `ModelAssignment`; returns first match or throws.
- `loadSkill` reads `<skillsDir>/<name>/SKILL.md`.
- `assembleSystemPrompt` concatenates: conventions skill +
  role skill + tool definitions + item context.
- Prompt includes tool call wire format instructions.

**Package:** `src/llm/`, `src/skills/`
**File:** `src/llm/select.ts`, `src/llm/prompts.ts`,
  `src/skills/loader.ts`
**Test file:** `src/test/llm/select.test.ts`,
  `src/test/llm/prompts.test.ts`

```typescript
// select.ts
export function selectModelForRole(
  role: Role,
  assignments: ModelAssignment[]
): Promise<vscode.LanguageModelChat>;

// prompts.ts
export function assembleSystemPrompt(
  role: Role,
  skillsDir: string,
  conventionsSkill: string,
  itemContext: string,
  tools: ToolDefinition[]
): Promise<string>;

// loader.ts
export function loadSkill(
  skillsDir: string,
  skillName: string
): Promise<string>;
export function discoverSkills(
  skillsDir: string
): Promise<string[]>;
```

**Acceptance tests:**

1. Given `ModelAssignment` with `vendor:"copilot",
   family:"gpt-4o"`, when `selectModelForRole` called with
   matching mock, then returned model's `family` is
   `"gpt-4o"`.
2. Given no matching model in `selectChatModels` result,
   when `selectModelForRole` called, then throws error
   containing `"no model found"`.
3. Given skills dir with `go-conventions/SKILL.md`
   containing `"# Go Conventions"`, when `loadSkill` called
   with `"go-conventions"`, then returns string starting
   with `"# Go Conventions"`.
4. Given missing skill name, when `loadSkill` called, then
   throws error containing `"skill not found"`.
5. Given role `"implementor"`, conventions `"go"`, and 6
   tool definitions, when `assembleSystemPrompt` called,
   then result contains `"<tool_call>"` format instructions
   and all 6 tool names.
6. `discoverSkills` on dir with `a/SKILL.md` and
   `b/SKILL.md` returns `["a", "b"]`.
7. Given role `"implementor"` and `conventionsSkill`
   `"go-conventions"`, when `assembleSystemPrompt`
   called, then result contains content from
   `go-implementor/SKILL.md`.

### C2: Tool-Loop Invocation Engine

As the orchestrator, I want a tool-loop engine that sends
prompts to models and executes tool calls iteratively, so
that models can interact with the filesystem autonomously.

- Sends system + user prompt to model via
  `model.sendRequest()`.
- Streams response text; extracts `<tool_call>` blocks.
- Dispatches each tool call via `dispatchTool`.
- Appends tool results as follow-up user messages.
- Repeats until `<done>` marker or `maxTurns` exceeded.
- Tracks cumulative token usage across turns.
- Records full message history for transcript.

**Package:** `src/llm/`
**File:** `src/llm/invoke.ts`
**Test file:** `src/test/llm/invoke.test.ts`

```typescript
export function invokeWithToolLoop(
  model: vscode.LanguageModelChat,
  systemPrompt: string,
  userPrompt: string,
  projectDir: string,
  options: {
    maxTurns: number;
    token: vscode.CancellationToken;
  }
): Promise<InvocationResult>;

export function parseToolCalls(text: string): ToolCall[];
export function parseDoneSignal(
  text: string
): { done: boolean; result?: string };
export function parseAddendum(
  text: string
): string | null;
```

**Acceptance tests:**

1. Given model response containing no tool calls and
   `<done>PASS</done>`, when invoked, then
   `InvocationResult.done` is `true`, `response` is
   `"PASS"`, `turns` is `1`.
2. Given response `<tool_call>{"name":"Read","arguments":
   {"path":"f.ts"}}</tool_call>`, when `parseToolCalls`
   called, then returns array of length 1 with
   `name:"Read"` and `arguments.path:"f.ts"`.
3. Given model emitting 2 tool calls in one response, when
   invoked, both tools dispatched and results fed back as
   one message.
4. Given `maxTurns: 3` and model never emitting `<done>`,
   when invoked, then after 3 turns `done` is `false` and
   `error` contains `"max turns"`.
5. Given response with malformed JSON in `<tool_call>`,
   when `parseToolCalls` called, then returns empty array
   (graceful skip).
6. Given cancellation token cancelled mid-loop, when
   invoked, then returns partial result with `done: false`.
7. Given 2 turns with tool calls, `totalTokensIn` and
   `totalTokensOut` equal sum of per-turn token counts.
8. Given response containing
   `<addendum>deviation text</addendum>`, when
   `parseAddendum` called, then returns
   `"deviation text"`.
9. Given response with no `<addendum>` tags, when
   `parseAddendum` called, then returns `null`.
10. Given `model.sendRequest()` throws on first call and
    succeeds on second, when `invokeWithToolLoop` called,
    then `InvocationResult.done` is `true` and 2 LLM
    requests were made.
11. Given `model.sendRequest()` throws 3 consecutive
    times, when `invokeWithToolLoop` called, then
    `InvocationResult.error` contains `"LLM API error"`
    and `done` is `false`.

---

## D -- Orchestration

### D1: Phase File Parser

As the orchestrator, I want to parse phase files into
structured `Phase` objects, so that the state machine knows
what items to process.

- Parses phase number and title from `# Phase N: Title`.
- Extracts items with IDs, titles, spec section refs.
- Reads checkbox state: `- [x]` = true, `- [ ]` = false.
- Groups parallel batch items by batch number.
- Items outside batches treated as sequential (batch
  undefined).

**Package:** `src/orchestrator/`
**File:** `src/orchestrator/parser.ts`
**Test file:** `src/test/orchestrator/parser.test.ts`

```typescript
export function parsePhaseFile(
  content: string
): Phase;
```

**Acceptance tests:**

1. Given phase file with header `# Phase 2: Tool System`
   and 2 sequential items, when parsed, then
   `phase.number` is `2`, `title` is `"Tool System"`,
   `items.length` is `2`.
2. Given item with `- [x] implemented\n- [ ] reviewed`,
   when parsed, then `item.implemented` is `true` and
   `item.reviewed` is `false`.
3. Given 3 items in `### Batch 1 (parallel)`, when parsed,
   then `batches[0].length` is `3` and all have
   `batch: 1`.
4. Given item `### Item 1.2: B1 - Tool dispatch` with
   `spec.md section: B1`, when parsed, then `item.id` is
   `"B1"` and `item.title` is `"Tool dispatch"`.
5. Given empty content, when `parsePhaseFile` called, then
   returns Phase with `items: []` and `batches: []`.

### D2: Orchestration State Machine

As the extension, I want a state machine that executes the
implement-test-review-retry cycle, so that phase items
complete deterministically.

Per unchecked item:
1. Invoke implementor model with spec section + skill.
2. Run test suite via Bash tool (e.g. `npm test`).
3. Invoke reviewer model with diff + skill.
4. Parse reviewer verdict from `<done>` signal.
5. FAIL: reset `consecutivePasses[itemId]` to 0, loop to
   step 1 with reviewer feedback. Decrement retries.
6. PASS: increment `consecutivePasses[itemId]`. If < 2,
   loop to step 3 for second review.
7. 2 PASS: if `requireApproval`, set status
   `pending-approval` and wait; else tick checkboxes in
   phase file, write audit entry, advance.
- Parallel batches: launch items concurrently; after all
  implementations complete, reviewer invoked exactly once
  with combined diff of all batch items.
- Parallel batch FAIL: when the batch reviewer returns
  FAIL, all items in the batch re-enter the implement
  cycle individually and `consecutivePasses` resets to
  0 for every item in the batch.
- Pause: save state and stop loop; Resume: reload and
  continue from saved position.

**Package:** `src/orchestrator/`
**File:** `src/orchestrator/machine.ts`
**Test file:** `src/test/orchestrator/machine.test.ts`

```typescript
export function createOrchestrator(
  config: OrchestratorConfig,
  context: vscode.ExtensionContext
): Orchestrator;

export interface Orchestrator {
  run(token: vscode.CancellationToken): Promise<void>;
  pause(): void;
  resume(): void;
  skip(itemId: string): void;
  retry(itemId: string): void;
  changeModel(
    role: Role, vendor: string, family: string
  ): void;
  approve(itemId: string): void;
  reject(itemId: string, feedback: string): void;
  addNote(
    itemId: string, text: string, author?: string
  ): void;
  getState(): OrchestratorState;
  onStateChange: vscode.Event<OrchestratorState>;
}
```

**Acceptance tests:**

1. Given item with passing implementation and 2 consecutive
   PASS reviews (mocked), when machine runs, then
   `consecutivePasses[itemId]` reaches `2` and item status
   is `"pass"`.
2. Given reviewer returns FAIL then PASS then PASS, when
   machine runs, then implementor invoked twice (initial +
   retry) and `consecutivePasses` reset to 0 after FAIL.
3. Given `maxRetries: 2` and reviewer always returns FAIL,
   when machine runs, then after 2 retries item status is
   `"fail"` and audit has 2 FAIL entries.
4. Given 3 items in a parallel batch (mocked), when machine
   runs, then all 3 implementor invocations start before
   any review invocation.
5. Given running machine, when `pause()` called, then state
   written with `status: "paused"` and loop stops.
6. Given paused state loaded, when `resume()` called, then
   machine continues from `currentItemIndex`.
7. Given phase file with `- [ ] implemented`, after item
   passes, then phase file re-read contains
   `- [x] implemented` and `- [x] reviewed`.
8. Given `requireApproval: true` and item with 2 PASS, then
   `itemStatuses[id]` is `"pending-approval"` until
   `approve(id)` called.
9. Given `reject(id, "fix X")`, then item re-enters
   implement cycle with feedback containing `"fix X"`.
10. Given item A1 pending, when `skip("A1")` called, then
    `itemStatuses["A1"]` is `"skipped"` and machine
    advances to next item.
11. Given item A1 with `status: "fail"`, when
    `retry("A1")` called, then item re-enters implement
    cycle and `consecutivePasses["A1"]` resets to `0`.
12. When `changeModel("reviewer", "copilot", "o3")`,
    then `state.modelAssignments` entry for `reviewer`
    has `vendor:"copilot", family:"o3"` and next
    reviewer invocation uses the updated model.
13. Given test command exits non-zero after implementation,
    then implementor re-invoked with test failure output
    appended to feedback (counts as retry, decrementing
    retries remaining).
14. Given test command exceeds `timeoutMs`, then item
    status is `"fail"` and audit entry records
    `result: "error"` with message containing
    `"test timeout"`.
15. Given reviewer response containing
    `<addendum>deviation text</addendum>`, then state
    machine calls `appendAddendum` with `deviation`
    matching `"deviation text"`.
16. Given 3-item parallel batch, when all 3 implementations
    complete, then reviewer invoked exactly once with
    combined diff of all 3 items.
17. Given 3-item parallel batch where reviewer returns
    FAIL, then all 3 items re-enter implement cycle
    individually and `consecutivePasses` resets to `0`
    for all 3 items.
18. Given `addNote("A1", "needs fix")` called, then
    `appendAddendum` invoked with `itemId` `"A1"` and
    entry containing `"needs fix"`.

---

## E -- State Persistence

### E1: State, Audit, Addendum, and Transcripts

As the orchestrator, I want persistent state files, so that
runs survive restarts and provide audit trails.

- `state.json`: read/write `OrchestratorState` as JSON.
  Missing file returns default state (`status: "idle"`).
- `audit.md`: Markdown table appended after each LLM call.
  Header row auto-created if file missing.
- `addendum.md`: append `AddendumEntry` when reviewer notes
  spec deviation.
- `runs/<ISO-timestamp>/<role>-<itemId>.json`: full
  `RunTranscript` per invocation.
- All files under `.conductor/` in project root.

**Package:** `src/state/`
**File:** `src/state/persistence.ts`, `src/state/audit.ts`,
  `src/state/addendum.ts`, `src/state/transcript.ts`
**Test file:** `src/test/state/persistence.test.ts`,
  `src/test/state/audit.test.ts`,
  `src/test/state/addendum.test.ts`,
  `src/test/state/transcript.test.ts`

```typescript
// persistence.ts
export function loadState(
  conductorDir: string
): Promise<OrchestratorState>;
export function saveState(
  conductorDir: string,
  state: OrchestratorState
): Promise<void>;

// audit.ts
export function appendAudit(
  conductorDir: string,
  entry: AuditEntry
): Promise<void>;
export function readAudit(
  conductorDir: string
): Promise<AuditEntry[]>;

// addendum.ts
export function appendAddendum(
  conductorDir: string,
  entry: AddendumEntry
): Promise<void>;

// transcript.ts
export function saveTranscript(
  conductorDir: string,
  transcript: RunTranscript
): Promise<void>;
export function loadTranscript(
  path: string
): Promise<RunTranscript>;
```

**Acceptance tests:**

1. Given valid `OrchestratorState`, when `saveState` then
   `loadState`, then loaded state deep-equals original.
2. Given no `state.json` exists, when `loadState` called,
   then returns state with `status: "idle"`.
3. Given empty `.conductor/`, when `appendAudit` called with
   entry, then `audit.md` exists with header row and 1
   data row containing entry's `timestamp`, `role`,
   `model`, `itemId`, `result`.
4. Given `audit.md` with 1 entry, when `appendAudit` called
   again, then file has 2 data rows (header unchanged).
5. Given `readAudit` on file with 3 entries, then returns
   array of length 3 with all fields populated.
6. When `appendAddendum` called with entry, then
   `addendum.md` contains `itemId`, `deviation`, and
   `rationale` strings.
7. Given `RunTranscript` with 4 messages, when
   `saveTranscript` called, then JSON file appears under
   `runs/` with path matching
   `runs/<timestamp>/<role>-<itemId>.json`.
8. Given saved transcript, when `loadTranscript` called with
   its path, then `messages.length` is `4`.

---

## F -- TreeView Sidebar

### F1: TreeView Provider

As a VS Code user, I want a sidebar TreeView showing
orchestration progress, so that I can monitor status without
opening files.

- Root nodes: one per phase.
- Phase children: one per item with status icon.
- Icons: pending (circle), in-progress (sync), pass
  (check), fail (error), pending-approval (eye).
- Tooltip shows model name for current role.
- Tree refreshes on every `onStateChange` event.
- Click item: opens `audit.md` or transcript file.

**Package:** `src/views/`
**File:** `src/views/treeProvider.ts`
**Test file:** `src/test/views/treeProvider.test.ts`

```typescript
export class ConductorTreeProvider
  implements vscode.TreeDataProvider<ConductorTreeItem>
{
  constructor(getState: () => OrchestratorState);
  getTreeItem(
    el: ConductorTreeItem
  ): vscode.TreeItem;
  getChildren(
    el?: ConductorTreeItem
  ): ConductorTreeItem[];
  refresh(): void;
}
export interface ConductorTreeItem {
  type: "phase" | "item";
  label: string;
  status?: ItemStatus;
  phaseNumber?: number;
  itemId?: string;
}
```

**Acceptance tests:**

1. Given state with 2 phases (3 items, 2 items), when
   `getChildren(undefined)` called, then returns 2
   phase nodes.
2. Given phase node for phase 1 with 3 items, when
   `getChildren(phaseNode)` called, then returns 3 item
   nodes.
3. Given item with `status: "pass"`, when `getTreeItem`
   called, then `iconPath` corresponds to check icon.
4. Given item with `status: "fail"`, when `getTreeItem`
   called, then `iconPath` corresponds to error icon.
5. After `refresh()` called, then
   `onDidChangeTreeData` event fires.

---

## G -- Webview Dashboard

### G1: Webview Panel with Real-Time Dashboard

As a VS Code user, I want a rich dashboard inside VS Code,
so that I can view progress, audit logs, transcripts, and
control orchestration.

- Opens via `Conductor: Dashboard` command.
- HTML/CSS/JS served from `src/webview/dashboard.html`.
- Extension posts state updates via `panel.webview
  .postMessage({type:"state", data})`.
- Webview sends commands via `postMessage`:
  `{type:"pause"}`, `{type:"resume"}`,
  `{type:"skip", itemId}`, `{type:"retry", itemId}`,
  `{type:"approve", itemId}`,
  `{type:"reject", itemId, feedback}`,
  `{type:"changeModel", role, vendor, family}`.
- Displays:
  - Phase items with status indicators (colour-coded).
  - Current step with animated indicator.
  - Model name per role.
  - Streaming audit log with filter by role/status.
  - Cumulative token counts (in/out) per step and total.
  - Expandable transcript viewer per invocation.
- Uses VS Code Webview API (`getUri` for local resources,
  CSP-compliant).

**Package:** `src/webview/`
**File:** `src/webview/panel.ts`, `src/webview/dashboard.html`
**Test file:** `src/test/webview/panel.test.ts`

```typescript
export function createDashboardPanel(
  context: vscode.ExtensionContext,
  orchestrator: Orchestrator
): vscode.WebviewPanel;
```

**Acceptance tests:**

1. When `Conductor: Dashboard` executes, then a
   `WebviewPanel` is created with `viewType`
   `"conductor.dashboard"`.
2. Given state update, when extension posts message with
   `type:"state"`, then webview receives message with
   `data` matching `OrchestratorState`.
3. When webview sends `{type:"pause"}`, then
   `orchestrator.pause()` called.
4. When webview sends `{type:"resume"}`, then
   `orchestrator.resume()` called.
5. When webview sends `{type:"approve", itemId:"A1"}`, then
   `orchestrator.approve("A1")` called.
6. Given `AuditEntry` with `tokensIn:500, tokensOut:200`,
   when rendered, then cumulative token display shows at
   least `700` total tokens.
7. Panel HTML includes CSP meta tag restricting script
   sources to nonce-based inline scripts.
8. When webview sends `{type:"skip", itemId:"A1"}`,
   then `orchestrator.skip("A1")` called.
9. When webview sends `{type:"retry", itemId:"A1"}`,
   then `orchestrator.retry("A1")` called.
10. When webview sends `{type:"reject", itemId:"A1",
    feedback:"fix X"}`, then
    `orchestrator.reject("A1", "fix X")` called.
11. When webview sends `{type:"changeModel",
    role:"reviewer", vendor:"copilot",
    family:"o3"}`, then
    `orchestrator.changeModel("reviewer", "copilot",
    "o3")` called.
12. Given audit entries for roles `"implementor"` and
    `"reviewer"`, when filter set to `"reviewer"`,
    then only `"reviewer"` entries displayed.

---

## H -- Team Server

### H1: HTTP/WebSocket Server with Authentication

As a team lead, I want an embedded server in the extension,
so that team members can view progress remotely.

- HTTP server on configurable port (default 8484).
- Serves static files from `src/server/app/`.
- WebSocket endpoint at `/ws`.
- Auth: `Authorization: Bearer <token>` header checked
  against `conductor.server.authToken` setting.
- WebSocket pushes `ServerMessage` on every state change,
  audit append, addendum append.
- Accepts `ClientMessage` from connected clients.
- Multiple concurrent clients supported.
- Server starts/stops with orchestration run.

**Package:** `src/server/`
**File:** `src/server/http.ts`, `src/server/ws.ts`,
  `src/server/auth.ts`
**Test file:** `src/test/server/http.test.ts`,
  `src/test/server/ws.test.ts`,
  `src/test/server/auth.test.ts`

```typescript
// http.ts
export function startServer(
  port: number,
  staticDir: string,
  authToken: string,
  orchestrator: Orchestrator
): Promise<{ close(): void }>;

// ws.ts
export function handleWebSocket(
  ws: WebSocket,
  orchestrator: Orchestrator
): void;

// auth.ts
export function validateAuth(
  header: string | undefined,
  expectedToken: string
): boolean;
```

**Acceptance tests:**

1. Given server started on port 8484, when HTTP GET `/`
   sent, then response is 200 with HTML content.
2. Given `authToken: "secret123"`, when WebSocket connects
   without auth header, then connection rejected with
   status 401.
3. Given valid auth header `Bearer secret123`, when
   WebSocket connects, then connection accepted.
4. Given 2 connected WebSocket clients and state change,
   then both clients receive `{type:"state"}` message.
5. Given client sends `{type:"pause"}`, then
   `orchestrator.pause()` called.
6. Given server running, when `close()` called, then server
   stops accepting connections and port is freed.
7. Given `authToken: ""` (empty), then all connections
   accepted (auth disabled).
8. Given client sends `{type:"addNote",
   itemId:"A1", text:"needs fix"}`, then
   `orchestrator.addNote("A1", "needs fix")` called.

### H2: Browser Dashboard SPA

As a team member, I want a browser-based dashboard, so that
I can monitor and control orchestration from any device.

- Single-page HTML/JS app at `src/server/app/index.html`.
- Connects to WebSocket, renders state updates.
- Same features as Webview: progress, audit, transcripts.
- Team features:
  - `startedBy` field displayed.
  - Approval queue: list items with
    `status: "pending-approval"`.
  - Multi-user annotations: add notes to addendum via
    `{type:"addNote", itemId, text}`.
- Controls: pause, resume, approve, reject, add notes.
- Responsive layout for mobile (< 768px width).
- Reconnects WebSocket on disconnect with exponential
  backoff (1s, 2s, 4s, max 30s).

**Package:** `src/server/app/`
**File:** `src/server/app/index.html`
**Test file:** `src/test/server/app.test.ts`

**Acceptance tests:**

1. Given SPA loaded in browser, when WebSocket sends
   `{type:"state", data}` with 2 phases and 5 items,
   then DOM contains 2 phase headings and 5 item rows.
2. Given item with `status:"pending-approval"`, then
   approval queue section lists that item.
3. When user clicks Pause button, then WebSocket sends
   `{type:"pause"}` message.
4. When WebSocket disconnects, then client retries after
   1s, then 2s, then 4s (exponential backoff).
5. Given viewport width 375px, then layout renders single
   column with no horizontal scroll.
6. When user submits note for item A1 with text `"needs
   fix"`, then WebSocket sends `{type:"addNote",
   itemId:"A1", text:"needs fix"}`.

---

## Implementation Order

### Phase 1: Core Extension (stories A1-F1)

1. **A1** -- Extension scaffolding. Foundation for all
   subsequent work. Sequential.
2. **B1, B2** -- Tool schema, dispatch, Bash security.
   Parallel. No dependency on LLM layer.
3. **C1** -- Model selection and prompt assembly. Needs A1
   config. Sequential.
4. **C2** -- Tool-loop invocation engine. Needs B1+B2+C1.
   Sequential.
5. **D1** -- Phase file parser. Independent of C; can
   parallel with step 3-4.
6. **E1** -- State persistence. Independent of C/D.
   Can parallel with steps 3-5.
7. **D2** -- Orchestration state machine. Needs C2+D1+E1.
   Sequential.
8. **F1** -- TreeView sidebar. Needs D2 for state events.
   Sequential.

### Phase 2: Webview Dashboard (story G1)

9. **G1** -- Webview panel. Needs Phase 1 complete.
   Sequential.

### Phase 3: Team Server (stories H1-H2)

10. **H1** -- HTTP/WebSocket server + auth. Needs Phase 1
    complete. Sequential.
11. **H2** -- Browser dashboard SPA. Needs H1. Sequential.

---

## Appendix: Key Decisions

- **Text-based tool calls, not native `vscode.lm` tools
  API.** The prompt specifies "the vscode.lm API provides
  text completions only" and the extension implements its
  own tool loop. This provides full control over tool
  dispatch and avoids API version coupling.
- **2-consecutive-PASS gate.** Matches existing orchestrator
  skill workflow. Counter resets to 0 on any FAIL.
- **Search-and-replace for Edit tool.** More reliable than
  unified diff parsing; matches VS Code editing patterns.
- **State in `.conductor/`.** Tracked by default for team
  visibility via git; `.gitignore`-able if preferred.
- **Testing strategy.** Use vitest for unit tests. Mock
  `vscode.lm` API and filesystem for deterministic tests.
  Use vscode-test for integration tests requiring real
  extension host.
- **No external dependencies** beyond `vscode` API and
  Node.js builtins where possible. fast-glob and ripgrep
  are the exceptions (ripgrep bundled with VS Code).
  The `ws` npm package is a required dependency for H1;
  manual WebSocket frame handling over `http.upgrade` is
  possible but `ws` is the pragmatic choice.
- **Refer to** `agent-conduct` skill for bash security
  rules. Implementor and reviewer skills enforce the same
  constraints as the existing prompt-based workflow.
- **VS Code 1.110+** required for `vscode.lm` API
  stability.
