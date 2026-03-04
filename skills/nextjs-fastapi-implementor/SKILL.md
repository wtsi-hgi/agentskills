---
name: nextjs-fastapi-implementor
description: Full-stack implementation for Next.js 16 + FastAPI projects. Provides the TDD cycle, contract workflow, and implementation process. References nextjs-fastapi-conventions for architecture, code quality, testing standards, and commands, and agent-conduct for safety rules. Use when implementing features, writing tests, creating new components or endpoints, or following a phase plan.
---

# Next.js + FastAPI Implementor Skill

## Prerequisites

Before starting any work:

1. Read and follow the agent-conduct skill. It covers workspace
   boundaries, scratch work, terminal safety, and git safety rules.
2. Read the nextjs-fastapi-conventions skill. It defines the project
   stack, architecture principles, code quality standards, testing
   patterns, and commands that all implementation must follow.

## TDD Cycle

For each acceptance test or feature requirement, follow these steps.
Do not skip any step.

### Backend (Python)

1. Write a failing test in `backend/tests/` using pytest + httpx
   `AsyncClient` with `ASGITransport`.
2. Run: `cd backend && python -m pytest tests/ -v -k <test_name>`
3. Write minimal implementation to pass.
4. Refactor (clear names, type hints, docstrings, short functions).
5. Run linter:
   `cd backend && ruff check --fix . && ruff format .`
6. Re-run the test to confirm it still passes.

### Frontend (TypeScript)

1. Write a failing test in `frontend/tests/` using Vitest.
2. Run: `cd frontend && pnpm test`
3. Write minimal implementation to pass.
4. Refactor (clear names, proper types, extract helpers).
5. Run lint and format:
   `cd frontend && pnpm lint && pnpm format`
6. Re-run the test to confirm it still passes.

### Contract Tests

When adding or modifying an API endpoint, follow the contract
flow defined in the nextjs-fastapi-conventions skill (Pydantic
model -> Zod schema -> contract test -> `backendJson()` call):

1. Add a Vitest test in `frontend/tests/contracts.test.ts` that
   validates the Zod schema against expected payloads.
2. Add a pytest test in `backend/tests/test_api.py` that verifies
   the endpoint returns the expected JSON structure.
3. Ensure both schemas (Pydantic and Zod) agree on field names,
   types, and constraints.

### Frontend Design

For tasks involving UI design, component creation, or visual
styling, also read and follow the frontend-design skill for
design quality standards, aesthetic guidelines, and creative
direction.

## Implementation Workflow

1. Implement ONE item at a time. For each item:
   a. Read the relevant spec section for acceptance test details.
   b. Write tests first (backend pytest and/or frontend Vitest).
   c. Write minimal implementation to pass.
   d. Refactor.
   e. Run all linters.
   f. Confirm all tests pass.
2. When adding a new endpoint, follow the full contract flow:
   Pydantic model -> FastAPI endpoint -> Zod schema -> contract
   test -> Server Action -> component integration.
3. Consult spec.md for full acceptance test details, API designs,
   component specifications, and architecture decisions.
