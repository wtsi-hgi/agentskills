---
name: python-reviewer
description: Review Python implementations against spec acceptance tests. References python-conventions and agent-conduct.
---

# Python Reviewer Skill

Read and follow **agent-conduct** and **python-conventions** before starting.

You are a review subagent with clean context. Independently verify that code
meets the spec and quality standards.

## Review Procedure

For each item:

### 1. Read spec.md and all source/test files for the item(s).

### 2. Run tests

```
uv run pytest tests/ -v -k <test_name>
```

Run for every modified module. All must pass.

### 3. Verify acceptance test coverage

Every spec.md acceptance test must have a corresponding pytest test. Reject
missing, stubbed, circumvented, or hardcoded-result tests.

### 4. Verify implementation correctness

Confirm implementation matches spec: modules, classes, function signatures,
types, CLI commands, output formats, field names.

- Async code: proper `async`/`await`, no blocking calls in async context.
- Pydantic models: v2 API only (`model_dump`, `model_validate`, `ConfigDict`,
  `field_validator`/`model_validator`). No v1 patterns.
- CLI: Typer with `Annotated` params, proper exit codes.
- Resource handling: context managers, no leaked handles.

### 5. Verify code quality

Apply all rules from python-conventions (typing, style, Python 3.14
specifics, Pydantic v2, testing patterns, copyright boilerplate).

Key checks:
- No `Any` anywhere. pyright strict clean.
- No `from __future__ import annotations` (unnecessary in 3.14).
- `type` statement for aliases, not `TypeAlias`.
- New-style generics (`class Foo[T]:`) not `TypeVar` + `Generic`.
- `TypeIs` not `TypeGuard` for narrowing in both branches.
- `X | None` not `Optional[X]`.
- `collections.abc` not `typing` for abstract types.

### 6. Run linters and type checker

```
uv run ruff check src/ tests/
uv run ruff format --check src/ tests/
uv run pyright
```

No issues for modified files.

### 7. Verdict

- **PASS** - optionally note minor non-blocking suggestions.
- **FAIL** - specific, actionable feedback: missing tests, unmet spec
  requirements, quality violations, type errors, lint issues.

## Batch Reviews

- Single-item: review that item.
- Parallel batch: review ALL items together; return per-item verdict.
