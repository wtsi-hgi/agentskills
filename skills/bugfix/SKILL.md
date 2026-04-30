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

One or more bug descriptions (from the user, an issue tracker, or a paste).
Parse them into a numbered list of discrete issues. Apply the same procedure
whether there is one bug or many.

## Checklist File

At the start of every invocation, create a checklist file at
`.docs/bugfixes/<YYMMDD>-<N>.md`, where `<YYMMDD>` is today's date and `<N>`
is the smallest positive integer that yields a path not already present.
Create the `.docs/bugfixes/` directory if missing.

Write the bugs verbatim as a GitHub-style checklist:

```
- [ ] <bug 1 description, verbatim>
- [ ] <bug 2 description, verbatim>
```

As each bug is completed (after commit), update its entry to `- [x]` and add
indented bullets summarising the fix (files touched, approach). Commit the
checklist update together with the fix.

## Procedure

Process each bug **sequentially**. Complete the full cycle (fix → review →
commit) for one bug before starting the next.

### For each bug:

#### 1. Fix (implementor subagent)

Launch an implementor subagent with:

- Conventions and implementor skill paths (to read).
- The bug description and any relevant file paths or reproduction steps.
- Instruction: "Read the conventions skill. Investigate the bug. Write a
  **regression test that fails** demonstrating the bug, then fix the code so
  the test passes. Follow the TDD cycle. Run tests and linters."

If the subagent reports it cannot reproduce or fix the bug, note the details of
this as indented bullets under the checklist item, do not check the item, and
move on to the next bug after reverting any other changes.

#### 2. Review (reviewer subagent)

Launch a reviewer subagent with:

- Conventions and reviewer skill paths (to read).
- The bug description and list of changed files.
- Instruction: "You have clean context. Read all changed source and test
  files. Verify: (a) a regression test exists that would fail without the
  fix, (b) the fix is correct and minimal, (c) all tests pass, (d) linter is
  clean. Return PASS or FAIL with specific feedback."

**PASS →** proceed to step 3.
**FAIL →** launch a new implementor subagent with the reviewer feedback, then
a fresh reviewer. Repeat until PASS (max 5 cycles; if still failing, note the
problem under the checklist item, do not check the item, and move on to the
next bug after reverting any other changes).

#### 3. Commit and update checklist

Update the checklist: change the bug's `- [ ]` to `- [x]` and append indented
bullets summarising the fix. Stage the files changed for this bug plus the
checklist file with `git add <files>`. Commit with a short imperative message
(max 72 chars) describing the bug fixed, e.g.
`Fix off-by-one in batch size calculation`.

Do NOT run `git push`. Do NOT ask the user for confirmation — proceed
straight to the next bug.

### After all bugs

Report completion with the checklist path and a summary of commits made.

## Rules

- Follow the rules in **subagents** (no direct implementation, no read-only
  agents for writing work, etc.).
- Always create the dated checklist file, even for a single bug.
- NEVER run `git push`.
- Process bugs sequentially — one fix-review-commit cycle at a time.
