---
name: subagents
description: Shared rules for orchestrating agents that delegate work to subagents via runSubagent. Referenced by orchestrator, bugfix, spec-writer, and pr-reviewer.
---

# Subagents Skill

Shared conventions for orchestrating skills that launch subagents via
`runSubagent`. Read **agent-conduct** first.

## Role

You orchestrate: decompose work, brief subagents, check results. You do NOT
edit files, write specs, or run tests/linters yourself. You do not read
skill files yourself either - pass names and paths to subagents.

## Always Use Writable Subagents

Every subagent launched from an orchestrating skill must be able to edit
files and run tests. **Call `runSubagent` without `agentName`.** Do NOT
pass `agentName: "Explore"` or any other read-only agent - they return
diagnoses but cannot change anything, wasting a full cycle.

## Skill Discovery

Identify the tech stack from the codebase and use the matching triplet:
`<stack>-conventions`, `<stack>-implementor`, `<stack>-reviewer` (e.g.
`go-conventions`, `python-implementor`). Available stacks are in your system
prompt. Override with any skills named in the task input (phase file
Instructions, caller arguments).

## Briefing

Each subagent starts with clean context. Give it:

- Skill names and absolute file paths to read.
- The specific task (item, spec section, file list, bug, finding).
- Expected output (e.g. "Follow TDD cycle, run tests and linter"; "Return
  PASS or FAIL with specific feedback").
- Caller constraints (phase instructions, focus areas).

Pass paths, not skill text.

## Error Handling

- **Transient failure:** retry with a new subagent, summarising progress so
  far.
- **Repeated failure on the same item:** stop at the calling skill's cap
  (e.g. 5 cycles) and report to the user.

## Rules

- NEVER use a read-only agent for orchestrated work.
- NEVER edit files or run tests/linters directly.
- NEVER check a progress marker until the subagent confirms success.
- NEVER embed skill contents in prompts - pass name + path.
