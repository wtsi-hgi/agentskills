---
name: implementation-principles
description: Shared cross-language delivery workflow and guidance for implementing the simplest sufficient solution, maximizing reuse of existing code, and avoiding speculative abstractions, dependencies, and refactors. Use when implementing or reviewing code in any language.
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

## Refactoring Gate

Refactor only when it is needed for the current behaviour, uses an established
abstraction, removes actual duplication of one responsibility, or makes the
current change materially clearer or testable. Keep the refactor scoped to the
requirement.

## Completion Check

Before finishing, ask:

- Did I reuse the closest existing implementation or extension point?
- Is every new abstraction, public API, dependency, and configuration option
  necessary for a current requirement?
- Is there one obvious implementation path with no duplicated business logic?
- Can any new code or changed surface area be removed while retaining the
  required behaviour?
