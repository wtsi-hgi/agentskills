---
name: bugfix
description: Orchestrates standalone or caller-batched bug fixes via implementor and reviewer subagents using TDD. Handles bugs and verified review findings sequentially, tracks them in a dated checklist, and commits each fix without disrupting a surrounding PR-resolution batch.
---

# Bugfix Skill

Read and follow **agent-conduct**, **testing-principles**, and **subagents**
before starting.
**subagents** covers orchestrator role, agent selection (always writable),
briefing, skill discovery, and error handling. This skill covers only the
bugfix-specific procedure.

## Input

One or more bug descriptions. Parse into a numbered list of discrete issues.
Same procedure whether one bug or many.

An issue may come from the user, a failed quality gate, or a verified PR review
finding. Preserve the original description and any source metadata supplied by
the caller, such as a PR thread ID. Source metadata is bookkeeping only; verify
and fix the underlying behaviour in the same way as any other bug.

Interpret reports by intent, not literally. Separate **visual** complaints
("this box is ugly") from **layout** requirements: hiding an element
visually is fine if it still serves sizing/layout. Don't delete structure
that other things depend on.

## Invocation mode

- **Standalone:** Own the checklist and commits. Do not push unless the user
  explicitly asked.
- **Batched caller (for example, pr-resolver):** Own the checklist and commits,
  but never push, reply to reviews, resolve threads, or wait on remote events.
  Return control after the local queue is drained. The caller owns one batched
  push and all remote state. Reuse one checklist for the caller's whole active
  session; append later findings instead of starting another bugfix workflow.

If the user reports another bug while this workflow is active, append it to the
current queue and checklist. Finish the current fix-review-commit cycle, then
process the new item before returning to the caller. Do not start a parallel
bugfix workflow or push an incomplete batch.

## Discover Quality Gates (once, up front)

Before fixing anything, read `README.md`, `Makefile`/`justfile`/`package.json`
scripts, and any CONTRIBUTING doc to identify the project's lint, test, and
fixture/dev commands (e.g. `make lint`, `make test`, `make dev-fixtures`,
`npm run lint`). Record the exact commands and pass them to every subagent.
Subagents must run these gates, not invent their own.

## Checklist File

If a batched caller supplies its active checklist, append to it. Otherwise
create `.docs/bugfixes/<YYMMDD>-<N>.md` (smallest `N` not already taken; create
`.docs/bugfixes/` if missing). Write each bug verbatim:

```
- [ ] <bug 1 description, verbatim>
- [ ] <bug 2 description, verbatim>
```

Put caller-supplied source metadata in an indented bullet under its item so a
PR caller can map the resulting commit back to the review thread.

After each fix is committed, change `- [ ]` to `- [x]` and add indented
bullets summarising files touched and approach. Commit the checklist update
with the fix.

If a distinct issue appears while fixing, reviewing, or running quality gates,
append it to the current checklist as a new unchecked bug with a concise
description and the evidence that exposed it. This includes lint/test gates
that fail for "unrelated", "pre-existing", or flaky reasons. Do not waive,
ignore, skip, or quarantine the failure; process the added bug with the same
fix → review → commit loop before treating the checklist as done. If the new
bug blocks the current item's gates, solve the added bug before marking the
current item complete.

**Before starting a new bug, scan prior `.docs/bugfixes/*.md` checklists.**
Their checked items define behaviour that must not regress. A new fix may
only change a previously-fixed behaviour if that prior item is demonstrably
wrong; if so, note the reasoning in the new checklist entry.

## Procedure

Process each bug **sequentially**. Complete fix → review → commit before
starting the next.

### For each bug:

#### 1. Reproduce first (UI bugs)

If the bug is visual or interactive, brief an implementor subagent to:

- Extend the dev fixtures (e.g. `make dev-fixtures`) so the buggy state is
  reachable.
- Capture a screenshot demonstrating the issue.
- Stop there and report the fixture changes and screenshot path.

Keep the screenshot for comparison. The fixture extension is part of the
fix and should be committed with it.

#### 2. Fix (implementor subagent)

Brief an implementor subagent with:

- Conventions, testing-principles, and implementor skill paths.
- Bug description, repro steps, relevant paths, and the discovered quality
  gate commands.
- Paths to prior bugfix checklists; instruction not to break, bypass, or
  weaken any existing regression test unless explicitly justified per the
  rule above.
- Instruction: "Follow TDD and **testing-principles**. Add a behavioural
  regression test when testing-principles calls for one, then fix the code so
  it passes. Do not modify unrelated tests. Run the project's lint and test
  commands; both must pass. If any gate fails for an unrelated, pre-existing,
  or flaky reason, report it as a newly discovered bug for the checklist; do
  not skip or quarantine it. Do not paper over, work around, or fake a fix (see
  agent-conduct § Honesty About Blockers). If the bug cannot be fixed due to an
  outside constraint, revert and report the blocker with reasoning and 1-3
  alternatives - do not commit code."

If the subagent reports it cannot reproduce, cannot fix, or hits a
blocker, leave the checklist item **unchecked**, add indented notes
under it explaining the issue and any proposed alternatives, revert any
partial changes, and move to the next bug. Do not retry with "try
harder" wording.

#### 3. Review (reviewer subagent)

Brief a reviewer subagent with:

- Conventions, testing-principles, and reviewer skill paths.
- Bug description, list of changed files, prior bugfix checklist paths, and
  the quality gate commands.
- Instruction: "Clean context. Read all changed source and test files.
  Verify: (a) test strategy follows **testing-principles**; (b) the fix is
  minimal and correct; (c) no prior regression test was deleted, skipped, or
  weakened; (d) the project's lint and test commands pass (run them); (e) for
  UI bugs, a post-fix screenshot from the same fixture shows the issue resolved
  with no visible regressions elsewhere. If any gate fails for an unrelated,
  pre-existing, or flaky reason, return FAIL and identify it as a newly
  discovered checklist bug. Return PASS or FAIL with specific feedback."

**PASS →** step 4. **FAIL →** new implementor with feedback, then new
reviewer. Max 5 cycles; if still failing, note the problem under the
checklist item (unchecked), revert, move on.

Watch for flip-flopping across cycles (fix A re-breaks B). If you see it,
brief the next implementor explicitly on which behaviours must coexist.

#### 4. Commit and update checklist

Update the checklist (`- [x]` plus indented summary). `git add` the changed
files plus the checklist. Commit with a short imperative message
(≤72 chars), e.g. `Fix off-by-one in batch size calculation`.

In standalone mode, do not `git push` unless the user asked. In batched-caller
mode, never push. Do NOT ask for confirmation — proceed to the next bug.

### After all bugs

Report the checklist path, each item's outcome, and its commit SHA. For a
batched caller, also return the source metadata unchanged so it can reply to
and resolve the correct review threads after pushing.

## Rules

- Follow **subagents** rules (no direct implementation, always writable
  subagents, etc.).
- Always create the dated checklist, even for one bug.
- Do not `git push` unless the user asked for it and this is standalone. A
  batched caller always owns pushing, even when the user's overall request
  includes a push. Never push to `master`, `main`, or `develop`.
- One fix-review-commit cycle at a time.
