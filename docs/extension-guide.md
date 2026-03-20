# Copilot Conductor

Deterministic orchestration for AI coding workflows in VS Code.

## What It Does

Copilot Conductor automates the full journey from a feature prompt to working
code: writing the spec, creating phase plans, driving the
implement → test → lint → review cycle, running PR reviews, and committing
results — all without manual prompting. Type a feature description inline (or
point it at an existing spec with phase plans) and it handles the rest:
auto-detecting your conventions skill, extracting test/lint commands, selecting
the right LLM model for each role, running tools, enforcing quality gates, and
persisting full audit trails.

Instead of shepherding an AI agent through "write the spec", "review it",
"implement this", "now run tests", "review these changes", "the tests failed,
try again" — Conductor does it all automatically. It also supports a dedicated
bugfix workflow via **Conductor: Fix Bugs**.

## Why Use It

- **Reliable execution.** A code-driven state machine replaces fragile prompt
  chains. Every step is deterministic and repeatable.
- **Pause, resume, and crash recovery.** Walk away mid-run. Conductor saves
  state to `.conductor/state.json` and picks up where it left off — even after
  a VS Code restart or crash. On activation, it scans for interrupted runs and
  offers to resume or abandon them.
- **Multi-model support.** Assign different Copilot models to different roles
  (implementor, reviewer, pr-reviewer, spec-author, spec-reviewer,
  spec-proofreader, phase-creator, phase-reviewer). Use a fast model for
  implementation and a reasoning model for review.
- **Inline prompt entry.** Start a new feature or bugfix directly from the
  Command Palette — no need to create files manually. Conductor derives a
  directory name, writes `prompt.md`, and proceeds.
- **Conventions auto-detection.** Conductor guesses the right conventions skill
  (e.g. `go-conventions`, `python-conventions`) from your project's file
  extensions and build files, then extracts test and lint commands
  automatically.
- **Automated spec writing.** Place a `prompt.md` in your feature directory and
  Conductor handles the entire spec-writing pipeline before implementation:
  requirements clarification, spec authoring, review, proofreading, and phase
  plan creation.
- **Quality gates.** Implementation items must pass tests, then lint (re-running
  tests if lint modifies files), then 2 consecutive reviewer PASSes before
  being marked done.
- **PR review.** After all phases complete, Conductor runs a two-step PR
  review: a spec-aware review comparing the diff to `spec.md`, then a spec-free
  general quality review. Each step requires 2 consecutive PASSes.
- **Bugfix workflow.** **Conductor: Fix Bugs** parses a bug description into
  individual issues, then runs a fix → review → approve → commit cycle for
  each bug with human approval gates.
- **Branch safety.** Conductor refuses to run on `main`, `master`, or the
  remote default branch, protecting production branches from accidental commits.
- **Git automation.** Conductor commits and pushes after each phase, after
  spec-writing, and after state changes — keeping the remote branch up to date.
- **Copilot re-review.** After a run completes, trigger GitHub Copilot code
  review via the `gh` CLI and automatically fix any findings.
- **Full audit trail.** Every LLM invocation is logged with token counts,
  timing, pass/fail results, and complete message transcripts in `.conductor/`.
- **Team visibility.** An embedded HTTP/WebSocket server lets teammates monitor
  progress, approve changes, and add notes from any browser — no VS Code
  required.
- **Approval workflows.** Require human approval before the run proceeds past
  each item.
- **Safety net.** Files deleted by the LLM are moved to `.trash/` instead of
  being permanently removed, and cleaned up only after all phases complete.

## Getting Started

### Prerequisites

- VS Code 1.90 or later
- GitHub Copilot extension (provides the `vscode.lm` Language Model API)
- Agent skills installed at `~/.agents/skills/` (see the
  [skills documentation](skills.md))

### Install the Extension

Install the `.vsix` file:

1. Open VS Code.
2. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`).
3. Run **Extensions: Install from VSIX…**
4. Select the `copilot-conductor-*.vsix` file.

### Prepare Your Project

The quickest way to start is to run **Conductor: Start** from the Command
Palette and type your feature description inline. Conductor creates a feature
directory under `conductor.docsDir` (default `.docs/`) with a `prompt.md` and
proceeds automatically.

Alternatively, you can prepare files in advance in a feature directory (e.g.
`.docs/conductor/`):

**Option A — start from a prompt (spec-writing + implementation):**

- A `prompt.md` file describing the feature you want to build. Conductor will
  run the full spec-writing pipeline first (clarification, authoring, review,
  proofreading, phase plan creation) and then proceed to implementation.

**Option B — start from an existing spec (implementation only):**

- A `spec.md` describing the feature with acceptance tests.
- Phase files (e.g. `phase1.md`, `phase2.md`) listing the implementation items
  with checkboxes.

Use the [spec-writer skill](skills.md) to generate Option B from a feature
description manually, or write the files by hand.

**Important:** Conductor refuses to run on `main`, `master`, or the remote
default branch. Create a feature branch before starting.

### Configure

Open VS Code settings and search for "Conductor". Key settings:

| Setting | Default | Description |
|---|---|---|
| `conductor.docsDir` | `.docs/` | Root directory for Conductor feature folders. |
| `conductor.skillsDir` | `~/.agents/skills/` | Path to agentskills.io skills. |
| `conductor.maxTurns` | `50` | Maximum tool-call turns per LLM invocation. |
| `conductor.maxRetries` | `3` | Max retries on failure before moving on. |
| `conductor.requireApproval` | `false` | Pause for human approval after each item. |
| `conductor.models.implementor` | *(auto)* | Model for implementation (`{ vendor, family }`). |
| `conductor.models.reviewer` | *(auto)* | Model for review. |
| `conductor.models.prReviewer` | *(auto)* | Model for PR review. |
| `conductor.models.specAuthor` | *(auto)* | Model for authoring the spec. |
| `conductor.models.specReviewer` | *(auto)* | Model for reviewing the spec. |
| `conductor.models.specProofreader` | *(auto)* | Model for proofreading the spec. |
| `conductor.models.phaseCreator` | *(auto)* | Model for creating phase plan files. |
| `conductor.models.phaseReviewer` | *(auto)* | Model for reviewing phase plan files. |
| `conductor.server.port` | `8484` | HTTP/WebSocket server port. |
| `conductor.server.authToken` | *(empty)* | Bearer token for server authentication. |

Conductor auto-detects the conventions skill for your tech stack on each new run
(you can override the guess via quick-pick). The selected skill, plus the
extracted test and lint commands, are stored per feature in
`.conductor/state.json` rather than as workspace-wide settings. You can override
the test and lint commands at any time from the dashboard.

### Run

1. Open the Command Palette.
2. Run **Conductor: Start**.
3. Type your feature description (or press Escape to select an existing feature
   directory).
4. Confirm the conventions skill and feature directory name.

Conductor auto-detects what to do based on the files present in the feature
directory:

- **`prompt.md` found, no `spec.md`** — runs the spec-writing pipeline first:
  1. **Clarifying** — asks the LLM for clarification questions; you answer them
     in the dashboard and the answers are appended to `prompt.md`.
  2. **Authoring** — spec-author writes `spec.md` from the prompt.
  3. **Reviewing** — spec-reviewer checks the spec (2-consecutive-PASS gate).
  4. **Proofreading** — spec-proofreader checks for text quality (2-PASS gate).
  5. **Creating phases** — phase-creator generates the phase plan files.
  6. **Reviewing phases** — phase-reviewer checks the phase plans (1-PASS gate).
  Then commits the spec and phase files and continues to implementation.
- **`spec.md` found** — skips spec-writing and goes straight to implementation.
- **Neither found** — shows an error.

During implementation, for each item Conductor:

- Invokes an implementor LLM with the right skills and tools.
- Runs your test command.
- Runs your lint command; if lint modifies files, re-runs tests.
- Invokes a reviewer LLM.
- Requires 2 consecutive PASS reviews before marking an item done.
- Commits and pushes after each completed phase.
- Shows progress in the **Conductor** sidebar (activity bar icon).

After all phases complete, Conductor runs a **PR review** in two steps:

1. **Spec-aware review** — compares the branch diff to `spec.md`
   (2-consecutive-PASS gate).
2. **Spec-free review** — general code quality review
   (2-consecutive-PASS gate).

Findings are fixed automatically by dispatching implementor calls, running
tests/lint, and committing. If `requireApproval` is set, Conductor pauses for
human approval after both PR review steps pass.

### Monitor Progress

**Sidebar:** The Conductor activity bar icon shows a tree of phases and items
with status indicators:

- ○ pending
- ◉ in-progress
- ✓ pass
- ✗ fail
- 👁 pending-approval

**Dashboard:** Run **Conductor: Dashboard** to open a rich webview with:

- Real-time status and token metrics
- Current spec-writing step and consecutive-pass counter (shown during spec-writing pipeline)
- Clarification Q&A form (shown when the LLM has generated questions requiring your answers)
- Bugfix status (current bug number, fix-review cycle, approval status)
- PR review status (current step, consecutive passes)
- Audit log with filtering by role (including spec-writing roles) and status
- Expandable LLM transcripts
- Inline prompt entry for starting new features or bugfixes
- Test/lint command override fields
- Conventions skill selector
- Controls: pause, resume, skip, retry, approve, reject, abandon, change model,
  Copilot Re-Review

**Team server:** When a run is active, an HTTP server starts on the configured
port. Open `http://localhost:8484` in any browser to access the team dashboard
with approval queues, multi-user notes, and live WebSocket updates. Set
`conductor.server.authToken` to secure it.

### Commands

| Command | Description |
|---|---|
| **Conductor: Start** | Begin a new feature run. Accepts an inline prompt or selects an existing feature directory. |
| **Conductor: Fix Bugs** | Start a bugfix run. Accepts an inline prompt or selects an existing bugfix directory. |
| **Conductor: Pause** | Pause the current run (safe to close VS Code). |
| **Conductor: Resume** | Resume a paused run. |
| **Conductor: Abandon Run** | Mark the current run as abandoned, freeing the extension for a new run. |
| **Conductor: Status** | Show current phase, item, and status. |
| **Conductor: Dashboard** | Open the webview dashboard. |

### Bugfix Workflow

1. Open the Command Palette.
2. Run **Conductor: Fix Bugs**.
3. Describe the bug(s) inline, or select an existing bugfix directory.

Conductor parses your description into individual bug issues and processes each
one sequentially:

1. **Fixing** — implementor creates a regression test and fix.
2. **Reviewing** — reviewer verifies the fix (up to 5 fix-review cycles).
3. **Approving** — pauses for human approval.
4. **Committing** — commits and pushes the fix.

Bugfix progress is shown in both the VS Code dashboard and the team server.

### Copilot Re-Review

After a run completes (or at any time from the dashboard), click the **Copilot
Re-Review** button to trigger a GitHub Copilot code review loop:

1. Pushes the current branch.
2. Requests a Copilot re-review via the `gh` CLI.
3. Polls for the review result.
4. Fetches unresolved comments and dispatches implementor fixes.
5. Commits and repeats until clean or 20 cycles elapse.

Requires the [GitHub CLI](https://cli.github.com/) (`gh`) with the Copilot
extension installed.

## How Skills Are Used

Conductor reads skills from the `skillsDir` directory. For each LLM invocation,
it loads:

1. The **conventions skill** (auto-detected or chosen at run start, e.g.
   `go-conventions`) — coding standards, testing patterns, and commands for
   your stack.
2. The **role skill** derived from conventions (e.g. `go-implementor` for the
   implementor role, `go-reviewer` for the reviewer role, `pr-reviewer` for PR
   review).

Conductor replaces the workflow skills that would otherwise need manual
prompting:

| Manual workflow | Conductor equivalent |
|---|---|
| orchestrator skill | State machine in `src/orchestrator/machine.ts` |
| spec-writer skill | Built-in spec-writing pipeline (clarifying → authoring → reviewing → proofreading → creating-phases → reviewing-phases) triggered when `prompt.md` is present |
| pr-reviewer skill | Built-in PR review cycle (spec-aware + spec-free steps, 2-consecutive-PASS gate each) |
| bugfix skill | Built-in bugfix workflow (fix → review → approve → commit per bug) |

You still need the **conventions** and **implementor/reviewer** skills for your
tech stack installed in `skillsDir`.

## State and Artifacts

Each feature has its own `.conductor/` directory inside the feature folder (e.g.
`.docs/my-feature/.conductor/`). State is self-contained with the conventions
skill, test command, and lint command stored alongside run progress:

| File | Purpose |
|---|---|
| `state.json` | Current run state (phase, item, statuses, conventions skill, test/lint commands, bug tracking, PR review progress). |
| `audit.md` | Markdown table of every LLM invocation with results and token counts. |
| `addendum.md` | Deviations noted by reviewers with rationale. |
| `runs/<timestamp>/<role>-<item>.json` | Full message transcripts per invocation. |

These files are committed and pushed automatically at checkpoints (phase
completion, spec-writing, bugfix commits, PR review passes). They are
human-readable and safe to share for team visibility.

Files deleted by the LLM during implementation are moved to `.trash/` in the
repo root (preserving relative paths) and cleaned up after all phases complete.
