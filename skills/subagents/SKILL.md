---
name: subagents
description: "Shared rules for orchestrating agents that delegate work to subagents. Referenced by orchestrator, bugfix, spec-writer, pr-reviewer, and pr-resolver."
---

# Subagents Skill

Shared conventions for orchestrating skills that launch subagents through the
active harness. Read **agent-conduct** first.

## Invocation Authority

When a skill's instructions say to launch, brief, delegate to, or review with
a subagent, that is an explicit instruction to use subagents. Do not decline
solely because the user's original message did not say "use subagents"; the
user invoked a skill whose documented workflow requires them.

If the active harness exposes a subagent tool, use it. If no subagent tool is
available, first use the harness's tool-discovery mechanism if one exists. If
subagents still are not available, report that as a blocker to the calling
skill instead of doing the delegated work directly.

## Role

You orchestrate: decompose work, brief subagents, check results. Delegate
all implementation, spec writing, and reviewing to subagents - do NOT do
that work yourself. You MAY run read-only verification directly (tests,
linters, `git diff`, `git status`) to check a subagent's claims before
acting on them, and you MAY edit your own orchestration artifacts
(checklists, blocker files, `prompt.md` notes). You do not read skill
files yourself either - pass names and paths to subagents.

## Concurrency

Default to one heavy worker across the full workflow tree, including the
owner's own implementation, review, and test runs. Nested workflows inherit
that budget; an idle coordinator or light status polling consumes no heavy
slot. Keep implementation, review, and checks sequential unless parallel
work is explicitly authorized by the user or supplied plan.

Authorized parallel work may use at most two heavy workers. First check
actual and planned changed files and dependencies for both tasks. Run them
serially if they overlap or independence is uncertain; separate worktrees
alone do not establish independence. Schedule larger batches in bounded
waves within this limit. Brief children on occupied slots and their assigned
files so nested delegation cannot exceed the shared budget.

On a usage limit or reset, preserve edits, evidence, and branch/checklist
references before stopping or retrying. After capacity returns, restart one
worker at a time and check its state before launching more work.

## Harness Adapters

Use the active harness's vocabulary and constraints.

### VS Code Harness

- Launch with `runSubagent`.
- For writable work, call `runSubagent` without `agentName`.
- Do NOT pass `agentName: "Explore"` or any other read-only agent for work
  that must edit files, write specs, or run tests.
- Always pass `model` to `runSubagent`; otherwise it picks one for you. Strings
  must be exact, format `"<Model Name> (<Vendor>)"` (vendor usually
  `copilot`).
- To discover valid model strings, call `runSubagent` once with
  `model: "__probe__"` - the error lists every available model verbatim.
  Cache that list.

### Codex Harness

- Use the collaboration tools exposed by the active Codex harness and follow
  their live schemas. The common operations are `spawn_agent`, `wait_agent`,
  `send_message`, `followup_task`, `interrupt_agent`, and `list_agents`; tool
  namespaces and parameters may vary by release.
- If Codex tool metadata says subagents require an explicit request, this
  repo's invoked orchestrating skill is that explicit request when its
  procedure says to use subagents.
- Codex subagents inherit the available workspace tools. Do not invent an
  `agent_type` parameter when the active `spawn_agent` schema has none.
- Omit `model` unless the user explicitly asks for a different model or there
  is a clear task-specific reason. Codex subagents inherit the parent model by
  default.
- Use `wait_agent` when the orchestration step needs a result. Use
  `send_message` to add context without starting a turn, and `followup_task`
  to give an idle agent more work and start a turn. Use `interrupt_agent` only
  to stop work that is still running and no longer needed.
- For authorized parallel batches, spawn only workers admitted by the
  shared concurrency limit, then wait before scheduling the next wave.

### Claude Code Harness

- Launch with the `Agent` tool, passing `subagent_type`.
- For writable work, use `subagent_type: "general-purpose"` (or `"claude"`).
  Both carry the full toolset (`*`), including `Edit`, `Write`, and
  `NotebookEdit`, so they can implement, write specs, and run tests/linters.
- Do NOT pass `subagent_type: "Explore"` or `"Plan"` for work that must edit
  files: those agent types are missing `Edit`, `Write`, and `NotebookEdit`.
  (They retain `Bash`, so a determined agent could still shell-write, but it
  lacks the proper editing tools and returns diagnoses, not completed work.)
- Omit `model` by default so the subagent inherits the parent model. When you
  do set it, use a tier keyword: `"opus"`, `"sonnet"`, `"haiku"`, or
  `"fable"` (not a full model id).
- For authorized parallel batches, emit only calls admitted by the shared
  concurrency limit in one response. Wait before scheduling the next wave.
  Use `run_in_background: true` for long work you do not need to block on;
  background work still counts against the shared limit.
- Each `Agent` result ends with an `agentId`. To continue that subagent with
  its context intact, use `SendMessage` (`to: "<agentId>"`) **if the harness
  exposes it**. `SendMessage` is not always available; when it is absent,
  start a fresh `Agent` and summarise progress so far (see Error Handling).
- If a needed tool is not in the top-level tool list, use `ToolSearch` to load
  its schema before calling it - this is the Claude Code tool-discovery
  mechanism.

## Always Use Writable Subagents

Every subagent launched from an orchestrating skill must be able to edit
files and run tests. Use the writable/default agent in VS Code (`runSubagent`
without `agentName`), a Codex subagent with the inherited workspace tools, or
a Claude Code writable agent (`Agent` with
`subagent_type: "general-purpose"` or `"claude"`).

Do NOT use VS Code `agentName: "Explore"` or Claude Code
`subagent_type: "Explore"`/`"Plan"` for work that must change files, write
specs, run tests, or verify fixes. Read-only agents return diagnoses but
cannot complete the workflow, wasting a full cycle.

## Model Selection

Default to your own model (per your system prompt). If the user names one,
pick the closest match from the available models; if none is plausible, ask.

Apply the harness-specific rule:

- VS Code `runSubagent`: always pass an exact `model` string; discover strings
  with the `__probe__` call described above.
- Codex `spawn_agent`: omit `model` by default so the subagent inherits the
  parent model; set it only for an explicit user request or a clear
  task-specific reason.
- Claude Code `Agent`: omit `model` by default so the subagent inherits the
  parent model; when set, use a tier keyword (`"opus"`, `"sonnet"`,
  `"haiku"`, `"fable"`).

## Skill Discovery

Identify the tech stack from the codebase and use the matching triplet:
`<stack>-conventions`, `<stack>-implementor`, `<stack>-reviewer` (e.g.
`go-conventions`, `python-implementor`). Available stacks are in your system
prompt. Override with any skills named in the task input (phase file
Instructions, caller arguments). For tasks that write or review tests, also
include `testing-principles`. Give a reviewer the path to `go-test-strength`
too; that skill's own trigger decides whether it gets read.

## Briefing

Word each briefing per **writing-for-agents** § Writing Subagent Briefings.
Each subagent starts with clean context. Give it:

- Skill names and absolute file paths to read.
- The **agent-conduct** path, which requires the completion contract below.
- The specific task (item, spec section, file list, bug, finding).
- Expected output (e.g. "Follow TDD cycle and testing-principles, run tests
  and linter"; "Return PASS or FAIL with specific feedback").
- Caller constraints (phase instructions, focus areas), queue owner identity
  and branch-owned checklist when supplied. Workers return distinct incidental
  findings and evidence for caller routing before editing incidental code.
  Child workflows inherit the owner and return deferred branch/entry
  references without draining them; see
  [bugfix routing](../bugfix/references/incidental-issues.md).

Pass paths, not skill text.

On resume, include updated context, exact live IDs and pending artifacts, and
instruct the worker to wait through completion. Check actual worker state
before choosing a context update or a resume call.

## Error Handling

- **Transient failure:** retry with a new subagent, summarising progress so
  far.
- **Repeated failure on the same item:** stop at the calling skill's cap
  (e.g. 5 cycles) and report to the user.
- **Blocker reported by subagent:** see agent-conduct § Honesty About
  Blockers. Do not relaunch with "try harder" wording. Route per the
  calling skill (bugfix / orchestrator / spec-writer).

## Reporting To The User

Your closing message is the part of the run the user actually reads. Write it
through **final-response**: what changed, what was verified and by which
command, what is still open, and the paths, verdicts, and commit SHAs that
prove it.

Describe the artifact, not the summary you were handed. A subagent reports
what it intended; read the diff, run the tests, or list the files before
repeating its claim.

## Completion And Liveness

This section applies to workers and owners in every harness, including agents
that do not delegate. It does not assign them the orchestration role above.

Workers wait for their own tests, tool sessions, and background children before
final handback. Return finally only when complete, blocked, or explicitly
paused. A tool yield is still live work; resume its wait within bounded calls.
Do not invent a harness requirement to finalize early. If an interim handback
is unavoidable, label it `INTERIM`, list exact live agent/process/job/wait IDs,
pending artifacts, ownership, and the commands or calls needed to resume.
An owner must resume that work, not count it as success or check a marker.

Before reporting running or waiting, inspect the actual agent, process, job,
or PR state and available output. Silence and a prior promise are not evidence.
If tools cannot verify state, report it as unknown. When a background wait
ends, consume its output and report the result in the next update, especially
for an awaited gate. Read the semantic result; exit 0 alone does not prove a
gate passed. Send concise progress updates through **final-response**.

Bound potentially long or networked commands with `timeout` or native flags,
and use bounded, interruptible waits. Report a real timeout instead of waiting
forever. Do not interrupt required work merely to end the turn.

Before final, blocked, or paused handback, stop unneeded background work and
verify it stopped. Account for nested work too. Completed agents need no
cleanup if the harness exposes no close operation. For any retained work,
report its current state, exact IDs, owner, purpose, and resume or cleanup
action; unverified state remains unknown.

Tag context updates to active agents `FYI, keep going`. Recipients incorporate
them and continue the same task through completion. An explicit pause or stop
ends work; a real blocker or timeout still requires an honest report.

## Rules

- NEVER use a read-only agent for orchestrated work.
- NEVER implement, fix, or author specs/reviews directly - delegate to
  subagents. Read-only verification runs (tests, linters, diffs) and edits
  to your own orchestration artifacts (checklists, blocker files) are
  allowed.
- NEVER check a progress marker until the subagent confirms success.
- NEVER report a subagent's work from its summary alone. Check the diff, the
  tests, or the files first.
- NEVER embed skill contents in prompts - pass name + path.
- NEVER leave an unneeded Codex subagent running.
- NEVER omit the `model` parameter on VS Code `runSubagent`; never set Codex
  `spawn_agent.model` or Claude Code `Agent.model` without an explicit user
  request or clear task-specific reason.
