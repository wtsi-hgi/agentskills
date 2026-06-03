---
name: pr-reviewer
description: Reviews changes on current branch vs base. Checks code quality, bugs, usability, and optionally spec conformance. Fixes issues via implementor subagents.
---

# PR Reviewer Skill

Read and follow **agent-conduct**, **subagents**, and the project's
**conventions** skill before starting. **subagents** covers orchestrator
role, agent selection (always writable), briefing, skill discovery, and
error handling. This skill covers only PR-review specifics.

You examine the diff, perform a thorough review, and fix issues by
delegating to implementor subagents.

## Input

- **Base reference** (optional): branch/SHA. Resolution order: caller-provided
  -> active PR `base.ref` -> fallback `develop`.
- **Spec document** (optional): path for conformance checking.
- **Focus areas** (optional): specific files or concerns.

## Procedure

### GitHub CLI prerequisite (mandatory)

Before resolving base or doing any diff/lint/test, verify `gh` is installed
and authenticated:

```bash
if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI (gh) is not installed. Stop. Install gh from https://cli.github.com/manual/installation, then run: gh auth login" >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "GitHub CLI (gh) is not authenticated. Stop. Run: gh auth login. For non-interactive environments, set GH_TOKEN or GITHUB_TOKEN, then confirm with: gh auth status" >&2
  exit 1
fi
```

If either check fails, stop, with instructions on how to install and
authenticate `gh`. Do not continue in local-only mode, silently skip PR data,
use `curl`, rely on raw tokens directly, use VS Code GitHub tools, or use the
web UI as a workaround.

### 0. Resolve base (mandatory)

Lock the review base before any diff/lint/test:

1. Caller-provided base, OR
2. PR `base.ref` (query via `gh pr view --json baseRefName` if needed), OR
3. `develop` (only if no PR exists and no caller base).

**Hard rules:** Never use repo default branch when a PR exists. Never diff
before base is resolved. Emit `Review base resolved: <base>`. If PR exists but
`base.ref` unavailable, stop and report failure.

### 1. Gather context

- Get current branch, collect `git diff <base>...HEAD` and `git diff HEAD`.
- Read full content of every modified file (not just diff hunks).

### 2. Check for open PR

Use `gh pr view --json number,baseRefName,headRefName,url` to check for an
active PR. If there is an active PR, validate the resolved base matches PR
`base.ref`. If there is no active PR, skip PR comment handling.

When an active PR exists, read all review comments via `gh api` (NOT the
VS Code tool - it caps at 50 and misreports state):

```bash
gh api repos/{owner}/{repo}/pulls/{number}/comments --paginate
```

Note unresolved threads as additional review items.

### 3. Code review

For every changed file, assess:

- **Quality:** Apply all rules from the project's conventions skill.
- **Bugs:** races, resource leaks, off-by-one, nil derefs, goroutines without
  exit paths, missing `await`, unvalidated external data.
- **Usability:** Are features actually usable end-to-end (not just mocked)?
  Clear CLI help/error messages? Edge cases handled?
- **Test quality:** Meaningful assertions? Faithful mocks? Adequate coverage?
  Conventions-compliant patterns?
- **Unresolved PR comments:** verify if current code addresses them.

### 4. Spec conformance (if spec provided)

Launch a reviewer subagent with the reviewer + conventions skill paths, spec
path, and modified files list.

### 5. Run linters and tests

Use commands from the conventions skill. Note failures.

### 6. Compile findings

Numbered list ordered by severity (bugs > quality > style). Each finding:
file/lines, category, description, suggested fix. If no findings, report clean
and stop.

### 7. Fix issues

For each finding:

**a.** Launch an implementor subagent with: implementor + conventions skill
paths, the specific finding (file, lines, description, fix), surrounding
context, and "Fix this issue. Follow TDD cycle. Run linters. Confirm tests
pass."

**b.** Verify the fix is correct and tests pass. Retry if needed.

**c.** If fixing addresses unresolved PR threads, reply (`fixed - ...`) and
resolve each thread.

**d.** Commit each fix (single-line imperative message, max 72 chars). Batch
purely cosmetic fixes into one style-cleanup commit.

### 8. Copilot re-review loop

If any resolved threads in step 7 were authored by Copilot (`login` =
`"Copilot"`, `"copilot-pull-request-reviewer"`,
`"copilot-pull-request-reviewer[bot]"`, or `"github-actions[bot]"` with
Copilot indicators), enter the re-review loop. Track a **cycle counter**
starting at 1.

**a. Push fixes.**
`git push` the current branch. This is an allowed exception to the
agent-conduct no-push rule (see agent-conduct § Git Safety).

**b. Wait for GitHub to see the push.**
Poll until the PR head SHA matches the local HEAD:

```bash
until [ "$(gh api repos/{owner}/{repo}/pulls/{number} --jq .head.sha)" = "$(git rev-parse HEAD)" ]; do sleep 5; done
```

**c. Request Copilot re-review.**

Use the official `gh pr edit --add-reviewer @copilot` path when available.
GitHub CLI versions before the Copilot-reviewer release can fail on unrelated
deprecated GraphQL fields, so fall back to the GraphQL `requestReviews`
mutation with `botIds`. Do **not** use the generic REST
`requested_reviewers` endpoint as proof that Copilot was queued; it can return
success-shaped PR data while creating no Copilot review request.

```bash
REQUEST_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)

if gh pr edit {number} --add-reviewer @copilot; then
  :
else
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

DEADLINE=$((SECONDS + 120))
until gh api repos/{owner}/{repo}/issues/{number}/events --paginate \
  --jq '[.[] | select(.created_at > "'"$REQUEST_TIME"'") | select(.event=="review_requested" and .requested_reviewer.login=="Copilot")] | length' \
  | grep -q '^[1-9]'; do
  if [ "$SECONDS" -ge "$DEADLINE" ]; then
    echo "Timed out waiting for Copilot review_requested event" >&2
    exit 1
  fi
  sleep 5
done
```

Optionally confirm that Copilot work started before waiting for the review:

```bash
gh api repos/{owner}/{repo}/issues/{number}/events --paginate \
  --jq '.[] | select(.created_at > "'"$REQUEST_TIME"'") | select(.event=="review_requested" or .event=="copilot_work_started")'
```

**d. Wait for new Copilot review.**
Poll for a Copilot review submitted after `REQUEST_TIME` from step 8c:

```bash
while true; do
  LATEST=$(gh api repos/{owner}/{repo}/pulls/{number}/reviews --paginate \
    --jq '[.[] | select(.user.login=="copilot-pull-request-reviewer[bot]") | select(.submitted_at > "'"$REQUEST_TIME"'") | .id] | last')
  [ -n "$LATEST" ] && break
  sleep 15
done
```

Timeout after 20 minutes; if no review appears, log a warning and exit the
loop.

**e. Check for new Copilot comments.**
Re-fetch PR comments (step 2 recipe). Filter for unresolved threads authored
by Copilot that were not present in the previous cycle.

- If **no new Copilot comments** exist, the loop ends.
- If **new Copilot comments** exist, increment the cycle counter and process
  them as in step 7 (fix, reply, resolve, commit), then return to step 8a.

**f. Escalation for persistent issues.**
If the cycle counter reaches **3 or more**, the implementor subagent prompts
must prepend this instruction:

> Consider the problem holistically. The same area has attracted repeated
> reviewer findings across multiple fix cycles. Rather than patching
> individual comments, refactor the surrounding code so that reviewers do not
> keep finding issues.

After **20 cycles**, stop the loop, push whatever has been committed, and
report that Copilot keeps raising issues - manual review is needed.

## Rules

- Follow the rules in **subagents** (no direct fixes, no read-only agents
  for work that must change files or run tests).
- NEVER skip findings.
- One fix per commit (cosmetic batches excepted).
- Reply+resolve PR threads before committing fixes that address them.
- `gh` is mandatory. If it is not installed or authenticated, stop, with
  instructions on how to install and authenticate `gh`; do not attempt
  workarounds.
- `git push` is ONLY permitted during the Copilot re-review loop (step 8).
  This is the sole exception to the agent-conduct no-push rule.

## Appendix: GitHub API Recipes

All commands require an installed and authenticated `gh` CLI. If `gh` is not
installed or `gh auth status` fails, stop, with instructions on how to install
and authenticate `gh`. Do not fall back to `curl`, raw token calls, VS Code
GitHub tools, or the web UI.

### Verify GitHub CLI

```bash
command -v gh >/dev/null 2>&1
gh auth status >/dev/null 2>&1
```

### Fetch PR comments

```bash
gh api repos/{owner}/{repo}/pulls/{number}/comments --paginate
```

Root comments only:

```bash
gh api repos/{owner}/{repo}/pulls/{number}/comments --paginate \
  --jq '[.[] | select(.in_reply_to_id == null)] | .[] | "\(.id) \(.path) \(.body[:80])"'
```

### Reply to thread

```bash
gh api repos/{owner}/{repo}/pulls/{number}/comments \
  -f body='fixed - <description>' -F in_reply_to=<comment_id>
```

### Resolve thread (GraphQL)

Get thread node IDs:

```bash
gh api graphql -f query='{
  repository(owner: "{owner}", name: "{repo}") {
    pullRequest(number: {number}) {
      reviewThreads(last: 100) {
        nodes { id isResolved comments(first: 1) { nodes { databaseId path } } }
      }
    }
  }
}'
```

Resolve:

```bash
gh api graphql -f query='mutation {
  resolveReviewThread(input: {threadId: "{thread_node_id}"}) {
    thread { isResolved }
  }
}'
```

### Request Copilot re-review

Preferred path:

```bash
REQUEST_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)
gh pr edit {number} --add-reviewer @copilot
```

Fallback for older GitHub CLI versions:

```bash
REQUEST_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)
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
```

Verify Copilot was queued:

```bash
gh api repos/{owner}/{repo}/issues/{number}/events --paginate \
  --jq '.[] | select(.created_at > "'"$REQUEST_TIME"'") | select(.event=="review_requested" or .event=="copilot_work_started")'
```

Do not rely on this REST call for Copilot re-review:

```bash
gh api repos/{owner}/{repo}/pulls/{number}/requested_reviewers \
  -f 'reviewers[]=copilot'
```

It can return successful PR data while leaving no `review_requested` event and
no queued Copilot review.

### Poll for Copilot review after a push

```bash
while true; do
  LATEST=$(gh api repos/{owner}/{repo}/pulls/{number}/reviews --paginate \
    --jq '[.[] | select(.user.login=="copilot-pull-request-reviewer[bot]") | select(.submitted_at > "'"$REQUEST_TIME"'") | .id] | last')
  [ -n "$LATEST" ] && break
  sleep 15
done
```

### Filter new unresolved Copilot comments

```bash
gh api repos/{owner}/{repo}/pulls/{number}/comments --paginate \
  --jq '[.[] | select(.user.login=="Copilot" or .user.login=="copilot-pull-request-reviewer[bot]") | select(.in_reply_to_id == null)] | .[] | "\(.id) \(.path) \(.body[:80])"'
```

Cross-reference with resolved thread IDs from the GraphQL query to find only
unresolved ones.
