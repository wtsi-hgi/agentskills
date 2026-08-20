---
name: implementation-principles
description: Shared cross-language delivery workflow and guidance for implementing the simplest sufficient solution, maximizing reuse of existing code, fixing root causes, proving work against the real artifact, and avoiding speculative abstractions, dependencies, and refactors. Use when implementing or reviewing code in any language.
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

- Reuse existing code and established extension points.
- Compose existing operations before adding another abstraction.
- Keep changes local and preserve stable interfaces unless the requirement
  demands otherwise.
- Use straightforward control flow, the standard library, and dependencies
  already in the project.
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

## Comments

Keep the comment that carries a non-obvious why: the constraint, the bug it
works around, the reason the obvious approach fails. Write the code so
anything else is unnecessary, rather than writing narration and deleting it
later.

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
