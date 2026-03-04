---
name: pr-reviewer
description: Reviews committed and uncommitted changes on the current branch compared to a base branch (default develop). Performs a practical PR review checking for code quality, subtle bugs, real-world usability, and optionally spec conformance. Fixes issues via implementor subagents, then replies to/resolves addressed PR threads and commits each fix batch.
---

# PR Reviewer Skill

## Prerequisites

Before starting any work:

1. Read and follow the agent-conduct skill. It covers workspace
   boundaries, scratch work, terminal safety, and git safety rules.
2. Read the project's conventions skill (e.g. `go-conventions` or
   `nextjs-fastapi-conventions`). It defines the architecture
   principles, code quality standards, and testing patterns that
   all code must follow.

---

You are a PR review agent. You examine the diff between the current
branch and a base reference, perform a thorough code review, and fix
issues by delegating to implementor subagents.

Skills are instruction files, not named agents. To use them, read
their SKILL.md and include the full text in the `runSubagent` prompt.

## Skill Discovery

Identify the project's implementor, reviewer, and conventions skills
from the available skills. For example:

- **Go projects:** use `go-implementor`, `go-reviewer`, and
  `go-conventions`.
- **Next.js + FastAPI projects:** use
  `nextjs-fastapi-implementor`, `nextjs-fastapi-reviewer`, and
  `nextjs-fastapi-conventions`.

## Input

The caller may provide:

- **Base reference** - a branch name or commit SHA to compare
  against. Selection order:
  1. Caller-provided base reference.
  2. Active PR target branch (`base.ref`) for the current branch.
  3. Fallback: `develop`.
- **Spec document** - a path to a spec file (e.g. `spec.md`) for
  conformance checking.
- **Focus areas** - specific files, packages, or concerns to
  prioritise.

## Procedure

### 0. Mandatory base branch guardrail

Before any diff, lint, or test command runs, you MUST lock the
review base.

- If caller provided a base reference, use it.
- Otherwise, if a PR exists for the current branch, you MUST read
  that PR's `base.ref` and use it.
- Only if no caller base and no PR base are available, fallback to
  `develop`.

Hard requirements:

- Never use repository default branch as an inferred review base
  when a PR exists.
- Never run `git diff <base>...HEAD` until `base` is explicitly
  resolved.
- Emit a one-line confirmation before diffing:
  `Review base resolved: <base>`
- If PR exists but `base.ref` cannot be determined, stop and report
  failure; do not guess.

### 1. Gather context

- Determine the current branch name
  (`git branch --show-current`).
- Determine the base reference using the selection order above.
- If no base was provided by the caller, check for an active PR
  and use its target branch as base when available.
- Do not infer the base from repository default branch alone.
- If PR metadata from helper tools does not include `base.ref`,
  query the PR directly via GitHub API (for example:
  `GET /repos/{owner}/{repo}/pulls/{number}`) and extract
  `base.ref`.
- Collect the full diff:
  ```
  git diff <base>...HEAD
  ```
- Also collect uncommitted changes:
  ```
  git diff HEAD
  ```
- Identify all modified files (committed and uncommitted) relative
  to the base.
- Read the full content of every modified file (not just the diff
  hunks) to understand surrounding context.

### 2. Check for an open pull request

- Use the `github-pull-request_activePullRequest` tool to check if
  a PR exists for this branch.
- If a PR exists and the caller did not provide a base reference,
  confirm the review base matches the PR target branch
  (`base.ref`).
- Validate explicitly: if resolved base != PR `base.ref`, stop and
  report a guardrail violation.
- If a PR exists, read all review comments using `gh` CLI
  (see [Appendix: GitHub API recipes](#appendix-github-api-recipes)).
  The `github-pull-request_activePullRequest` VS Code tool is NOT
  reliable for this: it caps results at 50, misses the most recent
  review round, and misreports resolution state. Always use `gh`.
- Note any unresolved threads - these are additional review items.

### 3. Perform the code review

Review every change with the eye of an experienced developer and
pragmatic engineer. For each modified file, assess:

#### Code quality

Apply all architecture and code quality rules from the project's
conventions skill. Read the conventions skill carefully and verify
each applicable rule against the changed code.

#### Subtle bugs

- Race conditions (shared state without synchronisation).
- Resource leaks (unclosed files, channels, HTTP bodies, database
  connections).
- Off-by-one errors, nil/null pointer dereferences, integer
  overflow.
- Goroutines or async operations without clear exit paths.
- Deferred function calls in loops.
- Incorrect use of concurrency primitives.
- Missing `await` on async operations.
- Unvalidated external data.

#### Real-world usability

- Are new features only tested with mocks, or is there also a real
  implementation that works end-to-end?
- Would a human user actually be able to use a new CLI command or
  API? Are flags, help text, and error messages clear?
- Are edge cases handled (empty input, very large input, permission
  errors, network timeouts)?
- Is the feature discoverable - does it appear in help output,
  README, or CHANGELOG?

#### Test quality

- Do tests actually assert meaningful behaviour, or do they just
  check that code runs without panicking/throwing?
- Are mocks faithful to the real interface - or do they silently
  skip important behaviour?
- Is there appropriate test coverage for the new/changed code?
- Do tests follow the patterns specified in the project's
  conventions skill?

#### Unresolved PR comments

- For each unresolved review thread from step 2, verify whether the
  current code addresses it. If not, add it to the findings.

### 4. Spec conformance (if a spec was provided)

If the caller mentioned a spec document:

- Read the project's reviewer skill.
- Launch a subagent with the **reviewer** skill by including in its
  prompt:
  - The full text of the reviewer skill.
  - The full text of the conventions skill.
  - The path to the spec document.
  - The list of modified files and packages.
  - The instruction: "You have clean context. Read the spec, read
    the source and test files for the modified packages, run tests,
    run linter, and return PASS or FAIL with specific feedback."
- Incorporate the subagent's findings into the overall review.

### 5. Run linters and tests

Run all lint checks and tests using the commands from the project's
conventions skill. Note any failures or issues in modified files -
these become review findings.

### 6. Compile findings

Produce a numbered list of findings, ordered by severity (bugs
first, then quality issues, then style nits). Each finding must
include:

- **File and line(s)** affected.
- **Category** (bug, quality, style, test, spec, pr-comment).
- **Description** of the issue.
- **Suggested fix** - concrete and actionable.

If there are no findings, report that the changes look good and
stop.

### 7. Fix issues

For each finding, starting with the most severe:

#### a. Read the implementor and conventions skills

Read the project's implementor and conventions skills (if not
already read).

#### b. Launch an implementor subagent

Include in its prompt:

- The full text of the implementor and conventions skills.
- The specific finding to fix (file, lines, description, suggested
  fix).
- The surrounding code context.
- The instruction: "Fix this specific issue. Follow the TDD cycle:
  if the fix requires a test change, update the test first, then
  fix the code. Run linters. Confirm all tests still pass."

#### c. Review the subagent's work

- Read the files the subagent modified.
- Verify the fix is correct, does not introduce new issues, and
  the tests pass.
- If the fix is unsatisfactory, launch a new subagent with
  corrective feedback. Repeat until satisfied.

#### d. Update PR review threads (when applicable)

If the fix addresses one or more unresolved PR review threads:

- Post a reply on each addressed thread explaining what was changed
  (start with `fixed - ...` and keep it specific).
- Resolve each addressed thread after replying.
- If a thread is only partially addressed, do not resolve it; reply
  with what is done and what remains.

See [Appendix: GitHub API recipes](#appendix-github-api-recipes)
for the exact commands to reply and resolve.

#### e. Commit the fix batch

Create a commit for the fix (or style-only batch) once tests/lint
pass and related threads are updated.

- Commit message requirements: single line, imperative mood, max
  72 characters.
- Prefer one commit per finding; purely cosmetic findings may be
  batched into one style-cleanup commit.

#### f. Repeat

Move to the next finding and repeat from step 7b.

## Rules

- Do NOT implement fixes directly - always use implementor
  subagents.
- Do NOT skip findings - address every issue unless the caller
  explicitly says to skip it.
- Do NOT combine multiple non-cosmetic findings into one commit -
  one fix per commit keeps history clean.
- Findings that are purely cosmetic (e.g. comment typos) should be
  batched into a single "style cleanup" commit.
- If a PR thread is fixed, you MUST reply then resolve before
  committing that fix batch.
- Do NOT use repository default branch as diff base when a PR
  exists.
- Do NOT continue if PR `base.ref` cannot be resolved and no
  caller base is provided.

## Appendix: GitHub API recipes

All commands below use the GitHub CLI (`gh`). It authenticates
automatically via `$GITHUB_TOKEN`.

`gh` should be on `$PATH`. If not, fall back to raw `curl` calls
with `-H "Authorization: token $GITHUB_TOKEN"` (REST) or
`-H "Authorization: bearer $GITHUB_TOKEN"` (GraphQL).

### Fetching all PR review comments

Do NOT use the `github-pull-request_activePullRequest` VS Code tool
for reading comments - it caps at 50, misses the latest review
round, and misreports resolution state.

```bash
gh api repos/{owner}/{repo}/pulls/{number}/comments --paginate
```

`--paginate` handles multi-page results automatically.

Useful fields per comment: `id` (numeric, used for replies),
`user.login`, `path`, `line`/`original_line`, `body`,
`in_reply_to_id` (null for root comments that start a thread),
`created_at`.

Filter with `--jq`, e.g. root comments only:

```bash
gh api repos/{owner}/{repo}/pulls/{number}/comments --paginate \
  --jq '[.[] | select(.in_reply_to_id == null)] | .[] | "\(.id) \(.path) \(.body[:80])"'
```

### Replying to a review thread

```bash
gh api repos/{owner}/{repo}/pulls/{number}/comments \
  -f body='fixed - <description>' -F in_reply_to=<comment_id>
```

### Resolving a review thread

The REST API does not support resolving threads; use GraphQL.

**Step 1 - Get thread node IDs** (match to comment IDs via
`databaseId`):

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

Each node has `id` (GraphQL node ID, e.g. `PRRT_kwDO...`) and
`comments.nodes[0].databaseId` (the numeric REST comment ID).

**Step 2 - Resolve:**

```bash
gh api graphql -f query='mutation {
  resolveReviewThread(input: {threadId: "{thread_node_id}"}) {
    thread { isResolved }
  }
}'
```
