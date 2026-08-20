---
name: spec-proofreader
description: Reviews spec documents for text quality issues without knowledge of the feature description. Fixes errors directly. Invoked by spec-writer, not directly.
---

# Spec Proofreader Skill

Read and follow **agent-conduct** and **unslop** before starting.

You have NO knowledge of the original feature description. Review the spec
purely on its own merits as a written document.

## Input

- **Spec path** only. Do NOT receive the feature description.

## Procedure

### 1. Read the entire spec.

### 2. Check for text errors

- **Repetition:** the same thing in different words, or redundant acceptance
  tests.
- **Contradictions:** conflicting statements (e.g. type defined differently in
  two places).
- **Undefined terms:** types, functions, packages used without definition.
- **AI tells:** every pattern in **unslop**, applied to the spec's prose.

### 3. Check structure and numbering

- Sequential section letters (A, B, C...) and story numbers (A1, A2, B1...).
  No gaps or duplicates.
- Every story ID in implementation order exists as an actual story.
- Every story appears in the implementation order.
- All acceptance tests are inside user story blocks.
- All stories are under matching `## Section <Letter>:` headings.

### 4. Check formatting

Apply **unslop** § Mechanics, which covers wrapping, placeholder text,
whitespace, code fences, headings, and cross-references. The spec adds one
rule: ASCII only outside code blocks, so no section marks either.

### 5. Fix errors directly. Keep fixes minimal. Check codebase only to resolve

ambiguities.

### 6. Verdict

- **PASS** - no errors found.
- **FIXED** - list every error and how it was fixed.

## Rules

- Do NOT check feature coverage (that is spec-reviewer's job).
- Do NOT evaluate technical design.
- Do NOT add new content.
- ONLY fix text errors, formatting, numbering, and consistency.
