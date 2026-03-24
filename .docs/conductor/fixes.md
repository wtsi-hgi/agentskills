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

## 2026-03-21 - Bug 6

Request:
- When starting spec work from a prompt like `Write a spec for seqmeta, described in .docs/proposal.md`, the clarification step can ask for files that already exist instead of checking the repository first.
- Tool paths are intentionally resolved relative to the project root, so this should be fixed in the startup instructions rather than by changing tool semantics.

Fix summary:
- Kept the clarification prompt guidance that tells the model to inspect referenced repository files before asking the user for them.
- Added a runtime orchestrator fix that scans `prompt.md` for existing repo-root-relative file references such as `.docs/proposal.md`, reads those files deterministically, and appends a dedicated referenced-files section to clarification and spec-author prompts.
- Added orchestrator-level regression coverage to pin that referenced file contents are injected into the invoked user prompt when the referenced file exists.

## 2026-03-24 - Bug 7

Request:
- Conductor should not fail state or spec checkpoints on a new local feature branch that has no upstream yet.
- Local progress commits should still succeed without an upstream, while existing upstream pushes should continue as before.
- Real push failures unrelated to a missing upstream should still surface.

Fix summary:
- Added a narrow git-push fallback that treats `has no upstream branch` as a non-fatal skip for ordinary local progress pushes while preserving existing behavior for successful pushes and unrelated push failures.
- Applied that fallback to Conductor state checkpoints plus the ordinary local spec-writing, phase-completion, and bugfix commit paths, without changing the explicit Copilot re-review push flow.
- Added regression coverage for no-upstream behavior in a state checkpoint flow and a spec-writing commit flow, plus a guard test that unrelated checkpoint push failures still throw.

## 2026-03-24 - Bug 8

Request:
- Spec-writing can reach authoring, the model/tool loop can effectively produce empty assistant output across turns, and the run ends with a useless error like `Spec authoring failed:` with nothing after the colon.
- The invocation layer already records more specific failure information in `InvocationResult.error` such as max-turn exhaustion or LLM API failure, but the spec-writing steps were only surfacing `result.response`.

Fix summary:
- Added a shared spec-writing invocation failure-detail helper that falls back to `InvocationResult.error` whenever a spec-writing step fails with an empty response.
- Applied that helper to spec authoring and the analogous spec-writing failure paths for spec rewrites, proofreading, phase creation, and phase review so those system error audits now surface the real underlying reason instead of an empty suffix.
- Added a regression test covering a spec-author invocation that returns an empty response plus a concrete invocation error and verified the surfaced failure message contains that real reason.
- Added an explicit spec-author completion contract in both initial authoring and reviewer-driven rewrite prompts: write the target spec via tools, then terminate with `<done>PASS</done>` once the file update is complete.
- Added prompt-level regression coverage so future prompt edits cannot drop that completion contract from either spec-author path.
- Continued the same blank-assistant/spec-author bug fix by teaching both LM response readers to fall back to `response.stream` text parts when `response.text` is empty, matching providers that emit `LanguageModelTextPart.value` instead of reliable `response.text` chunks.
- Added regression coverage for both the tool-loop reader and the orchestrator's direct one-shot reader so empty `response.text` no longer causes repeated blank `[assistant]` transcript entries and max-turn exhaustion when the model actually returned text on the stream.
- Tightened the shared tool-loop reader again to consume `response.stream` before `response.text` and serialize native `LanguageModelToolCallPart` chunks back into the existing `<tool_call>{...}</tool_call>` wire format, so providers that emit tool calls on the stream no longer lose them whenever any text is also present.
- Added regressions for both pure stream-native tool calls and mixed text-plus-tool-call stream responses, which would previously truncate the tool call and spin until max turns without ever writing `spec.md`.

## 2026-03-24 - Current resume state

Verified live state in external test repo:
- Test repo used for reproduction: `/nfs/users/nfs_s/sb10/src/go/github.com/wtsi-hgi/wa`.
- Most recent failing run was recorded in the root conductor state, not the nested feature state.
- Root state file at `.conductor/state.json` pointed at `specDir = /nfs/users/nfs_s/sb10/src/go/github.com/wtsi-hgi/wa/.docs/seqmeta` and ended in `status = error`, `specStep = authoring`.
- Root audit file at `.conductor/audit.md` showed:
	- clarifier run at `2026-03-24T15:18:55.427Z`
	- three spec-author retries at `2026-03-24T15:19:01.788Z`, `2026-03-24T15:19:04.026Z`, and `2026-03-24T15:19:06.297Z`
	- final system error `Spec authoring failed: Exceeded max turns (50) without receiving <done>`
- Saved transcripts for those spec-author retries under `.conductor/runs/.../spec-author-phase0:authoring.json` contained repeated literal empty assistant messages: the provider returned `"content": ""` for every assistant turn, not hidden streamed text.

Latest attempted fixes after reading the live transcripts:
- Added LM request-message construction in `src/llm/invoke.ts` so Conductor no longer passes plain `{ role, content }` objects with an unsupported `system` role directly to `sendRequest`.
- Folded initial system instructions into the first user message and used valid user/assistant LM message construction when the runtime `vscode` module is available.
- Switched the direct `sendRequest` helper paths in `src/orchestrator/machine.ts` to the same message builder.
- Added and updated regression coverage in `src/test/llm/invoke.test.ts` and `src/test/orchestrator/machine.test.ts`.
- Focused LM and orchestrator suites passed and the extension built after those changes.

Result after latest fix:
- User retested and reported no improvement.
- Therefore the remaining authoring failure is still unresolved.
- Current best evidence is that there may be another provider-specific incompatibility or request-shape issue beyond the previously fixed unsupported `system` role and dropped stream parts.

Other user-reported bugs that remain open or may need explicit re-checking:
- Recovered model assignments can still revert to `Auto` instead of preserving the previously chosen per-role assignments.
- Clarification UX still needs improvement.
- Feature-specific state placement and recovery behavior still need cleanup; there is still ambiguity between the root `.conductor/` state and nested feature state such as `.docs/seqmeta/.conductor/state.json`.
- The live `wa` reproduction is especially relevant here because both root `.conductor/` and nested `.docs/seqmeta/.conductor/` exist, while the failing authoring run inspected in this session was recorded under the root `.conductor/` directory.

Recommended resume point for next session:
- Start from the saved live transcripts in `/nfs/users/nfs_s/sb10/src/go/github.com/wtsi-hgi/wa/.conductor/runs/2026-03-24T15:19:01.788Z/spec-author-phase0:authoring.json` and its sibling retries.
- Compare the actual LM request shape seen by `claude-sonnet-4.6` in the Extension Development Host against the new request builder in `src/llm/invoke.ts`.
- Investigate whether the provider requires request options, different message history shaping, or stricter handling of repeated instruction folding than the current implementation.
