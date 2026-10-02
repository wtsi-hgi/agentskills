---
name: bugfix
description: "Orchestrates standalone or caller-batched bug fixes via implementor and reviewer subagents using TDD. Reproduces each bug with a red command before fixing it, handles bugs and verified review findings sequentially, tracks them in branch-owned checklists, and routes incidental issues without disrupting the current task."
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
  explicitly asked or **agent-conduct**'s standing rebase authorization applies.
  A dependency publication hold in [routing](references/incidental-issues.md)
  keeps the branch local even under that standing authorization.
- **Batched caller (for example, pr-resolver):** Own the checklist and commits,
  but never push, reply to reviews, resolve threads, or wait on remote events.
  Return control after the local queue is drained. The caller owns one batched
  push and all remote state. Reuse one checklist for the caller's whole active
  session; append later findings instead of starting another bugfix workflow.

If the user reports another bug while this workflow is active, append it to the
current queue and checklist. Finish the current fix-review-commit cycle, then
process the new item before returning to the caller. Do not start a parallel
bugfix workflow or push an incomplete batch.

Before starting, establish the queue owner using
[incidental issue routing](references/incidental-issues.md). Apply it whenever
another issue appears and again at completion. A batched caller's local queue
contains only work routed to its current branch; return deferred items to the
owner without processing them.

## Discover Quality Gates (once, up front)

Before fixing anything, read `README.md`, `Makefile`/`justfile`/`package.json`
scripts, and any CONTRIBUTING doc to identify the project's lint, test, and
fixture/dev commands (e.g. `make lint`, `make test`, `make dev-fixtures`,
`npm run lint`). Discover performance commands and applicability using
[gate policy](../implementation-principles/references/performance-gates.md).
Record exact commands, scope, policy, and base evidence and pass them with
that reference to every implementor and reviewer. Reassess applicability as
the diff or base changes. Subagents must run applicable project gates, not
invent their own; required performance regressions remain current work.

## Checklist File

Reuse a supplied or existing checklist only when its `Branch` metadata matches
the current branch and it belongs to this workflow. An inherited checklist
from another branch is history, not the active ledger. Otherwise create
`.docs/bugfixes/<YYMMDD>-<short-slug>-<id>.md`, with a readable task slug and an
independently generated random ID, such as `uuid.uuid4().hex`. Generate the
name once and retain it on resume. Never choose a next-free number.

Record `Branch`, resolved `Base` ref and SHA, and queue owner branch/checklist
in the header. For a dependent local branch, include the dependency and
publication hold metadata from [routing](references/incidental-issues.md).
Use repository-relative paths in committed metadata and evidence, never
absolute workspace paths. Write each bug verbatim except for secret or
personal-data redactions:

```markdown
- [ ] <bug description, verbatim>
  - Source: <caller metadata, if supplied>
```

Record the red command and before screenshot path under its item. On success,
check the item and add the files touched and approach before committing the
checklist with the fix. Deferred entries carry the branch and committed entry
reference required by [routing](references/incidental-issues.md); they are
handoffs, not successful fixes.

**Before starting a new bug, scan prior `.docs/bugfixes/*.md` checklists.**
Their checked items define behaviour that must not regress. A new fix may
only change a previously-fixed behaviour if that prior item is demonstrably
wrong; if so, note the reasoning in the new checklist entry.

## Evidence hygiene

These rules govern evidence copied into repository files or added to a commit.
They do not restrict terminal or subagent output that stays outside the
repository.

- Before writing evidence, redact credentials, tokens, cookies, personal data,
  private payload fields, and unrelated environment values. Preserve the
  failure's meaning and mark each replacement `[REDACTED]`. Evidence supplied
  by a caller is verbatim after redaction, not before it.
- In the checklist, record the command, its exit status, and the smallest
  output excerpt that proves the failure. Cap the excerpt at 80 lines and 8
  KiB. Do not copy larger logs, traces, response bodies, or payloads into the
  repository.
- Reach visual states with synthetic fixtures. Sanitize any image before
  adding it to the repository.
- Follow the project's evidence policy. With none, commit only the sanitized
  before and after images needed to review a perceptual bug, each no larger
  than 5 MiB. Keep bounded text evidence in the checklist.

## Procedure

Process each bug **sequentially**. Complete fix -> review -> commit before
starting the next, except when a discovered blocker prevents completion.
Pause the affected item, resolve the blocker first, then resume and rerun the
item's checks.

### For each bug:

#### 1. Build a red feedback loop

Before any fix, you need one command that fails because of this bug. Name it,
run it, and record it under the checklist item with its output, redacted per
Evidence hygiene. No red command, no fix. This is the step that decides
whether the right bug gets fixed; spend the effort here.

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
- Bug description, the red command with its bounded failing output,
  the minimal repro, relevant paths, and the discovered quality gate commands.
  For a UI bug, also the before screenshot path, the fixture command that
  reaches the buggy state, and the viewport it was captured at.
- Paths to prior bugfix checklists; instruction not to break, bypass, or
  weaken any existing regression test unless explicitly justified per the
  rule above.
- Instruction: "Run the red command first and confirm it fails for the stated
  reason. Follow TDD and **testing-principles**. Add a behavioural regression
  test encoding the minimal repro when testing-principles calls for one, then
  fix the cause so both the test and the red command pass. Do not modify
  unrelated tests. Run the project's applicable quality gates, including
  required performance comparisons; all must pass. Report distinct incidental
  issues to the caller for routing, including unrelated, pre-existing, or flaky
  gate failures.
  Required gates still must pass; do not skip or quarantine them. Do not paper
  over, work around, or fake a fix (see agent-conduct § Honesty About Blockers).
  If the bug cannot be fixed due to an outside constraint, revert and report
  the blocker with reasoning and 1-3 alternatives - do not commit code."

If the subagent reports it cannot reproduce, cannot fix, or hits a
blocker, leave the checklist item **unchecked**, add indented notes
under it explaining the issue and any proposed alternatives, revert any
changes made solely for that failed attempt, and continue only independent
current-branch items. Preserve pre-existing work. Do not retry with "try
harder" wording. A required red gate still blocks completion.

#### 3. Review (reviewer subagent)

Brief a reviewer subagent with:

- Conventions, testing-principles, and reviewer skill paths.
- Bug description, the red command and its bounded evidence, list
  of changed files, prior bugfix checklist paths, and the quality gate
  commands.
- Instruction: "Clean context. Read all changed source and test files.
  Verify: (a) the recorded red command now passes (run it); (b) test strategy
  follows **testing-principles** and the regression test encodes the minimal
  repro; (c) the fix addresses the cause rather than suppressing the symptom,
  and is minimal; (d) no prior regression test was deleted, skipped, or
  weakened; (e) the project's lint and test commands pass (run them), and
  required performance evidence fits the current revision and changed scope
  per the supplied performance reference; (f) for a web UI or otherwise visual
  bug, drive the app yourself from the same
  fixture and viewport, capture a post-fix screenshot, and compare it against
  the before image: the reported symptom is gone and nothing else visibly
  regressed. A green test suite alone does not satisfy (f). If any gate fails
  for an unrelated, pre-existing, or flaky reason, return FAIL and identify it
  as a newly discovered checklist bug. Return PASS or FAIL with specific
  feedback."

**PASS ->** step 4. **FAIL ->** new implementor with feedback, then new
reviewer. Route distinct incidental findings before the next cycle; keep
feedback about the current fix in this cycle. Max 5 cycles; if still failing,
leave the item unchecked, revert only that attempt's changes, and continue
only independent current-branch items.

Watch for flip-flopping across cycles (fix A re-breaks B). If you see it,
brief the next implementor explicitly on which behaviours must coexist.

#### 4. Commit and update checklist

Update the checklist (`- [x]` plus indented summary). `git add` the changed
files plus the checklist. Commit with a short imperative message
(max 72 chars), e.g. `Fix off-by-one in batch size calculation`.

Follow the invocation mode's push rules. In batched-caller mode, the caller
also owns any rebase and force-push required by **agent-conduct**. Do NOT ask
for confirmation. Proceed to the next bug.

### After all bugs

Apply [queue completion](references/incidental-issues.md#finish-or-stop): only
the outermost owner drains deferred branches, after its current work succeeds.
Report the checklist path, each item's outcome and commit SHA, and any pending
branch/entry references. Include performance applicability and comparison
evidence for the caller's PR body. For a batched caller, return source metadata
unchanged so it can reply to the correct review threads after pushing.

## Rules

- Follow **subagents** rules (no direct implementation, always writable
  subagents, etc.).
- Always create the dated checklist, even for one bug.
- Always have a red command before briefing an implementor. A bug nobody can
  reproduce is a blocker to report, not a fix to attempt.
- Follow the invocation mode's push rules and **agent-conduct** Git Safety.
  A batched caller always owns pushing, including authorized force-pushes.
- One fix-review-commit cycle at a time.
