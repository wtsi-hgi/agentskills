---
name: spec-writer
description: "Orchestrates spec creation and review via subagents. Use when designing a new feature or writing a spec."
---

# Spec Writer Skill

Read and follow **agent-conduct** and **subagents** before starting.
**subagents** owns delegation: agent choice, briefing, skill discovery, and
error handling. This skill covers only the spec-writing procedure.

## Input

- **Feature description** and **output path** (e.g. `.docs/myfeature/spec.md`).

## Procedure

### 1. Initialise prompt

Save the feature description verbatim to `prompt.md` in the same directory as
the target spec.md. This file is the evolving source of truth for requirements.

### 2. Clarify requirements (subagent Q&A rounds)

Work the open decisions as a tree: settling one unblocks the questions that
depended on it. The **frontier** is every decision whose prerequisites are
already settled. Ask the whole frontier in one round, then recompute it.

Repeat until a subagent returns NONE:

1. Launch a **fresh subagent** with: the conventions skill path, `prompt.md`
   path, and the instruction "Read the conventions skill. Read prompt.md.
   Research the codebase to understand what exists. Return every question on
   the current frontier: each decision the spec needs that prompt.md does not
   already settle and that does not depend on another question you are
   returning now. Anything observable in the codebase, in project docs, or by
   running a command is a fact, not a question: find it yourself and return it
   as a finding. Ask only what is genuinely the user's to decide. Give each
   question a short title, its options, and your recommended answer, numbered
   so the user can answer by number. If nothing is left to decide, return
   NONE."
2. If the subagent returns NONE, the loop is done - proceed to
   "Note skill file paths".
3. Relay the questions with the harness's structured question tool
   (`ask_questions`, `AskUserQuestion`, or equivalent), keeping each
   recommended answer so the user can accept it as-is.
4. Append each settled decision to a `## Notes` section in `prompt.md` (create
   the section on first use) as a direct statement of how the feature should
   work. Include the subagent's findings the user did not contradict. Do NOT
   paste raw questions or answers.
5. Go to step 2.1 (new subagent, fresh context, updated prompt).

A question whose answer depends on another question in the same round belongs
to the next round, not this one. The loop ends when the frontier is empty, not
after a fixed number of rounds.

This keeps the parent agent's context lean - only `prompt.md` content and the
question relay, never codebase research.

### 3. Note skill file paths

Note paths for: conventions, spec-author, spec-reviewer, spec-proofreader,
phase-creator, phase-reviewer, unslop. Do not read them.

### 4. Spec authoring

Launch **spec-author** subagent with: spec-author + conventions + unslop skill
paths, `prompt.md` path (not raw feature description), output path. "Read
prompt.md for requirements. Research codebase, write spec."

### 5. Feature coverage review cycle

Launch **spec-reviewer** subagent with: spec-reviewer + conventions skill paths,
`prompt.md` path (as feature description), spec path. "Return PASS or FAIL."

- **PASS:** increment consecutive pass count. After 2nd consecutive PASS, go to
  step 6.
- **FAIL:** reset count. Launch new spec-author with reviewer feedback, then
  re-launch a fresh reviewer. Repeat.

### 6. Text quality proofreading cycle

Launch **spec-proofreader** with: spec-proofreader + unslop skill paths, spec
path. Do NOT include feature description. "Fix errors directly, return PASS or
FIXED."

- **PASS:** increment count. After 2nd consecutive PASS, go to step 7.
- **FIXED:** reset count. Repeat with fresh proofreader.

### 7. Phase document creation

Launch **phase-creator** with: phase-creator skill path, spec path, output
directory, implementor + reviewer skill names.

### 8. Phase document review

For each phase file, launch **phase-reviewer** with: phase-reviewer skill path,
phase file path, spec path.

- **PASS:** next file.
- **FIXED:** repeat for same file until PASS.

Report completion when all phases pass.

## Error Handling

Transient subagent failures: see **subagents**.

**Blocker during clarification or authoring** (per agent-conduct §
Honesty About Blockers - e.g. the requested feature relies on a
capability the chosen external API does not provide):

1. Stop the current cycle. Do not have spec-author invent functionality
   to fill the gap.
2. Write `blocker.md` alongside `prompt.md` describing the
   impossibility (what was requested, why it cannot work) and 1-3
   proposed alternatives or scope changes.
3. Do not author or revise the spec further. Report the blocker path to
   the user and stop.

## Rules

- Follow the rules in **subagents** (no direct spec writing/reviewing, no
  read-only agents for writing work, etc.).
- NEVER pass feature description to spec-proofreader.
- NEVER skip review cycles. Feature review and proofreading each need 2
  consecutive passes. Phase reviews need 1 clean pass each.
