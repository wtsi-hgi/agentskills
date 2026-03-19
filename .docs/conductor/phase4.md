# Phase 4: Spec-Writing Orchestration

Ref: [addendum.md](addendum.md) sections J1, I1, I2, I4,
I3, G1 update, H2 update

## Instructions

Use the `orchestrator` skill to complete this phase,
coordinating subagents with the `implementor` and
`reviewer` skills.

## Items

### Item 4.1: J1 - Remove spec-writer Dead Code

addendum.md section: J1

Remove `"spec-writer"` from the `Role` union in
`src/types.ts`, remove `conductor.models.specWriter` from
`package.json`, remove the `if (role === "spec-writer")`
branch in `deriveRoleSkillName` in `src/llm/prompts.ts`,
update `getModelAssignments` in `src/extension.ts` to
read five new model configs instead of `specWriter`, and
update all test files referencing `"spec-writer"`. Must
come first so subsequent items build on clean types.
Covering all 6 acceptance tests from J1.

- [ ] implemented
- [ ] reviewed

### Item 4.2: I1 - Skill Loading for Spec-Writing Roles

addendum.md section: I1

Update `deriveRoleSkillName` in `src/llm/prompts.ts` to
return the role name directly for spec-writing roles
(`spec-author`, `spec-reviewer`, `spec-proofreader`,
`phase-creator`, `phase-reviewer`) without conventions
prefix. Ensure conventions skill is loaded only for
`implementor` and `reviewer`. Apply
`stripAgentConductReferences` to all loaded skills. Test
file: `src/test/llm/prompts.test.ts`. Depends on item 4.1
(J1). Covering all 5 acceptance tests from I1.

- [ ] implemented
- [ ] reviewed

### Item 4.3: I2 - Spec-Writing State Machine

addendum.md section: I2

Add `SpecStep`, `ClarificationQuestion` types and
`specStep`, `specConsecutivePasses`, `specPhaseFileIndex`,
`clarificationQuestions` fields to `OrchestratorState` in
`src/types.ts`. Implement the spec-writing "phase 0"
workflow in `src/orchestrator/machine.ts`: auto-detection
from `prompt.md`/`spec.md` presence, 6-step sequence
(clarifying, authoring, reviewing with 2-PASS gate,
proofreading with 2-PASS gate, creating-phases,
reviewing-phases with 1-PASS gate), approval checkpoints,
error handling with `maxRetries`, and pause/resume with
state persistence. Test file:
`src/test/orchestrator/machine.test.ts`. Depends on
item 4.2 (I1). Covering all 21 acceptance tests from I2.

- [ ] implemented
- [ ] reviewed

### Item 4.4: I4 - Requirements Clarification Loop

addendum.md section: I4

Implement the clarification step as step 1 of spec-writing
in `src/orchestrator/machine.ts` and
`src/llm/prompts.ts`: build system prompt from conventions
skill and clarification template, parse LLM response for
JSON question array or NONE, store questions in
`state.clarificationQuestions`, await user answers via
`submit-clarification` message, convert Q&A pairs to
notes appended to `prompt.md` `## Notes` section using
code-based formatting, re-invoke fresh LLM until NONE.
Handle malformed JSON as NONE. Audit with `"clarifier"`
label using `specAuthor` model config. Test file:
`src/test/orchestrator/machine.test.ts`. Depends on
item 4.3 (I2). Covering all 13 acceptance tests from I4.

- [ ] implemented
- [ ] reviewed

### Item 4.5: I3 - Extension Command Auto-Detection

addendum.md section: I3

Update `Conductor: Start` in `src/extension.ts` to check
for `spec.md` in `specDir`. If absent but `prompt.md`
exists, begin spec-writing (set `specStep` to
`"clarifying"`). If `spec.md` exists, begin implementation
(current behaviour). If neither exists, show error. Test
file: `src/test/extension.test.ts`. Depends on item 4.4
(I4). Covering all 3 acceptance tests from I3.

- [ ] implemented
- [ ] reviewed

### Item 4.6: G1/H2 - Dashboard and Team Server Updates

addendum.md sections: G1 update, H2 update

Add spec-writing status display to
`src/webview/dashboard.html` and
`src/server/app/index.html`: show current `specStep` and
consecutive pass counter when `specStep !== "done"`, add
`spec-author`, `spec-reviewer`, `spec-proofreader`,
`phase-creator`, `phase-reviewer` to audit log role
filters, render clarification Q&A form when
`clarificationQuestions` is non-empty with
`submit-clarification` message on submit, handle
`submit-clarification` in `src/webview/panel.ts` and
`src/server/ws.ts`. No new acceptance tests -- existing
G1/H2 tests cover rendering paths. Depends on item 4.4
(I4).

- [ ] implemented
- [ ] reviewed
