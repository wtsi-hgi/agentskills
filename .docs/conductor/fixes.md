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
