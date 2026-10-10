---
name: orchestrator
description: "Orchestrates implementation, review, and user-path verification of phase plans via subagents. Use when given a phase MD file to complete."
---

# Orchestrator Skill

Read and follow **agent-conduct**, **testing-principles**, and **subagents**
before starting. **subagents** owns delegation: agent choice, briefing, skill
discovery, and error handling. This skill covers only the orchestrator
procedure. Establish the outermost queue owner using
[bugfix routing](../bugfix/references/incidental-issues.md) before starting;
inherit a caller's owner when nested. Route incidental findings returned by
implementation, review, and verification before resuming phase work.

Use skills named in the phase file's Instructions section if specified;
otherwise follow the skill-discovery procedure in **subagents**.

## Input

A phase MD file containing items with `- [ ] implemented` and
`- [ ] reviewed` checkboxes, possibly grouped into ordered batches.

## Procedure

### 1. Read the phase file. Note which items are already checked (skip those).

### 2. Process items in order

- **Sequential items:** one at a time.
- **Parallel batch:** apply
  [shared concurrency limits](../subagents/SKILL.md#concurrency).
- Complete and review each batch before starting the next.

### 3. For each item (or batch)

#### a. Implementation

Launch an implementor subagent with:

- Conventions, testing-principles, and implementor skill names + file paths
  (to read).
- Item description, spec.md section reference, phase instructions.
- "Read spec.md for acceptance tests. Follow TDD cycle and
  **testing-principles**. Run tests and linters."

On success, check `- [x] implemented`.

#### b. Review

Launch a reviewer subagent with:

- Conventions, testing-principles, and reviewer skill names + file paths (to
  read).
- Item(s) description, spec.md section reference(s), phase instructions.
- "You have clean context. Read spec.md, source and test files, run tests and
  linter, return PASS or FAIL with specific feedback."

**PASS:** check `- [x] reviewed`.
**FAIL:** launch new implementor with feedback, then fresh reviewer. Repeat
until PASS.

### 4. Verify user-visible behaviour

Apply
[user-path verification](../testing-principles/SKILL.md#user-path-verification).
Delegate required drives with the **verification** skill path and affected
features. Keep affected `reviewed` markers unchecked until VERIFIED; follow
verification's failure handling before resuming.

### 5. Phase completion

When every checkbox is checked and every required drive is VERIFIED, commit
with `Implement phase <N>`. Use targeted `git add <path>` for every changed
path that belongs to the phase, including the phase file. Inspect the staged
diff before committing to confirm it contains the complete phase and no
unrelated changes.

Cite the retained verification evidence in your report.

### 6. Spec-aware PR review (after all phases)

Launch a **pr-reviewer** subagent with:

- pr-reviewer skill name + file path.
- Path to spec document.
- "Review all changes on this branch vs base. Check code quality, bugs,
  usability, and spec conformance. Fix via implementor subagents."

Follow fix-and-commit cycle. Repeat with fresh context until **2 consecutive
clean passes**.

### 7. Spec-free PR review

Same as step 6 but **without** the spec document (focus on code quality and
usability only). Repeat until **2 consecutive clean passes**.

### 8. Complete or return to caller

After all requested phases and required reviews succeed, apply
[queue completion](../bugfix/references/incidental-issues.md#finish-or-stop).
Nested workflows return pending references without processing them. Only the
outermost owner drains deferred branches. Report pending references with any
blocker or stopped phase.

## Error Handling

- **Transient failures:** see **subagents**.
- **File removal:** delete normally. If deletion fails (e.g. NFS refusing
  the unlink), move the file to `.tmp/trash/` in the repo instead; clean up
  after all phases.
- **Blocker reported by subagent** (per agent-conduct § Honesty About
  Blockers - e.g. an external API cannot do what the spec requires):
  1. Do NOT relaunch the implementor to "find a way". Do NOT check the
     item.
  2. Write `blocker-phase<N>-<item-id>.md` next to the phase file,
     containing: the item, the impossibility (what was tried, what
     failed and why), and 1-3 proposed alternatives or clarifications
     needed from the user.
  3. Abort the current phase and any later phases that depend on the
     blocked item. Continue only with independent phases.
  4. At the end, report all blocker files and which phases were
     skipped.

## Rules

- Follow the rules in **subagents** (no direct implementation, no read-only
  agents for writing work, etc.).
- NEVER check a checkbox until the subagent confirms success.
- NEVER skip or reorder items unless the phase file allows parallel execution.
- Follow **agent-conduct** Git Safety for push authorization, rebasing feature
  branches on the resolved base, and force-pushing with a lease.
