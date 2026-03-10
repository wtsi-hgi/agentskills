---
name: python-conventions
description: Shared conventions for modern Python 3.14 projects. Project layout, typing, linting, testing, and commands. Referenced by python-implementor, python-reviewer, and workflow skills.
---

# Python Conventions

Single source of truth for Python code standards. Other skills reference this.

## Copyright Boilerplate

All new source files must start with:

```
# Copyright (c) 2026 Genome Research Ltd.
#
# Author: Sendu Bala <sb10@sanger.ac.uk>
#
# Permission is hereby granted, free of charge, to any person obtaining
# a copy of this software and associated documentation files (the
# "Software"), to deal in the Software without restriction, including
# without limitation the rights to use, copy, modify, merge, publish,
# distribute, sublicense, and/or sell copies of the Software, and to
# permit persons to whom the Software is furnished to do so, subject to
# the following conditions:
#
# The above copyright notice and this permission notice shall be included
# in all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
# EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
# MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
# IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
# CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
# TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
# SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## Project Layout

```
pyproject.toml          # single config file (no setup.py, setup.cfg, requirements.txt)
src/<pkg>/              # all source code under src/
  __init__.py
  py.typed              # PEP 561 marker
tests/                  # mirrors src/ structure
```

- **uv** for dependency management and virtualenvs. Never pip install directly.
- All tool config (ruff, pyright, pytest) lives in `pyproject.toml`.

## Python 3.14 Specifics

LLMs trained on older code will get these wrong. Pay attention.

- **PEP 649 deferred annotations are the default.** Do NOT add
  `from __future__ import annotations`. It is unnecessary and discouraged.
  All annotations are evaluated lazily at runtime automatically.
- **PEP 728 `TypedDict` with `extra_items`.** Use `closed=True` on TypedDicts
  that should reject extra keys; use `extra_items=<type>` for known-extra
  patterns. These replace `@final` workarounds.
- **PEP 742 `TypeIs`** narrowing: use `TypeIs[T]` (not `TypeGuard[T]`) for
  type-narrowing functions that narrow in both branches. `TypeGuard` only
  narrows the truthy branch. `TypeIs` is the default choice now.
- **`type` statement (3.12+):** Prefer `type Alias = ...` over
  `TypeAlias: TypeAlias = ...`. The `type` statement supports forward
  references natively.
- **Generic syntax (3.12+):** Use `class Foo[T]:` and `def bar[T](x: T) -> T:`
  instead of `TypeVar` + `Generic[T]`. Only use `TypeVar` if you need
  `bound=` or `constraints=` that can't be expressed inline.
- **`match` statements (3.10+):** Prefer `match`/`case` over long if/elif
  chains for structural pattern matching where appropriate.
- **Exception groups and `except*` (3.11+):** Use for concurrent error handling
  where multiple exceptions may be raised simultaneously.
- **f-string improvements (3.12+):** Nested quotes and backslashes are allowed
  inside f-string expressions. No need for workarounds.

## Code Quality

### Typing

- **Strict mode. No `Any`.** Every function has full parameter and return type
  annotations. pyright strict must pass clean.
- Use `collections.abc` for abstract types (`Sequence`, `Mapping`, `Callable`,
  `Iterator`, `AsyncIterator`), not `typing` equivalents.
- `X | None` (not `Optional[X]`). `X | Y` (not `Union[X, Y]`).
- `Annotated[T, ...]` for metadata (Pydantic `Field`, Typer `Option`/
  `Argument`).
- Pydantic models for structured data, dataclasses for plain value objects.
  No raw dicts for structured data.
- `Self` return type for fluent/builder methods.
- `@overload` for functions with distinct return types based on input.
- `Never` for functions that always raise.

### Style

- Functions ~30 lines max, excluding type annotations and docstrings.
- Early returns/guard clauses over nested if/else.
- Docstrings on all public modules, classes, functions (imperative mood, one
  line if sufficient).
- One responsibility per module; filenames describe the responsibility.
- Import grouping: stdlib | third-party | local (enforced by ruff isort).
- `__all__` in every public module.
- Context managers (`with`) for all resource handling.
- Prefer comprehensions over `map`/`filter` with lambdas.
- `pathlib.Path` over `os.path`.

### Pydantic v2

- `model_validator`, `field_validator` (not v1 `@validator`, `@root_validator`).
- `model_dump()` / `model_validate()` (not `.dict()` / `.parse_obj()`).
- `ConfigDict` class attribute (not inner `class Config`).
- `Annotated[T, Field(...)]` for field metadata.
- `model_json_schema()` for JSON Schema export.
- Strict mode where appropriate: `model_config = ConfigDict(strict=True)`.

### CLI (Typer)

- Typer app per CLI module. Commands as decorated functions.
- `Annotated[T, typer.Option(...)]` / `Annotated[T, typer.Argument(...)]` for
  all params (not default-value style).
- Rich help panels for grouped options.
- `raise typer.Exit(code=1)` for errors (not `sys.exit`).

### Error Handling

- Custom exception hierarchy rooted in a project base exception.
- Never bare `except:` or `except Exception:` without re-raise or logging.
- `logging` module with structured fields, not print statements.

## Testing (pytest)

- `pytest` with `pytest-asyncio` (auto mode) for async tests.
- Fixtures over setup/teardown. `tmp_path` for filesystem ops.
- `pytest.raises` for expected exceptions with `match=` pattern.
- `pytest.mark.parametrize` for data-driven tests.
- No mutable global state between tests.
- Test files mirror `src/` structure: `tests/test_<module>.py`.
- Assertions use plain `assert` (pytest introspection rewrites them).
- Every spec.md acceptance test MUST have a corresponding pytest test. No
  stubs, no hardcoded results, no swallowed failures.

## Commands

```bash
# Deps
uv sync                                    # install/sync all deps
uv add <pkg>                               # add dependency
uv add --group dev <pkg>                   # add dev dependency

# Tests
uv run pytest tests/ -v                    # all tests
uv run pytest tests/ -v -k <name>          # specific test

# Lint + format
uv run ruff check --fix src/ tests/        # lint + autofix
uv run ruff format src/ tests/             # format
uv run ruff check src/ tests/              # lint check only
uv run ruff format --check src/ tests/     # format check only

# Type checking
uv run pyright                             # strict type check
```
