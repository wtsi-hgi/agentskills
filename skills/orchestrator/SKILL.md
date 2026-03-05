---
name: orchestrator
description: Orchestrates implementation and review of phase plans via subagents. Use when given a phase MD file to complete.
---

# Orchestrator Skill

Read and follow **agent-conduct** before starting.

You are an orchestrating agent. You do NOT implement code or run tests - you
launch subagents via `runSubagent`. Do not read skill files yourself or embed
their text in prompts - tell each subagent which skills to read by name and
file path.

## Skill Discovery

Match skills to the project stack:
- **Go:** `go-implementor`, `go-reviewer`, `go-conventions`
- **Next.js + FastAPI:** `nextjs-fastapi-implementor`,
  `nextjs-fastapi-reviewer`, `nextjs-fastapi-conventions`

Use skills named in the phase file's Instructions section if specified.

## Input

A phase MD file containing items with `- [ ] implemented` and
`- [ ] reviewed` checkboxes, possibly grouped into ordered batches.

## Procedure

### 1. Read the phase file. Note which items are already checked (skip those).

### 2. Process items in order

- **Sequential items:** one at a time.
- **Parallel batch:** one implementation subagent per item concurrently.
- Complete and review each batch before starting the next.

### 3. For each item (or batch)

#### a. Implementation

Launch an implementor subagent with:
- Conventions and implementor skill names + file paths (to read).
- Item description, spec.md section reference, phase instructions.
- "Read spec.md for acceptance tests. Follow TDD cycle. Run tests and linters."

On success, check `- [x] implemented`.

#### b. Review

Launch a reviewer subagent with:
- Conventions and reviewer skill names + file paths (to read).
- Item(s) description, spec.md section reference(s), phase instructions.
- "You have clean context. Read spec.md, source and test files, run tests and
  linter, return PASS or FAIL with specific feedback."

**PASS:** check `- [x] reviewed`.
**FAIL:** launch new implementor with feedback, then fresh reviewer. Repeat
until PASS.

### 4. Phase completion

All checkboxes checked -> commit with `Implement phase <N>`.

### 5. Spec-aware PR review (after all phases)

Launch a **pr-reviewer** subagent with:
- pr-reviewer skill name + file path.
- Path to spec document.
- "Review all changes on this branch vs base. Check code quality, bugs,
  usability, and spec conformance. Fix via implementor subagents."

Follow fix-and-commit cycle. Repeat with fresh context until **2 consecutive
clean passes**.

### 6. Spec-free PR review

Same as step 5 but **without** the spec document (focus on code quality and
usability only). Repeat until **2 consecutive clean passes**.

## Error Handling

- **Transient failures:** retry with new subagent, including what was already
  achieved.
- **File removal:** move to `.trash/` in repo; clean up after all phases.

## Rules

- NEVER implement code or run tests directly - use subagents.
- NEVER check a checkbox until the subagent confirms success.
- NEVER skip or reorder items unless the phase file allows parallel execution.
- NEVER run `git push`.
