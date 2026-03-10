---
name: spec-writer
description: Orchestrates spec creation and review via subagents. Use when designing a new feature or writing a spec.
---

# Spec Writer Skill

Read and follow **agent-conduct** before starting.

You are an orchestrating agent. You do NOT write or review specs directly - you
launch subagents via `runSubagent`. Do not read skill files yourself - tell
subagents which skills to read by name and file path.

## Skill Discovery

Identify the project's conventions skill (e.g. `go-conventions` or
`nextjs-fastapi-conventions`) and implementor/reviewer skill names for use in
phase files.

## Input

- **Feature description** and **output path** (e.g. `.docs/myfeature/spec.md`).

## Procedure

### 1. Initialise prompt

Save the feature description verbatim to `prompt.md` in the same directory as
the target spec.md. This file is the evolving source of truth for requirements.

### 2. Clarify requirements (subagent Q&A loop)

Repeat the following cycle until a subagent returns no questions:

1. Launch a **fresh subagent** with: the conventions skill path, `prompt.md`
   path, and the instruction "Read the conventions skill. Read prompt.md.
   Research the codebase to understand what exists. Produce 3-5 clarifying
   questions (with suggested answer options) that must be answered before a spec
   can be written. Return ONLY the questions. If prompt.md already addresses
   everything, return NONE."
2. If the subagent returns NONE, the loop is done - proceed to
   "Note skill file paths".
3. Use `ask_questions` to relay the subagent's questions to the user.
4. For each answered question, append a concise instruction to a `## Notes`
   section in `prompt.md` (create the section on first use). Convert each Q&A
   pair into a direct statement of how the feature should work. Do NOT paste
   raw questions or answers.
5. Go to step 2.1 (new subagent, fresh context, updated prompt).

This keeps the parent agent's context lean - only `prompt.md` content and Q&A
relay, never codebase research.

### 3. Note skill file paths

Note paths for: conventions, spec-author, spec-reviewer, spec-proofreader,
phase-creator, phase-reviewer. Do not read them.

### 4. Spec authoring

Launch **spec-author** subagent with: spec-author + conventions skill paths,
`prompt.md` path (not raw feature description), output path. "Read prompt.md
for requirements. Research codebase, write spec."

### 5. Feature coverage review cycle

Launch **spec-reviewer** subagent with: spec-reviewer + conventions skill paths,
`prompt.md` path (as feature description), spec path. "Return PASS or FAIL."

- **PASS:** increment consecutive pass count. After 2nd consecutive PASS, go to
  step 6.
- **FAIL:** reset count. Launch new spec-author with reviewer feedback. Re-launch
  fresh reviewer. Repeat.

### 6. Text quality proofreading cycle

Launch **spec-proofreader** with: spec-proofreader skill path, spec path. Do NOT
include feature description. "Fix errors directly, return PASS or FIXED."

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

Transient subagent failures: retry with new subagent, including what was already
achieved.

## Rules

- NEVER write specs or review them directly - use subagents.
- NEVER pass feature description to spec-proofreader.
- NEVER skip review cycles. Feature review and proofreading each need 2
  consecutive passes. Phase reviews need 1 clean pass each.
