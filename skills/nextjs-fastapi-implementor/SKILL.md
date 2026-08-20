---
name: nextjs-fastapi-implementor
description: Full-stack TDD implementation for Next.js 16 + FastAPI projects. References implementation-principles, nextjs-fastapi-conventions, testing-principles, and agent-conduct.
context: fork
---

# Next.js + FastAPI Implementor Skill

Read and follow **agent-conduct**, **implementation-principles**,
**testing-principles**, and **nextjs-fastapi-conventions** before starting.

## Stack-Specific TDD Steps

### Backend (Python)

- Tests: pytest + httpx `AsyncClient` + `ASGITransport` in `backend/tests/`.
- Targeted test: `cd backend && python -m pytest tests/ -v -k <test_name>`
- Lint with:
  `cd backend && ruff check --fix . && ruff format .`

### Frontend (TypeScript)

- Tests: Vitest in `frontend/tests/`.
- For visual styling changes, write a failing Playwright/perceptual test when
  jsdom cannot prove the user-visible result.
- Test command: `cd frontend && pnpm test`
- Lint with:
  `cd frontend && pnpm lint && pnpm format`

### Contract Tests

When adding/modifying an endpoint, follow the contract flow from
nextjs-fastapi-conventions: Pydantic, then Zod, then contract test, then
`backendJson()`.
Ensure both schemas agree on field names, types, and constraints.

### Frontend Design

For UI tasks, also read and follow the **frontend-design** skill.
For Tailwind v4 theming and perceptual UI tests, follow the styling/testing
rules in **nextjs-fastapi-conventions** before changing selectors or tokens.
