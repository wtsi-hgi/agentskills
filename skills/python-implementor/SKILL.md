---
name: python-implementor
description: Python TDD implementation workflow. References implementation-principles, python-conventions, testing-principles, and agent-conduct.
context: fork
---

# Python Implementor Skill

Read and follow **agent-conduct**, **implementation-principles**,
**testing-principles**, and **python-conventions** before starting.

## Python TDD Steps

- Test framework: pytest.
- Targeted test: `uv run pytest tests/ -v -k <test_name>`
- Lint with:
  `uv run ruff check --fix src/ tests/ && uv run ruff format src/ tests/`
- Type check with: `uv run pyright`
