---
name: pr-resolver
description: Resolve GitHub PR review comments from humans and Copilot. Use when asked to address PR comments, distinguish required human change requests from questions or suggestions, evaluate invalid or low-value comments, reply and resolve threads, and push only when needed for Copilot re-review.
---

# PR Resolver Skill

Read and follow **agent-conduct**. If code changes are needed, also read
**subagents**, the project's **conventions** skill, and the matching
implementor skill. This skill covers PR review comment resolution.

## Core rule

For each comment, verify the concern against the current code before acting.
Code changes are not always required.

- Treat direct human requests for changes as requirements: implement them, or
  report a blocker if they are impossible, unsafe, or conflict with other
  requirements.
- Treat human questions, hedged suggestions, "consider..." comments, and nits
  like review input: answer, fix, or explain why no code change is needed.
- Treat Copilot comments like review input: verify them before acting. Fix
  valid issues; otherwise reply that the suggestion is invalid, stale,
  non-actionable, duplicate, already covered, or would make the code worse.

Resolve the thread after replying unless a direct human change request is
blocked and needs a decision. Do not make churn-only code changes just to
appease a reviewer.

## Procedure

### 1. Confirm PR access

`gh` is mandatory. If it is missing or unauthenticated, stop and tell the user
to install/authenticate GitHub CLI.

```bash
command -v gh >/dev/null 2>&1
gh auth status >/dev/null 2>&1
gh pr view --json number,baseRefName,headRefName,url
```

Use `gh api`; do not use VS Code GitHub tools for PR comments because they can
cap or misreport review-thread state.

### 2. Find unresolved review threads

Copilot authors include `Copilot`, `copilot-pull-request-reviewer`,
`copilot-pull-request-reviewer[bot]`, and `github-actions[bot]` when the body
or surrounding event data clearly indicates Copilot.

Fetch review threads through GraphQL so `isResolved` is available. Paginate if
the PR has more than 100 threads.

```bash
gh api graphql -f query='{
  repository(owner: "{owner}", name: "{repo}") {
    pullRequest(number: {number}) {
      reviewThreads(last: 100) {
        nodes {
          id
          isResolved
          comments(first: 1) {
            nodes { databaseId path line author { login } body }
          }
        }
      }
    }
  }
}'
```

### 3. Triage each thread

Read the current file and nearby tests before deciding. For each unresolved
thread, choose exactly one outcome:

- **Fix:** The concern is valid and current code should change. Delegate to an
  implementor subagent with the exact comment, file/line, surrounding context,
  and instructions to follow TDD, run lint/tests, and avoid unrelated changes.
- **Explain:** The concern does not warrant a code change. Reply in the review
  thread with the concrete reason and resolve it.
- **Already handled:** Current code or tests already address the concern.
  Reply with the evidence and resolve it.
- **Blocked:** A direct human change request is impossible, unsafe, or
  conflicts with another requirement. Do not resolve it silently; report the
  blocker and the needed decision.

After code fixes, verify the diff and the implementor's reported quality-gate
results, then reply and resolve the relevant thread before committing. Commit
code changes with a short imperative message. Comment-only resolutions do not
need a commit.

### 4. Reply and resolve

Reply before resolving. Keep replies direct: `fixed - ...`,
`not changing - ...`, or `already covered - ...`.

```bash
gh api repos/{owner}/{repo}/pulls/{number}/comments \
  -f body='not changing - <concise technical reason>' \
  -F in_reply_to=<comment_id>

gh api graphql -f query='mutation {
  resolveReviewThread(input: {threadId: "{thread_node_id}"}) {
    thread { isResolved }
  }
}'
```

### 5. Copilot re-review loop

Run this loop only after committed code changes address Copilot comments, or
when the user explicitly asks for a Copilot re-review. If every thread was
resolved by explanation or "already handled" replies, do not push or request
another review unless asked. If human comments changed code but Copilot did
not comment on those changes, do not start the Copilot loop.

Track a cycle counter starting at 1.

1. Push the current branch. This is the allowed `git push` exception in
   **agent-conduct** for this skill.
2. Wait until GitHub sees local `HEAD`:

```bash
until [ "$(gh api repos/{owner}/{repo}/pulls/{number} --jq .head.sha)" = "$(git rev-parse HEAD)" ]; do
  sleep 5
done
```

3. Request Copilot re-review. Prefer `gh pr edit`; fall back to GraphQL
   `requestReviews` with `botIds`. Do not treat the generic REST
   `requested_reviewers` endpoint as proof that Copilot was queued.

```bash
REQUEST_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)

if ! gh pr edit {number} --add-reviewer @copilot; then
  PR_ID=$(gh api repos/{owner}/{repo}/pulls/{number} --jq .node_id)
  COPILOT_BOT_ID=$(gh api 'users/copilot-pull-request-reviewer%5Bbot%5D' --jq .node_id)

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

4. Confirm a `review_requested` or `copilot_work_started` event appears after
   `REQUEST_TIME`; time out after 2 minutes if neither appears.
5. Poll up to 20 minutes for a new
   `copilot-pull-request-reviewer[bot]` review submitted after `REQUEST_TIME`.
6. Re-fetch unresolved review threads. Continue the loop only for new
   unresolved Copilot comments. If Copilot stops commenting, end the loop even
   if unrelated human comments remain.

If the cycle counter reaches 3, prepend implementor prompts with:

> Consider the problem holistically. The same area has attracted repeated
> reviewer findings across multiple fix cycles. Rather than patching
> individual comments, refactor the surrounding code so that reviewers do not
> keep finding issues.

After 20 cycles, stop, push committed work, and report that Copilot keeps
raising issues and manual review is needed.

## Rules

- `gh` is mandatory; do not fall back to `curl`, raw tokens, VS Code GitHub
  tools, or the web UI.
- Do not skip review comments. Resolve each with a code fix, a no-code
  explanation, or evidence that it is already handled. Report blocked direct
  human change requests instead of silently resolving them.
- Do not request Copilot re-review when only comment replies changed unless
  the user asks.
- `git push` is permitted only inside the re-review loop.
