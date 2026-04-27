---
name: nextjs-fastapi-conventions
description: Shared conventions for Next.js 16 + FastAPI full-stack projects. Architecture, code quality, testing, styling, and commands. Referenced by nextjs-fastapi-implementor and nextjs-fastapi-reviewer.
---

# Next.js + FastAPI Conventions

Single source of truth for architecture, code quality, and testing in
Next.js + FastAPI full-stack projects.

## Project Stack

- **Frontend:** Next.js 16 (App Router) + React 19 + shadcn/ui + Tailwind CSS
  v4 (TypeScript, in `frontend/`)
- **Backend:** FastAPI + Uvicorn + Pydantic (Python 3.11+, in `backend/`)

## Architecture

### BFF Pattern

The browser NEVER calls FastAPI directly. All backend communication flows
through the Next.js server layer:
- **Server Actions** (`app/actions.ts`) handle mutations. Client components call
  these; they run on the Next.js server and proxy to FastAPI.
- **API Routes** (`app/api/*/route.ts`) exist ONLY for external consumers
  (health checks, webhooks), NOT for frontend use.

### Type Safety (Zod Contracts)

Every FastAPI response is validated on the frontend with Zod:
- `lib/contracts.ts`: Zod schemas mirroring Pydantic models.
- `lib/backend-client.ts`: `backendJson()` fetches + validates against Zod.
- Contract breaks fail fast with `BackendRequestError`.

**New endpoint checklist:**
1. Pydantic response model in `backend/api/schemas.py`.
2. Matching Zod schema in `frontend/lib/contracts.ts`.
3. Contract test in `frontend/tests/contracts.test.ts`.
4. `backendJson()` with schema in Server Action.

### Components

- **Server Components** (default): fetch data, pass as props.
- **Client Components** (`'use client'`): interactivity, browser APIs, hooks.

### React 19

- `useActionState` (NOT deprecated `useFormState`).
- Explicit state types (e.g. `GreetingState` in `lib/greeting-state.ts`).

### Backend Structure

- Lifespan via `@asynccontextmanager` (NOT `@app.on_event`).
- `pydantic-settings` for typed config from env vars.
- Versioned routers under `api/v1/`.
- Every endpoint declares `response_model` and returns a Pydantic model.

## Code Quality

### Python

- Async endpoints, `httpx.AsyncClient` (not `requests`).
- Type hints everywhere. `Annotated` for FastAPI params.
- Docstrings on modules, classes, public functions.
- `HTTPException` for API errors. No swallowed exceptions.
- Import grouping: stdlib | third-party | local.

### TypeScript

- `strict: true`. Never `any` (prefer `unknown` + narrowing).
- Zod for all external data; derive types with `z.infer<>`.
- Server Actions: `'use server'`, return typed state objects.
- shadcn/ui components from `components/ui/`.
- Import grouping: React/Next.js | third-party | local `@/` (components > lib >
  types).
- Tailwind v4 semantic tokens (`text-foreground`, `bg-muted`), not raw colours.

### Styling

- Tailwind utility classes in JSX. `cn()` from `lib/utils.ts` for conditional
  classes.
- Semantic tokens from `@theme`, not raw colour values.
- Mobile-first responsive (`sm:`, `md:`, `lg:`).
- CVA for component variants. Sonner for toasts. next-themes for theme switching.

### Tailwind v4 Runtime Theming

- Treat Tailwind v4 theme variables as part of the runtime contract, not as
  ordinary CSS constants. Read the project's actual `globals.css`/theme setup
  before changing visual states.
- If dark mode is driven by `next-themes` with `attribute="class"`, ensure
  Tailwind's `dark:` variant is also class-driven (for example with
  `@custom-variant dark (&:where(.dark, .dark *));`). Do not assume `.dark`
  affects Tailwind utilities when the compiled CSS still uses
  `prefers-color-scheme`.
- Use `@theme inline` only when utilities should inline a referenced value.
  Do not use it for semantic colours that must change at runtime between light
  and dark themes; compiled utilities may freeze light-mode literals such as
  `#ffffff` or `#e2e8f0`.
- For semantic colours that must respond to theme changes, prefer utilities
  that compile to runtime CSS variables, explicit arbitrary values such as
  `bg-[var(--color-card)]`, or small custom CSS rules that use `var(...)`.
- When debugging Tailwind v4 styling, inspect the generated CSS or browser
  computed styles before changing specificity. Cascade layers, `!important`,
  and `@theme inline` can make source CSS misleading.

### File Organisation

- Pages in `app/` (App Router). Reusable components in `components/`.
- shadcn/ui in `components/ui/` (don't edit directly).
- Shared utils/types in `lib/`. Import via `@/`.

## Testing

### Backend (pytest)

- `pytest` + `pytest-asyncio` (auto mode).
- `httpx.AsyncClient` + `ASGITransport` against FastAPI `app`.
- Assert status codes AND JSON payloads.
- `@pytest.mark.anyio` for async tests.

### Frontend (Vitest)

- `environment: 'node'`. Tests in `frontend/tests/*.test.ts`.
- Contract tests: `.parse()` and `.safeParse()` against schemas.
- `describe`/`it` blocks, `expect()` matchers.

### Visual and Perceptual UI Tests

- For styling bugs that users perceive visually (contrast, borders, selection,
  focus rings, dark mode, animations), prefer real-browser tests with
  Playwright over jsdom-only tests.
- A test that reads source CSS text, checks for a class name, or asserts only a
  computed property is not sufficient for a visual regression. It can be useful
  as a guard, but it does not prove the rendered UI is visible.
- Assert the user-visible result: compare screenshots or sample rendered pixels
  from the affected element and its surroundings. For borders and rings, check
  frame pixels against the element fill and neighbouring cells/surfaces, not
  just `borderTopColor` against another element's border.
- Test every relevant theme/mode through the same mechanism the app uses in
  production. If dark mode is class-driven, set the class and verify compiled
  CSS responds to it; if it is media-driven, use `page.emulateMedia()`.
- Avoid injecting fake probe styles into tests for the feature under test. Load
  the real app stylesheet and fail against the actual cascade.
- If a visual assertion is hard to express, include a focused screenshot
  assertion or a small canvas/pixel sampler plus clear thresholds derived from
  visible contrast, not from the implementation details of a chosen token.

## Commands

### Backend
```bash
cd backend && python -m pytest tests/ -v              # all tests
cd backend && python -m pytest tests/ -v -k <name>    # specific test
cd backend && ruff check --fix . && ruff format .     # lint+fix
cd backend && ruff check . && ruff format --check .   # lint check only
```

### Frontend
```bash
cd frontend && pnpm test          # all tests
cd frontend && pnpm test:watch    # watch mode
cd frontend && pnpm lint          # lint
cd frontend && pnpm format        # format
```
