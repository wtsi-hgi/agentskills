---
name: agent-conduct
description: "Mandatory safety rules for all agents. Read before starting any work."
---

# Agent Conduct

These rules apply to ALL agents regardless of skill.

## Workspace Boundary

- Write only inside the repository, a designated Git worktree of the same
  repository, or a harness-provided scratchpad/temp directory. Actual harness
  restrictions still apply; this rule grants no extra filesystem access.
  Redirecting command output to `/dev/null` is fine.
- Before any file-writing command, confirm the target is within one of those
  locations. Create worktrees with normal Git commands, not clones or edits
  to `.git/` internals.

## Scratch Work

- Use language-appropriate test temp dirs (`t.TempDir()`, `tmp_path`, etc.).
- If a temp file is truly needed, prefer the harness-provided scratchpad
  directory; otherwise use `.tmp/agent/` in the repo and clean up.
- Put every new source file in an existing package. A stray `.go` or `.py`
  outside one confuses tooling.

## Terminal Safety

Avoid triggering VS Code modal confirmation prompts:

- No interactive commands (`ssh`, `less`, `vi`). Use `git --no-pager`, etc.
- No `sudo`. No broad `rm -rf`.
- No port-listening processes without background mode.

## Git Safety

- NEVER push to `master`, `main`, or `develop` branches, including normal and
  force pushes. Check the destination ref, not just the checked-out branch.
- Keep the task's feature branch rebased on the latest remote `develop`,
  unless the caller or PR specifies another base. If remote `develop` is
  confirmed absent, resolve the configured remote's default branch instead.
  A failed fetch is a blocker, not evidence that a branch is absent. Retain
  the resolved base throughout the task. Deferred branches with an unmerged
  dependency follow the base transition and publication hold in
  [routing](../bugfix/references/incidental-issues.md#dependent-local-branches).
  Fetch before checking whether it is current. When that base has advanced,
  rebase onto it instead of merging it into the feature branch. Resolve
  conflicts and rerun the applicable quality gates on the rebased result.
- After those gates pass, push the rebased feature branch with
  `--force-with-lease`. The user gives standing authorization for this;
  no separate request or confirmation is needed. Deferred branches held for
  recording or dependency merge remain local under
  [bugfix routing](../bugfix/references/incidental-issues.md).
  Verify the remote feature-branch tip before rebasing and use it as the
  explicit expected SHA in the lease. If the lease fails, inspect and
  reconcile the intervening work before retrying; never use plain `--force`.
- Do not push other branches unless the user asks or the task is working on a
  PR and a push is needed to update the PR, rerun checks, or request review,
  or the push applies the standing rebase authorization above.
- Do NOT modify `.git/` internals.
- Use targeted `git add <file>` over `git add .`.
- Before deleting a clone, worktree, or local branch, inspect the work that
  deletion puts at risk. For a clone, check all local branches with
  `git log --branches --not --remotes` and inspect detached HEADs too.
  Check at-risk uncommitted changes, untracked/ignored files, and stashes.
  Every at-risk commit or file must be verified preserved outside the deletion
  scope, verified integrated, or explicitly authorized for discard. For squash
  merges, verify the merged PR head and resulting integration diff; account
  for commits beyond that head too. Linked worktrees share branches and
  stashes; unrelated surviving work need not be cleaned. Report what was
  checked and how at-risk work was accounted for. Retain unaccounted-for work.
  These checks do not authorize deletion.
- After the hosting service confirms a task PR merged, apply
  [post-merge cleanup](references/post-merge-cleanup.md). The user gives
  standing authorization to delete its verified local task branch, remove
  its clean disposable worktree, and prune stale remote-tracking refs without
  asking again. This does not authorize remote branch or clone deletion.

## General

- Do NOT install system packages.
- Do NOT modify files outside the current task's scope.
- For heavy work on shared or quota-constrained machines, read
  [shared resources](references/shared-resources.md).

## Discovered Issues

When a distinct issue appears during implementation, review, or verification,
read [bugfix routing](../bugfix/references/incidental-issues.md). Workers
report the evidence to their caller before changing incidental code; the
caller applies the routing rules. A directly invoked agent is its own caller.

## Completion And Live Work

For delegated or background work, read
[completion and liveness](../subagents/references/completion-liveness.md).

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
