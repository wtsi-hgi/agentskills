---
name: bugfix
description: Orchestrates standalone or caller-batched bug fixes via implementor and reviewer subagents using TDD. Reproduces each bug with a red command before fixing it, handles bugs and verified review findings sequentially, tracks them in a dated checklist, and commits each fix without disrupting a surrounding PR-resolution batch.
---

# Bugfix Skill

Read and follow **agent-conduct**, **testing-principles**, and **subagents**
before starting. **subagents** owns delegation: agent choice, briefing, skill
discovery, and error handling. This skill covers only the bugfix procedure.

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
PR caller can map the resulting commit back to the review thread. Record the
red command from step 1 the same way, plus the before screenshot path for a UI
bug, so the reviewer and any later reader can re-run it and compare against
the same evidence.

After each fix is committed, change `- [ ]` to `- [x]` and add indented
bullets summarising files touched and approach. Commit the checklist update
with the fix.

If a distinct issue appears while fixing, reviewing, or running quality gates,
append it to the current checklist as a new unchecked bug with a concise
description and the evidence that exposed it. This includes lint/test gates
that fail for "unrelated", "pre-existing", or flaky reasons. Do not waive,
ignore, skip, or quarantine the failure; process the added bug with the same
fix -> review -> commit loop before treating the checklist as done. If the new
bug blocks the current item's gates, solve the added bug before marking the
current item complete.

**Before starting a new bug, scan prior `.docs/bugfixes/*.md` checklists.**
Their checked items define behaviour that must not regress. A new fix may
only change a previously-fixed behaviour if that prior item is demonstrably
wrong; if so, note the reasoning in the new checklist entry.

## Procedure

Process each bug **sequentially**. Complete fix -> review -> commit before
starting the next.

### For each bug:

#### 1. Build a red feedback loop

Before any fix, you need one command that fails because of this bug. Name it,
run it, and record it under the checklist item with its output. No red
command, no fix. This is the step that decides whether the right bug gets
fixed; spend the effort here.

The command must be:

- **Red-capable:** it drives the real code path and asserts the symptom the
  reporter described, so it fails now and passes once the bug is gone.
  "Runs without erroring" is not a signal.
- **Deterministic:** the same verdict every run. For an intermittent bug, a
  pinned reproduction rate high enough to debug against.
- **Fast:** seconds, not minutes.
- **Agent-runnable:** it needs no human in the loop.

Ways to build one, cheapest first:

1. A failing test at whatever seam reaches the bug.
2. A CLI invocation on a fixture input, diffed against known-good output.
3. An HTTP request against a locally running service.
4. A browser or PTY script that drives the app and asserts on what it shows.
5. A replay of a captured payload, trace, or event log through the code path.
6. A throwaway harness that calls the failing path directly.
7. A loop over many repeated or randomised inputs, for "sometimes wrong" bugs.
8. A differential run of two versions or configs, diffing the outputs.

**Web UI, visual, and interactive bugs take route 4, and the red evidence is a
screenshot.** A cheaper route cannot prove a perceptual symptom, per
**testing-principles** § Perceptual Requirements. Drive the real app in a
browser with the project's browser tooling (its Playwright or Puppeteer setup,
or a CDP session against the running dev server), extend the project's dev
fixtures (e.g. `make dev-fixtures`) until the buggy state is reachable, and
capture a screenshot of it. Where the project has a verify skill (see
**verification**), use its Drive recipe rather than inventing one.

That screenshot is the before image. Keep it, record its path in the
checklist, and hand it to the implementor and the reviewer so the after
comparison is against the same fixture and the same viewport. The fixture
extension is part of the fix: commit it with the change. Where the assertion
can be made machine-checkable (pixel or contrast sampling, a bounding-box
measurement), add that to the drive script as well, so the loop has a verdict
and not only an image.

Then tighten it. Cut setup, aim the assertion at the exact symptom, and remove
nondeterminism by controlling clocks, randomness, ordering, and external
services. A two-second deterministic loop is worth far more than a
thirty-second flaky one. For an intermittent bug the goal is a higher
reproduction rate, not a clean single run: loop the trigger, add load, narrow
the timing window until the rate is high enough to debug against.

Once it is red, shrink the scenario until every remaining element is
load-bearing, so removing any one of them makes it pass. That minimal case is
what the regression test encodes.

If no loop can be built, that is a blocker, not a licence to guess. Per
**agent-conduct**, stop, leave the item unchecked, record what you tried, and
ask the user for the environment that reproduces it, a captured artifact, or
the missing access. Do not brief an implementor to fix a bug nobody can
observe failing.

#### 2. Fix (implementor subagent)

Brief an implementor subagent with:

- Conventions, testing-principles, and implementor skill paths.
- Bug description, the red command with its failing output, the minimal
  repro, relevant paths, and the discovered quality gate commands. For a UI
  bug, also the before screenshot path, the fixture command that reaches the
  buggy state, and the viewport it was captured at.
- Paths to prior bugfix checklists; instruction not to break, bypass, or
  weaken any existing regression test unless explicitly justified per the
  rule above.
- Instruction: "Run the red command first and confirm it fails for the stated
  reason. Follow TDD and **testing-principles**. Add a behavioural regression
  test encoding the minimal repro when testing-principles calls for one, then
  fix the cause so both the test and the red command pass. Do not modify
  unrelated tests. Run the project's lint and test
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
- Bug description, the red command, list of changed files, prior bugfix
  checklist paths, and the quality gate commands.
- Instruction: "Clean context. Read all changed source and test files.
  Verify: (a) the recorded red command now passes (run it); (b) test strategy
  follows **testing-principles** and the regression test encodes the minimal
  repro; (c) the fix addresses the cause rather than suppressing the symptom,
  and is minimal; (d) no prior regression test was deleted, skipped, or
  weakened; (e) the project's lint and test commands pass (run them); (f) for
  a web UI or otherwise visual bug, drive the app yourself from the same
  fixture and viewport, capture a post-fix screenshot, and compare it against
  the before image: the reported symptom is gone and nothing else visibly
  regressed. A green test suite alone does not satisfy (f). If any gate fails
  for an unrelated, pre-existing, or flaky reason, return FAIL and identify it
  as a newly discovered checklist bug. Return PASS or FAIL with specific
  feedback."

**PASS ->** step 4. **FAIL ->** new implementor with feedback, then new
reviewer. Max 5 cycles; if still failing, note the problem under the
checklist item (unchecked), revert, move on.

Watch for flip-flopping across cycles (fix A re-breaks B). If you see it,
brief the next implementor explicitly on which behaviours must coexist.

#### 4. Commit and update checklist

Update the checklist (`- [x]` plus indented summary). `git add` the changed
files plus the checklist. Commit with a short imperative message
(max 72 chars), e.g. `Fix off-by-one in batch size calculation`.

In standalone mode, do not `git push` unless the user asked. In batched-caller
mode, never push. Do NOT ask for confirmation. Proceed to the next bug.

### After all bugs

Report the checklist path, each item's outcome, and its commit SHA. For a
batched caller, also return the source metadata unchanged so it can reply to
and resolve the correct review threads after pushing.

## Rules

- Follow **subagents** rules (no direct implementation, always writable
  subagents, etc.).
- Always create the dated checklist, even for one bug.
- Always have a red command before briefing an implementor. A bug nobody can
  reproduce is a blocker to report, not a fix to attempt.
- Do not `git push` unless the user asked for it and this is standalone. A
  batched caller always owns pushing, even when the user's overall request
  includes a push. Never push to `master`, `main`, or `develop`.
- One fix-review-commit cycle at a time.
