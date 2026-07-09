---
name: testing-principles
description: Shared guidance for behaviour-focused tests in TDD, regression fixes, acceptance-test implementation, flaky test fixes, and test review. Use when writing, updating, stabilizing, or reviewing tests, or briefing another agent about tests, especially when deciding whether a cleanup/removal request needs a new test.
---

# Testing Principles

## Core Rule

Use tests to declare desired behaviour and prove the system has that
behaviour. Prefer supported boundaries: public APIs, CLI output, HTTP
contracts, rendered UI, persisted state, emitted files, errors, or other
effects visible to users, callers, or downstream steps.

## Avoid

Do not write tests whose only claim is an implementation detail: private
helpers, source layout, filenames, imports, CSS classes, deleted files,
removed functions, removed routes, removed modules/processes, or the mere
absence of an old feature.

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
preserving its behavioural intent.
