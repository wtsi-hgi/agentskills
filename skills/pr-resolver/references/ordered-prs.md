# Ordered PRs

For multiple supplied PRs, preserve the user's order in persistent owner
notes before starting. Reuse existing workflow notes or create a local
`.tmp/agent/pr-resolver-<id>.md` checkpoint in the retained owner worktree.
Retain its path across turns and report it for resume. Keep observations out
of PR commits so recording a validated head does not change that head.

Record the owner, ordered PR IDs/URLs, each branch and actual base ref, current
position, and each observed state: queued, active, ready awaiting user merge,
merged, closed unmerged, or blocked. Include observed head/base SHAs, gate and
review evidence links, unresolved work, and incidental queue references.
Stored readiness is an observation to refresh, not a reusable guarantee.

Process one PR through the main procedure at a time. Queued PRs stay with the
same outer owner; the deferred incidental bug queue remains separate and
follows [routing](../../bugfix/references/incidental-issues.md). Preserve
dependency publication holds and dirty work when changing worktrees. Local
preparation of later PRs does not establish their readiness against a future
base.

When the current PR converges, report it ready for the user to merge, save
the queue checkpoint, and return without polling forever for human input.
Only the user controls merges. Do not merge or silently reorder the queue.
An outer owner may drain incidental work at this completion boundary under
routing; refresh the current PR's base before the final ready report.

On resume after a reported merge, load the same checkpoint and verify the
PR's actual merged state. Advance to the next queued PR only after that
confirmation or explicit user direction. If closed unmerged, record it and
report the queue decision needed. If still open, refresh its readiness and
return the remaining user action without waiting indefinitely.

For each next PR, repeat the main procedure against its actual fetched base.
Previous convergence cannot substitute for fresh gates and review after a
rebase.

Recheck the fetched base during waits and before readiness. A moved base
invalidates any affected queued PR's stored ready state; mark it for refresh
and return the active PR to the rebase cycle. Report later PRs as queued or
needing refresh until they complete the readiness checks in order.

At a blocker, timeout, explicit pause, or user-merge boundary, save current
states, evidence, pending actions, and retained work ownership. The next turn
resumes the checkpoint; advancing the queue does not require one endless turn.
