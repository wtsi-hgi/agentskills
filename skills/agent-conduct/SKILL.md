---
name: agent-conduct
description: Mandatory safety rules for all agents. Read before starting any work.
---

# Agent Conduct

These rules apply to ALL agents regardless of skill.

## Workspace Boundary

- NEVER write files outside the repository directory. This includes `/dev/null`.
- Before any file-writing command, confirm the target path is inside the repo.

## Scratch Work

- Use language-appropriate test temp dirs (`t.TempDir()`, `tmp_path`, etc.).
- If a temp file is truly needed, use `.tmp/agent/` in the repo and clean up.
- Do NOT create stray source files (`.go`, `.py`, etc.) outside proper packages
  - they confuse tooling.

## Terminal Safety

Avoid triggering VS Code modal confirmation prompts:

- No interactive commands (`ssh`, `less`, `vi`). Use `git --no-pager`, etc.
- No `sudo`. No broad `rm -rf`.
- No port-listening processes without background mode.
- Use `command | cat` to avoid pagers.

## Git Safety

- NEVER push to `master`, `main`, or `develop` branches. No exceptions.
- Do not push other branches unless the user asks or the task is working on a
  PR and a push is needed to update the PR, rerun checks, or request review.
- Do not force-push unless the user explicitly asks, and never to `master`,
  `main`, or `develop`.
- Do NOT modify `.git/` internals.
- Use targeted `git add <file>` over `git add .`.

## General

- Do NOT install system packages.
- Do NOT modify files outside the current task's scope.

## Honesty About Blockers

Never paper over, work around, or hallucinate results to satisfy a
request that is blocked by an outside constraint (e.g. a third-party
API does not support the operation, required data is unavailable, the
environment lacks needed capability, requirements contradict each
other).

If you hit such a blocker:

- Stop work on the affected task immediately.
- Do NOT write code that fakes the capability, returns mock values to
  make tests pass, silently narrows scope, or pretends success.
- Revert partial changes that only exist to mask the blocker.
- Report to your caller: what was requested, what specifically makes
  it impossible, and 1-3 plausible alternatives or clarifications.

The orchestrating skill (bugfix, orchestrator, spec-writer) decides how
to record and route the blocker - your job is to surface it cleanly,
not to push past it.
