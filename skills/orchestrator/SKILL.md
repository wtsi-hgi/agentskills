---
name: orchestrator
description: Orchestrates implementation and review of phase plans via subagents, and drives the real app through the project's verify skill when one exists. Use when given a phase MD file to complete.
---

# Orchestrator Skill

Read and follow **agent-conduct**, **testing-principles**, and **subagents**
before starting. **subagents** owns delegation: agent choice, briefing, skill
discovery, and error handling. This skill covers only the orchestrator
procedure.

Use skills named in the phase file's Instructions section if specified;
otherwise follow the skill-discovery procedure in **subagents**.

## Input

A phase MD file containing items with `- [ ] implemented` and
`- [ ] reviewed` checkboxes, possibly grouped into ordered batches.

## Procedure

### 1. Read the phase file. Note which items are already checked (skip those).

### 2. Process items in order

- **Sequential items:** one at a time.
- **Parallel batch:** one implementation subagent per item concurrently.
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

If the phase changed behaviour a user can observe, glob
`.github/skills/verify-*/SKILL.md`. That is the contract **verification**
publishes; do not search elsewhere.

- **Found:** launch a subagent with the verify skill path, its feature map
  path, and the features this phase touched. "Follow the skill: launch,
  doctor, drive each named feature, capture evidence, clean up. Return
  VERIFIED, NOT VERIFIED, or INCONCLUSIVE per feature, each with its evidence
  path." Treat NOT VERIFIED or INCONCLUSIVE as a review failure: uncheck the
  affected item's `reviewed` marker, route it through the fix-and-review cycle
  in step 3, then re-drive before restoring the marker. A drive that fails on
  stale skill steps is drift in the verify skill, not a product failure.
  Launch a subagent with the **verification** skill path and verify skill
  directory in maintenance mode to repair only the verify skill, then re-drive
  the affected feature.
- **Not found:** say so in your final report, and name **verification** as the
  skill that creates one. Do not create one mid-phase.

### 5. Phase completion

When every checkbox is checked and every required drive is VERIFIED, commit
with `Implement phase <N>`. Use targeted `git add` for the phase's source,
tests, and the phase file.

Drive evidence is kept. Leave it where the verify skill puts it and cite that
path in your report, so a reviewer can see the proof without re-running the
drive. Whether it is committed follows the project's evidence policy; with
none, leave it out of the phase commit rather than adding screenshots or logs
to it.

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
- Do not `git push` unless the user asked for it or the phase work is on a
  PR branch that must be updated. Never push to `master`, `main`, or
  `develop`.
