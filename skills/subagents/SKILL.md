---
name: subagents
description: Shared rules for orchestrating agents that delegate work to subagents. Referenced by orchestrator, bugfix, spec-writer, pr-reviewer, and pr-resolver.
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

- Launch with `multi_agent_v1.spawn_agent`.
- If Codex tool metadata says subagents require an explicit request, this
  repo's invoked orchestrating skill is that explicit request when its
  procedure says to use subagents.
- Use `agent_type: "worker"` for implementors, reviewers, spec authors,
  proofreaders, phase creators, phase reviewers, PR reviewers, and any
  subagent expected to edit files, write artifacts, run tests, or verify work.
- Avoid `agent_type: "explorer"` for orchestrated writing/review workflows.
  It is only appropriate for a clearly read-only codebase question when the
  calling skill explicitly allows read-only exploration.
- Omit `model` unless the user explicitly asks for a different model or there
  is a clear task-specific reason. Codex subagents inherit the parent model by
  default.
- Use `wait_agent` when the orchestration step needs the result, `send_input`
  to refine an existing live subagent, and `close_agent` when a subagent is no
  longer needed.
- For parallel batches, spawn all independent workers first, then wait for
  completion as needed.

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
- For parallel batches, emit all independent `Agent` calls in a single
  response so they run concurrently; the runtime returns each result when it
  finishes. Use `run_in_background: true` for long work you do not need to
  block on - you are notified when it completes.
- Each `Agent` result ends with an `agentId`. To continue that subagent with
  its context intact, use `SendMessage` (`to: "<agentId>"`) **if the harness
  exposes it**. `SendMessage` is not always available; when it is absent,
  start a fresh `Agent` and summarise progress so far (see Error Handling).
- If a needed tool is not in the top-level tool list, use `ToolSearch` to load
  its schema before calling it - this is the Claude Code tool-discovery
  mechanism.

## Always Use Writable Subagents

Every subagent launched from an orchestrating skill must be able to edit
files and run tests unless the calling skill explicitly says the task is
read-only. Use the writable/default agent in VS Code (`runSubagent` without
`agentName`), a Codex worker (`spawn_agent` with `agent_type: "worker"`), or a
Claude Code writable agent (`Agent` with `subagent_type: "general-purpose"` or
`"claude"`).

Do NOT use VS Code `agentName: "Explore"`, Codex `agent_type: "explorer"`, or
Claude Code `subagent_type: "Explore"`/`"Plan"` for work that must change
files, write specs, run tests, or verify fixes. Read-only agents return
diagnoses but cannot complete the workflow, wasting a full cycle.

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
include `testing-principles`.

## Briefing

Word each briefing per **writing-for-agents** § Writing Subagent Briefings.
Each subagent starts with clean context. Give it:

- Skill names and absolute file paths to read.
- The specific task (item, spec section, file list, bug, finding).
- Expected output (e.g. "Follow TDD cycle and testing-principles, run tests
  and linter"; "Return PASS or FAIL with specific feedback").
- Caller constraints (phase instructions, focus areas).

Pass paths, not skill text.

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
through **unslop**: what changed, what was verified and by which command, what
is still open, and the paths, verdicts, and commit SHAs that prove it.

Describe the artifact, not the summary you were handed. A subagent reports
what it intended; read the diff, run the tests, or list the files before
repeating its claim.

## Liveness and Bounded Tool Calls

### All Harnesses

Brief every subagent to bound its tool calls and shell commands so they
cannot hang indefinitely: wrap potentially long or networked commands
with `timeout` (or framework-native timeout flags), and prefer
test/lint invocations that fail fast. Subagents must abort and report
rather than wait forever on an unresponsive command.

### Codex Harness

- Send concise progress updates while long-running subagents are active.
- Track spawned agent IDs. Call `close_agent` promptly when a Codex subagent is
  no longer needed, including after its result has been integrated, after the
  task is canceled, or after the workflow changes direction. This prevents
  later turns from burning time rediscovering a subagent limit.
- Before final response, ensure all subagents needed for the request have
  completed or have been explicitly closed.

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
- NEVER leave Codex subagents open once they are no longer needed.
- NEVER omit the `model` parameter on VS Code `runSubagent`; never set Codex
  `spawn_agent.model` or Claude Code `Agent.model` without an explicit user
  request or clear task-specific reason.
