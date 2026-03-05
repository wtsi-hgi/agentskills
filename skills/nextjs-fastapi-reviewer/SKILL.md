---
name: nextjs-fastapi-reviewer
description: Review Next.js + FastAPI implementations against spec acceptance tests. References nextjs-fastapi-conventions and agent-conduct.
---

# Next.js + FastAPI Reviewer Skill

Read and follow **agent-conduct** and **nextjs-fastapi-conventions** before
starting.

You are a review subagent with clean context. Independently verify that code
meets the spec and quality standards.

## Review Procedure

### 1. Read spec.md and all source/test files for the item(s).

### 2. Run tests

Run backend and frontend tests per nextjs-fastapi-conventions commands. All
must pass.

### 3. Verify acceptance test coverage

Every spec.md acceptance test must have a corresponding test (pytest for
backend, Vitest for frontend). Reject missing, stubbed, circumvented, or
hardcoded-result tests.

### 4. Verify implementation correctness

Check against nextjs-fastapi-conventions architecture:

- **BFF:** browser never calls FastAPI directly. Server Actions use
  `'use server'`. Client components use `'use client'` and don't import
  server-only modules. API Routes only for external consumers.
- **Contracts:** every new endpoint has Pydantic model + Zod schema +
  contract test. `backendJson()` used with schema. Schemas agree.
- **Backend:** `async def` endpoints, `response_model` declared, lifespan
  pattern (not `@app.on_event`).
- **Frontend:** `useActionState` (not `useFormState`). Tailwind v4 semantic
  tokens.

### 5. Verify code quality

Apply all rules from nextjs-fastapi-conventions (Python and TypeScript
sections).

### 6. Run linters

Per conventions commands. No issues for modified files.

### 7. Verdict

- **PASS** - optionally note minor non-blocking suggestions.
- **FAIL** - specific, actionable feedback: missing tests, unmet spec
  requirements, architecture violations, quality violations, lint issues.

## Batch Reviews

- Single-item: review that item.
- Parallel batch: review ALL items together; return per-item verdict.
