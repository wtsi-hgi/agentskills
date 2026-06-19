---
name: pr-resolver
description: Resolve GitHub PR review comments from humans and Copilot. Use when asked to address PR comments, distinguish required human change requests from questions or suggestions, evaluate invalid or low-value comments, reply and resolve threads, and run PR CI/Copilot loops.
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

### 5. CI and Copilot loop

Run this loop after committed PR code changes, when PR checks fail, or when
the user explicitly asks for a Copilot re-review. If every thread was resolved
by explanation or "already handled" replies and checks already pass, do not
push or request another review unless asked.

Track a cycle counter starting at 1.

1. Confirm the current branch is safe to push, then push the PR branch.

```bash
branch=$(git branch --show-current)
case "$branch" in
  master|main|develop|"")
    echo "Stop: never push $branch" >&2
    exit 1
    ;;
esac
git push
```

This is allowed by **agent-conduct** only because this skill is working on a
PR. Do not force-push unless the user explicitly asked.

2. Wait until GitHub sees local `HEAD`:

```bash
until [ "$(gh api repos/{owner}/{repo}/pulls/{number} --jq .head.sha)" = "$(git rev-parse HEAD)" ]; do
  sleep 5
done
```

3. Wait for checks. If any fail, inspect logs, reproduce locally, fix, commit,
   and return to step 1. Do not request Copilot re-review while checks fail.

```bash
gh pr checks {number} -R {owner}/{repo} --watch --fail-fast

gh pr view {number} -R {owner}/{repo} \
  --json headRefOid,statusCheckRollup \
  --jq '.statusCheckRollup[] |
    {name, workflowName, status, conclusion, state, detailsUrl}'
```

For a failed GitHub Actions job, first try the CLI log command:

```bash
gh run view {run_id} -R {owner}/{repo} --job {job_id} --log-failed
```

If the workflow run is still in progress, `gh run view` may refuse logs even
for a completed failed job. Use the job API instead; get `{run_id}` and
`{job_id}` from the `detailsUrl` like
`.../actions/runs/{run_id}/job/{job_id}`.

```bash
gh api repos/{owner}/{repo}/actions/jobs/{job_id} \
  --jq '{id, run_id, name, status, conclusion, html_url,
         steps: [.steps[] |
           select(.conclusion != "success" and .conclusion != "skipped")] }'

gh api repos/{owner}/{repo}/actions/jobs/{job_id}/logs |
  rg -n -i -C 3 '##\[error\]|error|fail|panic|traceback|make:|eslint|prettier'
```

For non-Actions check runs, inspect output and annotations:

```bash
gh api repos/{owner}/{repo}/commits/{head_sha}/check-runs \
  --jq '.check_runs[] |
    select(.conclusion != null and .conclusion != "success") |
    {id, name, conclusion, details_url, output}'

gh api repos/{owner}/{repo}/check-runs/{check_run_id}/annotations --paginate
```

4. When checks pass, request Copilot re-review if committed code changes
   addressed Copilot comments or the user asked for it. Prefer `gh pr edit`;
   fall back to GraphQL `requestReviews` with `botIds`. Do not treat the
   generic REST `requested_reviewers` endpoint as proof that Copilot was
   queued.

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

5. Confirm a `review_requested` or `copilot_work_started` event appears after
   `REQUEST_TIME`; time out after 2 minutes if neither appears.
6. Poll up to 20 minutes for a new
   `copilot-pull-request-reviewer[bot]` review submitted after `REQUEST_TIME`.
7. Re-fetch unresolved review threads and checks. Continue the loop for any
   failed check or new unresolved Copilot comment. End only when checks pass
   and Copilot has no new unresolved comments.

If the cycle counter reaches 3, prepend implementor prompts with:

> Consider the problem holistically. The same area has attracted repeated
> reviewer findings across multiple fix cycles. Rather than patching
> individual comments, refactor the surrounding code so that reviewers do not
> keep finding issues.

After 20 cycles, stop after any committed PR-branch work has been pushed and
report that checks or Copilot keep failing and manual review is needed.

## Rules

- `gh` is mandatory; do not fall back to `curl`, raw tokens, VS Code GitHub
  tools, or the web UI.
- Do not skip review comments. Resolve each with a code fix, a no-code
  explanation, or evidence that it is already handled. Report blocked direct
  human change requests instead of silently resolving them.
- Do not request Copilot re-review when only comment replies changed unless
  the user asks.
- Follow **agent-conduct** for pushes: never push `master`, `main`, or
  `develop`; push other branches only when asked or while updating this PR.
