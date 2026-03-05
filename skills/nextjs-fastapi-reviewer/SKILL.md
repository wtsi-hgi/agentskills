---
name: nextjs-fastapi-reviewer
description: Review implementations in Next.js 16 + FastAPI projects against spec acceptance tests. Provides the review checklist, test verification, and verdict format. References nextjs-fastapi-conventions for architecture, code quality, and testing standards, and agent-conduct for safety rules. Use when reviewing implemented code, verifying tests, or performing a code review after implementation.
---

# Next.js + FastAPI Reviewer Skill

## Prerequisites

Before starting any work:

1. Read and follow the agent-conduct skill. It covers workspace boundaries,
   scratch work, terminal safety, and git safety rules.
2. Read the nextjs-fastapi-conventions skill. It defines the architecture
   principles, code quality standards, and testing patterns that all code must
   follow.

---

You are a review subagent with clean context - no memory of implementation
decisions. Your job is to independently verify that implemented code meets the
specification and quality standards.

## Review Procedure

For each item under review:

### 1. Read the specification

- Read spec.md for the referenced sections (acceptance tests, API designs,
  component specs, architecture decisions).
- Read all implemented source and test files for the item(s).

### 2. Run the tests

Run backend and frontend tests using the commands from the
nextjs-fastapi-conventions skill. Confirm all tests pass.

### 3. Verify acceptance test coverage

- For every acceptance test listed in spec.md for the referenced user stories,
  confirm there is a corresponding test (pytest for backend, Vitest for
  frontend).
- Do not accept missing, stubbed-out, or circumvented tests.
- Do not accept hardcoded expected results in implementations that make tests
  pass artificially.
- Do not accept test helpers that silently swallow failures.

### 4. Verify implementation correctness

Check against the architecture principles in the nextjs-fastapi-conventions
skill:

#### Architecture (BFF pattern)

- Confirm the browser NEVER calls FastAPI directly. All backend communication
  must flow through Server Actions or API Routes.
- Confirm Server Actions are in files with `'use server'` at the top.
- Confirm client components use `'use client'` and do NOT import server-only
  modules.
- Confirm API Routes (`app/api/*/route.ts`) are only used for external consumers
  (health checks, webhooks), not for frontend data fetching.

#### Contract integrity

- Confirm every new endpoint has BOTH a Pydantic response model AND a matching
  Zod schema.
- Confirm `backendJson()` is used with the Zod schema for all backend calls.
- Confirm contract tests exist for new schemas.
- Confirm Pydantic and Zod schemas agree on field names, types, and constraints.

#### Backend and frontend correctness

- Verify code follows all quality rules from the nextjs-fastapi-conventions
  skill (Python and TypeScript sections).
- Confirm endpoints use `async def`, declare `response_model`, and return
  Pydantic model instances.
- Confirm the lifespan pattern is used (not deprecated `@app.on_event`).
- Confirm `useActionState` is used (not deprecated `useFormState`) for form
  handling.
- Confirm Tailwind CSS v4 semantic tokens are used (not raw colour values).

### 5. Verify code quality

Apply all code quality rules from the nextjs-fastapi-conventions skill: Python
(backend) and TypeScript (frontend) sections.

### 6. Run the linters

Run lint checks using the commands from the nextjs-fastapi-conventions skill.
Confirm no issues are reported for modified files.

### 7. Return verdict

Return one of:

- **PASS** - Optionally note minor suggestions that do not block approval.
- **FAIL** - Provide specific, actionable feedback listing:
  - Which acceptance tests are missing or incorrect.
  - Which spec requirements are not met.
  - Which architecture violations were found (BFF, contracts).
  - Which quality violations were found.
  - Which lint issues remain.

## Review Scope per Phase Type

### Single-item phases

Review the one item's source and test files.

### Parallel batch phases

Review ALL items in the batch together in a single review pass. Return a
per-item verdict (PASS or FAIL with specific feedback for each).
