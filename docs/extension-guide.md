# Copilot Conductor

Deterministic orchestration for AI coding workflows in VS Code.

## What It Does

Copilot Conductor automates the full journey from a feature prompt to working
code: writing the spec, creating phase plans, and driving the
implement → test → review cycle — all without manual prompting. You point it at
a `prompt.md` (or an existing spec with phase plans), and it handles the rest:
selecting the right LLM model for each role, running tools, enforcing test
gates, and persisting full audit trails.

Instead of shepherding an AI agent through "write the spec", "review it",
"implement this", "now run tests", "review these changes", "the tests failed,
try again" — Conductor does it all automatically.

## Why Use It

- **Reliable execution.** A code-driven state machine replaces fragile prompt
  chains. Every step is deterministic and repeatable.
- **Pause and resume.** Walk away mid-run. Conductor saves state to
  `.conductor/state.json` and picks up where it left off — even after a VS Code
  restart or crash.
- **Multi-model support.** Assign different Copilot models to different roles
  (implementor, reviewer, spec-author, spec-reviewer, spec-proofreader,
  phase-creator, phase-reviewer). Use a fast model for implementation and a
  reasoning model for review.
- **Automated spec writing.** Place a `prompt.md` in your spec directory and
  Conductor handles the entire spec-writing pipeline before implementation:
  requirements clarification, spec authoring, review, proofreading, and phase
  plan creation.
- **2-consecutive-PASS gate.** Reviews must pass twice in a row before an item
  is marked done. A single failure resets the counter, preventing lucky passes.
- **Full audit trail.** Every LLM invocation is logged with token counts,
  timing, pass/fail results, and complete message transcripts in `.conductor/`.
- **Team visibility.** An embedded HTTP/WebSocket server lets teammates monitor
  progress, approve changes, and add notes from any browser — no VS Code
  required.
- **Approval workflows.** Require human approval before the run proceeds past
  each item.

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

Conductor needs one of the following in your project's spec directory (`.docs/conductor/` by default):

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

### Configure

Open VS Code settings and search for "Conductor". Key settings:

| Setting | Default | Description |
|---|---|---|
| `conductor.specDir` | `.docs/conductor` | Path to the spec and phase files. |
| `conductor.skillsDir` | `~/.agents/skills/` | Path to agentskills.io skills. |
| `conductor.conventionsSkill` | *(empty)* | Conventions skill for your stack (e.g. `go-conventions`, `python-conventions`). |
| `conductor.testCommand` | `npm test` | Command to run tests. |
| `conductor.maxTurns` | `50` | Maximum tool-call turns per LLM invocation. |
| `conductor.maxRetries` | `3` | Max retries on failure before moving on. |
| `conductor.requireApproval` | `false` | Pause for human approval after each item. |
| `conductor.models.implementor` | *(auto)* | Model for implementation (`{ vendor, family }`). |
| `conductor.models.reviewer` | *(auto)* | Model for review. |
| `conductor.models.specAuthor` | *(auto)* | Model for authoring the spec. |
| `conductor.models.specReviewer` | *(auto)* | Model for reviewing the spec. |
| `conductor.models.specProofreader` | *(auto)* | Model for proofreading the spec. |
| `conductor.models.phaseCreator` | *(auto)* | Model for creating phase plan files. |
| `conductor.models.phaseReviewer` | *(auto)* | Model for reviewing phase plan files. |
| `conductor.server.port` | `8484` | HTTP/WebSocket server port. |
| `conductor.server.authToken` | *(empty)* | Bearer token for server authentication. |

You **must** set `conductor.conventionsSkill` to match your project's tech
stack. The extension derives the implementor and reviewer skill names from it
(e.g. `go-conventions` → `go-implementor` + `go-reviewer`).

### Run

1. Open the Command Palette.
2. Run **Conductor: Start**.

Conductor auto-detects what to do based on the files present in `specDir`:

- **`prompt.md` found, no `spec.md`** — runs the spec-writing pipeline first:
  1. **Clarifying** — asks the LLM for clarification questions; you answer them
     in the dashboard and the answers are appended to `prompt.md`.
  2. **Authoring** — spec-author writes `spec.md` from the prompt.
  3. **Reviewing** — spec-reviewer checks the spec (2-consecutive-PASS gate).
  4. **Proofreading** — spec-proofreader checks for text quality (2-PASS gate).
  5. **Creating phases** — phase-creator generates the phase plan files.
  6. **Reviewing phases** — phase-reviewer checks the phase plans (1-PASS gate).
  Then continues to implementation automatically.
- **`spec.md` found** — skips spec-writing and goes straight to implementation.
- **Neither found** — shows an error.

During implementation, for each item Conductor:

- Invokes an implementor LLM with the right skills and tools.
- Runs your test command.
- Invokes a reviewer LLM.
- Requires 2 consecutive PASS reviews before marking an item done.
- Shows progress in the **Conductor** sidebar (activity bar icon).

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
- Audit log with filtering by role (including spec-writing roles) and status
- Expandable LLM transcripts
- Controls: pause, resume, skip, retry, approve, reject, change model

**Team server:** When a run is active, an HTTP server starts on the configured
port. Open `http://localhost:8484` in any browser to access the team dashboard
with approval queues, multi-user notes, and live WebSocket updates. Set
`conductor.server.authToken` to secure it.

### Commands

| Command | Description |
|---|---|
| **Conductor: Start** | Begin a new run from phase 1. |
| **Conductor: Pause** | Pause the current run (safe to close VS Code). |
| **Conductor: Resume** | Resume a paused run. |
| **Conductor: Status** | Show current phase, item, and status. |
| **Conductor: Dashboard** | Open the webview dashboard. |

## How Skills Are Used

Conductor reads skills from the `skillsDir` directory. For each LLM invocation,
it loads:

1. The **conventions skill** you configured (e.g. `go-conventions`) — coding
   standards, testing patterns, and commands for your stack.
2. The **role skill** derived from conventions (e.g. `go-implementor` for the
   implementor role, `go-reviewer` for the reviewer role).

Conductor replaces the workflow skills that would otherwise need manual
prompting:

| Manual workflow | Conductor equivalent |
|---|---|
| orchestrator skill | State machine in `src/orchestrator/machine.ts` |
| spec-writer skill | Built-in spec-writing pipeline (clarifying → authoring → reviewing → proofreading → creating-phases → reviewing-phases) triggered when `prompt.md` is present |
| pr-reviewer skill | Built-in review cycle with 2-consecutive-PASS gate |

You still need the **conventions** and **implementor/reviewer** skills for your
tech stack installed in `skillsDir`.

## State and Artifacts

All state lives in `.conductor/` in your project root:

| File | Purpose |
|---|---|
| `state.json` | Current run state (phase, item, statuses). |
| `audit.md` | Markdown table of every LLM invocation with results and token counts. |
| `addendum.md` | Deviations noted by reviewers with rationale. |
| `runs/<timestamp>/<role>-<item>.json` | Full message transcripts per invocation. |

These files are human-readable and safe to commit for team visibility.
