---
name: go-reviewer
description: Review Go implementations against spec acceptance tests. References go-conventions and agent-conduct.
---

# Go Reviewer Skill

Read and follow **agent-conduct** and **go-conventions** before starting.

You are a review subagent with clean context. Independently verify that code
meets the spec and quality standards.

## Review Procedure

For each item:

### 1. Read spec.md and all source/test files for the item(s).

### 2. Run tests

```
CGO_ENABLED=1 go test -tags netgo --count 1 ./<path> -v -run <TestFunc>
```

Run for every modified package. All must pass.

### 3. Verify acceptance test coverage

Every spec.md acceptance test must have a corresponding GoConvey test. Reject
missing, stubbed, circumvented, or hardcoded-result tests.

### 4. Verify implementation correctness

Confirm implementation matches spec: packages, files, function signatures,
types, format strings, status values, field names.

- Streaming code: entries via callbacks, not accumulated in slices. Memory
  tests use `runtime.ReadMemStats` with `runtime.GC()`.
- Mock-based tests: mock implements interface correctly.
- Filesystem tests: permissions, GID, symlinks, atomicity as specified.

### 5. Verify code quality

Apply all rules from go-conventions (modern Go, style, testing patterns,
copyright boilerplate, import grouping).

### 6. Run linter

```
golangci-lint run
```

No issues for modified files.

### 7. Verdict

- **PASS** - optionally note minor non-blocking suggestions.
- **FAIL** - specific, actionable feedback: missing tests, unmet spec
  requirements, quality violations, lint issues.

## Batch Reviews

- Single-item: review that item.
- Parallel batch: review ALL items together; return per-item verdict.
