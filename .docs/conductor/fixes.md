# Conductor Bug Fixes

## 2026-03-21 - Bug 1

Request:
- Replace free-text Vendor and Family model entry in the Conductor Dashboard with a runtime-backed dropdown of available chat models.

Fix summary:
- Added runtime chat model discovery via `vscode.lm.selectChatModels()` with no selector.
- Exposed those models through dashboard control options with human-friendly labels and an `Auto` option.
- Replaced the dashboard Vendor/Family inputs with a model dropdown that maps back to `changeModel(role, vendor, family)`.
- Treated empty vendor/family assignments as automatic selection so `Auto` remains functional in orchestrator model resolution.

## 2026-03-21 - Bug 2

Request:
- In the Conductor Dashboard, keep the selected Conventions skill instead of resetting it to None after Apply commands rerenders the controls.

Fix summary:
- Updated dashboard control syncing to preserve a locally selected conventions skill until the persisted state actually changes, instead of overwriting it on rerenders from an unchanged persisted value.
- Added regression coverage for the Apply commands round-trip with a non-empty persisted conventions skill and verified Start/Fix Bugs still send the local selection.

## 2026-03-21 - Bug 3

Request:
- Starting from scratch, the Conductor Dashboard currently says the current step is "Phase 1 / Item 1".
- That is misleading. When there is no runnable feature yet, it should instead indicate that a prompt is needed.

Fix summary:
- Updated the webview dashboard to show "Prompt needed" whenever no current runnable item exists yet, including the initial blank state before any dashboard messages arrive.
- Applied the same current-step behavior to the optional server dashboard so both UIs stay consistent.
- Added regression coverage for the blank-start state in the webview dashboard suite and for the server dashboard runtime state-before-phase path.

## 2026-03-21 - Bug 4

Request:
- The dashboard Role selector should default to the role most appropriate for the current state.
- During spec-writing clarifying or authoring it should default to Spec author, and similarly choose the matching review, proofreading, and phase roles.
- It should not stay on a generic default when the state already makes the best role obvious.
- Do not break the live model dropdown or user-chosen role changes.

Fix summary:
- Added a small role-derivation heuristic in the webview dashboard that maps active spec-writing steps to their corresponding roles, routes active PR review states to PR reviewer, falls back to Reviewer for approval or bug-review states, and otherwise defaults to Implementor.
- Updated the role/model control sync so the selector follows derived state by default but stops auto-overriding after the user manually changes the role.
- Added regression coverage to verify spec-step role defaults, PR review derivation, implementor fallback, model-dropdown syncing for those derived roles, and preservation of manual role overrides across later state rerenders.

## 2026-03-21 - Bug 5

Request:
- When starting from an inline prompt and choosing a feature slug, Conductor creates the slugged `.docs/<slug>` directory but then can run against the stale default `.docs/conductor` state and fail with missing spec input errors.
- Dashboard-selected model assignments and other current run settings can also be discarded when Start or Fix Bugs writes a fresh default state into the new slugged feature or bugfix directory, which can derail clarifying/spec-author startup.

Fix summary:
- Reworked the extension controller to hold a stable orchestrator proxy for the tree, dashboard, and server while allowing the backing orchestrator instance to be recreated when run state changes.
- Refreshed the backing orchestrator immediately after Start and Fix Bugs persist new state so inline slugged runs execute against the new workspace state instead of an activation-time default instance.
- Seeded new feature and bugfix startup state from the current persisted run configuration so model assignments and command/conventions settings carry forward into both workspace and nested feature state instead of being reset to defaults.
- Added regression coverage that distinguishes the two behaviors: the dashboard-path slugged-start test explicitly pins the stale-orchestrator refresh, the command-path test pins carry-forward into new feature state, and the Fix Bugs test verifies model-assignment carry-forward into the new bug directory.
