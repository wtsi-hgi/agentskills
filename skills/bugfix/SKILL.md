---
name: bugfix
description: Orchestrates bug fixes via implementor and reviewer subagents using TDD. Handles one or many bugs sequentially with human verification between each.
---

# Bugfix Skill

Read and follow **agent-conduct** before starting.

You are an orchestrating agent. You do NOT implement code or run tests — you
launch subagents via `runSubagent`. Do not read skill files yourself — tell
each subagent which skills to read by name and file path.

## Skill Discovery

Match skills to the project stack:
- **Go:** `go-implementor`, `go-reviewer`, `go-conventions`
- **Python:** `python-implementor`, `python-reviewer`, `python-conventions`
- **Next.js + FastAPI:** `nextjs-fastapi-implementor`,
  `nextjs-fastapi-reviewer`, `nextjs-fastapi-conventions`

## Input

One or more bug descriptions (from the user, an issue tracker, or a paste).
Parse them into a numbered list of discrete issues.

## Procedure

Process each bug **sequentially**. Complete the full cycle (fix → review →
verify → commit) for one bug before starting the next.

### For each bug:

#### 1. Fix (implementor subagent)

Launch an implementor subagent with:
- Conventions and implementor skill paths (to read).
- The bug description and any relevant file paths or reproduction steps.
- Instruction: "Read the conventions skill. Investigate the bug. Write a
  **regression test that fails** demonstrating the bug, then fix the code so
  the test passes. Follow the TDD cycle. Run tests and linters."

If the subagent reports it cannot reproduce or fix the bug, report this to the
user immediately and ask how to proceed before moving on.

#### 2. Review (reviewer subagent)

Launch a reviewer subagent with:
- Conventions and reviewer skill paths (to read).
- The bug description and list of changed files.
- Instruction: "You have clean context. Read all changed source and test
  files. Verify: (a) a regression test exists that would fail without the fix,
  (b) the fix is correct and minimal, (c) all tests pass, (d) linter is clean.
  Return PASS or FAIL with specific feedback."

**PASS →** proceed to step 3.
**FAIL →** launch a new implementor subagent with the reviewer feedback, then
a fresh reviewer. Repeat until PASS (max 5 cycles; if still failing, report to
user and ask how to proceed).

#### 3. Human verification

Present to the user:
- Bug description (as you understood it).
- Summary of the fix (files changed, approach).
- Confirmation that tests and linter pass.

Ask: "Happy with this fix, or would you like changes?"

- **Changes requested →** return to step 1 with the user's feedback appended
  to the bug description.
- **Approved →** proceed to step 4.

#### 4. Commit

Stage only the files changed for this bug with `git add <file>`. Commit with a
short imperative message describing the bug fixed (max 72 chars), e.g.
`Fix off-by-one in batch size calculation`.

Do NOT run `git push`.

### After all bugs

Report completion with a summary of commits made.

## Error Handling

- **Transient subagent failures:** retry with a new subagent, including what
  was already achieved.
- **Unresolvable bug:** report to user, skip to next bug if multiple remain.

## Rules

- NEVER implement code or run tests directly — use subagents.
- NEVER commit before the user approves the fix.
- NEVER run `git push`.
- NEVER skip human verification.
- Process bugs sequentially — one fix-review-verify-commit cycle at a time.
