# Incidental Issue Routing

Read this when an issue appears outside the requested work, and when a
workflow starts or finishes. **bugfix** owns this routing; its main skill
owns checklist naming, evidence hygiene, and the fix-review-commit procedure.

## Queue Owner

The outermost active workflow owns one deferred queue. It may be standalone
bugfix, pr-reviewer, orchestrator, or pr-resolver. Record its branch and
checklist and pass that identity to every child workflow. Children return
pending branch/entry references untouched; they never drain the queue when
their own step finishes. A directly invoked implementor reports incidental
findings to its caller; an agent with no caller owns its task's queue.

On resume, recover the owner and pending references from its checklist and
the referenced branches before creating entries. A workflow called while
draining the queue inherits the same owner. New independent findings append
to that queue, after existing items, without recursively starting another
queue. Use [shared concurrency limits](../../subagents/SKILL.md#concurrency)
across the owner and all nested workflows. When a long-lived owner moves to
another PR branch, carry its queue identity and pending references into that
branch's active checklist. Resume from those references without editing a
completed origin's handoff.

## Choose Where The Issue Belongs

Inspect the actual working changes, including staged, unstaged, and untracked
work. A changed line or a diff against the base is a clue, not proof of cause.
When ownership is uncertain, compare the same symptom against the resolved
base in a separate worktree; do not disturb the current work to reproduce it.
Use evidence appropriate to the failure, including intermittent failures.

- Requested work and regressions caused by the current task stay on the
  current branch unless the user directs otherwise.
- An incidental issue that blocks implementation, verification, or a required
  gate is fixed now on the current branch. Record the blocking command or
  behaviour and why this issue must be included. A pre-existing or flaky
  required gate remains required; it cannot wait until after convergence.
- An independent incidental issue gets a committed entry and durable handoff
  immediately, using the steps below. Resume the current task after recording
  it; implement the deferred fix at the owner's next completion boundary.

For an independent finding with possible release-blocking, data-integrity, or
safety impact, notify the user immediately with the evidence, likely impact,
durable branch/entry reference, and recommended priority or containment.
Do not delay the alert for bookkeeping or a failed search. If the reference
is not yet durable, identify that gap and finish recording when possible.
Record the impact and priority, including any user promotion, in the entry
for resume. When the user directs immediate work on the finding, preserve
current work and follow that direction before current-task completion.
Otherwise severity alone does not expand scope or change the completion
boundary. Actual current blockers follow the current-branch rule above;
ordinary independent findings remain deferred.

Workers report distinct findings and evidence to their caller before editing
incidental code. The caller applies this decision and records each handoff
before resuming. Feedback about the current fix stays in its review cycle.

## Check For Existing Work

Before creating a branch, implementing a queued item, or publishing it,
inspect the owner's queue, referenced entries, local and fetched remote
branches, and open PRs where the repository has a PR host. For GitHub, use
`gh pr list` and `gh pr view` to inspect titles, bodies, and changed paths;
use `gh pr diff` to inspect candidate fixes. Search by symptom and paths so
a generic PR title cannot hide an existing fix. Account for list limits
instead of treating a truncated result as a complete search. Path overlap is
only a clue. Confirm the same underlying issue from its symptom and fix.
For another PR host, use its equivalent read-only lookup. A local repository
without a PR host needs no PR search; that is not a failed GitHub lookup.

Reuse the existing pending entry when it covers the issue. If another branch
or PR already contains an in-flight fix, commit a tracking entry in the
owner's checklist with its branch, PR, relevant commit, evidence, and origin
item. Commit that handoff before resuming, using the metadata-only procedure
below. Mark it as an external pending handoff and track its outcome instead of
creating a duplicate branch or fix. It neither counts as fixed nor blocks
reporting current-task convergence while its owner finishes the work.
A checked historical item is regression evidence, not an unchecked task to
silently reopen.

If any search is unavailable, retain the finding in a committed tracking
entry and disclose the incomplete search. Do not assert that no duplicate
exists. Recheck before implementation and publication. If still unavailable,
record the uncertainty and assess duplication risk before proceeding; it need
not block unrelated or offline work. Known overlapping fixes require
reconciliation before duplicate work proceeds.
An actual current blocker still needs resolution now; reconcile any known
in-flight fix with the current branch without waiving its required gate.

## Record An Independent Issue

1. Identify the originating checklist/item. If none exists, create it using
   **bugfix**'s naming and metadata rules. Apply the existing-work check above.
2. Resolve and fetch the integration base through
   [agent-conduct Git Safety](../../agent-conduct/SKILL.md#git-safety).
   Record its ref and SHA. When the issue only exists on, or needs code from,
   an unmerged origin branch, use that branch's exact committed SHA as the
   local starting base and follow the dependency lifecycle below. An
   unavailable remote or ambiguous base blocks new branch creation; retain
   the finding in the origin's checklist and report the incomplete handoff.
3. A pending branch may group related issues while its base and
   dependency remain compatible. Keep each issue's entry and
   fix-review-commit cycle separate; a broad label such as tooling alone
   does not make unrelated fixes coherent.
   Otherwise create a designated worktree of this repository with
   `git worktree add -b <bugfix-branch> <worktree-path> <base>` using the
   checklist's random ID in the branch name.
   A PR that has converged or is waiting for merge takes no new incidental
   items. Leave the original worktree and index intact; never stash, reset,
   or copy unfinished implementation into the bugfix branch. Obey actual
   harness path restrictions.
4. In that worktree, create or append to its branch-owned **bugfix** checklist.
   Record the symptom, bounded redacted evidence, why it is independent, and
   origin branch/checklist/item plus queue owner. Commit that entry alone with
   targeted staging and `git commit --only <checklist>`. Recording a finding
   does not require completing its red reproduction; that remains mandatory
   before fixing it. Recording-only pending branches stay local, including
   under standing rebase authorization.
5. Verify the entry exists at the branch's commit. Add a stable handoff under
   the originating checklist item containing the bugfix branch,
   repository-relative checklist path/item, and entry commit SHA. Commit this
   handoff immediately with targeted staging and
   `git commit --only <checklist>`, preserving unrelated staged and unstaged
   changes. Only now call the issue deferred and resume the original task.

If recording fails, report the incomplete handoff and retain the evidence;
do not claim the issue is safely deferred. If a previously deferred issue
now blocks a required gate, route it to the current branch immediately and
retain its reference so the owner can reconcile it after the current work.

## Dependent Local Branches

Git Safety already permits a caller- or PR-selected base. For a deferred fix
based on an unmerged branch, record the dependency branch/PR, exact starting
SHA, and eventual integration base ref and fetched SHA in its checklist.
Keep the dependency SHA as the boundary between parent history and follow-up
commits. Work locally from committed dependency code; if the needed code is
uncommitted, retain the finding until its owner commits that code.

Local implementation and review may proceed at an owner completion boundary.
Mark the branch as held for dependency merge. While held, do not push it or
open a PR, including under standing rebase authorization. Local completion
and publication readiness are separate outcomes.

After verifying the dependency merged into the intended integration base:

1. Fetch the integration base and repeat the existing-work check. Inspect the
   merged result; a squash merge need not contain the dependency SHA in its
   ancestry. If the issue is already fixed, record that evidence instead of
   replaying an obsolete fix.
2. Preserve the local tip and dependency boundary before rewriting history.
   Move only follow-up commits onto the updated integration base, for example
   with `git rebase --onto <integration-base> <dependency-sha> <bugfix-branch>`.
   Inspect the selected range first. If dependency updates were incorporated,
   identify the actual boundary or select only the follow-up commits; never
   replay parent history just because a squash merge changed its SHAs.
3. Resolve conflicts, inspect the resulting diff for only the intended fixes
   and metadata, and run the normal quality gates and review on that result.
   Record the new base SHA and rewritten commit references in the owning
   checklist. Release the hold only after this verification. Publication then
   follows the caller's push authority and Git Safety's rebase/explicit-lease
   rules; removal of the hold does not itself authorize a new push or PR.

## Finish Or Stop

A workflow completes its requested current-branch work first, including its
required gates, reviews, and any required push/CI convergence. Waiting for
human merge is unnecessary. A long-lived owner may drain its queue between
converged PRs or completed tasks; it need not wait for the whole release,
session, or every PR to merge. A dependency publication hold remains in force
across these boundaries.

A child returns pending references to its caller. Only the outermost owner,
at such a boundary, processes deferred branches sequentially through
**bugfix**, each in its worktree with its existing checklist and recorded
base/dependency. Repeat the existing-work check before fixing each item. If
it is already fixed, record evidence instead of duplicating the fix. Track
in-flight fixes in their existing branch/PR. New independent findings go to
the end of the queue unless the user promotes their priority.

Update outcomes only on the branch that owns the deferred checklist. The
origin's handoff remains a stable reference; do not revisit completed
branches to edit cross-branch status. Return to the original worktree when
done and report each branch, checklist, outcome, commit, and publication hold.
Current-task completion can include pending handoffs; report these separately
from fixed items and never claim the entire queue is complete while any
remain pending.

Without user direction to reprioritize, if the current work is blocked or
stopped, leave deferred branches pending and report their references with
the blocker. Never claim current-task convergence by bypassing an unfinished
required gate. If a deferred fix blocks, record that outcome on
its branch and continue only independent queued items. Keep unresolved
entries and branches available for resume.

## Worktree Cleanup

Remove a deferred worktree only after verifying its fix merged into the
intended integration base and applying
[Git Safety deletion checks](../../agent-conduct/SKILL.md#git-safety).
Use normal `git worktree remove <worktree-path>` without force. Worktree
cleanup does not authorize branch deletion; delete a branch only when the
user or caller has authorized it.
