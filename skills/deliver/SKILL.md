---
name: deliver
description: "Only when explicitly invoked, take the requested change and every resulting branch, including incidental fixes, through PR review and verified user merges."
---

# Deliver

Complete the requested change, then push, open a PR, and use pr-resolver.
Do this for every branch created during the work, including incidental fixes.
Track delivery until the user has merged them all.

Use only when explicitly invoked. This authorizes commits, feature-branch
pushes, PR creation, and review resolution without asking again between steps.
Honor narrower user instructions. Leave merging to the user.

Save the queue in the owner's branch-owned checklist or another
project-approved location that survives cleanup. Record each branch, PR,
target, dependencies, head SHA, status, what it waits on, and next action.
Include its worktree per
[Workspace Boundary](../agent-conduct/SKILL.md#workspace-boundary).
Add incidental branches and update the record at every state change. On
resume, reconcile it with live GitHub state before acting.

When a branch waits on a human merge, input, review, or CI, continue on an
unblocked branch, respecting dependencies. Revisit waiting branches as results
arrive. Pause the whole delivery only when no queued work can advance.

1. Establish the branch worktree per
   [Workspace Boundary](../agent-conduct/SKILL.md#workspace-boundary).
   Complete the change using [bugfix](../bugfix/SKILL.md),
   [orchestrator](../orchestrator/SKILL.md), or the project's applicable
   implementation and review skills. Preserve their tests, reviews, and
   completion requirements. Reuse completed work where its evidence still
   applies. Tell local workers to return before pushing or handling PR threads.
2. Push the feature branch following [agent-conduct](../agent-conduct/SKILL.md).
   Create its PR, or update the existing one, with the change and validation.
3. Use [pr-resolver](../pr-resolver/SKILL.md) on that PR through completion.
   Confirm its current head meets the required checks and approvals and has no
   merge conflicts before calling it ready.
4. Ask for one merge at a time, choosing by dependency order, then user impact.
   As soon as that PR is checked against the current target and ready, link it
   and ask the user to merge it and tell you when done. Give the planned order
   for the rest. Other PRs with that target stay queued until rebased onto each
   merged result and rechecked; do not present them as ready together. If PRs
   overlap in files, explain that they must merge in sequence. Continue other
   unblocked work while waiting; do not merge or enable auto-merge yourself.
5. When the user reports a merge, verify on GitHub that the PR was merged into
   its intended target, then fetch the updated target. A closed PR or the
   user's report alone is not merge verification.
   Apply [post-merge cleanup](../agent-conduct/references/post-merge-cleanup.md)
   to its worktree, local branch, and stale remote-tracking refs, preserving
   the queue first. Report what was removed or kept and why. List any clones
   now eligible for deletion and ask once for permission to delete them.
6. Rebase the next unblocked branch's remaining work onto its updated target,
   adjusting the PR base if a merged dependency requires it. Resolve conflicts,
   rerun the needed checks, and push following agent-conduct. Run pr-resolver
   again for a changed head; otherwise refresh its checks and review status.
   Preparing this next PR takes the next available worker slot ahead of long
   implementation, investigation, or soak work. If another worker can safely
   pause to free capacity, pause it and resume it afterwards.
   Repeat from step 4 when ready. Branches still needing implementation or a
   PR start at step 1, so every branch receives the full workflow.

Report blockers and respect the invoked skills' retry and wait limits. At each
handoff, show the queue's status and exactly which PR the user should merge
next, or what blocks it.

Delivery is complete only when every PR in the queue is verified merged and
no branch remains unfinished. Return the merged PR links.
