---
name: verification
description: "Create, prove, and maintain a project-local skill that drives the real app the way a user does and captures evidence. Use when a project has no scripted way to prove user-visible behaviour, when an existing verify skill has gone stale, or when a workflow needs proof beyond tests and linters."
---

# Verification Skill

Tests and linters prove the code does what its tests say. They do not prove a
user can do the thing. This skill produces a project-local **verify skill**
that launches the real app, drives a named feature the way a user would, and
captures evidence.

Read and follow **agent-conduct**, **subagents**, and **writing-for-agents**
before starting. **subagents** owns delegation. Apply
**writing-for-agents** to the skill you generate: it will be read cold,
mid-task, by an agent that has never seen the app.

## Output

This skill owns the location, so callers find a verify skill without
searching. The path is fixed:

- `.github/skills/verify-<app>/SKILL.md` - the verify skill. `<app>` is the
  app or surface it drives, so a monorepo can hold several.
- `.github/skills/verify-<app>/features/` - the feature map: a `README.md`
  index plus one file per user-facing feature.

Callers detect a verify skill by globbing
`.github/skills/verify-*/SKILL.md`. That glob is the published contract, so
place the skill there whatever harness is in use. It does not need to sit in
the harness's own skills directory: its callers invoke it by absolute path,
the same way every other skill in this repo is passed to a subagent. Symlink
it into the harness directory only if a human also wants to invoke it by name,
and never move it out of the fixed path.

## Procedure

### 1. Interview the repo, not the user

Answer these from the codebase. Ask the user only what cannot be observed.

- **Surface:** what does a user touch? Web UI, CLI or TUI, desktop app, HTTP
  API, library. Pick the primary one and name the rest.
- **Launch:** how does the app start locally? Prefer the repo's own documented
  dev command. Note ports, environment variables, seed data, and auth.
- **Drive:** how can an agent interact with it unattended? Existing harnesses
  first (Playwright or Cypress specs, expect scripts, a debug port, curlable
  endpoints), then a generic recipe: browser automation for web, a PTY or tmux
  session for CLI and TUI, plain HTTP for services.
- **Observe:** what evidence can be captured? Screenshots, terminal
  transcripts, response bodies, exit codes, log lines, database rows, emitted
  files.
- **Isolate:** can two instances run side by side (ports, data directories,
  profiles)? If not, record that refusing to drive a shared instance is the
  correct behaviour.

If the checkout does not build or start, report it as a blocker per
**agent-conduct**. Repair product code only when the caller explicitly asked
for that repair; verification alone authorizes changes only to the verify
skill and its feature map. A skill written against a broken base teaches wrong
steps.

### 2. Write the skill

Ground every section in what the interview found, with no placeholders left.

- **Launch:** the exact command, and how to tell the app is ready (a log line,
  a port answering, a prompt). For a short-lived CLI, launch means build once,
  then start each drive in its own session.
- **Doctor:** one non-mutating check that answers "is this instance worth
  driving?" - process up, expected build, port owned by us, auth valid.
- **Drive:** the recipe, with real selectors and commands from this repo.
  Prefer stable handles (ARIA labels, data attributes, prompt strings, route
  paths) over screen coordinates and tab order.
- **Evidence:** what to capture for each proof, and the path it lands at.
- **Cleanup:** how to tear down what a run started. Kill what you started, by
  the handle you started it with, never by process name. Evidence outlives
  cleanup.
- **Helpers:** any script the skill ships is executable, and its invocation
  appears in the skill body.

### 3. Seed the feature map

Write `features/README.md` as an index, plus one file per user-facing feature.
Start with the top three to five found in routes, commands, menus, or docs.
Give each feature file these four headings:

- `What It Is` - the feature from the user's point of view.
- `How To Reach It` - the user's route to it.
- `How To Drive It` - the harness steps, using the Drive recipe.
- `Gotchas` - prerequisites, shared state, anything that misleads.

The map is the maintained record of what needs proving. A proof that drives
one convenient entry point is incomplete while the map lists others.

### 4. Prove the skill before handing it over

Validate the generated skill's frontmatter by the procedure in
**writing-for-agents**, under its frontmatter rules reference. Fix every
error it reports.

Run its own instructions end to end once: launch, doctor, drive one mapped
feature, capture evidence, clean up. Then confirm the evidence still exists
where the skill says it does. Fix what fails, and run cleanup after each
failed attempt so nothing is left holding a port. A generated skill that was
never executed is a draft, not a deliverable.

## Proof Standards

Put these in the generated skill, and hold to them whenever you drive an app.

- Exercise the real user path. Internal setters, test-only endpoints, and
  direct database writes prove the fixture, not the feature.
- Capture the action and the resulting state, not just the final screen.
- Verify side effects alongside what is visible: files written, rows
  inserted, messages sent, exit codes.
- Mock only where a production boundary already isolates an external system.
- Observe what a dry run actually skips (files, network, git refs) rather than
  trusting its name. Some dry runs still reach the network.
- A verdict is VERIFIED, NOT VERIFIED, or INCONCLUSIVE. Inconclusive is not a
  pass. Report the negative.

## Maintenance Pass

Run this when the app has changed user-visible behaviour, when a drive fails
on steps that used to work, or on whatever cadence the user asks for.

1. **Index.** Read `features/README.md` and glob its siblings. Fix missing,
   duplicate, and dead entries.
2. **Source.** Launch one normal subagent per feature file concurrently. Brief
   each to inspect without editing. It answers "how does this feature work
   now?" from source, flags likely drift with file and line citations, and
   returns one live verification recipe.
3. **Live.** Required even when source looks clean. Drive every feature at
   least once. Doctor before the first drive, on each fresh session, and again
   after any failed drive. A feature you cannot reach is unreachable only with
   the concrete prerequisite named and the route you attempted; a prerequisite
   missing from the map is drift.
4. **Triage.** A wrong user-facing description is doc drift: fix the map.
   Working behaviour the harness cannot drive is a harness gap: fix the skill
   and re-drive before shipping the fix. Behaviour that is actually broken is
   a product bug: report it and leave the docs honest.
5. **Report.** Say which outcome the pass reached: **clean** (full coverage,
   nothing to change), **changed** (proven corrections, listed), or
   **blocked** (coverage could not finish, with what blocked it).

## Rules

- Only edit the verify skill's own directory during a maintenance pass. Never
  edit product code to make a drive succeed.
- Never describe a feature as verified without the evidence path that proves
  it.
- Never paper over a product bug in the feature map (see **agent-conduct** on
  blockers).
- Evidence survives cleanup. Confirm it at its named path rather than assuming
  it.
- A caller building a red feedback loop for a bug (see **bugfix**) can reuse
  this skill's Drive recipe instead of inventing one.
