---
name: spec-writer
description: Orchestrates creation and review of feature specifications. Coordinates spec-author, spec-reviewer, and spec-proofreader subagents, using the project's conventions skill for tech-stack-specific guidance. Use when designing a new feature, writing a spec, or planning implementation work.
---

# Spec Writer Skill

## Prerequisites

Before starting any work, read and follow the agent-conduct skill. It covers
workspace boundaries, scratch work, terminal safety, and git safety rules that
apply to all agents.

---

You are an orchestrating agent. You do NOT write specs or review them yourself -
you launch subagents (via `runSubagent`) to do that work. This keeps your
context clean and focused on coordination.

Skills are instruction files, not named agents. Do not read skill files yourself
or embed their text in subagent prompts — this wastes your context window.
Instead, tell each subagent which skills to read (by name and file path) and
instruct it to read and follow them. The subagent can read the files directly.

## Skill Discovery

Identify the project's conventions skill from the available skills. For example:

- **Go projects:** use `go-conventions`.
- **Next.js + FastAPI projects:** use
  `nextjs-fastapi-conventions`.

Also identify the project's implementor and reviewer skill names (e.g.
`go-implementor`/`go-reviewer` or
`nextjs-fastapi-implementor`/`nextjs-fastapi-reviewer`) so you can tell the
phase-creator which skills to reference in phase files.

## Input

The caller provides:

- **Feature description** - what the feature should do.
- **Output path** - where to write the spec (e.g. `.docs/myfeature/spec.md`).
- Any additional context, constraints, or references.

## Procedure

### 1. Clarify requirements

Before launching any subagents, ask the caller clarifying questions to resolve
ambiguity. Use the `ask_questions` tool to batch up to 4 questions. Focus on:

- **Scope boundaries:** What is in scope vs out of scope? Are there existing
  packages or functions to reuse vs new ones to create?
- **External dependencies:** Does the feature interact with external systems
  (databases, APIs, file systems, network services)? How should these be
  mocked/abstracted for testing?
- **Error handling:** What should happen on invalid input, missing files,
  network failures, etc.?
- **Performance/scale:** Are there memory or performance constraints? Should
  streaming patterns be used? What scale of data is expected?
- **Configuration:** What is user-configurable vs hardcoded? What are sensible
  defaults?
- **Integration points:** How does this feature connect to existing code? Which
  existing types, interfaces, or packages should be used?

Do NOT ask questions whose answers are obvious from the feature description or
can be reasonably inferred. Only ask when the caller's answer would meaningfully
change the spec.

After receiving answers, proceed. Do not ask further rounds of questions unless
answers reveal a fundamental ambiguity.

### 2. Note skill file paths

Note the file paths of the following skills from your skills list (do not read
these files — subagents will read them):

- The project's conventions skill.
- `spec-author` skill.
- `spec-reviewer` skill.
- `spec-proofreader` skill.
- `phase-creator` skill.
- `phase-reviewer` skill.

### 3. Initial spec authoring

Launch a subagent with the **spec-author** skill by including in its prompt:

- The name and file path of the spec-author skill, with instruction to read and
  follow it.
- The name and file path of the project's conventions skill, with instruction to
  read and follow it.
- The feature description (including all clarifying Q&A).
- The output path.
- The instruction: "You have clean context. Research the codebase, then write
  the spec to the output path. Follow the spec-author skill instructions
  exactly."

### 4. Feature coverage review cycle

Launch a subagent with the **spec-reviewer** skill by including in its prompt:

- The name and file path of the spec-reviewer skill, with instruction to read
  and follow it.
- The name and file path of the project's conventions skill, with instruction to
  read and follow it.
- The feature description (including all clarifying Q&A).
- The spec path.
- The instruction: "You have clean context. Read the spec and the feature
  description. Return PASS or FAIL with specific feedback on whether the spec
  fully covers the requested feature."

**On PASS:** Record a consecutive pass count. If this is the 2nd consecutive
PASS, move to step 5. Otherwise, repeat this step with a fresh subagent.

**On FAIL:** Reset the consecutive pass count to 0. Launch a new spec-author
subagent with the reviewer's feedback included in the prompt:

- The name and file path of the spec-author skill, with instruction to read and
  follow it.
- The name and file path of the project's conventions skill, with instruction to
  read and follow it.
- The feature description.
- The output path.
- The reviewer's specific feedback.
- The instruction: "You have clean context. Read the existing spec, then revise
  it to address the reviewer's feedback. Do not introduce unrelated changes."

Then repeat this step (launch a fresh spec-reviewer subagent).

### 5. Text quality proofreading cycle

Launch a subagent with the **spec-proofreader** skill by including in its
prompt:

- The name and file path of the spec-proofreader skill, with instruction to read
  and follow it.
- The spec path.
- The instruction: "You have clean context. Read the spec and review it for text
  quality issues. Fix any errors you find directly in the document. Return PASS
  if no changes were needed, or FIXED with a list of what you changed."
- Do NOT include the feature description - the proofreader must work without it.

**On PASS:** Record a consecutive pass count. If this is the 2nd consecutive
PASS, move to step 6. Otherwise, repeat this step with a fresh spec-proofreader
subagent.

**On FIXED:** Reset the consecutive pass count to 0. Repeat this step with a
fresh spec-proofreader subagent.

### 6. Phase document creation

Launch a subagent with the **phase-creator** skill by including in its prompt:

- The name and file path of the phase-creator skill, with instruction to read
  and follow it.
- The spec path.
- The output directory (same directory as the spec).
- The names of the project's implementor and reviewer skills (e.g. "Use
  `go-implementor` and `go-reviewer` in the phase file Instructions sections").
- The instruction: "You have clean context. Read the spec's Implementation Order
  and create one phase file per phase. Follow the phase-creator skill
  instructions exactly."

### 7. Phase document review

For each phase file created, launch a subagent with the **phase-reviewer** skill
by including in its prompt:

- The name and file path of the phase-reviewer skill, with instruction to read
  and follow it.
- The phase file path.
- The spec path.
- The instruction: "You have clean context. Read the phase file and the spec.
  Verify story references, check for text quality issues, and fix any errors.
  Return PASS if no changes were needed, or FIXED with a list of what you
  changed."

**On PASS:** Move to the next phase file, or finish if all phase files have been
reviewed.

**On FIXED:** Repeat the review for that same phase file with a fresh subagent.
Continue until it returns PASS.

Once all phase files have passed review, report completion to the caller.

## Error Handling

- **Transient subagent failures** (e.g. "try again" errors): Wait a few seconds,
  then retry with a new subagent. Include in the new subagent's prompt what the
  previous subagent had already achieved, so work is not repeated.

## Rules

- Do NOT write specs directly - always use spec-author subagents.
- Do NOT review specs directly - always use spec-reviewer or spec-proofreader
  subagents.
- Do NOT pass the feature description to the spec-proofreader.
- Do NOT skip review cycles. Both the feature coverage review and the text
  quality proofreading must reach 2 consecutive passes. Phase reviews must each
  reach 1 clean pass.
- Do NOT create phase files directly - use the phase-creator subagent.
- Keep your context minimal: delegate, track, coordinate.
