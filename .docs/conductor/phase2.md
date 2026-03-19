# Phase 2: Webview Dashboard

Ref: [spec.md](spec.md) section G1

## Instructions

Use the `orchestrator` skill to complete this phase,
coordinating subagents with the `implementor` and
`reviewer` skills.

## Items

### Item 2.1: G1 - Webview Panel with Real-Time Dashboard

spec.md section: G1

Implement `createDashboardPanel` in `src/webview/panel.ts`
and the HTML/CSS/JS dashboard in
`src/webview/dashboard.html`. Extension posts state updates
via `postMessage`, webview sends commands (pause, resume,
skip, retry, approve, reject, changeModel). Displays phase
items with status indicators, streaming audit log with
filters, cumulative token counts, and expandable transcript
viewer. CSP-compliant with nonce-based inline scripts.
Requires Phase 1 complete. Test file:
`src/test/webview/panel.test.ts`, covering all 12
acceptance tests from G1.

- [x] implemented
- [x] reviewed
