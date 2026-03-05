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

### 1. Clarify requirements

Use `ask_questions` (unlimited questions) for genuine ambiguities: scope
boundaries, external dependencies, error handling, performance/scale,
configuration, integration points. Do NOT ask what is obvious or inferable. Do
as many rounds of questions as needed to resolve all ambiguity.

### 2. Note skill file paths

Note paths for: conventions, spec-author, spec-reviewer, spec-proofreader,
phase-creator, phase-reviewer. Do not read them.

### 3. Spec authoring

Launch **spec-author** subagent with: spec-author + conventions skill paths,
feature description (with Q&A), output path. "Research codebase, write spec."

### 4. Feature coverage review cycle

Launch **spec-reviewer** subagent with: spec-reviewer + conventions skill paths,
feature description, spec path. "Return PASS or FAIL."

- **PASS:** increment consecutive pass count. After 2nd consecutive PASS, go to
  step 5.
- **FAIL:** reset count. Launch new spec-author with reviewer feedback. Re-launch
  fresh reviewer. Repeat.

### 5. Text quality proofreading cycle

Launch **spec-proofreader** with: spec-proofreader skill path, spec path. Do NOT
include feature description. "Fix errors directly, return PASS or FIXED."

- **PASS:** increment count. After 2nd consecutive PASS, go to step 6.
- **FIXED:** reset count. Repeat with fresh proofreader.

### 6. Phase document creation

Launch **phase-creator** with: phase-creator skill path, spec path, output
directory, implementor + reviewer skill names.

### 7. Phase document review

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
