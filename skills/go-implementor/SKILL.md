---
name: go-implementor
description: Go TDD implementation workflow. References go-conventions and agent-conduct.
---

# Go Implementor Skill

Read and follow **agent-conduct** and **go-conventions** before starting.

## TDD Cycle

For each acceptance test, follow every step:

1. Write a failing GoConvey test.
2. Run: `CGO_ENABLED=1 go test -tags netgo --count 1 ./<path> -v -run <TestFunc>`
3. Write minimal implementation to pass.
4. Refactor.
5. Run `cleanorder -min-diff <file>` on every edited `.go` file.
6. Run `golangci-lint run --fix` and fix remaining issues.
7. Re-run test to confirm it passes.

## Workflow

Implement ONE item at a time: write all GoConvey tests for the spec.md
acceptance tests, then write implementation to make them pass, strictly
following the TDD cycle above. Consult spec.md for full details.
