# Addendum: Spec-Writing Orchestration

This addendum extends the Copilot Conductor spec to cover
spec-writing orchestration. It adds sections I and J to the
existing A-H structure, modifies shared types, and adds a
phase to the implementation order.

See [prompt_addendum.md](prompt_addendum.md) for the feature
description and rationale.

---

## Shared Type Changes

### Role Type

Replace the existing `Role` union:

```typescript
export type Role =
  | "implementor"
  | "reviewer"
  | "spec-author"
  | "spec-reviewer"
  | "spec-proofreader"
  | "phase-creator"
  | "phase-reviewer";
```

The `"spec-writer"` value is removed. The orchestration that
the manual spec-writer skill performed is now extension code.
The authoring role is `"spec-author"` to distinguish it from
the former orchestrating skill.

### OrchestratorState

Add fields:

```typescript
export interface OrchestratorState {
  // ... existing fields unchanged
  specStep: SpecStep;
  specConsecutivePasses: number;
  specPhaseFileIndex: number;
  clarificationQuestions: ClarificationQuestion[];
}

export interface ClarificationQuestion {
  question: string;
  suggestedOptions: string[];
}

export type SpecStep =
  | "clarifying"
  | "authoring"
  | "reviewing"
  | "proofreading"
  | "creating-phases"
  | "reviewing-phases"
  | "done";
```

Default `specStep` to `"done"` when `spec.md` already exists
at run start. Default to `"clarifying"` when only `prompt.md`
exists. `specConsecutivePasses` defaults to `0`.
`specPhaseFileIndex` defaults to `0`.

### Configuration

Remove `conductor.models.specWriter`. Add:

- `conductor.models.specAuthor`: `{vendor,family}` object
- `conductor.models.specReviewer`: `{vendor,family}` object
- `conductor.models.specProofreader`: `{vendor,family}`
  object
- `conductor.models.phaseCreator`: `{vendor,family}` object
- `conductor.models.phaseReviewer`: `{vendor,family}` object

### Client Message Types

Add to the webview/server message protocol:

```typescript
| { type: "submit-clarification";
    answers: { question: string; answer: string }[] }
```

---

## I -- Spec-Writing Orchestration

### I1: Skill Loading for Spec-Writing Roles

As the orchestrator, I want prompt assembly for all five
spec-writing roles, so that each invocation loads the
correct skill without requiring a conventions skill.

- `deriveRoleSkillName` returns the role name directly
  for spec-writing roles (no conventions prefix).
- Conventions skill is loaded only for `implementor` and
  `reviewer`. All other roles skip it.
- `stripAgentConductReferences` applies to all loaded
  skills.

Spec-writing role to skill mapping:

| Role | Skill name |
|---|---|
| `spec-author` | `spec-author` |
| `spec-reviewer` | `spec-reviewer` |
| `spec-proofreader` | `spec-proofreader` |
| `phase-creator` | `phase-creator` |
| `phase-reviewer` | `phase-reviewer` |

**File:** `src/llm/prompts.ts`
**Test file:** `src/test/llm/prompts.test.ts`

**Acceptance tests:**

1. Given role `"spec-author"` and empty `conventionsSkill`,
   when `assembleSystemPrompt` called, then result
   contains content from `spec-author/SKILL.md` and no
   error is thrown.
2. Given role `"spec-reviewer"` and `conventionsSkill`
   `"go-conventions"`, when `assembleSystemPrompt` called,
   then result contains `spec-reviewer/SKILL.md` content
   but does NOT contain `go-conventions/SKILL.md` content.
3. Given role `"phase-creator"` and empty
   `conventionsSkill`, when `assembleSystemPrompt` called,
   then result contains `phase-creator/SKILL.md` content
   and tool definitions.
4. Given role `"spec-proofreader"`, when
   `assembleSystemPrompt` called, then result does NOT
   contain any `agent-conduct` references.
5. Given role `"implementor"` and `conventionsSkill`
   `"go-conventions"`, when `assembleSystemPrompt` called,
   then result still contains `go-conventions/SKILL.md`
   content (unchanged from existing behaviour).

### I2: Spec-Writing State Machine

As an extension user, I want Conductor to orchestrate spec
authoring, review, proofreading, phase creation, and phase
review automatically, so that I get a complete spec and
phase files without manual prompting.

The spec-writing workflow runs as "phase 0" before
implementation phases. It activates when `specDir` contains
`prompt.md` but no `spec.md`.

#### Auto-detection

- On `Conductor: Start`, if `spec.md` exists in `specDir`,
  set `specStep` to `"done"` and proceed to
  implementation phase 1 (current behaviour).
- If `prompt.md` exists but `spec.md` does not, set
  `specStep` to `"clarifying"` and begin spec-writing
  with the requirements clarification loop.
- If neither exists, show error: "No spec.md or prompt.md
  found in specDir."

#### Step sequence

1. **Clarifying** (`specStep: "clarifying"`): the
   extension builds a prompt containing the conventions
   skill text, `prompt.md` contents, and the instruction:
   "Research the codebase. Produce 3-5 clarifying
   questions with suggested answer options. If prompt.md
   already addresses everything, return NONE."
   The LLM uses the tool loop to read codebase files.
   - NONE: advance to authoring.
   - Questions: parse questions from LLM response, store
     in `state.clarificationQuestions`. The machine
     awaits user answers (same promise pattern as
     approval). Dashboard/team server renders Q&A form.
     On `submit-clarification`: convert Q&A pairs to
     notes, append to `prompt.md` `## Notes` section,
     clear `clarificationQuestions`, invoke fresh LLM
     with updated `prompt.md`. Repeat until NONE.
   Model: reuse `conductor.models.specAuthor`. No
   separate role in the `Role` union -- the extension
   builds the system prompt internally from the
   conventions skill and a clarification template.
   Audit: log each clarification invocation with label
   `"clarifier"`.

2. **Authoring** (`specStep: "authoring"`): invoke
   `spec-author` role. User prompt includes `prompt.md`
   contents, target `spec.md` path, conventions skill name
   (for the author to reference architecture). LLM uses
   tool loop to research codebase and write `spec.md`.
   On `<done>PASS`, advance to reviewing.

3. **Reviewing** (`specStep: "reviewing"`): invoke
   `spec-reviewer` role. User prompt includes `prompt.md`
   contents (as feature description) and `spec.md` path.
   - PASS: increment `specConsecutivePasses`. If `>= 2`,
     advance to proofreading (or approval if
     `requireApproval`).
   - FAIL: reset `specConsecutivePasses` to `0`. Re-invoke
     `spec-author` with reviewer feedback. Then fresh
     `spec-reviewer`. Counts as retry.

4. **Proofreading** (`specStep: "proofreading"`): invoke
   `spec-proofreader` role. User prompt includes `spec.md`
   path only -- NOT `prompt.md` contents.
   - PASS: increment `specConsecutivePasses`. If `>= 2`,
     advance to creating-phases (or approval).
   - FIXED: reset `specConsecutivePasses` to `0`. Re-invoke
     fresh `spec-proofreader`. Counts as retry.

5. **Creating phases** (`specStep: "creating-phases"`):
   invoke `phase-creator` role. User prompt includes
   `spec.md` path, output directory (`specDir`), and
   implementor/reviewer skill names derived from
   `conventionsSkill`.
   On `<done>PASS`, advance to reviewing-phases.

6. **Reviewing phases** (`specStep: "reviewing-phases"`):
   for each `phase*.md` file in `specDir` (sorted
   numerically), invoke `phase-reviewer` role. User
   prompt includes phase file path and `spec.md` path.
   - PASS: advance `specPhaseFileIndex`, process next
     file.
   - FIXED: re-invoke fresh `phase-reviewer` for same
     file. Counts as retry.
   After all files pass, set `specStep` to `"done"` (or
   approval) and transition to implementation phase 1.

#### Approval checkpoints

When `requireApproval` is true, pause with
`pending-approval` status after:
- Spec reviewing completes (2 consecutive PASSes).
- Spec proofreading completes (2 consecutive PASSes).
- All phase files pass review.

On approve: advance to next step. On reject: re-enter
current step with feedback. On skip: set `specStep` to
`"done"`, proceed to implementation.

#### Error handling

Retry up to `maxRetries` per step. After exhaustion, set
`specStep` to the failing step, `status` to `"error"`,
and log audit entry with `result: "error"`.

Pause/resume works identically to implementation: save
`specStep` and counters to `state.json`, reload on resume.

**File:** `src/orchestrator/machine.ts`
**Test file:** `src/test/orchestrator/machine.test.ts`

**Acceptance tests:**

1. Given `specDir` with `prompt.md` but no `spec.md`, when
   `Conductor: Start` executes, then `state.specStep` is
   `"clarifying"` and the clarification LLM is invoked
   with `prompt.md` contents and conventions skill text.
2. Given `specDir` with both `spec.md` and `prompt.md`,
   when `Conductor: Start` executes, then
   `state.specStep` is `"done"` and machine proceeds to
   implementation phase 1.
3. Given `specDir` with neither file, when
   `Conductor: Start` executes, then error message shown
   and run does not start.
4. Given clarification returns NONE on first invocation,
   then `specStep` advances to `"authoring"` and
   `spec-author` role is invoked.
5. Given spec-author completes (`<done>PASS`), then
   `specStep` advances to `"reviewing"` and
   `spec-reviewer` role is invoked with `prompt.md`
   contents in user prompt.
6. Given spec-reviewer returns PASS twice consecutively,
   then `specConsecutivePasses` reaches `2` and
   `specStep` advances to `"proofreading"`.
7. Given spec-reviewer returns FAIL, then
   `specConsecutivePasses` resets to `0`, `spec-author`
   re-invoked with reviewer feedback, then fresh
   `spec-reviewer` invoked.
8. Given spec-proofreader returns PASS twice
   consecutively, then `specStep` advances to
   `"creating-phases"`.
9. Given spec-proofreader returns FIXED, then
   `specConsecutivePasses` resets to `0` and fresh
   `spec-proofreader` invoked.
10. Given spec-proofreader user prompt, then it contains
    `spec.md` path but does NOT contain `prompt.md`
    contents.
11. Given phase-creator completes, then `specStep`
    advances to `"reviewing-phases"` and
    `specPhaseFileIndex` is `0`.
12. Given 2 phase files and phase-reviewer returns PASS
    for both, then `specPhaseFileIndex` reaches `2` and
    `specStep` advances to `"done"`.
13. Given phase-reviewer returns FIXED for phase 1, then
    same file re-reviewed with fresh `phase-reviewer`
    invocation.
14. Given `specStep` is `"done"` after spec-writing, then
    machine transitions to implementation phase 1 and
    invokes `implementor` role for the first unchecked
    item.
15. Given `requireApproval: true` and spec review reaching
    2 PASSes, then status is `"pending-approval"`. When
    `approve` called, then `specStep` advances to
    `"proofreading"`.
16. Given `requireApproval: true` and approval rejected
    with feedback, then `specConsecutivePasses` resets to
    `0` and `spec-author` re-invoked with rejection
    feedback.
17. Given `maxRetries: 2` and spec-reviewer always returns
    FAIL, then after 2 retries `status` is `"error"` and
    audit has FAIL entries for `spec-reviewer` role.
18. Given running spec-writing, when `pause()` called,
    then `state.json` contains current `specStep` and
    `specConsecutivePasses`. When `resume()` called, then
    machine continues from saved `specStep`.
19. Given `specStep` is `"reviewing-phases"` and
    `specPhaseFileIndex` is `1`, when paused and resumed,
    then phase review continues from file index `1`.
20. Given `spec-author` role invoked and completes, then
    `audit.md` contains an entry with role `"spec-author"`
    and a transcript file is written to `runs/`.
21. Given `spec-reviewer` role invoked and returns PASS,
    then `audit.md` contains an entry with role
    `"spec-reviewer"` and result `"pass"`.

### I3: Extension Commands for Spec-Writing

As an extension user, I want the Start command to
auto-detect whether spec-writing is needed, so that I
don't need a separate command.

- `Conductor: Start` checks for `spec.md` in `specDir`.
  If absent but `prompt.md` exists, begins spec-writing.
  If `spec.md` exists, begins implementation (current
  behaviour).
- No separate `Conductor: Write Spec` command needed.

**File:** `src/extension.ts`
**Test file:** `src/test/extension.test.ts`

**Acceptance tests:**

1. Given `specDir` with `prompt.md` only, when
   `Conductor: Start` executes, then `state.json`
   contains `specStep: "clarifying"`.
2. Given `specDir` with `spec.md`, when
   `Conductor: Start` executes, then `state.json`
   contains `specStep: "done"` and `status: "running"`.
3. Given `specDir` with neither file, when
   `Conductor: Start` executes, then error message
   `"No spec.md or prompt.md found"` shown and
   `state.json` not created.

### I4: Requirements Clarification Loop

As an extension user, I want the extension to ask
clarifying questions before writing a spec, so that
`prompt.md` captures all requirements without me needing
to anticipate every detail upfront.

The clarification step runs as step 1 of the spec-writing
workflow (before authoring). It uses the same tool-loop
LLM invocation as other steps but with an
extension-built prompt template instead of a skill file.

#### Prompt template

System prompt assembled from:
- Conventions skill text (for architecture context).
- Tool definitions and wire format (same as other roles).
- Instruction: "Read prompt.md. Research the codebase to
  understand what exists. Produce 3-5 clarifying questions
  with suggested answer options that must be answered
  before a spec can be written. Return ONLY the questions
  as a JSON array of `{question, suggestedOptions}`. If
  prompt.md already addresses everything, return NONE."

User prompt: `prompt.md` contents.

#### Question parsing

Parse the LLM response:
- If response contains `NONE` (or empty question array),
  advance `specStep` to `"authoring"`.
- Otherwise, decode the JSON array into
  `ClarificationQuestion[]` and store in
  `state.clarificationQuestions`.

#### Dashboard Q&A flow

When `clarificationQuestions` is non-empty:
- Dashboard/team server renders each question with its
  suggested options and a free-text answer field.
- User submits via `submit-clarification` message with
  `answers: { question, answer }[]`.
- Extension converts each Q&A pair into a concise note
  (direct statement, not raw Q&A) using code-based
  string formatting -- no LLM invocation for conversion.
  Appends to `prompt.md` under a `## Notes` section
  (created on first use).
- Clear `clarificationQuestions`, invoke fresh LLM with
  updated `prompt.md`.
- Repeat until LLM returns NONE.

#### Model and audit

- Model: `conductor.models.specAuthor` (no separate
  config).
- Audit: log each clarification invocation with label
  `"clarifier"`. This label is not a `Role` union
  member -- the audit system accepts string labels.

**File:** `src/orchestrator/machine.ts`,
  `src/llm/prompts.ts`
**Test file:** `src/test/orchestrator/machine.test.ts`

**Acceptance tests:**

1. Given clarification LLM returns a JSON array of 3
   questions with `suggestedOptions`, when response
   parsed, then `state.clarificationQuestions` has
   length 3 and each entry has `question` and
   `suggestedOptions` fields.
2. Given clarification LLM returns NONE, then
   `specStep` advances to `"authoring"` and no
   questions are stored in state.
3. Given clarification LLM returns 3 questions, then
   `state.clarificationQuestions` has length 3 and
   dashboard receives state update with questions.
4. Given user submits answers via
   `submit-clarification` message, then each Q&A pair
   is appended to `prompt.md` `## Notes` section as a
   concise note.
5. Given `prompt.md` has no `## Notes` section, when
   first answers submitted, then `## Notes` section is
   created at end of file.
6. Given `prompt.md` already has `## Notes`, when more
   answers submitted, then new notes are appended below
   existing notes.
7. Given answers submitted, then
   `clarificationQuestions` is cleared and fresh
   clarification LLM invoked with updated `prompt.md`.
8. Given second clarification round returns NONE, then
   `specStep` advances to `"authoring"`.
9. Given `requireApproval: true`, when clarification
   completes (NONE), then NO approval pause -- authoring
   begins immediately (approval gates are after review
   and proofreading, not after clarification).
10. Given clarification LLM invocation, then audit log
    contains entry with label `"clarifier"` and
    transcript file is written.
11. Given `specStep` is `"clarifying"` with pending
    questions, when `pause()` called and `resume()`
    called, then questions are restored from
    `state.json` and dashboard re-renders Q&A form.
12. Given `maxRetries: 2` and clarification LLM always
    fails (tool error), then after 2 retries `status`
    is `"error"`.
13. Given clarification LLM returns malformed JSON (not
    a valid question array), then response is treated
    as NONE and `specStep` advances to `"authoring"`.

---

## J -- Dead Code Removal

### J1: Remove spec-writer Dead Code

As a maintainer, I want unused `spec-writer` plumbing
removed, so that the codebase matches its actual behaviour.

- Remove `"spec-writer"` from `Role` type (replaced by
  `"spec-author"`).
- Remove `conductor.models.specWriter` from
  `package.json` configuration.
- Remove the `if (role === "spec-writer")` branch in
  `deriveRoleSkillName` (replaced by generic direct-name
  handling for all spec-writing roles).
- Update `getModelAssignments` in `extension.ts` to read
  the five new model configs instead of `specWriter`.
- Update all test files referencing `"spec-writer"` role.

**File:** `src/types.ts`, `src/llm/prompts.ts`,
  `src/extension.ts`, `package.json`
**Test file:** `src/test/llm/prompts.test.ts`,
  `src/test/extension.test.ts`

**Acceptance tests:**

1. TypeScript compilation succeeds with `"spec-writer"`
   removed from the `Role` union.
2. `deriveRoleSkillName("spec-author", "")` returns
   `"spec-author"` (no conventions needed).
3. `deriveRoleSkillName("spec-reviewer", "")` returns
   `"spec-reviewer"`.
4. `deriveRoleSkillName("implementor", "go-conventions")`
   still returns `"go-implementor"` (unchanged).
5. `deriveRoleSkillName("implementor", "")` still throws
   (unchanged).
6. `getModelAssignments` returns entries for
   `spec-author`, `spec-reviewer`, `spec-proofreader`,
   `phase-creator`, `phase-reviewer` (not `spec-writer`).

---

## Updated Dashboard and Team Server

### Webview dashboard (G1 update)

- Spec-writing step shown in status area when
  `specStep !== "done"` (e.g. "Spec: reviewing (1/2
  passes)").
- Audit log role filter includes: `spec-author`,
  `spec-reviewer`, `spec-proofreader`, `phase-creator`,
  `phase-reviewer`.
- Approval controls active during spec-writing approval
  checkpoints.
- Clarification Q&A UI: when `specStep` is
  `"clarifying"` and `clarificationQuestions` is
  non-empty, render each question with suggested options
  and a free-text answer field. Submit button sends
  `submit-clarification` message. Section hidden when
  `clarificationQuestions` is empty.

### Browser SPA (H2 update)

- Same additions as webview dashboard.

No new acceptance tests -- existing G1/H2 dashboard tests
cover filter rendering and control wire-up. The new roles
and Q&A form flow through the same rendering paths.

---

## Implementation Order

### Phase 4: Spec-Writing Orchestration (stories I1-J1)

12. **J1** -- Dead code removal. Rename `spec-writer` to
    `spec-author` in types, config, prompts. Sequential.
    Must come first so I1/I2 build on clean types.
13. **I1** -- Skill loading for spec-writing roles. Update
    `deriveRoleSkillName` and `assembleSystemPrompt`.
    Sequential. Needs J1.
14. **I2** -- Spec-writing state machine. Add spec-writing
    phase 0 to orchestrator. Sequential. Needs I1.
15. **I4** -- Requirements clarification loop.
    Clarification prompt template, Q&A dashboard UI,
    `prompt.md` update logic. Sequential. Needs I2.
16. **I3** -- Extension command auto-detection. Update
    Start command. Sequential. Needs I4.
17. **G1/H2 updates** -- Dashboard role filters,
    spec-writing status, and Q&A UI. Sequential.
    Needs I4.

---

## Appendix: Key Decisions

- **No separate `Write Spec` command.** Auto-detection
  from file presence keeps the command surface minimal.
  Users who want to skip spec-writing can create
  `spec.md` manually.
- **Clarification via dashboard.** The Q&A loop uses the
  dashboard/team server UI instead of `ask_questions`.
  Questions rendered as a form; answers appended to
  `prompt.md` `## Notes`. Model reuses `specAuthor` --
  no separate clarifier model config.
- **Proofreader FIXED vs FAIL.** The spec-proofreader
  skill returns FIXED (meaning it edited the file) not
  FAIL. The state machine treats FIXED as "re-check
  needed" same as FAIL resets the consecutive pass
  counter. The distinction is that on FIXED the
  proofreader already applied fixes (no separate author
  re-invocation needed).
- **Phase review: 1-PASS gate.** Phase review follows
  the manual workflow: re-review after FIXED until a
  single clean PASS. No 2-consecutive-PASS requirement
  for phase files.
- **Conventions skill not loaded for spec-writing roles.**
  The spec-author skill reads the conventions skill
  content itself via the tool loop if it needs
  architecture context, rather than having it injected
  into the system prompt.
