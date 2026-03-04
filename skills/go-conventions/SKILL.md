---
name: go-conventions
description: Shared conventions for Go projects. Covers copyright boilerplate, code quality standards (modern Go 1.25+ idioms, style, naming), GoConvey testing patterns, memory-bounded test patterns, architecture principles, and tool commands. Referenced by go-implementor, go-reviewer, and other workflow skills.
---

# Go Conventions

This document is the single source of truth for Go code quality
standards, testing patterns, architecture principles, and tool
commands. Other skills reference it rather than duplicating these
rules.

## Copyright Boilerplate

All new source files must start with this exact header (only the
year may change):

```
/*******************************************************************************
 * Copyright (c) 2026 Genome Research Ltd.
 *
 * Author: Sendu Bala <sb10@sanger.ac.uk>
 *
 * Permission is hereby granted, free of charge, to any person obtaining
 * a copy of this software and associated documentation files (the
 * "Software"), to deal in the Software without restriction, including
 * without limitation the rights to use, copy, modify, merge, publish,
 * distribute, sublicense, and/or sell copies of the Software, and to
 * permit persons to whom the Software is furnished to do so, subject to
 * the following conditions:
 *
 * The above copyright notice and this permission notice shall be included
 * in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
 * EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
 * IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
 * CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
 * TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
 * SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 ******************************************************************************/
```

## Code Quality

### Modern Go (1.25+)

- **Range over integers:** Use `for i := range n` instead of C-style
  `for i := 0; i < n; i++`. This applies to all new code.
- **Structured logging:** Prefer `log/slog` over `log` or
  `fmt.Println` for operational output.
- **Errors:** Use `fmt.Errorf` with `%w` for wrapping. Prefer
  sentinel errors as package-level `var` with `errors.New`. Use
  `errors.Is` and `errors.As` for checking.
- **Slices and maps packages:** Use `slices.Contains`,
  `slices.Sort`, `maps.Keys`, etc. instead of hand-written loops
  where appropriate.
- **Short variable declarations:** Prefer `:=` over `var` where the
  type is obvious from the right-hand side.
- **Named return values:** Only use when they genuinely aid
  readability (e.g. multiple returns of the same type). Do not use
  them solely for naked returns.
- **Goroutine cleanup:** Always ensure goroutines have a clear exit
  path. Use `context.Context` for cancellation where appropriate.

### Style

- **Line width:** 100-column hard limit for code, 80-column for
  comments.
- **Function length:** Keep functions short. Extract helpers when a
  function exceeds ~30 lines of logic, excluding error handling. But
  do not be too aggressive about this: do not make it difficult to
  trace the logic by scattering it across too many tiny functions.
- **Cyclomatic complexity:** Keep low. Prefer early returns and guard
  clauses over deeply nested if/else.
- **Naming:** Self-documenting names. No abbreviations except
  well-known ones (e.g. `ctx`, `err`, `ok`, `i`, `n`). Exported
  identifiers must have doc comments.
- **Package organisation:** One responsibility per file. File names
  should describe the responsibility (e.g. `report.go`, `chunk.go`).
- **Import grouping:** Standard library, then a blank line, then
  third-party, then a blank line, then internal project imports.
- **Constants:** Prefer typed constants and `iota` for enumerations.
  Group related constants in a `const` block.

### Testing

- **Framework:** GoConvey
  (`github.com/smartystreets/goconvey/convey`).
- **Test naming:** `TestXxx` for the top-level function, then nested
  `Convey` blocks describing the scenario.
- **Assertions:** Use `So(actual, ShouldEqual, expected)` and
  related GoConvey matchers. Never use bare `if` checks in tests.
- **Temp dirs:** Use `t.TempDir()` for filesystem operations. Never
  leave test artifacts behind.
- **Table-driven tests:** Acceptable but not required when GoConvey
  nested Convey blocks are clearer.
- **Test independence:** Each `Convey` block must be independent. No
  shared mutable state between tests.
- **Assertion volume:** Never put `So()` assertions inside loops
  that iterate more than ~100 times. Instead, count
  successes/failures in the loop and assert the final count once
  after the loop. For example, count write errors in a variable and
  then `So(writeErrors, ShouldEqual, 0)`.
- Every acceptance test listed in spec.md for the referenced user
  stories MUST have a corresponding GoConvey test. Do not skip,
  stub out, or circumvent any test.
- Do not hardcode expected results in implementations to make tests
  pass.
- All tests must genuinely pass - no tricks, no test helpers that
  silently swallow failures, no build tags that exclude tests.

### Memory-Bounded Test Pattern

All memory tests follow this pattern:

```go
func TestStreamingMemory(t *testing.T) {
    // 1. Create large input (1M entries in t.TempDir())
    // 2. Measure baseline:
    runtime.GC()
    var before runtime.MemStats
    runtime.ReadMemStats(&before)
    // 3. Run the streaming operation
    // 4. Measure after:
    runtime.GC()
    var after runtime.MemStats
    runtime.ReadMemStats(&after)
    // 5. Assert (guard against unsigned underflow):
    var growth uint64
    if after.HeapInuse > before.HeapInuse {
        growth = after.HeapInuse - before.HeapInuse
    }
    So(growth, ShouldBeLessThan, 20*1024*1024)
}
```

## Architecture Principles

- **`cmd/*.go` is CLI-only:** Files in `cmd/` should contain only
  code concerned with the CLI (flag parsing, argument validation,
  wiring up components). No business logic.
- **New public packages for new functionality:** Most new code
  should live in new public packages that are fully tested using
  GoConvey, developed via TDD on desired public behaviour. Each
  package should be focused on a specific area of functionality.
- **`internal/` for shared helpers and mocks:** Use `internal/`
  sub-packages for shared testing helpers, mocks for external
  interactions, and generic utility code that does not belong in a
  public API.
- **`main_test.go` for integration tests:** High-level integration
  tests of the CLI go in `main_test.go` with no mocks - these
  tests exercise the real end-to-end flow.
- **Reuse existing code:** Reuse existing functions, types, and
  packages wherever possible. If existing code is in the wrong
  package for import reasons, move it to a shared location (e.g.
  `internal/`) rather than duplicating it.
- **Small, focused files:** Keep code per file to a minimum.
  Organise related code into separate files (and thus separate
  `_test.go` files) within a package, and use different packages
  as appropriate.

## Commands

Run tests:
```
CGO_ENABLED=1 go test -tags netgo --count 1 ./<path> -v -run <TestFunc>
```

Run linter:
```
golangci-lint run --fix
```

Check lint without fixing (for review):
```
golangci-lint run
```

Clean ordering:
```
cleanorder -min-diff <file>
```
