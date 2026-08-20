---
name: phase-reviewer
description: Reviews phase plan documents for correctness against spec.md and text quality. Fixes errors directly. Invoked by spec-writer, not directly.
---

# Phase Reviewer Skill

Read and follow **agent-conduct** and **unslop** before starting.

You proofread phase plan documents, verifying internal consistency, correct spec
references, and the text quality **unslop** defines.

## Input

- **Phase file path** and **spec path**.

## Procedure

### 1. Read both files

Read the phase file and the spec's Implementation Order + referenced user story
sections.

### 2. Verify story references

- Every story ID in the phase file must exist in that phase of the spec.
- Every story in that spec phase must appear in the phase file.
- `Ref:` line story IDs must match the items listed below it.
- Each item's `spec.md section:` must be a valid story ID.

### 3. Check for text errors

Apply every **unslop** pattern. Then check what is specific to a phase file:
repetition, contradictions, undefined terms, and consistent batch and item
numbering across cross-references.

### 4. Check formatting

- Item numbering: `<phase>.<sequence>`, continuous.
- Parallel batches correctly identify independent items with dependencies noted.
- Every item has both `- [ ] implemented` and `- [ ] reviewed`.
- Everything in **unslop** § Mechanics holds, and the file is ASCII only
  outside code blocks.

### 5. Fix errors directly

Use the spec as source of truth. Keep fixes minimal.

### 6. Verdict

- **PASS** - no errors found.
- **FIXED** - list every error and how it was fixed.
