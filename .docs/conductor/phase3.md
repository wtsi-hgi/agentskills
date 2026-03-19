# Phase 3: Team Server

Ref: [spec.md](spec.md) sections H1, H2

## Instructions

Use the `orchestrator` skill to complete this phase,
coordinating subagents with the `implementor` and
`reviewer` skills.

## Items

### Item 3.1: H1 - HTTP/WebSocket Server with Authentication

spec.md section: H1

Implement `startServer` in `src/server/http.ts`,
`handleWebSocket` in `src/server/ws.ts`, and
`validateAuth` in `src/server/auth.ts`. HTTP server on
configurable port serves static files from
`src/server/app/`. WebSocket at `/ws` pushes
`ServerMessage` on state/audit/addendum changes and accepts
`ClientMessage` from clients. Bearer token authentication
with empty-token bypass. Requires Phase 1 complete. Test
files: `src/test/server/http.test.ts`,
`src/test/server/ws.test.ts`,
`src/test/server/auth.test.ts`, covering all 8 acceptance
tests from H1.

- [x] implemented
- [x] reviewed

### Item 3.2: H2 - Browser Dashboard SPA

spec.md section: H2

Implement the browser dashboard SPA in
`src/server/app/index.html` with WebSocket connection,
state rendering, approval queue, multi-user annotations,
pause/resume/approve/reject/addNote controls, responsive
layout for mobile, and exponential-backoff reconnection.
Depends on item 3.1 (H1). Test file:
`src/test/server/app.test.ts`, covering all 6 acceptance
tests from H2.

- [x] implemented
- [x] reviewed
