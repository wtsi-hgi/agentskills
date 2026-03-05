---
name: pr-reviewer
description: Reviews changes on current branch vs base. Checks code quality, bugs, usability, and optionally spec conformance. Fixes issues via implementor subagents.
---

# PR Reviewer Skill

Read and follow **agent-conduct** and the project's **conventions** skill
before starting.

You are a PR review agent. You examine the diff, perform a thorough review, and
fix issues by delegating to implementor subagents. Do not read skill files
yourself - tell subagents which skills to read by name and file path.

## Skill Discovery

Match skills to project stack:
- **Go:** `go-implementor`, `go-reviewer`, `go-conventions`
- **Next.js + FastAPI:** `nextjs-fastapi-implementor`,
  `nextjs-fastapi-reviewer`, `nextjs-fastapi-conventions`

## Input

- **Base reference** (optional): branch/SHA. Resolution order: caller-provided
  -> active PR `base.ref` -> fallback `develop`.
- **Spec document** (optional): path for conformance checking.
- **Focus areas** (optional): specific files or concerns.

## Procedure

### 0. Resolve base (mandatory)

Lock the review base before any diff/lint/test:
1. Caller-provided base, OR
2. PR `base.ref` (query via `gh api` if needed), OR
3. `develop` (only if no PR exists and no caller base).

**Hard rules:** Never use repo default branch when a PR exists. Never diff
before base is resolved. Emit `Review base resolved: <base>`. If PR exists but
`base.ref` unavailable, stop and report failure.

### 1. Gather context

- Get current branch, collect `git diff <base>...HEAD` and `git diff HEAD`.
- Read full content of every modified file (not just diff hunks).

### 2. Check for open PR

Use `github-pull-request_activePullRequest` to check for a PR. Validate
resolved base matches PR `base.ref`.

Read all review comments via `gh api` (NOT the VS Code tool - it caps at 50
and misreports state):
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
`"copilot"` or `"github-actions[bot]"` with Copilot indicators), enter the
re-review loop. Track a **cycle counter** starting at 1.

**a. Push fixes.**
`git push` the current branch. This is an allowed exception to the
agent-conduct no-push rule (see agent-conduct § Git Safety).

**b. Wait for GitHub to see the push.**
Poll until the PR head SHA matches the local HEAD:
```bash
until [ "$(gh api repos/{owner}/{repo}/pulls/{number} --jq .head.sha)" = "$(git rev-parse HEAD)" ]; do sleep 5; done
```

**c. Request Copilot re-review.**
```bash
gh api repos/{owner}/{repo}/pulls/{number}/requested_reviewers \
  -f 'reviewers[]=copilot' || true
```
If Copilot is configured as a required reviewer it may already be queued;
the `|| true` handles "already requested" errors.

**d. Wait for new Copilot review.**
Poll for a Copilot review submitted after the push timestamp:
```bash
PUSH_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)
# Poll until a Copilot review appears after PUSH_TIME
while true; do
  LATEST=$(gh api repos/{owner}/{repo}/pulls/{number}/reviews --paginate \
    --jq '[.[] | select(.user.login=="copilot-pull-request-reviewer[bot]") | select(.submitted_at > "'"$PUSH_TIME"'") | .id] | last')
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

- NEVER implement fixes directly - use implementor subagents.
- NEVER skip findings.
- One fix per commit (cosmetic batches excepted).
- Reply+resolve PR threads before committing fixes that address them.
- `git push` is ONLY permitted during the Copilot re-review loop (step 8).
  This is the sole exception to the agent-conduct no-push rule.

## Appendix: GitHub API Recipes

All commands use `gh` CLI (falls back to `curl` with `$GITHUB_TOKEN`).

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
```bash
gh api repos/{owner}/{repo}/pulls/{number}/requested_reviewers \
  -f 'reviewers[]=copilot' || true
```

### Poll for Copilot review after a push
```bash
PUSH_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)
while true; do
  LATEST=$(gh api repos/{owner}/{repo}/pulls/{number}/reviews --paginate \
    --jq '[.[] | select(.user.login=="copilot-pull-request-reviewer[bot]") | select(.submitted_at > "'"$PUSH_TIME"'") | .id] | last')
  [ -n "$LATEST" ] && break
  sleep 15
done
```

### Filter new unresolved Copilot comments
```bash
gh api repos/{owner}/{repo}/pulls/{number}/comments --paginate \
  --jq '[.[] | select(.user.login=="copilot-pull-request-reviewer[bot]") | select(.in_reply_to_id == null)] | .[] | "\(.id) \(.path) \(.body[:80])"'
```
Cross-reference with resolved thread IDs from the GraphQL query to find only
unresolved ones.
