---
name: go-implementor
description: Go code implementation following TDD. Provides the TDD cycle and implementation workflow. References go-conventions for code quality standards, testing patterns, and commands, and agent-conduct for safety rules. Use when implementing Go code, writing tests, creating new packages, or following a phase plan.
---

# Go Implementor Skill

## Prerequisites

Before starting any work:

1. Read and follow the agent-conduct skill. It covers workspace
   boundaries, scratch work, terminal safety, and git safety rules.
2. Read the go-conventions skill. It defines code quality standards,
   GoConvey testing patterns, copyright boilerplate, architecture
   principles, and commands that all Go implementation must follow.

## TDD Cycle

For each acceptance test, follow these steps exactly. Do not skip
any step.

1. Write a failing test (GoConvey style).
2. Run:
   `CGO_ENABLED=1 go test -tags netgo --count 1 ./<path> -v -run <TestFunc>`
3. Write minimal implementation to pass.
4. Refactor (short functions, low complexity, self-documenting names,
   100-col line wrap, 80-col comment wrap).
5. Run `cleanorder -min-diff <file>` on every edited `.go` file.
6. Run `golangci-lint run --fix` and fix remaining issues.
7. Re-run the test to confirm it still passes.

## Implementation Workflow

1. Implement ONE item at a time, writing all GoConvey tests
   corresponding to the acceptance tests in spec.md, then writing
   the implementation code to make those tests pass - strictly
   following the TDD cycle above.
2. Consult spec.md for the full acceptance test details, function
   signatures, types, and package structure.
