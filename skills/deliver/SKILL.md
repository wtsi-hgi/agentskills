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

Keep a short queue of branches, PR links, target branches, dependencies, and
status. Add branches discovered during implementation or review to this queue.
Respect dependencies and preserve the queue across user handoffs. Whenever a
branch waits on a human merge, input, review, or CI, record what it needs and
continue on an unblocked branch. These steps apply per branch, not to the
whole queue in lockstep. Revisit waiting branches as responses or results
arrive, refreshing their state before resuming. Pause the whole delivery only
when no queued work can advance.

1. Complete the change using [bugfix](../bugfix/SKILL.md),
   [orchestrator](../orchestrator/SKILL.md), or the project's applicable
   implementation and review skills. Preserve their tests, reviews, and
   completion requirements. Reuse completed work where its evidence still
   applies. Tell local workers to return before pushing or handling PR threads.
2. Push the feature branch following [agent-conduct](../agent-conduct/SKILL.md).
   Create its PR, or update the existing one, with the change and validation.
3. Use [pr-resolver](../pr-resolver/SKILL.md) on that PR through completion.
   Confirm its current head meets the required checks and approvals and has no
   merge conflicts before calling it ready.
4. As soon as a PR is ready, link it and ask the user to merge it and tell you
   when done. Do not wait for all PRs to be ready. Continue other unblocked
   work while awaiting their response; do not merge or enable auto-merge.
5. When the user reports a merge, verify on GitHub that the PR was merged into
   its intended target, then fetch the updated target. A closed PR or the
   user's report alone is not merge verification.
6. Rebase the next unblocked branch's remaining work onto its updated target,
   adjusting the PR base if a merged dependency requires it. Resolve conflicts,
   rerun the needed checks, and push following agent-conduct. Run pr-resolver
   again for a changed head; otherwise refresh its checks and review status.
   Repeat from step 4 when ready. Branches still needing implementation or a
   PR start at step 1, so every branch receives the full workflow.

Report blockers and respect the invoked skills' retry and wait limits. At each
handoff, show the queue's status and exactly which PR the user should merge
next, or what blocks it.

Delivery is complete only when every PR in the queue is verified merged and
no branch remains unfinished. Return the merged PR links.
