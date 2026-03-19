# Copilot Conductor - Feature Description

Build a VS Code extension (`wtsi-hgi.copilot-conductor`) that
deterministically orchestrates multi-model AI coding workflows using
the `vscode.lm` Language Model API. It replaces prompt-dependent
orchestration with code-driven state machines, ensuring every step
(implement, review, retry) executes perfectly every time.

## Motivation

The skills in this repo (orchestrator, spec-writer, go-implementor,
go-reviewer, etc.) define multi-step workflows with strict sequencing:
implement then review, 2 consecutive PASS reviews required, phase
checkboxes, etc. Currently these run as prompt instructions that agents
may skip or misinterpret. The extension enforces them as deterministic
TypeScript code.

## Core Concept

The extension is the orchestrator. It reads phase files and spec.md,
selects models per role via `vscode.lm.selectChatModels()`, executes a
tool loop (Read, Edit, Bash, Grep, Glob), and enforces the
implement-review-retry cycle as a code loop - not a prompt hope.

Users choose which model to use for each role (e.g. GPT-5.4 for
implementing, Opus 4.6 for spec writing, Sonnet for reviewing). This
runs under a single Copilot subscription - no API keys needed.

## Tool Execution Loop

The extension implements its own tool execution loop since the
`vscode.lm` API provides text completions only:

- Define tools as JSON schema injected into system prompts.
- Model responds with structured tool calls.
- Extension dispatches: Read -> fs.readFile, Edit -> apply diff,
  Write -> fs.writeFile, Bash -> child_process.exec, Grep -> ripgrep,
  Glob -> fast-glob.
- Feed results back to model.
- Repeat until model signals done or max turns exceeded.

## Orchestration State Machine

The extension parses phase files (phase1.md, phase2.md, ...) from
a spec's Implementation Order. For each unchecked item:

1. Invoke the configured implementor model with the item's spec
   section and skill prompt.
2. Parse result, verify tests pass via Bash tool.
3. Invoke the configured reviewer model with the implementation diff
   and skill prompt.
4. If FAIL: loop back to step 1 with reviewer feedback.
5. If PASS: tick the checkbox, write audit entry, proceed.
6. For parallel batches: launch items concurrently where possible.

Review cycles require 2 consecutive PASS verdicts (matching the
existing skill workflows).

## Skill/Prompt Loading

The extension reads SKILL.md files from the skills directory
(configurable, defaults to ~/.agents/skills/) and injects their
content as system prompts for the appropriate role. The conventions
skill is always included alongside role-specific skills.

## State Persistence

All state is written to files in the project repo:

- `.conductor/state.json` - current phase, item index, status,
  consecutive pass counts, model assignments per role.
- `.conductor/audit.md` - timestamped log of every LLM invocation:
  role, model, item, prompt summary, result (PASS/FAIL/error),
  token usage, duration.
- `.conductor/addendum.md` - spec deviations: when an implementation
  diverges from the spec (reviewer notes differences), record them
  here with rationale.
- `.conductor/runs/<timestamp>/` - per-run transcripts: full
  request/response JSON for each LLM invocation.

## Phase 1: Core Extension + Git-Based Team Visibility

### Extension Scaffolding
- VS Code extension with `package.json`, activation events,
  commands: "Conductor: Start", "Conductor: Pause", "Conductor:
  Resume", "Conductor: Status".
- Configuration settings: model per role (implementor, reviewer,
  spec-writer), skills directory path, max turns per invocation,
  max retries per item.

### Tool Execution Loop
- Tool definitions (Read, Edit, Write, Bash, Grep, Glob) as JSON
  schema.
- Tool dispatch engine: parse model tool-call responses, execute
  tools, return results.
- Security: Bash commands restricted to project directory. No sudo,
  no interactive commands. Timeout enforcement.

### LLM Invocation Layer
- `vscode.lm.selectChatModels({vendor, family})` per role.
- System prompt assembly: conventions skill + role skill + item
  context.
- Turn management: max turns, done detection, error handling.
- Token usage tracking from API responses.

### Orchestration State Machine
- Phase file parser: extract items, batches, checkboxes.
- State machine: implement -> test -> review -> retry loop.
- Checkbox updater: tick items in phase files on completion.
- Consecutive PASS counter: 2 passes required.
- Parallel batch support: concurrent item execution.

### State Persistence
- state.json read/write for pause/resume.
- audit.md append after each invocation.
- addendum.md append when deviations detected.
- Run transcript storage.

### TreeView Sidebar Panel
- VS Code TreeView provider showing: phases, items, status
  (pending/in-progress/pass/fail), current model per role.
- Refresh on state changes.
- Click to open audit.md, addendum.md, or transcript.

## Phase 2: Rich Local Dashboard (Webview)

### Webview Panel
- Full HTML/CSS/JS dashboard inside VS Code.
- Real-time progress: phase items with status indicators,
  current step animation, model names.
- Streaming audit log with filtering by role/status.
- Cost/usage tracking: token counts per step, cumulative totals.
- Transcript viewer: expand any step to see full model interaction.
- Approve/reject buttons for items requiring human sign-off.
- Controls: pause, resume, skip item, retry item, change model.

## Phase 3: Team Server + Remote Dashboard

### Embedded HTTP/WebSocket Server
- Lightweight HTTP server inside the extension serving the team
  dashboard.
- WebSocket for real-time state push to all connected clients.
- Configurable port (default 8484).
- Authentication: shared secret token (configured in settings).

### Browser Dashboard
- Single-page HTML/JS app served by the embedded server.
- Same features as the Webview: progress, audit, transcripts.
- Team-specific features: who started the run, approval queue,
  multi-user annotations on addendum.md.
- Controls: pause/resume, approve/reject, add notes.
- Responsive design for mobile viewing.

## Notes

- The extension targets VS Code 1.110+ for the `vscode.lm` API.
- All models accessed via Copilot subscription through `vscode.lm` -
  no API keys, no separate billing.
- The tool execution loop is the largest component (~1500 lines).
  Study the Claude Agent SDK (open source) for reference patterns.
- Bash tool execution must enforce agent-conduct rules: no git push,
  no sudo, no interactive commands, project directory boundary.
- State files (.conductor/) should be .gitignore-able but default to
  tracked so the team can see them via git pull.
- The extension must handle VS Code restarts gracefully: read
  state.json on activation, offer to resume interrupted runs.
- Model selection is per-role, not per-invocation. Configured in
  VS Code settings and overridable from the dashboard.
- The orchestration logic must match the existing skill workflows:
  implement -> review -> 2 consecutive PASS -> next item. This is
  not suggestion - it is the exact same loop as orchestrator/SKILL.md
  but implemented as code instead of prompts.
