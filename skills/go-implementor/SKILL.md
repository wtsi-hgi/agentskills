---
name: go-implementor
description: Go TDD implementation workflow. References implementation-principles, go-conventions, testing-principles, and agent-conduct.
context: fork
---

# Go Implementor Skill

Read and follow **agent-conduct**, **implementation-principles**,
**testing-principles**, and **go-conventions** before starting.

## Go TDD Steps

- Test framework: GoConvey.
- Targeted test:
  `CGO_ENABLED=1 go test -tags netgo --count 1 ./<path> -v -run <TestFunc>`
- Run `cleanorder -min-diff <file>` on every edited `.go` file.
- Run `golangci-lint run --fix` and fix remaining issues.
