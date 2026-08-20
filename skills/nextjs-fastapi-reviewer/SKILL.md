---
name: nextjs-fastapi-reviewer
description: Review Next.js + FastAPI implementations against spec acceptance tests. References implementation-principles, code-smells, nextjs-fastapi-conventions, testing-principles, and agent-conduct. Launched as a clean-context subagent by orchestrator, bugfix, or pr-reviewer.
---

# Next.js + FastAPI Reviewer Skill

Read and follow **agent-conduct**, **implementation-principles**,
**testing-principles**, **code-smells**, and **nextjs-fastapi-conventions**
before starting.

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
hardcoded-result tests. Apply the **testing-principles** review rule.

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
  tokens. Runtime theme handling matches the project's Tailwind v4 setup
  (`@theme`, `@theme inline`, `@custom-variant dark`, and next-themes).
- **Visual regressions:** apply **testing-principles** § Perceptual
  Requirements. Reject a perceptual claim proven only from source CSS, class
  names, or isolated computed properties. The real app stylesheet and the
  production dark-mode mechanism are part of what the assertion must exercise.

### 5. Verify code quality

Apply all rules from implementation-principles and nextjs-fastapi-conventions
(Python and TypeScript sections).

Match the changed code against **code-smells**. Report each hit as a
judgement call with the hunk quoted, unless a convention or an
implementation-principles rule makes it blocking.

### 6. Run linters

Per conventions commands. No issues for modified files.

### 7. Verdict

- **PASS** - optionally note minor non-blocking suggestions.
- **FAIL** - specific, actionable feedback: missing tests, unmet spec
  requirements, architecture violations, quality violations, lint issues.

## Batch Reviews

- Single-item: review that item.
- Parallel batch: review ALL items together; return per-item verdict.
