---
name: go-test-strength
description: "Prove a Go package's tests catch defects, by injecting faults one at a time and requiring the suite to fail. Use when a spec says a named wrong implementation cannot pass, when reviewing a test suite, when auditing a package whose tests pass but whose correctness must be trusted, when comparing two implementations of one spec, or when deciding what a coverage number is worth."
---

# Go Test Strength Skill

Read and follow **agent-conduct** and **testing-principles** before starting.

A green suite proves the implementation passes its own tests. It says nothing
about which defects those tests would notice. This skill measures that
directly: break the implementation on purpose, one named defect at a time, and
require the suite to fail.

Coverage does not answer the question. A line executes under a test that
asserts nothing about it, so a suite at 98% statement coverage can miss whole
classes of defect at a type's boundaries. Treat coverage as a place to aim,
never as evidence.

## Core Rule

Every defect you can name and inject must make the suite fail. A defect the
suite tolerates is a finding, reported with the input that exposes it.

## Verdicts

Use these three words for every mutant, and no synonyms:

- **KILLED** - the suite failed. The tests defend that behaviour.
- **SURVIVED** - the suite passed. A finding or an equivalent mutant, decided
  in step 5.
- **INVALID** - the patch did not apply, or the mutant does not compile. Not a
  result.

An INVALID mutant counted as SURVIVED is what makes this exercise lie, and the
two look identical in the test output. Step 4 separates them mechanically
because judgement will not.

## Procedure

### 1. Baseline

```bash
go test ./<pkg>/ -count=1 -coverprofile=cover.out
go tool cover -func=cover.out
golangci-lint run ./<pkg>/...
```

Done when the pristine suite passes and the linter is clean. A red or flaky
baseline makes every later verdict noise: stop and report that instead.

Record every function below 100%. Each is a place to aim in step 3.

### 2. Isolate the workspace

Copy the module skeleton and the package into the scratch directory
**agent-conduct** allows, keeping the module path so imports still resolve.
Mutate the copy, never the working tree.

```bash
W="$SCRATCH/mutants"
mkdir -p "$W/<pkg>"
cp go.mod go.sum "$W"/
cp <pkg>/*.go "$W/<pkg>/"
```

Done when `go test ./<pkg>/ -count=1` passes inside the copy too.

### 3. Write the mutant list

Three sources, in this order:

1. **The spec.** Every clause of the form "so a naive X cannot pass",
   "asserted absent", "rather than", or "asserted side by side" names a mutant
   outright. Write those first: a survivor there is an unmet requirement, not
   a suggestion.
2. **The catalogue below**, applied to each exported function.
3. **The partially covered functions** from step 1.

Done when every exported function has at least one mutant, and every "cannot
pass" clause in the spec has the mutant it names.

### 4. Run each mutant

[mutate.sh](references/mutate.sh) applies, builds, tests and restores as one
step, and prints one of the three verdicts:

```bash
references/mutate.sh "$W" <pkg> <file> old.txt new.txt "<label>"
```

Replace text literally, which is what the script does. A `sed` or `perl`
pattern silently mangles Go punctuation, and a mutant that never applied reads
exactly like a mutant the suite failed to catch.

One mutant at a time: two at once can mask each other.

Done when no mutant is left INVALID.

### 5. Triage every SURVIVED mutant

Decide mechanically whether it is a defect or an equivalent mutant. Write a
throwaway test that calls both versions across the input domain, including
type boundaries, zero, and every sign quadrant:

- One input where they differ: a defect. Report that input.
- No differing input, plus an argument for why: equivalent. Exclude it.

Read the code and judge instead, and you will file real bugs as no-ops. An
off-by-one that looks like a harmless rewrite (`x < lo` to `x < lo+1`) is a
live signed-overflow bug at the type's maximum, which is exactly where a weak
suite has no assertion.

Done when every survivor carries a written verdict of defect or equivalent.

### 6. Report

One finding per surviving defect:

- the mutant, as the exact before and after text
- the input that distinguishes it from the original
- the assertion the suite is missing, named as a test the author can write

Close with the kill rate over valid mutants. Report it as evidence, not a
grade: "50 of 58, with five named defect classes undetected" carries the
review; a percentage alone does not.

## Mutant Catalogue

Apply to each exported function. A class that cannot apply is not a gap.

- **Guard removal.** Delete a zero, nil, bounds or overflow check. Return the
  zero value where the code panics, or `nil` where it errors.
- **Boundary shift.** `<` to `<=`; a threshold, index, cap or loop bound moved
  by one; an inclusive bound made exclusive.
- **Sign and direction.** Drop a sign normalisation, negate a comparison,
  reverse a compare function's return, swap round-up for round-down.
- **Width and overflow.** Replace a checked or wide computation with the
  native one, such as a `big.Int` product with `a*b`. Delete an overflow
  check.
- **Order of operations.** Divide before multiplying, round before
  accumulating, clamp before computing, filter after paginating.
- **Identity and empty.** Make an empty input yield zero where it owes the
  identity, or the identity where it owes zero. Nil slice, nil map, empty
  string.
- **Aliasing.** Return the internal slice or map instead of a copy, mutate an
  argument, share a pointer that should be cloned.
- **Error channel.** Return a different sentinel, swallow an error, drop the
  `%w`, report the wrong one of two failure modes.
- **Resource lifecycle.** Delete a `defer Close()` or `defer Unlock()`, or
  move the `defer` below an early return.
- **Concurrency.** Delete a lock, shrink a critical section to exclude one
  field, drop a `ctx.Err()` check.
- **Ordering.** `sort.SliceStable` to `sort.Slice`; iterate a map where output
  order is part of the contract.

## Stronger Evidence, When It Is Available

Neither of these needs you to guess the defect first, so both find what a
mutant list will not. Use them in addition to the procedure, not instead.

**An exact oracle.** Write the slower obviously-correct version and fuzz the
implementation against it, weighting type boundaries, zero and every sign
quadrant. `math/big` serves for integer arithmetic, an O(n^2) pass for an
optimised search, the standard library for anything reimplemented. Assert the
panic-versus-return behaviour as well as the returned values.

This harness is throwaway: it answers the review and goes. When the property
it proved deserves to outlive the review, the package owes a committed fuzz
target instead, whose shape **testing-principles** and **go-conventions** own.

**A second implementation.** When two agents or two branches implement one
contract, run each suite against the other implementation. A failure names a
contract disagreement with no mutant to design; both suites passing both
implementations narrows the open question to what neither suite asserts. Then
mutate each implementation in turn and run both suites against it. That
controls for one implementation simply being harder to mutate, and the suite
that kills a strict superset is the stronger one by the difference, which is
the review's finding.
