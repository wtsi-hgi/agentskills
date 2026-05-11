---
name: bugfix
description: Orchestrates bug fixes via implementor and reviewer subagents using TDD. Handles one or many bugs sequentially, tracks them in a dated checklist, and auto-commits each fix.
---

# Bugfix Skill

Read and follow **agent-conduct** and **subagents** before starting.
**subagents** covers orchestrator role, agent selection (always writable),
briefing, skill discovery, and error handling. This skill covers only the
bugfix-specific procedure.

## Input

One or more bug descriptions. Parse into a numbered list of discrete issues.
Same procedure whether one bug or many.

Interpret reports by intent, not literally. Separate **visual** complaints
("this box is ugly") from **layout** requirements: hiding an element
visually is fine if it still serves sizing/layout. Don't delete structure
that other things depend on.

## Discover Quality Gates (once, up front)

Before fixing anything, read `README.md`, `Makefile`/`justfile`/`package.json`
scripts, and any CONTRIBUTING doc to identify the project's lint, test, and
fixture/dev commands (e.g. `make lint`, `make test`, `make dev-fixtures`,
`npm run lint`). Record the exact commands and pass them to every subagent.
Subagents must run these gates, not invent their own.

## Checklist File

Create `.docs/bugfixes/<YYMMDD>-<N>.md` (smallest `N` not already taken;
create `.docs/bugfixes/` if missing). Write each bug verbatim:

```
- [ ] <bug 1 description, verbatim>
- [ ] <bug 2 description, verbatim>
```

After each fix is committed, change `- [ ]` to `- [x]` and add indented
bullets summarising files touched and approach. Commit the checklist update
with the fix.

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

- Conventions and implementor skill paths.
- Bug description, repro steps, relevant paths, and the discovered quality
  gate commands.
- Paths to prior bugfix checklists; instruction not to break, bypass, or
  weaken any existing regression test unless explicitly justified per the
  rule above.
- Instruction: "Follow TDD. Add a **behavioural regression test** that
  fails for this bug, then fix the code so it passes. Do not modify
  unrelated tests. Run the project's lint and test commands; both must
  pass. Do not paper over, work around, or fake a fix (see agent-conduct
  § Honesty About Blockers). If the bug cannot be fixed due to an
  outside constraint, revert and report the blocker with reasoning and
  1-3 alternatives - do not commit code."

If the subagent reports it cannot reproduce, cannot fix, or hits a
blocker, leave the checklist item **unchecked**, add indented notes
under it explaining the issue and any proposed alternatives, revert any
partial changes, and move to the next bug. Do not retry with "try
harder" wording.

#### 3. Review (reviewer subagent)

Brief a reviewer subagent with:

- Conventions and reviewer skill paths.
- Bug description, list of changed files, prior bugfix checklist paths, and
  the quality gate commands.
- Instruction: "Clean context. Read all changed source and test files.
  Verify: (a) a regression test exists that fails without the fix; (b) the
  fix is minimal and correct; (c) no prior regression test was deleted,
  skipped, or weakened; (d) the project's lint and test commands pass
  (run them); (e) for UI bugs, a post-fix screenshot from the same fixture
  shows the issue resolved with no visible regressions elsewhere. Return
  PASS or FAIL with specific feedback."

**PASS →** step 4. **FAIL →** new implementor with feedback, then new
reviewer. Max 5 cycles; if still failing, note the problem under the
checklist item (unchecked), revert, move on.

Watch for flip-flopping across cycles (fix A re-breaks B). If you see it,
brief the next implementor explicitly on which behaviours must coexist.

#### 4. Commit and update checklist

Update the checklist (`- [x]` plus indented summary). `git add` the changed
files plus the checklist. Commit with a short imperative message
(≤72 chars), e.g. `Fix off-by-one in batch size calculation`.

Do NOT `git push`. Do NOT ask for confirmation — proceed to the next bug.

### After all bugs

Report the checklist path and a summary of commits.

## Rules

- Follow **subagents** rules (no direct implementation, always writable
  subagents, etc.).
- Always create the dated checklist, even for one bug.
- NEVER `git push`.
- One fix-review-commit cycle at a time.
