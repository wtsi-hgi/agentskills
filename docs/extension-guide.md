# Copilot Conductor

Deterministic orchestration for AI coding workflows in VS Code.

## What It Does

Copilot Conductor automates the implement → test → review cycle that AI coding
agents normally require manual prompting to follow. You point it at a spec with
phase plans, and it drives the entire process: selecting the right LLM model for
each role, running tools, enforcing test gates, and persisting full audit trails.

Instead of shepherding an AI agent through "implement this", "now run tests",
"review these changes", "the tests failed, try again" — Conductor does it all
automatically. It reads phase files, invokes the right skills for your tech
stack, and only marks items as done after tests pass review twice in a row.

## Why Use It

- **Reliable execution.** A code-driven state machine replaces fragile prompt
  chains. Every step is deterministic and repeatable.
- **Pause and resume.** Walk away mid-run. Conductor saves state to
  `.conductor/state.json` and picks up where it left off — even after a VS Code
  restart or crash.
- **Multi-model support.** Assign different Copilot models to different roles
  (implementor, reviewer, spec-writer). Use a fast model for implementation and
  a reasoning model for review.
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

Conductor needs two things in your project:

1. **A spec file** at `.docs/conductor/spec.md` (configurable) describing the
   feature with acceptance tests.
2. **Phase files** (e.g. `.docs/conductor/phase1.md`, `phase2.md`) listing the
   implementation items with checkboxes.

Use the [spec-writer skill](skills.md) to generate these from a feature
description, or write them by hand.

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
| `conductor.models.specWriter` | *(auto)* | Model for spec writing. |
| `conductor.server.port` | `8484` | HTTP/WebSocket server port. |
| `conductor.server.authToken` | *(empty)* | Bearer token for server authentication. |

You **must** set `conductor.conventionsSkill` to match your project's tech
stack. The extension derives the implementor and reviewer skill names from it
(e.g. `go-conventions` → `go-implementor` + `go-reviewer`).

### Run

1. Open the Command Palette.
2. Run **Conductor: Start**.

The extension will:

- Parse your phase files.
- For each item: invoke an implementor LLM with the right skills and tools,
  run your test command, then invoke a reviewer LLM.
- Require 2 consecutive PASS reviews before marking an item done.
- Show progress in the **Conductor** sidebar (activity bar icon).

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
- Audit log with filtering by role and status
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
| spec-writer skill | Can still be used manually to create the initial spec |
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
