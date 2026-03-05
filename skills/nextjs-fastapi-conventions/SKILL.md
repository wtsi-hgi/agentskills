---
name: nextjs-fastapi-conventions
description: Shared conventions for Next.js 16 + FastAPI full-stack projects. Covers the project stack, architecture principles (BFF pattern, Zod contracts, Server/Client Components), code quality standards for Python and TypeScript, testing patterns, styling conventions, and tool commands. Referenced by nextjs-fastapi-implementor, nextjs-fastapi-reviewer, and other workflow skills.
---

# Next.js + FastAPI Conventions

This document is the single source of truth for architecture, code quality, and
testing standards in Next.js + FastAPI full-stack projects. Other skills
reference it rather than duplicating these rules.

## Project Stack

This applies to full-stack monorepos with:

- **Frontend:** Next.js 16 (App Router) + React 19 + shadcn/ui + Tailwind CSS v4
  (TypeScript, in `frontend/`)
- **Backend:** FastAPI + Uvicorn + Pydantic (Python 3.11+, in `backend/`)

## Architecture Principles

### Backend-for-Frontend (BFF) Pattern

The browser NEVER calls the FastAPI backend directly. All backend communication
flows through the Next.js server layer:

- **Server Actions** (`app/actions.ts`) handle form submissions and data
  mutations. Client components call these actions, which run on the Next.js
  server and proxy requests to FastAPI.
- **API Routes** (`app/api/*/route.ts`) exist ONLY for external consumers (e.g.
  health check monitors). They are NOT used by the frontend itself.

This pattern eliminates CORS issues and keeps backend URLs and secrets hidden
from the client.

### Type Safety at the Boundary (Zod Contracts)

Every FastAPI response is validated on the frontend with Zod:

- `lib/contracts.ts` defines Zod schemas mirroring FastAPI's Pydantic models.
- `lib/backend-client.ts` provides `backendJson()`, which fetches from FastAPI
  and validates the response against a Zod schema.
- If the API contract breaks, the frontend fails fast with a clear
  `BackendRequestError` rather than rendering undefined states.

When adding a new endpoint, ALWAYS:

1. Add a Pydantic response model in `backend/api/schemas.py`.
2. Add a matching Zod schema in `frontend/lib/contracts.ts`.
3. Add a contract test in `frontend/tests/contracts.test.ts`.
4. Use `backendJson()` with the schema in the Server Action.

### Server Components vs Client Components

- **Server Components** (default, no directive) fetch data on the server and
  pass it as props to client components. Use for pages and data-fetching
  wrappers.
- **Client Components** (`'use client'` directive) handle interactivity, browser
  APIs, and React hooks. Keep them focused on UX; delegate data fetching to
  Server Actions.

### React 19 Patterns

- Use `useActionState` (not the deprecated `useFormState`) for form submissions
  with pending states.
- Define state types explicitly (e.g. `GreetingState` in
  `lib/greeting-state.ts`) for Server Action return values.
- Use `useEffect` for side effects like toast notifications on state changes.

### Backend Structure

- **Lifespan management:** `main.py` uses the `@asynccontextmanager` lifespan
  pattern for startup/shutdown logic (e.g. creating and closing
  `httpx.AsyncClient`). NEVER use the deprecated `@app.on_event` decorators.
- **Pydantic Settings:** `config.py` uses `pydantic-settings` for typed
  configuration from environment variables.
- **Versioned routers:** Endpoints live under `api/v1/` with an `APIRouter`. New
  endpoints go in new or existing router files under `api/v1/`.
- **Typed responses:** Every endpoint declares `response_model` and returns a
  Pydantic model instance.

## Code Quality

### Python (Backend)

- **Python 3.11+:** Use modern syntax - type hints everywhere, `from __future__
  import annotations` when needed, `|` union syntax, `Annotated` for FastAPI
  dependencies.
- **Async first:** All endpoint handlers must be `async def`. Use
  `httpx.AsyncClient` (not `requests`) for outbound HTTP.
- **Type hints:** Every function parameter and return value must have type
  hints. Use `Annotated` for FastAPI query/path/body parameters.
- **Docstrings:** Every module, class, and public function must have a
  docstring. Use imperative mood for function docstrings.
- **Error handling:** Use FastAPI's `HTTPException` for API errors. Use Pydantic
  validation for input validation. Never swallow exceptions silently.
- **Import grouping:** Standard library, blank line, third-party, blank line,
  local imports.
- **Naming:** snake_case for functions and variables, PascalCase for classes.
  Self-documenting names.

### TypeScript (Frontend)

- **Strict TypeScript:** The project uses `strict: true`. Never use `any` unless
  absolutely unavoidable (and document why). Prefer `unknown` with type
  narrowing.
- **Zod for runtime validation:** Use Zod schemas for all external data. Derive
  TypeScript types with `z.infer<>` rather than defining types separately.
- **Server Actions:** Mark with `'use server'` at the top of the file. Return
  typed state objects, not raw data. Handle errors with try/catch and return
  error states.
- **Client Components:** Mark with `'use client'`. Keep them focused on UI and
  interaction. Import from `@/` path alias.
- **shadcn/ui:** Use existing shadcn/ui components from `components/ui/`. Add
  new ones with `pnpm dlx shadcn@latest add <component>`.
- **Import grouping:** React/Next.js imports, blank line, third-party, blank
  line, local `@/` imports. Within local imports: components, then lib, then
  types.
- **Tailwind CSS v4:** Use the CSS-first `@theme` configuration in
  `globals.css`. Use semantic colour tokens (`text-foreground`, `bg-muted`,
  `border-border`, etc.) not raw colours. Respect dark mode via the `.dark`
  class.
- **Naming:** PascalCase for components and types, camelCase for functions and
  variables. File names match the primary export (kebab-case for component
  files).

### Styling Conventions

- Use Tailwind utility classes directly in JSX. No separate CSS modules or
  styled-components.
- Use the `cn()` utility from `lib/utils.ts` (clsx + tailwind-merge) for
  conditional class composition.
- Use semantic tokens from the `@theme` block, not raw colour values (e.g.
  `text-muted-foreground` not `text-gray-500`).
- Support responsive design with mobile-first breakpoints (`sm:`, `md:`, `lg:`).
- Use `class-variance-authority` (CVA) for component variant systems (already
  used by shadcn/ui Button).
- **Sonner** for toast notifications via the `<Toaster />` component.
- **next-themes** for theme switching via `<ThemeProvider />`.

### File Organisation

- Pages go in `app/` following Next.js App Router conventions.
- Reusable components go in `components/`.
- shadcn/ui primitives live in `components/ui/` (do not edit these directly).
- Shared utilities and types go in `lib/`.
- Import using the `@/` path alias (e.g.
  `import { Button } from '@/components/ui/button'`).

## Testing Standards

### Backend (pytest)

- Use `pytest` with `pytest-asyncio` (mode: `auto`).
- Test endpoints using `httpx.AsyncClient` with `ASGITransport` against the
  FastAPI `app` directly (no live server needed).
- Assert response status codes AND JSON payloads.
- Use `@pytest.mark.anyio` for async tests.
- Keep tests independent - no shared mutable state between tests.

### Frontend (Vitest)

- Use Vitest with `environment: 'node'`.
- Test files go in `frontend/tests/` with `.test.ts` extension.
- Contract tests validate Zod schemas with `.parse()` and `.safeParse()` against
  expected and malformed payloads.
- Use `describe`/`it` blocks with clear scenario descriptions.
- Assert with `expect()` matchers.

## Commands

### Backend

Run all tests:
```
cd backend && python -m pytest tests/ -v
```

Run specific test:
```
cd backend && python -m pytest tests/ -v -k <test_name>
```

Run linter and formatter:
```
cd backend && ruff check --fix . && ruff format .
```

Check lint without fixing (for review):
```
cd backend && ruff check . && ruff format --check .
```

### Frontend

Run all tests:
```
cd frontend && pnpm test
```

Run tests in watch mode:
```
cd frontend && pnpm test:watch
```

Run lint:
```
cd frontend && pnpm lint
```

Run format:
```
cd frontend && pnpm format
```
