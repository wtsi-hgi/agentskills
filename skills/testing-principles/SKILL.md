---
name: testing-principles
description: "Shared guidance for behaviour-focused tests in TDD, regression fixes, acceptance-test implementation, perceptual and visual requirements, property and generated-input coverage, flaky test fixes, and test review. Use when writing, updating, stabilizing, or reviewing tests, or briefing another agent about tests, especially when deciding whether a cleanup/removal request needs a new test."
---

# Testing Principles

## Core Rule

Use tests to declare desired behaviour and prove the system has that
behaviour. Prefer supported boundaries: public APIs, CLI output, HTTP
contracts, rendered UI, persisted state, emitted files, errors, or other
effects visible to users, callers, or downstream steps.

## Perceptual Requirements

When the requirement is perceptual (colour, contrast, spacing, a focus ring, a
selection state, an animation end state), the supported boundary is the
rendered result in a real browser. Source CSS, class names, and jsdom computed
styles do not prove it.

Assert on a screenshot, or on sampled pixels and measured geometry, through the
same theming mechanism production uses. Compare the element against its own
fill and nearby surfaces rather than against token names. This holds for a
test, for a review, and for a bug's red command alike.

## Avoid

Do not write tests whose only claim is an implementation detail: private
helpers, source layout, filenames, imports, CSS classes, deleted files,
removed functions, removed routes, removed modules/processes, or the mere
absence of an old feature.

## Properties and Generated Input

A worked example the spec names earns a table test. A claim that must hold
across a whole domain earns generated input as well: overflow safety over a
numeric range, a round-trip that must return the original, a parser that must
never panic on any input.

Name the property before generating anything. Four shapes carry most cases:

- **Oracle.** A slower obviously-correct version agrees with the fast one.
- **Round-trip.** Decoding an encoded value returns the input.
- **Invariant.** Output stays in range, a total is conserved, nothing panics.
- **Two paths agree.** A cached or optimised path matches the plain one.

Assert the property, never a second copy of the implementation. Generated
input that recomputes the code the same way proves only self-consistency.

Generated input supplements the spec's worked examples and never replaces
them. A named example is a requirement; a generator that happens to reach it
today may not tomorrow.

Keep the generator deterministic, seeded from a fixed value, so a failure
reproduces. A failing generated case is a finding, not flakiness: pin that
exact input as a permanent regression case, then fix the code.

## Flaky Tests

Treat a flaky test as a bug in the test suite or product, not as a reason to
skip coverage. Do not skip, quarantine, xfail, delete, or loosen the test until
it no longer proves behaviour.

You may reimplement a flaky test to make it deterministic when the replacement
preserves the spirit of what the original test was trying to prove. Prefer
stable user-visible boundaries and remove nondeterminism by controlling clocks,
randomness, ordering, external services, async waits, or fixture setup.

## Cleanup and Removal

If a user asks to remove obsolete implementation or get rid of a previously
implemented feature, first identify the desired behaviour after the change.

- If supported behaviour changes, write a failing test for the new desired
  behaviour.
- If supported behaviour does not change, do not invent a new test that asserts
  old artifacts are gone. State why no new test is appropriate, then run the
  existing behavioural tests and quality gates.

## Review Rule

Reject tests that pass by coupling to implementation details, hardcoded
results, stubs that bypass the behaviour under test, or assertions that only
prove old artifacts are absent. Accept a cleanup/removal with no new test only
when the implementor explicitly justifies that no supported behaviour changed
and the existing behavioural tests and quality gates pass. Reject flaky-test
changes that merely skip, quarantine, delete, or weaken the check instead of
preserving its behavioural intent. Reject generated-input tests whose
assertion re-implements the code under test, and reject a generated failure
that is silenced or re-seeded away instead of pinned as a regression case.
