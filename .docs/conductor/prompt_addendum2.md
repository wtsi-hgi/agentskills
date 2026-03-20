# Addendum 2: Bugfix, PR Review, Per-Feature Config, and Remaining Gaps

Extend the Copilot Conductor extension with bugfix
orchestration, post-implementation PR review, per-feature
configuration, and several smaller gaps identified by
comparing every skill against the extension.

## Problem

### Bugfix orchestration is missing

The manual bugfix skill (`skills/bugfix/SKILL.md`) is an
orchestrating workflow that coordinates implementor and
reviewer subagents through a fix → review → approve →
commit cycle per bug. The extension does not handle this
at all — there is no bugfix role, no bugfix state, and no
bugfix loop in the state machine. Users must run the
bugfix skill manually via Copilot agent mode.

### Post-implementation PR review is missing

The manual orchestrator skill (`skills/orchestrator/SKILL.md`)
defines steps 5 and 6 after all phase items are implemented:
a spec-aware PR review and a spec-free PR review, each
requiring 2 consecutive clean passes from a pr-reviewer
subagent. The extension's state machine exits with
`status = "done"` immediately after the final phase item
passes review. The PR review tail was never implemented.

The extension guide even claims "pr-reviewer skill →
Built-in review cycle with 2-consecutive-PASS gate" in the
manual-to-Conductor equivalence table, but this refers to
the per-item reviewer role, not the whole-PR review that the
pr-reviewer skill performs.

### Configuration is global but should be per-feature

`specDir`, `conventionsSkill`, and `testCommand` are VS Code
settings applied globally to the workspace. This is wrong
for three reasons:

1. A user may have multiple feature directories (e.g.
   `.docs/feature-a/`, `.docs/feature-b/`), each with its
   own `prompt.md` and spec. The extension should work with
   whichever directory the user points it at, not a single
   configured path.

2. Different features in the same codebase may use different
   tech stacks (e.g. a Go backend feature and a TypeScript
   frontend feature). The conventions skill — and therefore
   the implementor and reviewer skills — must vary per
   feature.

3. Test and lint commands are a function of the tech stack
   and sometimes the feature. They should not be a separate
   config option at all — they are already specified in the
   conventions skill and can be extracted from it.

### No commits or pushes

The orchestrator skill step 4 says: "All checkboxes checked
→ commit with `Implement phase <N>`." The extension ticks
checkboxes but never commits. There is no `git add`,
`git commit`, or `git push` anywhere in the extension
source.

Without pushes, a second human cannot take over if the
first human's VS Code crashes mid-run. The extension's
state files (`.conductor/`) are also never committed or
pushed, so they exist only on the local machine.

### Bash tool blocks extension-owned commands

The bash tool blocks shell metacharacters (`&&`, `|`, etc.)
to prevent LLM injection. This is correct for LLM-invoked
commands. But the extension itself needs to run compound
commands: `git add` + `git commit` for per-phase commits and
bugfix commits, `git push` for the Copilot re-review loop,
and compound lint commands like
`ruff check --fix && ruff format`. The machine currently
passes `config.testCommand` through the same `executeBash`
that validates LLM commands, so any test/lint command
containing `&&` or pipes would be rejected.

### No lint execution

The extension runs only the test command after
implementation. The orchestrator, implementor, and reviewer
skills all expect linting and type checking (e.g.
`golangci-lint run --fix`, `ruff check --fix`, `pyright`)
to run as part of the quality gate. The extension has no
lint step.

## Requirements

### Prompt entry and directory creation

1. Both **Conductor: Start** and **Conductor: Fix Bugs**
   accept input in two ways:

   a. **Existing directory** — the user selects a feature
      directory that already contains a `prompt.md`.

   b. **Inline prompt** — the user types or pastes their
      feature description or bug report directly in the
      dashboard, team server, or a VS Code input box,
      without having created a directory first.

   When an inline prompt is provided, the extension creates
   the feature directory and writes `prompt.md` before
   proceeding.

2. For features (**Conductor: Start**), the directory is
   named `.docs/<feature-name>/` where `<feature-name>` is
   a short kebab-case slug. The extension asks a quick LLM
   to derive a slug from the prompt text (e.g. "Add batch
   retry logic" → `batch-retry-logic`). The user may
   override the suggested name. If the directory already
   exists, the extension appends an incrementing suffix
   (e.g. `batch-retry-logic-2`).

3. For bug fixes (**Conductor: Fix Bugs**), the directory
   is named `.docs/bugs<N>/` where `<N>` is the next
   unused increment (e.g. `bugs1`, `bugs2`). Each bug-fix
   run gets its own directory with `prompt.md`, audit
   trail, and state — the same structure as a feature run.

### Bugfix orchestration

4. The extension parses the bug description into discrete
   issues. Each issue is processed sequentially through:

   a. **Fix** — invoke an implementor LLM with the
      conventions and implementor skills, the bug
      description, and instruction to write a failing
      regression test then fix the code to make it pass.

   b. **Review** — invoke a reviewer LLM with the
      conventions and reviewer skills, the bug description,
      and the list of changed files. The reviewer checks
      that a regression test exists, the fix is correct and
      minimal, tests pass, and linting is clean. Returns
      PASS or FAIL.

      - PASS → proceed to step c.
      - FAIL → re-invoke the implementor with reviewer
        feedback, then a fresh reviewer. Maximum 5
        fix-review cycles.

   c. **Approve** — pause for human approval (always,
      regardless of `requireApproval`). Present the bug
      summary, fix summary, and test/lint status in the
      dashboard and team server. The user may approve or
      request changes with feedback.

      - Approved → proceed to step d.
      - Changes requested → return to step a with the
        user's feedback appended.

   d. **Commit** — `git add` only the changed files and
      commit with a short imperative message (max 72
      characters). Do not push.

5. After all bugs are processed, report a completion
   summary.

6. Bugfix invocations reuse the existing implementor and
   reviewer roles. No new roles are needed. The model
   configs for implementor and reviewer apply.

7. All bugfix invocations produce audit entries and
   transcripts using the existing infrastructure.

8. The dashboard and team server display bugfix status:
   current bug number, fix-review cycle count, and
   approval state.

### Post-implementation PR review

9. After all phase items pass review, the state machine
   continues with two whole-PR review steps before
   reaching `"done"`:

   a. **Spec-aware PR review** — invoke a pr-reviewer LLM
      with the pr-reviewer skill, the spec path, and
      instruction to review all changes on the current
      branch vs base. The reviewer checks code quality,
      bugs, usability, and spec conformance. It launches
      implementor subagents to fix findings and commits
      fixes. Repeat with a fresh pr-reviewer until
      2 consecutive clean passes (a clean pass = no
      findings).

   b. **Spec-free PR review** — same as above but without
      the spec (focus on code quality and usability only).
      Repeat until 2 consecutive clean passes.

10. Add `"pr-reviewer"` as a new role with its own
    configurable model (`conductor.models.prReviewer`).

11. When `requireApproval` is true, the extension pauses
    for human approval after both PR review steps pass.

### Copilot re-review loop

12. A new **Conductor: Copilot Re-Review** command lets the
    user trigger the Copilot re-review loop from the
    pr-reviewer skill (step 8). The user invokes this
    after seeing a GitHub Copilot review on their PR.
    Once triggered, the loop proceeds automatically:

    a. Push current commits.

    b. Wait for GitHub to see the push (poll until the
       remote HEAD SHA matches the local HEAD).

    c. Request a Copilot re-review via the GitHub API
       (`POST .../requested_reviewers` with
       `copilot` as reviewer).

    d. Poll for a new Copilot review submitted after the
       push timestamp. Timeout after 20 minutes.

    e. Fetch new unresolved Copilot comments.

       - No new comments → loop ends, report success.
       - New comments → invoke a pr-reviewer LLM to fix
         findings (same as requirement 7), commit fixes,
         return to step a.

    f. At cycle 3+, prepend to the implementor prompt:
       "Consider the problem holistically. The same area
       has attracted repeated reviewer findings across
       multiple fix cycles. Rather than patching
       individual comments, refactor the surrounding code
       so that reviewers do not keep finding issues."

    g. After 20 cycles, stop, push whatever is committed,
       and report that manual review is needed.

13. The Copilot re-review loop is also available in the
    dashboard and team server as a button. It is
    independent of the main implementation pipeline —
    the user can trigger it at any time on any branch
    with an open PR.

14. The loop reuses the pr-reviewer role and model config.
    GitHub API calls use the `gh` CLI (assumed available
    on PATH).

### Commit, push, and branch safety

15. After all items in a phase pass review, the extension
    runs `git add` on all changed files and commits with
    the message `Implement phase <N>` (matching the
    orchestrator skill step 4). This happens automatically
    before advancing to the next phase or to PR review.

16. After every code commit (per-phase, bugfix, PR review
    fix), the extension pushes to the remote. This ensures
    progress is recoverable if the local machine crashes
    and a teammate needs to resume the run.

17. The extension also commits and pushes its own state
    files (`.conductor/state.json`, `audit.md`,
    `addendum.md`, run transcripts) after each significant
    state transition (phase completion, spec-writing step
    completion, bugfix commit, PR review pass). Commit
    message: `conductor: update state`. This lets another
    human pull the state and resume on a different machine.

18. Hard safety constraint: the extension refuses to push
    to `main`, `master`, or the repository's default
    branch as reported by `git remote show origin`. It
    will only push to a feature branch. If the current
    branch is a protected branch, the extension aborts
    with an error at run start, before any work begins.

### Bash tool safety bypass for extension-owned commands

19. The bash tool (`bash.ts`) blocks shell metacharacters
    (`&&`, `|`, `;`, etc.) to protect against LLM prompt
    injection. This is correct for LLM-initiated commands.
    However, the extension itself needs to execute compound
    commands for testing and linting (e.g.
    `ruff check --fix src/ && ruff format src/`), git
    operations (`git add` + `git commit`), and the Copilot
    re-review loop (`git push`, `gh api` pipelines).

    The extension must distinguish between LLM-requested
    bash execution (subject to full safety validation) and
    extension-owned execution (trusted commands that bypass
    LLM safety checks but still enforce timeout and
    working directory constraints). This can be a separate
    internal function or a trusted flag — but LLM tool
    calls must never reach the trusted path.

### Lint command execution

20. The extension currently runs only the test command
    after implementation. The orchestrator, implementor,
    and reviewer skills all expect linting and type
    checking to run as well. The extension should run the
    extracted lint commands (from requirement 23) after
    tests pass, and feed lint failures back to the
    implementor as retry feedback, the same way test
    failures are handled.

### Per-feature configuration

21. Remove the `conductor.specDir` setting. The user
    either selects an existing feature directory or
    enters an inline prompt (see requirements 1–3).
    The extension stores the resolved path in the run
    state.

22. Remove the `conductor.conventionsSkill` setting as a
    global config. Instead, when starting a new run, the
    extension:

    a. Runs a quick LLM exploration of the project to
       guess the tech stack (inspect file extensions,
       build files, lock files, existing code).

    b. Presents the guess as a default in a quick-pick of
       available conventions skills found in `skillsDir`.

    c. The user confirms or overrides.

    d. The chosen conventions skill is stored in the
       feature's run state, not in VS Code settings. This
       means different features can use different
       conventions.

23. Remove the `conductor.testCommand` setting. Instead,
    when the conventions skill is selected, the extension
    runs a quick LLM parse of that skill's content to
    extract the test, lint, and other quality-checking
    commands from its Commands section. These are stored
    in the feature's run state. The user may override
    them via the dashboard or team server on a per-feature
    basis.

24. The `OrchestratorConfig` type drops `specDir`,
    `conventionsSkill`, and `testCommand`. The
    `OrchestratorState` gains `conventionsSkill`,
    `testCommand`, `lintCommand`, and any other extracted
    quality commands, alongside the existing `specDir`.
    These are populated during run initialization and
    persisted in `state.json`.

25. The existing `conductor.skillsDir`, `conductor.maxTurns`,
    `conductor.maxRetries`, `conductor.requireApproval`,
    model configs, and server settings remain as global
    VS Code settings — they apply uniformly across all
    features.

## Notes

- The bugfix workflow is simpler than spec-writing: it
  reuses implementor and reviewer roles rather than
  introducing new ones. The main new work is the per-bug
  sequential loop, mandatory approval, and commit step.
- Bug-fix directories (`.docs/bugs<N>/`) use the same
  `.conductor/` state layout as feature directories. This
  means audit trails, transcripts, and state persistence
  all work identically — no special-casing needed.
- The feature-name slug LLM call is a single short
  invocation (no tools) reusing the spec-author model.
  Fallback if the LLM returns garbage: `feature-<N>`.
- Inline prompt entry is the primary UX for casual use.
  Power users who maintain `prompt.md` files in version
  control can still select existing directories.
- The pr-reviewer role is new to the type system but the
  review loop architecture (2-consecutive-PASS gate) is
  identical to what already exists for spec review and
  item review.
- Phase review in the orchestrator skill uses the
  pr-reviewer skill, not the per-item reviewer skill.
  The pr-reviewer operates on the full branch diff, not
  a single item's changes.
- The Copilot re-review loop is deliberately decoupled
  from the main pipeline. It is user-triggered because
  only the user knows when a Copilot review has appeared
  on their PR. Once triggered it runs autonomously.
- The `gh` CLI is used for GitHub API calls (fetching PR
  info, requesting reviewers, polling reviews) rather
  than building a GitHub REST client into the extension.
- The conventions-skill LLM parse for extracting commands
  should be fast (single short invocation, no tools
  needed). It replaces what was previously manual
  configuration with an automated default that matches
  its source of truth.
- The tech-stack guess LLM call reuses the spec-author
  model config — no separate model needed.
- The per-feature state model means `state.json` is
  self-contained: it records which conventions skill and
  commands were used for that run, making runs
  reproducible even if the user later changes their
  environment.
- The orchestrator skill's error handling says to move
  removed files to `.trash/` in the repo and clean up
  after all phases. This is a minor resilience feature
  that the extension should implement: if a file the LLM
  wrote is later deleted (e.g. by a reviewer fix), stash
  it rather than losing it.
- The phase-creator skill receives implementor and
  reviewer skill names so it can reference them in the
  phase file's Instructions section. The extension must
  pass these derived skill names when invoking the
  phase-creator LLM.
- The `git push` block in `bash.ts` must remain for
  LLM-invoked commands. The extension's own trusted
  execution path (for commits, pushes, and compound lint
  commands) bypasses the LLM safety layer but still
  enforces timeouts and working directory constraints.
- The branch safety check (requirement 18) uses
  `git rev-parse --abbrev-ref HEAD` and compares against
  `main`, `master`, and the output of
  `git remote show origin | grep 'HEAD branch'`. This
  is a hard gate at run start — not a warning, not
  overridable.
- State file pushes (requirement 17) are batched: the
  extension does not push after every single audit entry,
  only at meaningful checkpoints. This avoids excessive
  push noise while still ensuring crash recovery.
- Items identified as NOT gaps (correctly handled or not
  automatable):
  - Checkbox ticking in phase files — implemented.
  - Agent-conduct rules — enforced by bash.ts safety
    checks for LLM commands and by prompt injection.
    The extension cannot enforce all conduct rules in
    code (e.g. "do not modify files outside scope")
    since scope is semantic, but the workspace boundary
    and git push blocks are code-enforced.
  - Skill discovery — the LLM reads the conventions
    skill as part of its system prompt; the extension
    derives implementor/reviewer skill names from the
    conventions skill name. This is correct.
  - Frontend-design skill — a style guide, not an
    orchestration workflow. Loaded as a skill when the
    conventions skill references it. No extension
    automation needed.
  - Test execution by LLM — the LLM runs tests as part
    of the TDD cycle via the bash tool; the extension
    also runs them as a deterministic gate. This
    redundancy is intentional and correct.

## Notes

- State files (`.conductor/`) live per-feature: each
  feature directory gets its own `.conductor/` subdirectory
  (e.g. `.docs/batch-retry-logic/.conductor/state.json`).
  On activation, the extension scans for active
  `state.json` files to detect crash recovery.
- Bug descriptions are parsed into discrete issues via a
  quick LLM call (reuse spec-author model) that splits the
  bug text into a JSON array of discrete issues, each with
  a short title and description.
- PR review fix cycle uses multi-invocation: the
  pr-reviewer LLM returns structured findings, the
  extension invokes an implementor LLM per finding to fix
  it, runs tests/lint, and commits. Then re-invokes a fresh
  pr-reviewer. This matches the subagent pattern from the
  manual skill.
- Only one feature run is active at a time. Starting a new
  run while one is active/paused requires the user to first
  complete or abandon the previous run.
- Auto-created feature and bugfix directories use a
  configurable base directory via a new
  `conductor.docsDir` setting (default `.docs/`).
- The pr-reviewer returns structured findings as a JSON
  array inside the done tag:
  `<done>FAIL[{"file":"...","line":...,"description":"..."}]</done>`.
  The extension parses and dispatches one implementor
  invocation per finding.
- The base branch for PR review diff is computed
  automatically via `git merge-base HEAD <default-branch>`.
- A new `Conductor: Abandon` command sets run state to
  `"abandoned"`, leaves files in place, and frees the
  extension to start a new run.
- For inline prompt entry via VS Code command palette, the
  extension opens a temporary untitled document for
  multi-line editing. The prompt is captured on
  close/confirm.
- Copilot re-review polling uses a hardcoded 30-second
  interval for both push verification and review wait.
- Bugfix commits push individually after each bug
  (requirement 16 wins over 4d's "do not push" phrasing).
- After lint auto-fix modifies code, tests are re-run to
  catch regressions. Full quality cycle:
  test → lint → retest if lint modified files.
- On activation, if crash recovery detects an active
  `state.json`, the extension prompts the user with a
  notification asking to resume or abandon the run.
- After spec-writing completes, the extension commits
  `spec.md` and `phase*.md` with the message
  `conductor: write spec` before implementation begins.
