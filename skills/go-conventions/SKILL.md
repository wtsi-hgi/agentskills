---
name: go-conventions
description: Shared conventions for Go projects. Copyright boilerplate, code quality, GoConvey testing, architecture, and commands. Referenced by go-implementor, go-reviewer, and workflow skills.
---

# Go Conventions

Single source of truth for Go code standards. Other skills reference this.

## Copyright Boilerplate

All new source files must start with:

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

- Range over integers: `for i := range n` (no C-style loops in new code).
- `log/slog` over `log` or `fmt.Println` for operational output.
- `fmt.Errorf` with `%w`; sentinel errors as package-level `var` with
  `errors.New`; `errors.Is`/`As` for checking.
- `slices`/`maps` packages instead of hand-written loops.
- Named return values only when they genuinely aid readability.
- Goroutines must have clear exit paths; use `context.Context` for cancellation.

### Style

- Functions ~30 lines max (excluding error handling), but don't scatter logic
  across too many tiny helpers.
- Early returns/guard clauses over nested if/else.
- Doc comments on all exports.
- One responsibility per file; filenames describe the responsibility.
- Import grouping: stdlib | third-party | project (blank-line separated).

### Testing (GoConvey)

- Framework: `github.com/smartystreets/goconvey/convey`.
- `So(actual, ShouldEqual, expected)` assertions - never bare `if` checks.
- `t.TempDir()` for filesystem ops.
- Each `Convey` block independent; no shared mutable state.
- Never put `So()` in loops >20 iterations; count and assert final count.
- Every spec.md acceptance test MUST have a corresponding GoConvey test. No
  stubs, no hardcoded results, no swallowed failures, no build-tag exclusions.

### Memory-Bounded Test Pattern

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
    // 5. Assert (guard unsigned underflow):
    var growth uint64
    if after.HeapInuse > before.HeapInuse {
        growth = after.HeapInuse - before.HeapInuse
    }
    So(growth, ShouldBeLessThan, 20*1024*1024)
}
```

## Architecture

- **`cmd/*.go`:** CLI-only (flag parsing, wiring). No business logic.
- **New public packages** for new functionality, fully tested via TDD.
- **`internal/`** for shared helpers, mocks, generic utilities.
- **`main_test.go`** for integration tests (no mocks, real end-to-end).
- Reuse existing code; move shared code to `internal/` rather than duplicating.

## Commands

```bash
# Tests
CGO_ENABLED=1 go test -tags netgo --count 1 ./<path> -v -run <TestFunc>

# Linter (check + autofix)
golangci-lint run --fix

# Clean ordering
cleanorder -min-diff <file>
```
