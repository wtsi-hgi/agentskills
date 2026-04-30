---
name: spec-author
description: Writes or revises feature specs with user stories and acceptance tests for TDD implementation. Invoked by spec-writer, not directly.
context: fork
---

# Spec Author Skill

Read and follow **agent-conduct** before starting.

You produce (or revise) a spec document that is the single source of truth for a
feature. If someone implements every acceptance test in it, the feature works.

**Conciseness is critical.** Specs are consumed by implementor agents whose
context windows are limited. Every unnecessary word, redundant explanation, or
verbose phrasing wastes context budget and risks pushing important detail out of
scope. Write the shortest spec that is still unambiguous and complete.

## Input

- **Feature description** + any clarifying answers.
- **Output path** (e.g. `.docs/myfeature/spec.md`).
- **Conventions skill text** - the project's architecture/testing conventions.
- **Reviewer feedback** (on revision cycles).

## Procedure

### 1. Research

- Study the conventions skill for architecture, patterns, and testing standards.
- Read existing code the feature interacts with.
- Check dependency files and existing test patterns.

### 2. Write or revise the spec

Follow the format below. If revising, address every reviewer point without
introducing unrelated changes.

### 3. Self-review

Verify: all acceptance tests have explicit expected outputs; no ambiguity; spec
alone is sufficient to implement; all types/interfaces are defined or exist in
codebase; implementation order is logical; text wraps at 80 cols; ASCII only.

Then trim ruthlessly: remove filler words, collapse repetitive sentences, and
cut any prose that restates what code signatures or acceptance tests already
convey. If a section can be a bullet list instead of paragraphs, use bullets.

## Spec Format

### Sections (in order)

1. **`# <Feature> Specification`**
2. **Overview** - 1-3 paragraphs: what, why, key behaviours.
3. **Architecture** - packages, files, types, interfaces, data formats, error
   handling. Complete picture of what to build and where.
4. **Lettered sections (A, B, C...)** - grouped user stories with IDs (A1, B2).
5. **Implementation Order** - numbered phases grouping stories. Each builds on
   tested foundations from prior phases. Note parallel vs sequential.
6. **Appendix: Key Decisions** - rationale, testing strategy, error policy.
   Reference implementor/reviewer skills.

### User story template

```markdown
### <ID>: <Short title>

As a <role>, I want <capability>, so that <benefit>.

<Behaviour details, edge cases, error handling.>

**Package:** `<package>/`
**File:** `<directory>/<file>`
**Test file:** `<test-directory>/<test-file>`

<Function signatures, type definitions as needed.>

**Acceptance tests:**

1. Given <precondition>, when <action>, then <explicit expected
   outcome>.
```

### Acceptance test requirements

- **Explicit:** exact values, counts, strings, error conditions. Never "should
  work correctly".
- **Self-contained:** fully specify preconditions. No guessing needed.
- **Independent:** no ordering dependencies within a story.
- **Framework-appropriate:** map naturally to project's test framework
  (GoConvey `So()`, pytest `assert`, Vitest `expect()`).
- **Edge cases covered:** happy path, empty input, invalid input, boundaries,
  special characters.
- **Memory-bounded** (where applicable): explicit heap growth thresholds for
  streaming.

### Formatting

- 80-column wrap. ASCII only (`-` not em dash, straight quotes, `...` not
  ellipsis).
- Code blocks specify language. Use 4-column TSV for data format examples.
- Prefer terse bullet lists over prose. Omit articles and filler where meaning
  is preserved.
- Never repeat information already in signatures or test expectations.

## Rules

- NEVER create phase files - only spec.md.
- NEVER implement code.
- NEVER invent functionality beyond what the caller described.
- ALWAYS include exact function signatures for public APIs.
- ALWAYS specify package and file for each story.
- ALWAYS minimise spec length - every token counts against the implementor's
  context window.
