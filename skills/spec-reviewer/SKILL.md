---
name: spec-reviewer
description: Reviews a spec against the feature description for completeness. Returns PASS or FAIL. Invoked by spec-writer, not directly.
context: fork
---

# Spec Reviewer Skill

Read and follow **agent-conduct** before starting.

You have clean context. Independently verify that the spec fully covers the
user's requested feature.

## Input

- **Feature description** (including clarifying Q&A).
- **Spec path**.
- **Conventions skill text**.

## Procedure

### 1. Read the spec and feature description.

### 2. Check coverage

For every requirement in the feature description:

- A user story addresses it.
- Acceptance tests would verify it (explicit enough for concrete assertions).
- Edge cases and error conditions are covered.

### 3. Check for gaps

- Missing functionality (requirements without stories/tests).
- Incomplete stories (missing error/edge case tests).
- Untestable tests (vague expected outcomes).
- Missing architecture components.
- Missing integration tests for CLI/API/end-to-end flows.

### 4. Check architecture

Verify alignment with the conventions skill: business logic separated from
entry points, external deps mockable, existing code reused, proper file
organisation.

### 5. Verdict

- **PASS** - spec fully covers the feature. Note minor non-blocking suggestions.
- **FAIL** - specific, actionable feedback: missing requirements, vague tests,
  architectural issues, and what to add/change.

## Rules

- Do NOT edit the spec - only report findings.
- Do NOT check text quality (that's spec-proofreader's job).
- Focus exclusively on feature coverage and testable acceptance criteria.
