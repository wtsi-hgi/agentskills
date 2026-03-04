---
name: orchestrator
description: Orchestrates implementation and review of phase plans. Coordinates implementor and reviewer subagents (selected based on the project's tech stack), tracks progress via checkboxes in phase MD files, handles retries on transient failures, and runs a final pr-reviewer pass over all changes. Use when given a phase MD file to complete.
---

# Orchestrator Skill

## Prerequisites

Before starting any work, read and follow the agent-conduct skill.
It covers workspace boundaries, scratch work, terminal safety, and
git safety rules that apply to all agents.

---

You are an orchestrating agent. You do NOT implement code or run
tests yourself - you launch subagents (via `runSubagent`) to do that
work, embedding the relevant skill instructions in each subagent's
prompt. This keeps your context clean and focused on coordination.

Skills are instruction files, not named agents. To use them, read
their SKILL.md and include the full text in the `runSubagent` prompt.

## Skill Discovery

Identify the project's implementor, reviewer, and conventions skills
from the available skills. For example:

- **Go projects:** use `go-implementor`, `go-reviewer`, and
  `go-conventions`.
- **Next.js + FastAPI projects:** use
  `nextjs-fastapi-implementor`, `nextjs-fastapi-reviewer`, and
  `nextjs-fastapi-conventions`.

If the phase file's Instructions section names specific skills, use
those. Otherwise, determine the appropriate skills from the project
context.

## Input

A phase MD file (e.g. `.docs/watchfofns/phase3.md`) containing:

- A title and spec references.
- An **Instructions** section with phase-specific guidance.
- **Items** - each with a description, spec.md section reference,
  and two checkboxes: `- [ ] implemented` and `- [ ] reviewed`.
- Items may be grouped into ordered **batches** (some parallel,
  some sequential).

## Procedure

### 1. Read context

- Read the phase MD file.
- Read the project's conventions skill.
- Read the project's implementor skill.
- Read the project's reviewer skill.
- Note which items already have checkboxes checked (skip completed
  work).

### 2. Process items in order

Respect the ordering and batch structure in the phase file:

- **Sequential items:** Process one at a time.
- **Parallel batch items:** Launch one implementation subagent per
  item concurrently.
- **Batch dependencies:** Complete and review an entire batch
  before starting the next.

### 3. For each item (or parallel batch of items)

#### a. Implementation

Launch a subagent with the project's **implementor** skill by
including in its prompt:

- The full text of the conventions skill.
- The full text of the implementor skill.
- The item description from the phase file.
- The spec.md section reference.
- Any phase-specific instructions from the Instructions section.
- The instruction: "Read spec.md for full acceptance test details.
  Follow the TDD cycle exactly. Run tests and linters as
  specified."

When the subagent completes successfully, check the `implemented`
checkbox in the phase MD file:

```
- [ ] implemented  ->  - [x] implemented
```

#### b. Review

Launch a subagent with the project's **reviewer** skill by
including in its prompt:

- The full text of the conventions skill.
- The full text of the reviewer skill.
- The item description (or all items in the batch for parallel
  batches).
- The spec.md section reference(s).
- Any phase-specific instructions from the Instructions section.
- The instruction: "You have clean context. Read spec.md, read the
  source and test files, run tests, run linter, and return PASS or
  FAIL with specific feedback."

**On PASS:** Check the `reviewed` checkbox in the phase MD file:

```
- [ ] reviewed  ->  - [x] reviewed
```

**On FAIL:** Address the feedback by launching a new implementor
subagent with the reviewer's feedback included, then re-launch a
fresh reviewer subagent. Repeat until PASS.

### 4. Phase completion

Once all items in the phase have both checkboxes checked, commit all
changes with the message:

```
Implement phase <N>
```

where `<N>` is the phase number from the filename (e.g.
`phase3.md` -> `Implement phase 3`). Then report completion to the
caller.

### 5. Spec-aware PR review (after all phases)

When the caller has no more phases to run, perform a holistic review
of all the work done across every phase:

- Read the `pr-reviewer` skill.
- Launch a subagent with the **pr-reviewer** skill by including in
  its prompt:
  - The full text of the pr-reviewer skill.
  - Do not provide a base reference unless the caller explicitly
    gave one; let pr-reviewer resolve base from PR `base.ref` per
    its own guardrails.
  - The path to the spec document referenced in the phase files.
  - The instruction: "You have clean context. Review all committed
    and uncommitted changes on this branch compared to the base.
    Check for code quality, subtle bugs, real-world usability, and
    spec conformance. Fix issues via implementor subagents,
    pausing after each fix for me to commit."
- Follow the subagent's fix-and-commit cycle: after each fix,
  commit as instructed before allowing the next fix to proceed.
- Once the pr-reviewer reports no remaining findings, repeat with
  fresh context until it passes with no changes **2 times in a
  row**.

### 6. Spec-free PR review

After section 5 completes (or when invoked independently), run the
same pr-reviewer cycle but **without** the spec document. This
ensures the review focuses on overall code quality and real-world
usability rather than spec conformance.

- Read the `pr-reviewer` skill if not already loaded.
- Launch a subagent with the **pr-reviewer** skill by including in
  its prompt:
  - The full text of the pr-reviewer skill.
  - Do not provide a base reference unless the caller explicitly
    gave one; let pr-reviewer resolve base from PR `base.ref` per
    its own guardrails.
  - **No spec document path.**
  - The instruction: "You have clean context. Review all committed
    and uncommitted changes on this branch compared to the base.
    Check for code quality, subtle bugs, and real-world usability.
    Fix issues via implementor subagents, pausing after each fix
    for me to commit."
- Follow the subagent's fix-and-commit cycle as in section 5.
- Once the pr-reviewer reports no remaining findings, repeat with
  fresh context until it passes with no changes **2 times in a
  row**.

## Error Handling

- **Transient subagent failures** (e.g. "try again" errors): Wait a
  few seconds, then retry with a new subagent. Include in the new
  subagent's prompt what the previous subagent had already achieved,
  so work is not repeated.
- **File conflicts:** If a subagent needs to remove a file, move it
  to a `.trash/` directory within the repo instead of deleting it.
  Clean up `.trash/` only after all phases are complete.
- **Follow workspace and git safety rules** from the agent-conduct
  skill.

## Rules

- Do NOT implement code directly - always use subagents.
- Do NOT run tests directly - the reviewer subagent handles that.
- Do NOT skip or reorder items unless the phase file explicitly
  allows parallel execution.
- Do NOT check a checkbox until the corresponding subagent confirms
  success.
- Do NOT push to the remote - never run `git push`.
- Keep your context minimal: delegate, track, coordinate.
