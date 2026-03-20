# Phase 5: Bugfix, PR Review, Config, Git, and Gaps

Ref: [addendum2.md](addendum2.md) sections K1, K2, K3,
L1, L2, L3, M1, M2, M3, N1, N2, O1, O2, O3, O4, P1, P2,
Q1, Q2, R1, R2, R3, R4, G1/H2 updates

## Instructions

Use the `orchestrator` skill to complete this phase,
coordinating subagents with the `implementor` and
`reviewer` skills.

## Items

### Item 5.1: R1 - Remove Global Config Settings

addendum2.md section: R1

Remove `conductor.specDir`, `conductor.conventionsSkill`,
and `conductor.testCommand` from `package.json`. Add
`conductor.docsDir` (string, default `".docs/"`). Drop
`specDir`, `conventionsSkill`, `testCommand` from
`OrchestratorConfig`; add `docsDir`. Add
`conventionsSkill`, `testCommand`, `lintCommand` fields to
`OrchestratorState` in `src/types.ts`. Update
`src/extension.ts` to read the new config shape. Must come
first so subsequent items build on clean types. Covering
all 4 acceptance tests from R1.

- [ ] implemented
- [ ] reviewed

### Item 5.2: P1 - Trusted Execution Path

addendum2.md section: P1

Add `executeTrusted` function in `src/tools/bash.ts` that
executes commands via `/bin/bash -lc` with timeout and cwd
constraints but without `DANGEROUS_SHELL_SYNTAX_PATTERNS`,
`SUDO_PATTERN`, `GIT_PUSH_PATTERN`, or
`INTERACTIVE_COMMAND_PATTERN` validation. Only callable
from extension code, never exposed as an LLM tool. The
existing `executeBash` remains unchanged. Depends on
item 5.1 (R1) for the `lintCommand` field. Covering all 6
acceptance tests from P1.

- [ ] implemented
- [ ] reviewed

### Item 5.3: O1 - Branch Safety Check

addendum2.md section: O1

Add `checkBranchSafety` function in
`src/orchestrator/machine.ts` that gets the current branch
via `git rev-parse --abbrev-ref HEAD` and the default
branch via `git remote show origin`, refusing to proceed
if on `main`, `master`, or the default branch. Hard gate
at run start. Depends on item 5.2 (P1) for trusted
execution. Covering all 6 acceptance tests from O1.

- [ ] implemented
- [ ] reviewed

### Item 5.4: Q1 - Lint Command Extraction

addendum2.md section: Q1

Add `parseCommandExtraction` function in
`src/orchestrator/machine.ts` that uses a quick LLM call
(spec-author model, no tools) to extract `testCommand` and
`lintCommand` from the conventions skill text. Store
results in `OrchestratorState`. Support user override via
`override-commands` message. Depends on item 5.2 (P1) for
trusted execution. Covering all 4 acceptance tests from
Q1.

- [ ] implemented
- [ ] reviewed

### Item 5.5: Q2 - Lint Step in Quality Gate

addendum2.md section: Q2

Integrate lint execution into the implement cycle in
`src/orchestrator/machine.ts`: after tests pass, run
`lintCommand` via trusted execution; if lint modifies
files re-run tests; if lint fails feed output back to
implementor as retry feedback. Full cycle: test -> lint ->
retest if lint modified files. Depends on items 5.4 (Q1)
and 5.2 (P1). Covering all 6 acceptance tests from Q2.

- [ ] implemented
- [ ] reviewed

### Item 5.6: R2 - Conventions Skill Auto-Detection

addendum2.md section: R2

On new run start, use a quick LLM call (spec-author model,
no tools) to guess the conventions skill from project file
extensions, build files, and lock files. Present guess as
default in a quick-pick of available `*-conventions` skills
from `skillsDir`. Store chosen skill in
`state.conventionsSkill`. Implement in `src/extension.ts`
and `src/orchestrator/machine.ts`. Depends on item 5.1
(R1). Covering all 5 acceptance tests from R2.

- [ ] implemented
- [ ] reviewed

### Item 5.7: K1 - Inline Prompt Entry for Features

addendum2.md section: K1

When `Conductor: Start` invoked with an inline prompt,
derive a kebab-case slug via quick LLM call, present slug
for user override, create `<docsDir>/<slug>/` directory
(appending `-2`, `-3` if exists), write `prompt.md`, and
proceed with spec-writing. Fallback to `feature-<N>` if
slug is garbage. Add `deriveFeatureSlug` function.
Implement in `src/extension.ts` and
`src/orchestrator/machine.ts`. Depends on items 5.1 (R1)
and 5.6 (R2). Covering all 7 acceptance tests from K1.

- [ ] implemented
- [ ] reviewed

### Item 5.8: K2 - Inline Prompt Entry for Bugfixes

addendum2.md section: K2

When `Conductor: Fix Bugs` invoked with inline prompt,
create `<docsDir>/bugs<N>/` directory (next unused
increment after highest existing), write `prompt.md`,
initialise `.conductor/state.json` with
`status: "running"`. If existing bugfix directory with
`prompt.md` selected, start from that directory.
Implement in `src/extension.ts`. Depends on item 5.7
(K1). Covering all 5 acceptance tests from K2.

- [ ] implemented
- [ ] reviewed

### Item 5.9: K3 - VS Code Input for Inline Prompts

addendum2.md section: K3

For `Conductor: Start` and `Conductor: Fix Bugs`, open a
temporary untitled document for multi-line prompt editing
when invoked from the command palette. Short single-line
prompts use a standard VS Code input box. Capture prompt
on document close/confirm. Implement in `src/extension.ts`.
Depends on item 5.7 (K1). Covering all 3 acceptance tests
from K3.

- [ ] implemented
- [ ] reviewed

### Item 5.10: M3 - PR Reviewer Skill Loading

addendum2.md section: M3

Update `deriveRoleSkillName` in `src/llm/prompts.ts` to
return `"pr-reviewer"` for role `"pr-reviewer"` (no
conventions prefix). Update `assembleSystemPrompt` to load
the pr-reviewer skill, tool definitions, and wire format
without loading the conventions skill. Depends on item 5.1
(R1). Covering all 3 acceptance tests from M3.

- [ ] implemented
- [ ] reviewed

### Item 5.11: M2 - PR Reviewer Model Config

addendum2.md section: M2

Add `conductor.models.prReviewer` setting in
`package.json`. Update `getModelAssignments` in
`src/extension.ts` to include
`{role: "pr-reviewer", ...}`. Update `selectModelForRole`
in `src/llm/select.ts` to handle `"pr-reviewer"`. Depends
on item 5.10 (M3). Covering all 2 acceptance tests from
M2.

- [ ] implemented
- [ ] reviewed

### Item 5.12: M1 - PR Review State Machine

addendum2.md section: M1

After all phase items pass review, enter PR review in
`src/orchestrator/machine.ts`: spec-aware step invokes
pr-reviewer with spec path and branch diff, requires 2
consecutive passes to advance; spec-free step reviews
without spec, requires 2 consecutive passes. Findings
dispatch implementor per finding, run tests/lint, commit,
push. If cycles exceed `maxRetries`, set status to error.
If `requireApproval`, pause for human approval after both
steps. Depends on items 5.11 (M2), 5.10 (M3), 5.5 (Q2),
5.3 (O1), and 5.2 (P1). Covering all 12 acceptance tests
from M1.

- [ ] implemented
- [ ] reviewed

### Item 5.13: O2 - Per-Phase Commit and Push

addendum2.md section: O2

After all items in a phase pass review, `git add` changed
files, `git commit -m "Implement phase <N>"`, and
`git push` via trusted execution in
`src/orchestrator/machine.ts`. Push failure is non-fatal
(logged in audit). Depends on items 5.2 (P1) and 5.3
(O1). Covering all 4 acceptance tests from O2.

- [ ] implemented
- [ ] reviewed

### Item 5.14: O3 - State File Commit and Push

addendum2.md section: O3

After phase completion, spec-writing step completion,
bugfix commit, and PR review pass, commit `.conductor/`
files with message `"conductor: update state"` and push
via trusted execution. One commit per checkpoint, not per
audit entry. Implement in `src/orchestrator/machine.ts`.
Depends on item 5.13 (O2). Covering all 4 acceptance
tests from O3.

- [ ] implemented
- [ ] reviewed

### Item 5.15: O4 - Spec-Writing Commit

addendum2.md section: O4

After `specStep` transitions to `"done"`, `git add`
`spec.md` and `phase*.md` in `specDir`, commit with
message `"conductor: write spec"`, and push. Implement in
`src/orchestrator/machine.ts`. Depends on item 5.13 (O2).
Covering all 2 acceptance tests from O4.

- [ ] implemented
- [ ] reviewed

### Item 5.16: L1 - Bug Description Parsing

addendum2.md section: L1

Add `parseBugDescription` function in
`src/orchestrator/machine.ts` that uses a quick LLM call
(spec-author model, no tools) to split bug text into a
JSON array of `BugIssue` objects. Fallback: treat entire
prompt as single bug with title "Bug fix" if JSON is
invalid or empty. Handle fenced code blocks. Depends on
item 5.1 (R1). Covering all 4 acceptance tests from L1.

- [ ] implemented
- [ ] reviewed

### Item 5.17: L2 - Bugfix State Machine

addendum2.md section: L2

Implement per-bug fix-review-approve-commit cycle in
`src/orchestrator/machine.ts`: fixing step invokes
implementor with regression test instruction; reviewing
step invokes reviewer (max 5 fix-review cycles);
approving step always pauses for human approval; committing
step does git add, commit (max 72 chars), and push. Track
`bugStep`, `bugIndex`, `bugFixCycle`. Send
`bugfix-status` messages to dashboard. Depends on items
5.16 (L1), 5.5 (Q2), 5.2 (P1), and 5.3 (O1). Covering
all 10 acceptance tests from L2.

- [ ] implemented
- [ ] reviewed

### Item 5.18: L3 - Fix Bugs Command

addendum2.md section: L3

Register `conductor.fixBugs` command in
`src/extension.ts`. Accepts inline prompt or existing
bugfix directory. Creates bug directory per K2 if inline.
Prevents concurrent runs with error message. Initialises
`state.json` with `bugStep: "fixing"` and `bugIndex: 0`.
Depends on items 5.17 (L2) and 5.8 (K2). Covering all 3
acceptance tests from L3.

- [ ] implemented
- [ ] reviewed

### Item 5.19: N1 - Copilot Re-Review Command

addendum2.md section: N1

Implement `startCopilotReReview` on the `Orchestrator`
interface in `src/orchestrator/machine.ts`. Loop: push,
poll remote HEAD match (5-min timeout), request Copilot
re-review via `gh` CLI, poll for new review (20-min
timeout), fetch unresolved comments, dispatch implementor
per finding, commit fixes, repeat. Holistic refactor
prompt at cycle 3+. Stop after 20 cycles. Independent of
main pipeline. Depends on items 5.2 (P1) and 5.12 (M1).
Covering all 9 acceptance tests from N1.

- [ ] implemented
- [ ] reviewed

### Item 5.20: N2 - Re-Review Dashboard/Server Button

addendum2.md section: N2

Add "Copilot Re-Review" button to
`src/webview/dashboard.html` and
`src/server/app/index.html`. Button sends
`{type: "copilot-rereview"}` message. Handle in
`src/webview/panel.ts` and `src/server/ws.ts` by calling
`orchestrator.startCopilotReReview()`. Depends on item
5.19 (N1). Covering all 2 acceptance tests from N2.

- [ ] implemented
- [ ] reviewed

### Item 5.21: R3 - Abandon Command

addendum2.md section: R3

Register `conductor.abandon` command in
`src/extension.ts`. Sets `status` to `"abandoned"` in
`state.json`, leaves files in place, frees the extension
to start a new run. Show info message if no active run.
Depends on item 5.1 (R1). Covering all 3 acceptance tests
from R3.

- [ ] implemented
- [ ] reviewed

### Item 5.22: R4 - Crash Recovery with Per-Feature State

addendum2.md section: R4

On extension activation, scan `docsDir` for directories
containing `.conductor/state.json` with `status` of
`"running"` or `"paused"`. Prompt user to resume or
abandon. Per-feature state is self-contained with
`conventionsSkill` and `testCommand` in `state.json`.
Implement in `src/extension.ts`. Depends on item 5.1 (R1).
Covering all 5 acceptance tests from R4.

- [ ] implemented
- [ ] reviewed

### Item 5.23: P2 - File Trash Safety Net

addendum2.md section: P2

In `src/tools/dispatch.ts`, when a file the LLM wrote is
explicitly deleted by a subsequent tool call, move it to
`.trash/` in the repo root preserving the relative path.
Clean up `.trash/` after all phases complete. No action
for files emptied but not deleted. Depends on item 5.2
(P1). Covering all 4 acceptance tests from P2.

- [ ] implemented
- [ ] reviewed

### Item 5.24: G1/H2 updates - Dashboard and Server Updates

addendum2.md sections: G1 update, H2 update

Add to `src/webview/dashboard.html` and
`src/server/app/index.html`: bugfix status section
(current bug number, fix-review cycle, approval status),
PR review status section (current step, consecutive
passes), "Copilot Re-Review" button, "Abandon" button,
inline prompt text area with "Start" / "Fix Bugs" buttons,
command override fields for `testCommand` and
`lintCommand`, conventions skill selector. Handle new
message types in `src/webview/panel.ts` and
`src/server/ws.ts`. No new acceptance tests -- existing
G1/H2 tests cover rendering and control paths. Depends on
all prior items.

- [ ] implemented
- [ ] reviewed
