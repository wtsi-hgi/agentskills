---
name: nextjs-fastapi-implementor
description: Full-stack TDD implementation for Next.js 16 + FastAPI projects. References nextjs-fastapi-conventions and agent-conduct.
---

# Next.js + FastAPI Implementor Skill

Read and follow **agent-conduct** and **nextjs-fastapi-conventions** before
starting.

## TDD Cycle

### Backend (Python)

1. Write failing test in `backend/tests/` (pytest + httpx `AsyncClient` +
   `ASGITransport`).
2. Run: `cd backend && python -m pytest tests/ -v -k <test_name>`
3. Minimal implementation to pass.
4. Refactor.
5. Lint: `cd backend && ruff check --fix . && ruff format .`
6. Re-run test.

### Frontend (TypeScript)

1. Write failing test in `frontend/tests/` (Vitest).
2. For visual styling changes, write a failing Playwright/perceptual test when
   jsdom cannot prove the user-visible result.
3. Run: `cd frontend && pnpm test`
4. Minimal implementation to pass.
5. Refactor.
6. Lint: `cd frontend && pnpm lint && pnpm format`
7. Re-run test.

### Contract Tests

When adding/modifying an endpoint, follow the contract flow from
nextjs-fastapi-conventions (Pydantic -> Zod -> contract test -> `backendJson()`).
Ensure both schemas agree on field names, types, and constraints.

### Frontend Design

For UI tasks, also read and follow the **frontend-design** skill.
For Tailwind v4 theming and perceptual UI tests, follow the styling/testing
rules in **nextjs-fastapi-conventions** before changing selectors or tokens.

## Workflow

Implement ONE item at a time: read spec, write tests first (pytest and/or
Vitest), implement, refactor, lint, confirm all tests pass. For new endpoints,
follow the full contract flow.
