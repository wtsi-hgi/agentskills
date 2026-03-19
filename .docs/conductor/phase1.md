# Phase 1: Core Extension

Ref: [spec.md](spec.md) sections A1, B1, B2, C1, C2, D1,
D2, E1, F1

## Instructions

Use the `orchestrator` skill to complete this phase,
coordinating subagents with the `implementor` and
`reviewer` skills.

## Items

### Item 1.1: A1 - Extension Activation and Commands

spec.md section: A1

Scaffold the VS Code extension entry point in
`src/extension.ts` with `activate`/`deactivate`, register
commands (Start, Pause, Resume, Status, Dashboard), define
`contributes.configuration` settings in `package.json`,
implement crash-recovery resume prompt, and create shared
types in `src/types.ts`. Test file:
`src/test/extension.test.ts`, covering all 9 acceptance
tests from A1.

- [ ] implemented
- [x] implemented
- [ ] reviewed
- [x] reviewed
- [x] reviewed
- [x] reviewed
- [x] reviewed
- [x] reviewed

### Batch 1 (parallel)

#### Item 1.2: B1 - Tool Schema and Dispatch [parallel]

spec.md section: B1

Implement `getToolDefinitions` and `formatToolsForPrompt`
in `src/tools/schema.ts` and `dispatchTool` in
`src/tools/dispatch.ts` for Read, Edit, Write, Grep, Glob
tools with path-traversal protection. Test file:
`src/test/tools/dispatch.test.ts`, covering all 10
acceptance tests from B1.

- [ ] implemented
- [x] implemented
- [ ] reviewed
- [x] reviewed

#### Item 1.3: B2 - Bash Tool with Security Enforcement [parallel]

spec.md section: B2

Implement `executeBash` and `validateBashCommand` in
`src/tools/bash.ts` enforcing rejection of sudo, git push,
interactive commands, and paths outside projectDir, plus
timeout enforcement. Test file:
`src/test/tools/bash.test.ts`, covering all 7 acceptance
tests from B2.

- [ ] implemented
- [x] implemented
- [ ] reviewed
- [x] reviewed

#### Item 1.4: C1 - Model Selection and Prompt Assembly [parallel]

spec.md section: C1

Implement `selectModelForRole` in `src/llm/select.ts`,
`assembleSystemPrompt` in `src/llm/prompts.ts`, and
`loadSkill`/`discoverSkills` in `src/skills/loader.ts`.
Depends on A1 configuration settings. Test files:
`src/test/llm/select.test.ts`,
`src/test/llm/prompts.test.ts`, covering all 7 acceptance
tests from C1.

- [ ] implemented
- [x] implemented
- [ ] reviewed
- [x] reviewed

#### Item 1.5: D1 - Phase File Parser [parallel]

spec.md section: D1

Implement `parsePhaseFile` in `src/orchestrator/parser.ts`
to extract phase number, title, items with
IDs/titles/spec-section refs, checkbox state, and parallel
batch grouping. Test file:
`src/test/orchestrator/parser.test.ts`, covering all 5
acceptance tests from D1.

- [ ] implemented
- [x] implemented
- [ ] reviewed
- [x] reviewed

#### Item 1.6: E1 - State, Audit, Addendum, and Transcripts [parallel]

spec.md section: E1

Implement `loadState`/`saveState` in
`src/state/persistence.ts`, `appendAudit`/`readAudit` in
`src/state/audit.ts`, `appendAddendum` in
`src/state/addendum.ts`, and
`saveTranscript`/`loadTranscript` in
`src/state/transcript.ts`. All files under `.conductor/`
directory. Test files:
`src/test/state/persistence.test.ts`,
`src/test/state/audit.test.ts`,
`src/test/state/addendum.test.ts`,
`src/test/state/transcript.test.ts`, covering all 8
acceptance tests from E1.

- [ ] implemented
- [x] implemented
- [ ] reviewed

For parallel batch items, use separate subagents per item.
Launch review subagents using the `reviewer` skill (review
all items in the batch together in a single review pass).

### Item 1.7: C2 - Tool-Loop Invocation Engine

spec.md section: C2

Implement `invokeWithToolLoop`, `parseToolCalls`,
`parseDoneSignal`, and `parseAddendum` in
`src/llm/invoke.ts`. Streams model responses, extracts
`<tool_call>` blocks, dispatches via `dispatchTool`,
handles `<done>` and `<addendum>` markers, enforces
maxTurns, and retries on LLM API errors. Depends on
items 1.2 (B1), 1.3 (B2), and 1.4 (C1). Test file:
`src/test/llm/invoke.test.ts`, covering all 11 acceptance
tests from C2.

- [ ] implemented
- [x] implemented
- [ ] reviewed

### Item 1.8: D2 - Orchestration State Machine

spec.md section: D2

Implement `createOrchestrator` returning an `Orchestrator`
interface in `src/orchestrator/machine.ts` with the full
implement-test-review-retry cycle, 2-consecutive-PASS gate,
parallel batch execution, pause/resume,
skip/retry/approve/reject/changeModel/addNote controls.
Depends on items 1.5 (D1), 1.6 (E1), and 1.7 (C2). Test
file: `src/test/orchestrator/machine.test.ts`, covering
all 18 acceptance tests from D2.

- [ ] implemented
- [x] implemented
- [ ] reviewed

### Item 1.9: F1 - TreeView Provider

spec.md section: F1

Implement `ConductorTreeProvider` and `ConductorTreeItem`
in `src/views/treeProvider.ts` with phase/item tree nodes,
status icons, tooltips, and refresh on `onStateChange`
events. Depends on item 1.8 (D2) for orchestrator state.
Test file: `src/test/views/treeProvider.test.ts`, covering
all 5 acceptance tests from F1.

- [ ] implemented
- [x] implemented
- [ ] reviewed
