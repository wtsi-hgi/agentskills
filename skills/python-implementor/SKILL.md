---
name: python-implementor
description: Python TDD implementation workflow. References python-conventions and agent-conduct.
context: fork
---

# Python Implementor Skill

Read and follow **agent-conduct** and **python-conventions** before starting.

## TDD Cycle

For each acceptance test, follow every step:

1. Write a failing pytest test.
2. Run: `uv run pytest tests/ -v -k <test_name>`
3. Write minimal implementation to pass.
4. Refactor.
5. Lint: `uv run ruff check --fix src/ tests/ && uv run ruff format src/ tests/`
6. Type check: `uv run pyright`
7. Re-run test to confirm it passes.

## Workflow

Implement ONE item at a time: write all pytest tests for the spec.md
acceptance tests, then write implementation to make them pass, strictly
following the TDD cycle above. Consult spec.md for full details.
