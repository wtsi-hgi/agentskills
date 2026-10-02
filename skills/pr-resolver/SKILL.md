---
name: pr-resolver
description: "Resolve GitHub PR review comments from humans and Copilot, including reviews already auto-requested or in progress. Use for verified comment resolution, sequential bugfix batching, one-push CI/Copilot cycles, and SHA-aware waits that avoid stale-event loops."
---

# PR Resolver Skill

Read and follow **agent-conduct** and **subagents**. Read **bugfix** before any
code change; it owns all fix-review-commit work. This skill owns PR state,
review replies, batched pushes, checks, and Copilot review requests. Establish
the outermost queue owner using
[bugfix routing](../bugfix/references/incidental-issues.md); inherit an existing
owner when called by another workflow.

## Invariants

1. Verify every comment against the current code before acting.
2. Route every valid code-changing finding through the full **bugfix**
   workflow. Reply-only findings do not need bugfix.
3. Finish current-branch items sequentially and commit each separately. Drain
   that local queue before pushing once; independent issues follow routing.
4. After any pushed code change, explicitly request Copilot review, regardless
   of whether the change came from Copilot, a human, CI, or a user-reported bug.
5. Wait for predicates about an immutable target SHA, not for the next event
   name. Re-read the complete PR snapshot before and during every wait.

## Comment policy

- Direct human change requests are requirements. Fix them or report a blocker
  if they are impossible, unsafe, or conflict with another requirement.
- Human questions, hedged suggestions, and nits are review input. Fix, answer,
  or explain why no code change is appropriate.
- Copilot comments are review input, not requirements. Fix valid current
  issues. Otherwise explain that the comment is invalid, stale,
  non-actionable, duplicate, already covered, or harmful.

Reply before resolving. Leave a blocked direct human request unresolved. Do
not create churn-only changes to satisfy a reviewer.

## 1. Confirm access and identify the PR

For multiple supplied PRs, read [ordered PRs](references/ordered-prs.md) and
retain that order across resumes. A single PR uses the procedure below without
a separate queue. The PR order and the incidental bug queue have the same
outer owner but remain separate lists.

`gh` is mandatory. Do not fall back to raw tokens, `curl`, editor integrations,
or the web UI.

```bash
command -v gh >/dev/null 2>&1
gh auth status >/dev/null 2>&1
gh pr view --json number,baseRefName,headRefName,headRefOid,url
```

Stop if `gh` is unavailable or unauthenticated. Confirm that the checked-out
branch is the PR head and is not `master`, `main`, or `develop` before any
push. Follow **agent-conduct** Git Safety for rebasing on the resolved base
and the standing authorization to force-push the feature branch with a lease.

Discover local lint, test, fixture, and performance gates before review or
push. Follow
[gate policy](../implementation-principles/references/performance-gates.md)
and pass applicable commands and policy to bugfix workers.
For release PRs, also read
[release checks](../implementation-principles/references/release-checks.md).

## 2. Read one complete snapshot

At entry and after every remote or local state change, refresh all of:

- local `HEAD` and dirty status;
- PR state, head SHA, base ref, and freshly fetched base SHA;
- check rollup for the PR head SHA;
- all unresolved review threads, paginated, including thread node ID, first
  comment database ID, author, path, line, body, associated review/commit SHA,
  and resolution state;
- all Copilot reviews, paginated, including review ID, `commit_id`,
  `submitted_at`, `state`, `body`, and `html_url`;
- current requested reviewers.

Use GraphQL review threads because `isResolved` is required. Copilot authors
include `Copilot`, `copilot-pull-request-reviewer`, and
`copilot-pull-request-reviewer[bot]`; treat `github-actions[bot]` as Copilot
only when the surrounding event/body proves it.

Fetch review threads with an explicit cursor. `fullDatabaseId` is the numeric
comment ID needed by the REST reply endpoint; the associated review commit is
needed for target-SHA attribution.

```bash
gh api graphql \
  -f owner='{owner}' \
  -f name='{repo}' \
  -F number={number} \
  -F cursor=null \
  -f query='
query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        nodes {
          id
          isResolved
          comments(first: 1) {
            nodes {
              fullDatabaseId
              path
              line
              author { login }
              body
              pullRequestReview {
                id
                submittedAt
                commit { oid }
              }
            }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}'
```

Use `-F cursor=null` on the first request. While `hasNextPage` is true, replace
it with `-f cursor="$END_CURSOR"` using the returned `endCursor`; do not stop
after the first 100 threads. Filter `isResolved == false` only after collecting
every page.

Fetch reviews with REST pagination so `commit_id` and `submitted_at` are
explicit; retain state and overview even with zero threads:

```bash
gh api --paginate repos/{owner}/{repo}/pulls/{number}/reviews \
  --jq '.[] | {id, author: .user.login, commit_id, submitted_at, state, body, html_url}'
```

Never use the same endpoint without `--paginate`: its default first page can
omit the newest Copilot review, including a no-comments review, and cause a
false wait. GraphQL `pullRequest.reviews` is also valid only when traversed to
completion with `pageInfo` cursors. `reviews(last: 20)` is a valid fast path:
finding a completed target-SHA review is conclusive, but absence requires
pagination before concluding it is absent.

Do not infer current state from a timeline event or an unpaginated REST page.
Timeline events are advisory and never control a wait.

Read the body/overview of each current-head Copilot review, even with no inline
findings. Triage actionable defects through the same fix queue as threads,
retaining review ID/link as source metadata. Carry human-attention areas such
as concurrency, lock order, durability, or security into the ready report with
the review link, labelled advisory/nonblocking when they allege no actionable
defect. A completed `COMMENTED` review can satisfy Copilot review; `APPROVED`
is not required. Pending/dismissed reviews do not prove completion.

## 3. Reconcile before waiting

Always evaluate terminal facts first:

If the PR merged or closed, record that state and stop its review loop. If the
head is behind its fetched base or that base advanced since the current gate
evidence, invalidate readiness and return to step 5 before waiting. Missing or
stale local gate evidence also requires step 5, even on entry without changes
to push. A failed fetch leaves base currency unknown and blocks readiness.

1. If an active wait target differs from the PR head, abandon that wait, take a
   new snapshot, and reconcile the new head.
2. If unresolved threads exist, triage them now.
3. If a completed Copilot review exists for the current PR head SHA, consume
   its overview and findings, even if the request/start event was missed.
4. If current requested-reviewer state lists Copilot and no review for that SHA
   exists, wait for that review.
5. Otherwise settle checks, then request Copilot instead of waiting for a
   request or work-start event.

This entry reconciliation is what handles a PR whose automatic Copilot review
was requested immediately before pr-resolver started.

## 4. Build and drain the local work queue

For each unresolved thread or actionable overview finding, choose one outcome:

- **Fix:** Redact secret or personal data, preserve PR/thread/comment IDs, and
  apply [bugfix routing](../bugfix/references/incidental-issues.md). Requested
  changes and required gate blockers stay on this branch. For an independent
  incidental finding, record the durable handoff, reply with its branch/entry
  reference, and resolve the thread without claiming the bug is fixed.
- **Explain:** Reply with a concrete reason and resolve the thread.
- **Already handled:** Reply with current code/test evidence and resolve it.
- **Blocked:** Report the required decision; do not silently resolve a direct
  human request.

Pass all queued fixes and discovered gate evidence to **bugfix** in
batched-caller mode. It must process them sequentially using its
implementor-reviewer TDD cycle, update its dated
checklist, and create one commit per item without pushing. Keep a mapping from
each successful commit to its source thread.

Overview-only findings retain review IDs and links instead of thread IDs.
Report their disposition in the PR summary; reply/resolve API calls below
apply only to actual threads.

If the user reports a bug, a local gate exposes a bug, or CI feedback is
already available while the queue is active, append it to the same bugfix
queue after routing it. Handle a blocker before completing the affected
item; independent handoffs stay with the owner. Before pushing, refresh user
input and PR threads and drain newly known current-branch work.

For current-branch fixes, do not reply `fixed` or resolve the thread yet; the
commit is still local.

## 5. Push the drained batch once

First apply **agent-conduct** Git Safety to fetch and rebase the PR branch
onto the actual updated base when behind, including after a preceding PR
merged. Preserve dirty user work in its worktree. Resolve conflicts and inspect
the resulting diff; in CHANGELOG Unreleased append sections, retain distinct
entries from both sides under the appropriate sections. Update source-thread
commit mappings after rebasing. Run applicable local gates across the resulting
batch, using project-defined performance baselines. Refresh required evidence
in the PR body. If nothing needs publication, skip only the push; required
evidence must still be current.

Confirm that the checked-out branch is the PR head and that the destination
ref is not `master`, `main`, or `develop`. Use an explicit remote and feature
branch destination. After rebasing, use `--force-with-lease` with the expected
remote SHA required by **agent-conduct**; otherwise use a normal push.

Capture `TARGET_SHA=$(git rev-parse HEAD)` before the push. Poll with a bounded,
interruptible harness monitor until the PR head equals `TARGET_SHA`. Do not use
a long foreground shell loop: the user may add a bug while waiting. If that
happens before `git push`, add it to the current batch. If it arrives after
`git push` has completed, stop the monitor, process it through **bugfix**, and
make the next unavoidable batched push; never pretend the completed push can
still be enlarged.

After GitHub sees `TARGET_SHA`, keep the source-thread mappings pending until
checks pass. Do not claim a remote fix is complete before its target is green.

## 6. Settle checks for the pushed SHA

Evaluate checks only for `TARGET_SHA`. Allow a short registration grace period
after the head becomes visible, then poll the check rollup with a bounded,
interruptible monitor. At every poll, first test these state transitions:

- PR head changed: abandon this target and reconcile the new snapshot;
- fetched base advanced: invalidate readiness and return to step 5;
- user supplied new work: stop waiting and drain it;
- any check failed: inspect its logs and annotations, reproduce locally, and
  enqueue the verified defect through **bugfix**;
- all observed checks are terminal and successful (or no checks registered by
  the end of the grace period): checks are settled.

Prefer `gh run view ... --log-failed` for Actions. If a run is still active,
inspect the job endpoint and logs directly. For non-Actions checks, inspect
check-run output and annotations. Never waive a failure as unrelated,
pre-existing, or flaky; route it through **bugfix**. Drain and commit all such
items locally, then return to the single-push step.

Do not request Copilot while checks for the target SHA are failing.

Once checks settle successfully, reply
`fixed - <concise summary> (<commit>)` to each successfully fixed source thread
and resolve it:

```bash
gh api repos/{owner}/{repo}/pulls/{number}/comments \
  -f body='fixed - <concise summary> (<commit>)' \
  -F in_reply_to=<comment_id>

gh api graphql -f query='mutation {
  resolveReviewThread(input: {threadId: "{thread_node_id}"}) {
    thread { isResolved }
  }
}'
```

## 7. Ensure Copilot reviews the exact head

### Existing or automatic request

On initial entry with no locally pushed changes, set `TARGET_SHA` to the
current PR head. If a completed Copilot review with `commit_id == TARGET_SHA`
exists, process its overview and unresolved findings, then test convergence.
Otherwise, if requested-reviewer state lists Copilot, use the SHA-aware wait
below. With neither, settle checks for the initial head and request review.

### After a push

After checks settle for any pushed code changes, always request Copilot review
for `TARGET_SHA`, even when automatic review-on-push is configured and even
when none of the changes addressed a Copilot comment.

Record the current Copilot review IDs and `TARGET_SHA` immediately before
requesting. Prefer:

```bash
if ! gh pr edit {number} -R {owner}/{repo} --add-reviewer @copilot; then
  # First re-snapshot: if Copilot is already pending, wait instead of falling
  # back. Otherwise use the GraphQL botIds mutation below.
  PR_ID=$(gh api repos/{owner}/{repo}/pulls/{number} --jq .node_id)
  COPILOT_BOT_ID=$(gh api \
    'users/copilot-pull-request-reviewer%5Bbot%5D' --jq .node_id)

  gh api graphql \
    -f pr="$PR_ID" \
    -f bot="$COPILOT_BOT_ID" \
    -f query='
mutation($pr: ID!, $bot: ID!) {
  requestReviews(input: {pullRequestId: $pr, botIds: [$bot]}) {
    pullRequest { number }
  }
}'
fi
```

Do not treat the generic REST requested-reviewers response as proof that review
completed. A successful request call is sufficient to start waiting. If GitHub
reports that Copilot is already requested or working on `TARGET_SHA`, treat the
request attempt as satisfied and wait; treat any other failure from both
request methods as a blocker. Never wait separately for `review_requested` or
`copilot_work_started`.

### SHA-aware wait

Poll up to 20 minutes with an interruptible monitor. On every poll, fetch a
fresh paginated snapshot and evaluate in this order:

1. PR head is no longer `TARGET_SHA` -> abandon the stale wait and reconcile.
2. Fetched base advanced -> invalidate readiness and return to step 5.
3. New user work exists -> stop waiting and run the batched bugfix workflow.
4. A completed Copilot review exists with `commit_id == TARGET_SHA` (and after
   an explicit request, is not in the recorded review-ID baseline) -> review is
   complete; read its overview and fetch threads immediately.
5. New unresolved Copilot threads attributable to `TARGET_SHA` exist -> triage
   immediately, but require completed review metadata before readiness.
6. Deadline expired -> report the timeout and the last full snapshot.
7. Otherwise continue waiting.

Never wait for an event merely because a previous event was observed. The
state predicate for readiness requires a completed Copilot review for the
target SHA and no actionable unresolved findings, including overview defects.

## 8. Repeat to convergence

After a Copilot review completes, refresh threads and checks. Drain new fixes,
push the next batch once, settle checks, and explicitly request review for the
new head. End only when:

- local `HEAD` equals the PR head and the worktree has no uncommitted workflow
  changes;
- checks for that head are settled and successful;
- applicable local gates, including required performance comparisons, passed
  on that revision and current base, with evidence in the PR body;
- Copilot has completed a review of that head;
- no unresolved actionable findings remain, including review overviews; and
- the head is zero commits behind the freshly fetched base.

Immediately before reporting ready, fetch the base again, capture immutable
`BASE_SHA` and `HEAD_SHA`, verify remote PR head still equals local `HEAD`, and
run `git rev-list --count "$HEAD_SHA..$BASE_SHA"`. It must return 0. Record both
SHAs and observation time outside the PR's commits; never commit a head-SHA
checkpoint onto the head it validates. If base advanced during checks/review
or this final check, invalidate readiness and return to step 5. A prior green
snapshot is historical evidence only. Report readiness for the observed pair
of SHAs with current-head advisory risks and their review links.

Count cycles by distinct pushed target SHA, not by polling attempts or event
transitions. From cycle 3 onward, tell bugfix implementors to consider whether
repeated findings in the same area require a small cohesive refactor. After 20
pushed-head cycles, push any completed local batch, stop, and report that
manual review is needed.

After convergence, apply
[queue completion](../bugfix/references/incidental-issues.md#finish-or-stop).
Only the outermost owner drains deferred branches; a nested resolver returns
them to its caller. On timeout, cycle cap, or blocker, report pending branch
references and leave them for resume.

## Rules

- Do not skip comments: fix, explain, show they are already handled, or report
  a blocked direct human request.
- Replies alone do not require a push or another Copilot review. A rebase
  required by an updated base still follows the push and review workflow.
  Also request review when the user explicitly asks.
- Once code changes are pushed, always request Copilot review of that exact
  head.
- Keep every network wait bounded, interruptible, and keyed to an immutable
  SHA. Refresh state before sleeping and after waking.
- Follow **agent-conduct**: never push `master`, `main`, or `develop`.
