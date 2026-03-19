# Addendum: Spec-Writing Orchestration - Feature Description

Extend the Copilot Conductor extension to orchestrate the
spec-writing workflow with the same determinism it applies to
implementation and review.

## Problem

The `Role` type includes `"spec-writer"`, `package.json`
defines `conductor.models.specWriter`, and `prompts.ts` has
a special case in `deriveRoleSkillName` for `"spec-writer"`.
None of this is wired into the state machine — it is dead
code. The orchestrator in `machine.ts` only invokes
`"implementor"` and `"reviewer"` roles.

The manual spec-writer skill (`skills/spec-writer/SKILL.md`)
is an orchestrating workflow that coordinates five sub-skills:
spec-author, spec-reviewer, spec-proofreader, phase-creator,
phase-reviewer. The extension was built to replace exactly
this kind of prompt-based orchestration with code-driven state
machines, but only did so for implementation and review.

This means users must run the spec-writer skill manually via
Copilot agent mode to create a spec and phase files, then
switch to the Conductor extension for implementation. The
extension should handle the entire pipeline.

## Requirements

1. The extension orchestrates spec authoring, spec reviewing,
   spec proofreading, phase creation, and phase review using
   the same LLM tool-loop invocation already built for
   implementation and review.

2. Spec review uses a 2-consecutive-PASS gate, same as
   implementation review. Spec proofreading uses a
   2-consecutive-PASS gate.

3. Each spec-writing sub-step (author, review, proofread,
   create phases, review phases) is a distinct role with its
   own skill loaded and its own configurable model.

4. The state machine auto-detects whether to start from
   spec-writing or implementation based on whether `spec.md`
   exists in `specDir`.

5. All spec-writing invocations produce audit entries and
   transcripts using the existing infrastructure.

6. When `requireApproval` is true, the extension pauses for
   human approval after spec review passes, after
   proofreading passes, and after all phase files pass
   review.

7. The proofreader must NOT receive `prompt.md` content —
   only the spec path. This matches the manual skill's
   rule to prevent bias.

8. The dead `"spec-writer"` role is renamed to
   `"spec-author"` to match what it actually does (writing,
   not orchestrating).

9. Remove the existing dead `conductor.models.specWriter`
   config and replace with per-role model configs for all
   five spec-writing roles.

10. The dashboard and team server display spec-writing
    status and include the new roles in audit log filters.

11. Before spec authoring, the extension runs a
    requirements clarification loop. An LLM reads the
    conventions skill and `prompt.md`, researches the
    codebase, and generates clarifying questions with
    suggested answer options. Questions are displayed in
    the dashboard / team server UI. User answers are
    converted to notes and appended to `prompt.md`
    `## Notes` section. The loop repeats with a fresh
    LLM invocation until the LLM returns NONE (no
    further questions). The model config reuses
    `specAuthor` -- no separate clarifier model.

## Notes

- The clarification loop from the manual spec-writer
  skill replaces `ask_questions` with dashboard/team
  server UI controls, matching the extension's
  approval UX pattern.
- Phase review in the manual workflow requires 1 clean PASS
  per file (re-review after FIXED), not 2 consecutive
  PASSes.
- The spec-proofreader returns PASS or FIXED (not
  PASS/FAIL). FIXED means it edited the file directly and
  a fresh proofreader should re-check.
- The spec-reviewer returns PASS or FAIL. On FAIL, the
  spec-author is re-invoked with feedback, then a fresh
  reviewer runs.
