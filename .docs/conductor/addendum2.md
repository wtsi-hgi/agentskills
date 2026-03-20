# Addendum 2: Bugfix, PR Review, Config, Git, and Gaps

This addendum extends the Copilot Conductor spec to cover
bugfix orchestration, post-implementation PR review,
per-feature configuration, git commit/push integration,
bash tool safety bypass, and lint execution. It adds
sections K through R to the existing A-J structure,
modifies shared types, and adds Phase 5 to the
implementation order.

See [prompt_addendum2.md](prompt_addendum2.md) for the
feature description and rationale.

---

## Shared Type Changes

### Role Type

Replace the existing `Role` union:

```typescript
export type Role =
  | "implementor"
  | "reviewer"
  | "pr-reviewer"
  | "spec-author"
  | "spec-reviewer"
  | "spec-proofreader"
  | "phase-creator"
  | "phase-reviewer";
```

### RunStatus Type

Replace the existing `RunStatus` union:

```typescript
export type RunStatus =
  | "idle"
  | "running"
  | "paused"
  | "pending-approval"
  | "done"
  | "error"
  | "abandoned";
```

### OrchestratorState

Add fields:

```typescript
export interface OrchestratorState {
  // ... existing fields unchanged
  conventionsSkill: string;
  testCommand: string;
  lintCommand: string;
  bugStep?: BugStep;
  bugIndex?: number;
  bugFixCycle?: number;
  bugIssues?: BugIssue[];
  prReviewStep?: PrReviewStep;
  prReviewConsecutivePasses?: number;
}

export type BugStep =
  | "fixing"
  | "reviewing"
  | "approving"
  | "committing"
  | "done";

export type PrReviewStep =
  | "spec-aware"
  | "spec-free"
  | "done";

export interface BugIssue {
  title: string;
  description: string;
}

export interface PrReviewFinding {
  file: string;
  line: number;
  description: string;
}

export type TrustedExecutor = (
  command: string,
  projectDir: string,
  timeoutMs?: number
) => Promise<ToolResult>;
```

Default `conventionsSkill` to `""`, `testCommand` to
`"npm test"`, `lintCommand` to `""`. Default `bugStep`,
`bugIndex`, `bugFixCycle`, `bugIssues`, `prReviewStep`,
and `prReviewConsecutivePasses` to `undefined`.

### OrchestratorConfig

Remove `specDir`, `conventionsSkill`, and `testCommand`.
These are now per-feature state fields. Add `docsDir`.

```typescript
export interface OrchestratorConfig {
  projectDir: string;
  skillsDir: string;
  docsDir: string;
  modelAssignments: ModelAssignment[];
  maxTurns: number;
  maxRetries: number;
  requireApproval: boolean;
}
```

### Configuration Changes

Remove from `package.json`:
- `conductor.specDir`
- `conductor.conventionsSkill`
- `conductor.testCommand`

Add:
- `conductor.docsDir`: string, default `".docs/"`
- `conductor.models.prReviewer`: `{vendor,family}` object

### Client/Server Message Types

Add to `ClientMessage`:

```typescript
| { type: "start-bugfix"; prompt: string }
| { type: "start-feature"; prompt: string }
| { type: "copilot-rereview" }
| { type: "abandon" }
| { type: "override-commands";
    testCommand: string; lintCommand: string }
```

Add to `ServerMessage`:

```typescript
| { type: "bugfix-status";
    bugIndex: number; bugCount: number;
    fixCycle: number; bugStep: BugStep }
| { type: "pr-review-status";
    step: PrReviewStep;
    consecutivePasses: number }
| { type: "prompt-slug"; suggestedSlug: string }
```

### Orchestrator Interface

Add methods:

```typescript
export interface Orchestrator {
  // ... existing methods unchanged
  abandon(): void;
  startCopilotReReview(): void;
  overrideCommands(
    testCommand: string, lintCommand: string
  ): void;
}
```

---

## K -- Prompt Entry and Directory Creation

### K1: Inline Prompt Entry for Features

As an extension user, I want to type a feature description
directly instead of creating a `prompt.md` file, so that I
can start quickly without manual file management.

When `Conductor: Start` is invoked:
- If the user provides an inline prompt (via dashboard,
  team server, or VS Code input box), the extension:
  1. Invokes a quick LLM (spec-author model, no tools) to
     derive a kebab-case slug from the prompt text.
  2. Presents the slug as default; user may override.
  3. Creates `<docsDir>/<slug>/` directory. If the
     directory exists, appends `-2`, `-3`, etc.
  4. Writes `prompt.md` with the prompt text.
  5. Proceeds with spec-writing workflow.
- If the user selects an existing directory containing
  `prompt.md`, proceeds as before.
- Fallback if slug LLM returns garbage (no kebab-case
  match): use `feature-<N>` where `<N>` is the next
  unused increment.

The slug LLM invocation is a single `sendRequest` call
with no tool loop -- just a short instruction and the
prompt text. No audit entry needed.

**File:** `src/extension.ts`, `src/orchestrator/machine.ts`
**Test file:** `src/test/extension.test.ts`

```typescript
export function deriveFeatureSlug(
  text: string
): Promise<string>;
```

**Acceptance tests:**

1. Given inline prompt "Add batch retry logic", when
   slug LLM returns "batch-retry-logic", then directory
   `.docs/batch-retry-logic/` is created and
   `prompt.md` contains the prompt text.
2. Given slug LLM returns "batch-retry-logic" but
   `.docs/batch-retry-logic/` exists, then directory
   `.docs/batch-retry-logic-2/` is created.
3. Given slug LLM returns `"!!! not valid"` (no
   kebab-case match), then directory
   `.docs/feature-1/` is created.
4. Given user overrides suggested slug "batch-retry"
   with "my-feature", then directory
   `.docs/my-feature/` is created.
5. Given existing directory with `prompt.md` selected,
   then no new directory created and no slug LLM
   invoked.
6. Given `docsDir` configured as `.specs/`, then
   directory created under `.specs/`.
7. Given active bugfix run, when `Conductor: Start`
   invoked with inline prompt, then error message
   "Complete or abandon current run first." shown
   and no new directory created.

### K2: Inline Prompt Entry for Bugfixes

As an extension user, I want to type a bug description
directly for `Conductor: Fix Bugs`, so that I can report
bugs without file management.

When `Conductor: Fix Bugs` is invoked:
- Directory named `<docsDir>/bugs<N>/` where `<N>` is
  the next unused increment (e.g. `bugs1`, `bugs2`).
- Writes `prompt.md` with the bug description.
- The same `.conductor/` state layout is used.
- If the user selects an existing bugfix directory
  containing `prompt.md`, proceed without creating a
  new directory.

**File:** `src/extension.ts`
**Test file:** `src/test/extension.test.ts`

**Acceptance tests:**

1. Given no `bugs*` directories exist under `.docs/`,
   when inline bugfix prompt provided, then
   `.docs/bugs1/` is created with `prompt.md`.
2. Given `.docs/bugs1/` exists, when inline bugfix
   prompt provided, then `.docs/bugs2/` is created.
3. Given `.docs/bugs1/` and `.docs/bugs3/` exist (gap),
   then `.docs/bugs4/` is created (next after highest).
4. Given bugfix directory created, then
   `.docs/bugs1/.conductor/state.json` is initialised
   with `status: "running"`.
5. Given existing `.docs/bugs1/` directory with
   `prompt.md` selected, when `Conductor: Fix Bugs`
   invoked, then bugfix orchestration starts from
   existing directory without creating a new one.

### K3: VS Code Input for Inline Prompts

As a VS Code user, I want a multi-line input for entering
prompts from the command palette, so that I don't need the
dashboard open.

- `Conductor: Start` and `Conductor: Fix Bugs` open a
  temporary untitled document for multi-line editing.
- The prompt is captured when the user closes or confirms
  the document.
- Short prompts (single line) use a standard VS Code
  input box instead.

**File:** `src/extension.ts`
**Test file:** `src/test/extension.test.ts`

**Acceptance tests:**

1. Given user invokes `Conductor: Start` with no
   existing directory selected, then an untitled
   document opens for prompt entry.
2. Given user confirms the untitled document with text,
   then the text is used as the inline prompt.
3. Given user cancels the untitled document, then no
   directory is created and no run starts.

---

## L -- Bugfix Orchestration

### L1: Bug Description Parsing

As the orchestrator, I want to parse a bug description
into discrete issues, so that each bug is fixed
independently.

- Quick LLM call (spec-author model, no tool loop) that
  splits the bug text into a JSON array of `BugIssue`
  objects (`{title, description}`).
- Fallback if LLM returns invalid JSON: treat the entire
  prompt as a single bug issue with title "Bug fix".

**File:** `src/orchestrator/machine.ts`
**Test file:** `src/test/orchestrator/machine.test.ts`

```typescript
export function parseBugDescription(
  response: string
): BugIssue[];
```

**Acceptance tests:**

1. Given LLM returns
   `[{"title":"NPE in parser","description":"..."},
   {"title":"Off-by-one","description":"..."}]`,
   when parsed, then result has length 2 with matching
   titles.
2. Given LLM returns invalid JSON, when parsed, then
   result has length 1 with title "Bug fix" and
   description equal to the full response text.
3. Given LLM returns empty array `[]`, when parsed, then
   result has length 1 with title "Bug fix" (fallback).
4. Given LLM returns JSON in a fenced code block, when
   parsed, then the JSON is extracted and parsed
   correctly.

### L2: Bugfix State Machine

As an extension user, I want the extension to fix each
bug through a fix-review-approve-commit cycle, so that
bugs are resolved reliably with human oversight.

Per bug issue, sequentially:
1. **Fix** (`bugStep: "fixing"`): invoke implementor
   with conventions skill, implementor skill, bug
   description, and instruction to write a failing
   regression test then fix the code.
2. **Review** (`bugStep: "reviewing"`): invoke reviewer
   with conventions skill, reviewer skill, bug
   description, and changed files. Reviewer checks
   regression test exists, fix is correct and minimal,
   tests pass, lint clean. Returns PASS or FAIL.
   - PASS: advance to approve.
   - FAIL: re-invoke implementor with feedback, then
     fresh reviewer. Max 5 fix-review cycles
     (`bugFixCycle` tracks count).
3. **Approve** (`bugStep: "approving"`): pause for human
   approval (always, regardless of `requireApproval`).
   Dashboard/server show bug summary, fix summary,
   test/lint status.
   - Approved: advance to commit.
   - Changes requested: return to fix with feedback.
4. **Commit** (`bugStep: "committing"`): `git add` only
   changed files, commit with short imperative message
   (max 72 chars), push to remote.

After all bugs processed, set `bugStep` to `"done"` and
report completion summary.

**File:** `src/orchestrator/machine.ts`
**Test file:** `src/test/orchestrator/machine.test.ts`

**Acceptance tests:**

1. Given single bug with implementor PASS and reviewer
   PASS on first try, when bugfix runs, then `bugStep`
   progresses through `"fixing"` -> `"reviewing"` ->
   `"approving"` and approval is requested.
2. Given reviewer returns FAIL, then implementor
   re-invoked with feedback and `bugFixCycle`
   incremented.
3. Given `bugFixCycle` reaches 5 and reviewer still
   FAIL, then bug marked as failed and machine
   advances to next bug.
4. Given human approves in approve step, then git
   commit is created with message <= 72 characters
   and push executes.
5. Given human requests changes in approve step, then
   `bugStep` returns to `"fixing"` with user feedback
   appended.
6. Given 3 bugs and all approved, then 3 separate
   commits are created and `bugStep` is `"done"`.
7. Given bugfix invocation, then audit entry logged
   with role `"implementor"` or `"reviewer"` and
   transcript saved.
8. Given `bugStep` is `"reviewing"` and pause called,
   then `state.json` contains `bugStep: "reviewing"`,
   `bugIndex`, and `bugFixCycle`. On resume, continues
   from saved state.
9. Given bugfix approval pending, then dashboard
   receives `bugfix-status` message with current
   `bugIndex`, `bugCount`, `fixCycle`, and `bugStep`.
10. Given all bugs processed, then dashboard receives
    `bugfix-status` with `bugStep: "done"`.

### L3: Fix Bugs Command

As an extension user, I want a `Conductor: Fix Bugs`
command, so that I can trigger bugfix orchestration.

- New command `conductor.fixBugs` registered on
  activation.
- Accepts inline prompt or existing bugfix directory.
- Creates bug directory per K2 if inline.
- Only one run active at a time. If active/paused run
  exists, show error "Complete or abandon current run
  first."

**File:** `src/extension.ts`
**Test file:** `src/test/extension.test.ts`

**Acceptance tests:**

1. Given no active run, when `Conductor: Fix Bugs`
   invoked with inline prompt, then bug directory
   created and bugfix orchestration starts.
2. Given active feature run, when `Conductor: Fix Bugs`
   invoked, then error message
   "Complete or abandon current run first." shown.
3. Given `Conductor: Fix Bugs` invoked, then
   `state.json` contains `bugStep: "fixing"` and
   `bugIndex: 0`.

---

## M -- Post-Implementation PR Review

### M1: PR Review State Machine

As the orchestrator, I want whole-PR review after all
phase items pass, so that code quality is validated before
the run completes.

After all phase items pass review, instead of setting
`status` to `"done"`, the machine enters PR review:

1. **Spec-aware** (`prReviewStep: "spec-aware"`): invoke
   pr-reviewer with pr-reviewer skill, spec path, and
   instruction to review all changes on current branch
   vs base (computed via
   `git merge-base HEAD <default-branch>`).
   - Returns structured findings as JSON array inside
     done tag:
     `<done>FAIL[{"file":"...","line":...,"description":"..."}]</done>`.
   - No findings (`<done>PASS</done>`): increment
     `prReviewConsecutivePasses`. If `>= 2`, advance to
     spec-free (or approval if `requireApproval`).
   - Findings: reset `prReviewConsecutivePasses` to 0.
     Invoke implementor per finding to fix. Run
     tests/lint. Commit fixes. Push to remote.
     Re-invoke fresh pr-reviewer.
   - If fix-review cycles exceed `maxRetries`, set
     `status` to `"error"` with an audit entry.

2. **Spec-free** (`prReviewStep: "spec-free"`): same as
   above but without spec (focus on code quality and
   usability only). Commit fixes. Push to remote.
   Repeat until 2 consecutive clean passes.

After both steps, if `requireApproval`, pause for human
approval. Then set `status` to `"done"`.

**File:** `src/orchestrator/machine.ts`
**Test file:** `src/test/orchestrator/machine.test.ts`

**Acceptance tests:**

1. Given all phase items pass, then `prReviewStep` is
   `"spec-aware"` and pr-reviewer invoked with spec
   path and branch diff.
2. Given pr-reviewer returns PASS twice consecutively
   in spec-aware step, then `prReviewStep` advances to
   `"spec-free"`.
3. Given pr-reviewer returns FAIL with 2 findings, then
   2 implementor invocations execute (one per finding),
   tests run, and fresh pr-reviewer invoked.
4. Given pr-reviewer returns PASS twice in spec-free
   step, then `status` is `"done"`.
5. Given `requireApproval: true` and both PR review
   steps pass, then `status` is `"pending-approval"`.
   On approve, `status` becomes `"done"`.
6. Given spec-aware pr-reviewer prompt, then it
   contains the spec file path and the branch diff
   output.
7. Given spec-free pr-reviewer prompt, then it does NOT
   contain the spec file path.
8. Given pr-reviewer finding fix committed, then git
   commit message is imperative and <= 72 chars.
9. Given pr-reviewer finding fix committed, then git
   push executes after commit.
10. Given `prReviewStep` is `"spec-aware"` and pause
    called, then `state.json` contains
    `prReviewStep: "spec-aware"` and
    `prReviewConsecutivePasses`. On resume, continues.
11. Given pr-reviewer invocation, then audit entry has
    role `"pr-reviewer"` and transcript saved.
12. Given `maxRetries: 3` and spec-aware pr-reviewer
    always returns findings, then after 3 fix-review
    cycles `status` is `"error"` and audit contains
    `result: "error"` for `"pr-reviewer"`.

### M2: PR Reviewer Model Config

As the extension, I want a configurable model for
pr-reviewer, so that users can choose which model reviews
the whole PR.

- `conductor.models.prReviewer` setting in `package.json`.
- `getModelAssignments` reads it and includes
  `{role: "pr-reviewer", ...}` in the array.
- `selectModelForRole` handles `"pr-reviewer"`.

**File:** `src/extension.ts`, `src/llm/select.ts`
**Test file:** `src/test/extension.test.ts`,
  `src/test/llm/select.test.ts`

**Acceptance tests:**

1. Given `conductor.models.prReviewer` set to
   `{vendor:"copilot", family:"o3"}`, then
   `getModelAssignments` returns entry with
   `role: "pr-reviewer"`, `vendor: "copilot"`,
   `family: "o3"`.
2. Given `selectModelForRole("pr-reviewer", ...)` with
   matching mock, then returned model's family is
   `"o3"`.

### M3: PR Reviewer Skill Loading

As the orchestrator, I want pr-reviewer prompt assembly to
load the pr-reviewer skill, so that the LLM has correct
review instructions.

- `deriveRoleSkillName("pr-reviewer", ...)` returns
  `"pr-reviewer"` (no conventions prefix).
- `assembleSystemPrompt` for `"pr-reviewer"` loads the
  pr-reviewer skill, tool definitions, and wire format.
  Conventions skill is NOT loaded (pr-reviewer operates
  on code quality, not conventions).

**File:** `src/llm/prompts.ts`
**Test file:** `src/test/llm/prompts.test.ts`

**Acceptance tests:**

1. Given role `"pr-reviewer"`, when
   `deriveRoleSkillName` called, then returns
   `"pr-reviewer"`.
2. Given role `"pr-reviewer"`, when
   `assembleSystemPrompt` called, then result contains
   `pr-reviewer/SKILL.md` content and does NOT contain
   conventions skill content.
3. Given `"pr-reviewer"` prompt, then it contains tool
   definitions and `<tool_call>` wire format.

---

## N -- Copilot Re-Review Loop

### N1: Copilot Re-Review Command

As an extension user, I want a `Conductor: Copilot
Re-Review` command, so that I can trigger the Copilot
re-review loop after seeing a GitHub Copilot review on
my PR.

The command is independent of the main pipeline -- it can
be triggered at any time on any branch with an open PR.

Loop steps:
1. Push current commits via trusted execution.
2. Poll until remote HEAD SHA matches local HEAD
   (30-second interval, timeout 5 minutes).
3. Request Copilot re-review via `gh` CLI:
   `gh api repos/{owner}/{repo}/pulls/{pr}/requested_reviewers`
   `-f reviewers[]=copilot`
4. Poll for new Copilot review submitted after push
   timestamp (30-second interval, timeout 20 minutes):
   `gh api repos/{owner}/{repo}/pulls/{pr}/reviews`
5. Fetch unresolved Copilot comments:
   `gh api repos/{owner}/{repo}/pulls/{pr}/comments`
   - No new comments: loop ends, report success.
   - New comments: pr-reviewer LLM evaluates Copilot
     comments into structured findings, then the
     extension dispatches implementor subagents per
     finding to fix. Commit fixes, return to step 1.
6. At cycle 3+, prepend to implementor prompt:
   "Consider the problem holistically. The same area
   has attracted repeated reviewer findings across
   multiple fix cycles. Rather than patching individual
   comments, refactor the surrounding code so that
   reviewers do not keep finding issues."
7. After 20 cycles, stop, push whatever is committed,
   and report manual review needed.

Uses `gh` CLI (assumed on PATH). All git/gh commands
execute via trusted execution (P1), not the LLM-facing
bash tool.

**File:** `src/orchestrator/machine.ts`
**Test file:** `src/test/orchestrator/machine.test.ts`

```typescript
export interface Orchestrator {
  // ... existing methods
  startCopilotReReview(): void;
}
```

**Acceptance tests:**

1. Given clean branch with open PR and no Copilot
   comments, when re-review triggered, then push
   executes, Copilot review requested, poll finds no
   new comments, and loop reports success.
2. Given Copilot review with 2 unresolved comments,
   then implementor LLM invoked per finding to fix,
   commit created, and loop returns to push step.
3. Given cycle count reaches 3, then implementor prompt
   contains holistic refactor instruction.
4. Given cycle count reaches 20, then loop stops and
   reports "manual review needed".
5. Given remote HEAD poll exceeds 5-minute timeout,
   then loop reports push verification timeout.
6. Given Copilot review poll exceeds 20-minute timeout,
   then loop reports review wait timeout.
7. Given `gh` CLI not on PATH, then error message
   "gh CLI not found" reported.
8. Given re-review triggered during active run, then
   both proceed independently (re-review does not
   block main pipeline).
9. Given re-review loop, then audit entries logged with
   role `"pr-reviewer"`.

### N2: Re-Review Dashboard/Server Button

As a team member, I want a re-review button in the
dashboard and team server, so that I can trigger the
Copilot re-review loop from the UI.

- Dashboard and browser SPA show a "Copilot Re-Review"
  button.
- Button sends `{type: "copilot-rereview"}` client
  message.
- Extension calls `orchestrator.startCopilotReReview()`.
- Status updates shown during the loop.

**File:** `src/webview/panel.ts`, `src/webview/dashboard.html`,
  `src/server/app/index.html`, `src/server/ws.ts`
**Test file:** `src/test/webview/panel.test.ts`,
  `src/test/server/ws.test.ts`

**Acceptance tests:**

1. When dashboard sends `{type: "copilot-rereview"}`,
   then `orchestrator.startCopilotReReview()` called.
2. When server receives `{type: "copilot-rereview"}`,
   then `orchestrator.startCopilotReReview()` called.

---

## O -- Commit, Push, and Branch Safety

### O1: Branch Safety Check

As the extension, I want to refuse to push to protected
branches, so that the repository's main branch is never
accidentally modified.

At run start (before any work), the extension:
1. Gets current branch:
   `git rev-parse --abbrev-ref HEAD`.
2. Gets default branch:
   `git remote show origin | grep 'HEAD branch'`.
3. If current branch is `main`, `master`, or the default
   branch, aborts with error:
   "Cannot run Conductor on protected branch '<name>'.
   Switch to a feature branch first."

This is a hard gate -- not a warning, not overridable.

**File:** `src/orchestrator/machine.ts`
**Test file:** `src/test/orchestrator/machine.test.ts`

```typescript
export function checkBranchSafety(
  projectDir: string,
  executeTrusted: TrustedExecutor
): Promise<{ safe: boolean; branch: string;
  reason?: string }>;
```

**Acceptance tests:**

1. Given current branch is `feature/foo`, then
   `checkBranchSafety` returns `{safe: true}`.
2. Given current branch is `main`, then returns
   `{safe: false, reason: "...protected branch..."}`.
3. Given current branch is `master`, then returns
   `{safe: false}`.
4. Given default branch from remote is `develop` and
   current branch is `develop`, then returns
   `{safe: false}`.
5. Given current branch is `develop` but default branch
   is `main`, then returns `{safe: true}`.
6. Given `git remote show origin` fails, then default
   branch check skipped and only `main`/`master`
   checked.

### O2: Per-Phase Commit and Push

As the orchestrator, I want automatic commits after each
phase completes, so that progress is saved in git.

After all items in a phase pass review:
1. `git add` all changed files.
2. `git commit -m "Implement phase <N>"`.
3. `git push`.

Executed via trusted execution (P1).

**File:** `src/orchestrator/machine.ts`
**Test file:** `src/test/orchestrator/machine.test.ts`

**Acceptance tests:**

1. Given phase 2 all items pass, then `git add .` and
   `git commit -m "Implement phase 2"` execute.
2. Given commit succeeds, then `git push` executes.
3. Given `git push` fails, then error logged in audit
   but run continues (non-fatal).
4. Given phase includes skipped items, then commit
   still happens for items that passed.

### O3: State File Commit and Push

As the extension, I want state files committed and pushed
at meaningful checkpoints, so that progress is recoverable
from another machine.

After each of: phase completion, spec-writing step
completion, bugfix commit, PR review pass:
1. `git add .conductor/`.
2. `git commit -m "conductor: update state"`.
3. `git push`.

Batched: one commit per checkpoint, not per individual
audit entry.

**File:** `src/orchestrator/machine.ts`
**Test file:** `src/test/orchestrator/machine.test.ts`

**Acceptance tests:**

1. Given phase 1 completes, then `.conductor/` files
   are committed with message
   `"conductor: update state"` and pushed.
2. Given spec-writing authoring completes, then state
   commit and push occur.
3. Given bugfix commit completes, then state commit and
   push occur.
4. Given two rapid state transitions, then only one
   state commit per checkpoint (not per audit entry).

### O4: Spec-Writing Commit

As the orchestrator, I want spec and phase files committed
after spec-writing completes, so that the spec is version
controlled before implementation begins.

After `specStep` transitions to `"done"`:
1. `git add spec.md phase*.md` in `specDir`.
2. `git commit -m "conductor: write spec"`.
3. `git push`.

**File:** `src/orchestrator/machine.ts`
**Test file:** `src/test/orchestrator/machine.test.ts`

**Acceptance tests:**

1. Given spec-writing completes, then `spec.md` and
   `phase*.md` committed with message
   `"conductor: write spec"`.
2. Given commit succeeds, then push executes.

---

## P -- Bash Tool Safety Bypass

### P1: Trusted Execution Path

As the extension, I want to run compound commands for
git, lint, and testing without LLM safety restrictions,
so that shell metacharacters in trusted commands are not
blocked.

New function `executeTrusted` in `bash.ts`:
- Executes the command via `/bin/bash -lc`.
- Enforces timeout and working directory constraints.
- Does NOT validate against `DANGEROUS_SHELL_SYNTAX_PATTERNS`,
  `SUDO_PATTERN`, `GIT_PUSH_PATTERN`, or
  `INTERACTIVE_COMMAND_PATTERN`.
- Only callable from extension code -- never exposed as
  an LLM tool.

The existing `executeBash` (LLM-facing) remains unchanged.

**File:** `src/tools/bash.ts`
**Test file:** `src/test/tools/bash.test.ts`

```typescript
export function executeTrusted(
  command: string,
  projectDir: string,
  timeoutMs?: number
): Promise<ToolResult>;
```

**Acceptance tests:**

1. Given command `echo a && echo b`, when
   `executeTrusted` called, then `success` is `true`
   and output contains both `"a"` and `"b"`.
2. Given command `git push origin feature`, when
   `executeTrusted` called, then command executes
   (not blocked).
3. Given command `ruff check --fix src/ && ruff format src/`,
   when `executeTrusted` called, then `success` is
   `true` (`&&` allowed).
4. Given `timeoutMs: 100` and `sleep 60`, when
   `executeTrusted` called, then `success` is `false`
   with error containing `"timeout"`.
5. Given `executeBash` (LLM-facing) with `echo a && echo b`,
   then `valid` is `false` (unchanged behaviour).
6. Given `executeTrusted` with `projectDir`, then
   command runs in `projectDir` working directory.

### P2: File Trash Safety Net

As the extension, I want deleted files stashed rather
than lost, so that the run is resilient to accidental
file removal.

If a file the LLM wrote is later deleted (e.g. by a
reviewer fix), move it to `.trash/` in the repo root.
Clean up `.trash/` after all phases complete.

**File:** `src/tools/dispatch.ts`
**Test file:** `src/test/tools/dispatch.test.ts`

**Acceptance tests:**

1. Given file `src/foo.ts` exists and Edit tool removes
   all content, then file is NOT moved to `.trash/`.
2. Given LLM-written file `src/bar.ts` is explicitly
   deleted by a subsequent tool call, then
   `.trash/src/bar.ts` contains the original content.
3. Given all phases complete, then `.trash/` directory
   is removed.
4. Given `.trash/` does not exist at run start, then
   no error on cleanup.

---

## Q -- Lint Execution

### Q1: Lint Command Extraction

As the extension, I want lint commands extracted from the
conventions skill automatically, so that linting works
without manual configuration.

When the conventions skill is selected (per R2), the
extension:
1. Runs a quick LLM parse (spec-author model, no tools)
   of the skill content.
2. Instruction: "Extract the test command and lint
   command(s) from this skill text. Return JSON:
   `{testCommand, lintCommand}`. The lintCommand may be
   a compound command using `&&`."
3. Stores extracted `testCommand` and `lintCommand` in
   `OrchestratorState`.
4. User may override via dashboard or team server
   (`override-commands` message).

**File:** `src/orchestrator/machine.ts`
**Test file:** `src/test/orchestrator/machine.test.ts`

```typescript
export function parseCommandExtraction(
  response: string
): { testCommand: string; lintCommand: string };
```

**Acceptance tests:**

1. Given LLM returns
   `{"testCommand":"go test ./...","lintCommand":"golangci-lint run --fix"}`,
   when parsed, then `testCommand` is
   `"go test ./..."` and `lintCommand` is
   `"golangci-lint run --fix"`.
2. Given LLM returns JSON in fenced code block, then
   extracted and parsed correctly.
3. Given LLM returns invalid JSON, then `testCommand`
   defaults to `"npm test"` and `lintCommand` to `""`.
4. Given user sends `override-commands` with custom
   values, then `state.testCommand` and
   `state.lintCommand` updated.

### Q2: Lint Step in Quality Gate

As the orchestrator, I want linting to run after tests
pass, so that code quality issues are caught before
review.

After tests pass in the implement cycle (both item and
bugfix):
1. If `lintCommand` is non-empty, run it via trusted
   execution.
2. If lint modifies files (exit 0 but files changed),
   re-run tests to catch regressions.
3. If lint fails (non-zero exit), feed lint output back
   to implementor as retry feedback (same as test
   failures).
4. Full quality cycle: test -> lint -> retest if lint
   modified files.

**File:** `src/orchestrator/machine.ts`
**Test file:** `src/test/orchestrator/machine.test.ts`

**Acceptance tests:**

1. Given `lintCommand` is `"ruff check --fix && ruff format"`,
   when tests pass and lint passes (no changes), then
   review proceeds.
2. Given lint exits non-zero, then implementor re-invoked
   with lint failure output as feedback.
3. Given lint modifies files (detected via `git diff`
   after lint), then tests re-run.
4. Given lint modifies files and re-test fails, then
   implementor re-invoked with test failure feedback.
5. Given `lintCommand` is empty string, then lint step
   skipped entirely.
6. Given lint timeout, then item marked as failed with
   audit entry `result: "error"`.

---

## R -- Per-Feature Configuration

### R1: Remove Global Config Settings

As a maintainer, I want `specDir`, `conventionsSkill`,
and `testCommand` removed from global settings, so that
configuration is per-feature.

- Remove `conductor.specDir` from `package.json`.
- Remove `conductor.conventionsSkill` from `package.json`.
- Remove `conductor.testCommand` from `package.json`.
- Add `conductor.docsDir` to `package.json` (string,
  default `".docs/"`).
- `OrchestratorConfig` drops `specDir`,
  `conventionsSkill`, `testCommand`; gains `docsDir`.
- `OrchestratorState` gains `conventionsSkill`,
  `testCommand`, `lintCommand` (persisted in
  `state.json`).

**File:** `src/types.ts`, `src/extension.ts`,
  `package.json`
**Test file:** `src/test/extension.test.ts`

**Acceptance tests:**

1. TypeScript compilation succeeds with `specDir`,
   `conventionsSkill`, `testCommand` removed from
   `OrchestratorConfig`.
2. `OrchestratorState` includes `conventionsSkill`,
   `testCommand`, `lintCommand` fields.
3. `package.json` contains `conductor.docsDir` with
   default `".docs/"`.
4. `package.json` does NOT contain `conductor.specDir`,
   `conductor.conventionsSkill`, or
   `conductor.testCommand`.

### R2: Conventions Skill Auto-Detection

As an extension user, I want the extension to guess the
tech stack and suggest a conventions skill, so that I
don't need to configure it manually.

On new run start:
1. Quick LLM exploration (spec-author model, no tools):
   pass a summary listing file extensions, build files,
   lock files found in project root.
2. LLM returns a conventions skill name guess.
3. Extension presents guess as default in a quick-pick
   of available skills from `skillsDir` (filtered to
   `*-conventions`).
4. User confirms or overrides.
5. Chosen skill stored in `state.conventionsSkill`.

**File:** `src/extension.ts`, `src/orchestrator/machine.ts`
**Test file:** `src/test/extension.test.ts`

**Acceptance tests:**

1. Given project with `go.mod` and `go.sum`, when LLM
   returns `"go-conventions"`, then quick-pick shows
   `"go-conventions"` as default.
2. Given user overrides to `"python-conventions"`, then
   `state.conventionsSkill` is `"python-conventions"`.
3. Given `skillsDir` contains `go-conventions` and
   `python-conventions`, then quick-pick shows both.
4. Given LLM returns garbage, then quick-pick shows all
   available conventions skills with no default
   selected.
5. Given chosen skill stored, then `state.json` persists
   it across pause/resume.

### R3: Abandon Command

As an extension user, I want to abandon a run, so that
I can start a new one without completing the current run.

New command `conductor.abandon`:
- Sets `status` to `"abandoned"`.
- Leaves all files in place.
- Frees the extension to start a new run.

**File:** `src/extension.ts`
**Test file:** `src/test/extension.test.ts`

**Acceptance tests:**

1. Given active run, when `Conductor: Abandon` invoked,
   then `state.json` has `status: "abandoned"`.
2. Given abandoned run, when `Conductor: Start` invoked,
   then new run starts normally.
3. Given no active run, when `Conductor: Abandon`
   invoked, then info message "No active run to
   abandon." shown.

### R4: Crash Recovery with Per-Feature State

As the extension, I want to detect and resume crashed
runs from per-feature state directories, so that
progress survives VS Code restarts.

On activation:
1. Scan `docsDir` for directories containing
   `.conductor/state.json` with `status` of `"running"`
   or `"paused"`.
2. If found, prompt user to resume or abandon.
3. Per-feature state is self-contained: `state.json`
   records conventions skill and commands used.

**File:** `src/extension.ts`
**Test file:** `src/test/extension.test.ts`

**Acceptance tests:**

1. Given `.docs/my-feature/.conductor/state.json` with
   `status: "running"`, when extension activates, then
   user prompted to resume.
2. Given user selects "Resume", then run continues from
   saved state with `conventionsSkill` and
   `testCommand` from `state.json`.
3. Given user selects "Abandon", then `status` set to
   `"abandoned"`.
4. Given multiple feature dirs with active state, then
   user prompted per dir (or shown a list).
5. Given `status: "done"` in state, then no resume
   prompt shown.

---

## Updated Dashboard and Team Server

### Webview dashboard (G1 update)

- Bugfix status section: current bug number, fix-review
  cycle count, approval status.
- PR review status section: current step (spec-aware /
  spec-free), consecutive passes count.
- "Copilot Re-Review" button.
- "Abandon" button.
- Inline prompt entry: text area for feature/bugfix
  description with "Start" / "Fix Bugs" buttons.
- Command override fields for `testCommand` and
  `lintCommand`.
- Conventions skill selector.

### Browser SPA (H2 update)

- Same additions as webview dashboard.

No new acceptance tests -- existing G1/H2 tests cover
rendering and control wire-up. New message types flow
through the same paths.

---

## Implementation Order

### Phase 5: Bugfix, PR Review, Config, Git, and Gaps (stories K1-R4)

18. **R1** -- Remove global config, add `docsDir`. Type
    changes to `OrchestratorConfig` and
    `OrchestratorState`. Must come first so subsequent
    stories build on clean types. Sequential.
19. **P1** -- Trusted execution path in `bash.ts`. Add
    `executeTrusted`. Sequential. Needs R1 for
    `lintCommand` field.
20. **O1** -- Branch safety check. Sequential. Needs P1
    for trusted execution.
21. **Q1** -- Lint command extraction from conventions
    skill. Sequential. Needs P1.
22. **Q2** -- Lint step in quality gate. Sequential.
    Needs Q1 + P1.
23. **R2** -- Conventions skill auto-detection. Needs R1.
    Sequential.
24. **K1** -- Inline prompt entry for features. Needs R1
    + R2. Sequential.
25. **K2** -- Inline prompt entry for bugfixes. Needs K1.
    Sequential.
26. **K3** -- VS Code input for inline prompts. Needs
    K1. Sequential.
27. **M3** -- PR reviewer skill loading. Add
    `"pr-reviewer"` to `deriveRoleSkillName`. Needs R1.
    Sequential.
28. **M2** -- PR reviewer model config. Needs M3.
    Sequential.
29. **M1** -- PR review state machine. Needs M2 + M3 +
    Q2 + O1 + P1. Sequential.
30. **O2** -- Per-phase commit and push. Needs P1 + O1.
    Sequential.
31. **O3** -- State file commit and push. Needs O2.
    Sequential.
32. **O4** -- Spec-writing commit. Needs O2. Sequential.
33. **L1** -- Bug description parsing. Needs R1.
    Sequential.
34. **L2** -- Bugfix state machine. Needs L1 + Q2 + P1 +
    O1. Sequential.
35. **L3** -- Fix Bugs command. Needs L2 + K2.
    Sequential.
36. **N1** -- Copilot re-review command. Needs P1 + M1.
    Sequential.
37. **N2** -- Re-review dashboard/server button. Needs
    N1. Sequential.
38. **R3** -- Abandon command. Needs R1. Sequential.
39. **R4** -- Crash recovery with per-feature state.
    Needs R1. Sequential.
40. **P2** -- File trash safety net. Needs P1.
    Sequential.
41. **G1/H2 updates** -- Dashboard bugfix status, PR
    review status, re-review button, abandon button,
    inline prompt UI, command overrides, conventions
    selector. Needs all above. Sequential.

---

## Appendix: Key Decisions

- **Per-feature state.** `conventionsSkill`, `testCommand`,
  and `lintCommand` move from global config to
  `OrchestratorState`. Each feature directory has its own
  `.conductor/state.json`. This makes runs reproducible
  and supports multiple tech stacks in one repo.
- **Trusted execution.** `executeTrusted` is a separate
  function, not a flag on `executeBash`. LLM tool calls
  always route through `executeBash` with full safety
  validation. Extension-owned commands route through
  `executeTrusted` which still enforces timeout and cwd
  but skips shell metacharacter blocking.
- **Mandatory bugfix approval.** The bugfix approve step
  always pauses for human approval regardless of
  `requireApproval`. Bug fixes modify production code and
  need human sign-off.
- **PR review uses structured findings.** The pr-reviewer
  returns `<done>FAIL[...]</done>` with a JSON array of
  findings. The extension dispatches one implementor
  invocation per finding. This matches the subagent
  pattern from the manual pr-reviewer skill.
- **Copilot re-review is decoupled.** The loop is
  user-triggered and independent of the main pipeline.
  Only the user knows when a Copilot review has appeared.
  Uses `gh` CLI for GitHub API calls rather than building
  a REST client.
- **One active run.** Only one feature or bugfix run is
  active at a time. `Conductor: Abandon` frees the slot.
  The Copilot re-review loop runs independently and does
  not count as an active run.
- **Branch safety is a hard gate.** The extension refuses
  to push to `main`, `master`, or the default branch.
  This prevents accidental damage to protected branches.
- **Push after every commit.** Per-phase commits, bugfix
  commits, and PR review fix commits all push to remote.
  State files push at checkpoints. This ensures crash
  recovery is possible from another machine.
- **Lint-then-retest cycle.** If lint auto-fix modifies
  files, tests re-run to catch regressions. The full
  quality gate is: test -> lint -> retest (if lint
  modified files).
- **Bug directory naming.** `bugs<N>` incrementing from
  the highest existing number. Each bugfix run gets full
  `.conductor/` state like a feature run.
- **Slug fallback.** If the slug LLM returns garbage,
  `feature-<N>` is used. Garbage is defined as: no match
  for `/^[a-z0-9]+(-[a-z0-9]+)*$/`.
- **Refer to** `agent-conduct` skill for bash security
  rules. Implementor and reviewer skills enforce the same
  constraints as the existing prompt-based workflow.
