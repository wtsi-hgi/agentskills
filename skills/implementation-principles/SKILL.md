---
name: implementation-principles
description: "Shared cross-language delivery workflow and guidance for implementing the simplest sufficient solution, maximizing reuse of existing code, fixing root causes, proving work against the real artifact, scoping a costly mechanism to the case that needs it, avoiding speculative abstractions, dependencies, and refactors, and never trading away validation, error handling, security, or accessibility to shorten a diff. Use when implementing or reviewing code in any language."
---

# Implementation Principles

## Core Rule

Make the smallest coherent change that satisfies the requested behaviour and
acceptance tests. Prefer the repository's existing design, code, and
dependencies over introducing another way to solve the same problem.

## Before Coding

Search the relevant call paths, modules, types, helpers, configuration, tests,
and dependencies. Identify what can be called, composed, or extended before
designing anything new. Check whether configuration or a small change to an
existing responsibility already expresses the required behaviour.

## Escalation Order

Climb only as far as the behaviour needs, and stop at the first step that
holds:

1. No code at all, because the behaviour is already there or was never asked
   for.
2. Existing code in this repository: the helper, pattern, or extension point
   already written.
3. The standard library.
4. A native platform or framework feature.
5. A dependency the project already has.
6. New code, as the smallest thing that satisfies the behaviour.

Climb after understanding the problem, not instead of it. The smallest change
in the wrong place is a second defect, not a shorter diff. When two options at
the same step cost the same, take the one that handles the edge cases: less
code does not mean the flimsier algorithm.

When a request is more elaborate than the need it names, say what would cover
that need with less, and let the requester choose.

## Scope The Mechanism

The escalation order says where code may come from. Within a step, take the
narrowest mechanism that meets the constraint, and scope it to the case that
needs it.

One hard case does not set the strategy for its neighbours: unbounded-precision
arithmetic belongs in the function whose width is unbounded, not in the other
eight; a mutex covers the path that is concurrent, not the package; a cache
wraps the call that is expensive, not every call; reflection serves the case
whose type is unknown. Read the constraint as written, since "must not wrap" is
narrower than "arbitrary precision", and the narrower reading often has a
fixed-width answer already in the standard library.

For a primitive every caller routes through, per-call cost is part of the
contract rather than a tuning detail, because it multiplies by every call site.
Settle it once from a measurement, not an assumption. This is not the premature
optimization the Avoid list names: that rule excludes work unrelated to the
current requirement, and a shared primitive's cost is part of its requirement.

## Domain Shape

Name the data and its states before writing logic. Encode the domain in one
structure - a state machine, a typed model, a lookup table, a single validated
type - rather than repeating the same shape assumption as conditionals across
files. Where the language allows it, make the illegal state unrepresentable
instead of guarding against it at each call site.

This is subtractive. It replaces scattered branches with one authoritative
shape. It does not license a new layer or a speculative interface (see Avoid).

## Delivery Workflow

Work on one requested item at a time. Treat the specification and its
acceptance tests as the source of truth.

For each behaviour change:

1. Write the relevant behavioural test first and run it to confirm that it
   fails for the expected reason. Follow **testing-principles**; do not invent a
   new test when supported behaviour is unchanged.
2. Implement the smallest change that makes the test pass.
3. Refactor only when the refactoring gate below permits it.
4. Re-run the targeted test, then run all relevant tests, linters, formatters,
   type checks, and other project quality gates before declaring completion.

If a required quality gate cannot run, report that explicitly. Do not claim it
passed.

## Root Causes

Fix the cause, not the symptom. Reproduce the failure first, then trace it
until you can name the line that is wrong. A guard that suppresses a symptom
hides the defect and outlives it: a nil check around a value that should never
be nil, a retry around a deterministic failure, a widened type, a tolerance
loosened until the assertion stops firing.

One wrong line can have many callers. When it sits in a shared function, fix
it there and check every caller: one correction in the shared function is a
smaller change than one per call site, and repairing only the path the report
names leaves its siblings broken.

When the cause is genuinely outside the current scope, make the smallest
in-scope fix and report the rest. Do not paper over it (see **agent-conduct**
on blockers).

## Prove It Works

Verify against the real artifact, not a proxy. "It compiles", a green build
alone, a file timestamp, or a summary of what was intended are not evidence.
Run the code path and read the actual value.

Where the check can be a script, write the script and keep its output, so a
reviewer can re-run the same comparison instead of taking your word for it.

## Prefer

- Compose existing operations before adding another abstraction.
- Keep changes local and preserve stable interfaces unless the requirement
  demands otherwise.
- Use straightforward control flow.
- Consolidate duplicated business rules so there is one authoritative path.

## Avoid

- Speculative support for possible future requirements.
- New layers, interfaces, factories, wrappers, helpers, or configuration when
  direct code is clearer.
- New dependencies for behaviour the project or standard library already
  provides.
- Parallel implementations of an existing workflow or business rule.
- Broad refactors, premature optimization, concurrency, or configurability
  unrelated to the current requirement.
- Forced DRY abstractions that join code sharing syntax but not the same
  responsibility. Reuse semantics; do not couple unrelated concepts merely to
  reduce line count.

## Do Not Economize On

The smallest sufficient change is still a complete one. Keep, at full
strength:

- Input validation at trust boundaries.
- Error handling that prevents data loss or corruption.
- Security.
- Accessibility.

## Comments

Keep the comment that carries a non-obvious why: the constraint, the bug it
works around, the reason the obvious approach fails. Write the code so
anything else is unnecessary, rather than writing narration and deleting it
later.

A ceiling accepted on purpose is one of those whys. When the simple approach
carries a known limit, such as a global lock, a quadratic scan, or a naive
heuristic, the comment names the limit and what would lift it.

Narration to leave unwritten: a restatement of the next line, a phase label
above a block, a note about what the code used to do, a description of the
test the assertion already names. Language conventions that require doc
comments on exported symbols still apply; see the project's conventions skill.

## Refactoring Gate

Refactor only when it is needed for the current behaviour, uses an established
abstraction, removes actual duplication of one responsibility, or makes the
current change materially clearer or testable. Keep the refactor scoped to the
requirement.

## Encode Lessons In Structure

When you would write the same instruction, or make the same correction, a
second time, encode it instead. Pick the strongest mechanism the situation
allows: a type that makes the mistake impossible, then a lint rule or CI check
that fails on it, then one canonical helper every caller uses, then a runtime
check. People and agents copy the surrounding code, so a weak guard becomes
the next template.

Only if the rule genuinely needs judgement does it stay as text, and then it
gets an example of the failure mode.

## Completion Check

Before finishing, ask:

- Did I reuse the closest existing implementation or extension point?
- Did I check the real behaviour rather than a proxy for it?
- Is every new abstraction, public API, dependency, and configuration option
  necessary for a current requirement?
- Is there one obvious implementation path with no duplicated business logic?
- Can any new code or changed surface area be removed while retaining the
  required behaviour?
