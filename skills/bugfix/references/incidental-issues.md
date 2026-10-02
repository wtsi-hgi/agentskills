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
queue.

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
- An independent incidental issue gets its own branch and committed unchecked
  bugfix entry immediately, using the steps below. Resume the current task
  after recording it; implement the deferred fix only at queue completion.

Workers report distinct findings and evidence to their caller before editing
incidental code. The caller applies this decision and records each handoff
before resuming. Feedback about the current fix stays in its review cycle.

## Record An Independent Issue

1. Identify the originating checklist/item. If none exists, create it using
   **bugfix**'s naming and metadata rules. Look for the same symptom in the
   owner's queue and referenced bugfix branches. Reuse an existing pending
   branch/entry, including one discovered in an earlier session. A checked
   historical item is regression evidence, not an unchecked task to duplicate
   or silently reopen.
2. Resolve and fetch the base through
   [agent-conduct Git Safety](../../agent-conduct/SKILL.md#git-safety).
   An unavailable remote or ambiguous base blocks branch creation. Record the
   base ref and SHA; retain this base for the branch and later rebases.
3. Create a designated worktree of this repository with
   `git worktree add -b <bugfix-branch> <worktree-path> <base>`. Use the
   checklist's random ID in the branch name. Leave the original worktree and
   its index intact; never stash, reset, or copy its unfinished implementation
   into the bugfix branch. Obey actual harness path restrictions.
4. In that worktree, create the branch-owned checklist specified in
   **bugfix**. Record the symptom, bounded redacted evidence, why it is
   independent, and origin branch/checklist/item plus queue owner. Commit
   that entry alone with targeted staging. Recording a finding does not
   require completing its red reproduction; that remains mandatory before
   fixing it. Do not push merely to record the issue.
5. Verify the entry exists at the new branch's commit. Add a stable handoff
   under the originating checklist item containing the bugfix branch,
   repository-relative checklist path/item, and entry commit SHA. Commit this
   handoff immediately with targeted staging and
   `git commit --only <checklist>`, preserving unrelated staged and unstaged
   changes. Only now call the issue deferred and resume the original task.

If recording fails, report the incomplete handoff and retain the evidence;
do not claim the issue is safely deferred. If a previously deferred issue
now blocks a required gate, route it to the current branch immediately and
retain its reference so the owner can reconcile it after the current work.

## Finish Or Stop

A workflow completes its requested current-branch work first, including its
required gates, reviews, and any required push/CI convergence. Waiting for
merge is unnecessary. Current-branch completion may include recorded
handoffs; it does not mean those deferred bugs are fixed.

A child returns pending references to its caller. Only the outermost owner,
after its current work succeeds, processes the deferred branches sequentially
through **bugfix**, each in its own worktree with its existing checklist and
resolved base. Inspect current branch state before fixing a rediscovered
issue; if it is already fixed, record evidence there instead of duplicating
the fix. Any newly found independent issue goes to the end of the queue.

Update outcomes only on the branch that owns the deferred checklist. The
origin's handoff remains a stable reference; do not revisit completed
branches to edit cross-branch status. Return to the original worktree when
done and report each branch, checklist, outcome, and commit.

If the current work is blocked or stopped, leave deferred branches pending
and report their references with the blocker. Never drain them to bypass an
unfinished required gate. If a deferred fix blocks, record that outcome on
its branch and continue only independent queued items. Keep unresolved
entries and branches available for resume; do not report full completion
while any remain pending.
