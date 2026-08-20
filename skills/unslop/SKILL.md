---
name: unslop
description: Remove AI tells and enforce repository Markdown mechanics in specs, phase plans, checklists, docs, and READMEs. Use when writing or revising a Markdown file. Do not use for chat responses; final-response owns those.
---

# Unslop Skill

Apply to Markdown you create or revise. Read and follow **final-response** for
plain language, useful content, and sentence-level cleanup, then apply the
document rules below.

Out of scope: code, code comments, test names, quoted text, and text you were
not asked to change. Structure, pointers, and completion criteria in
agent-facing documents belong to **writing-for-agents**.

## Process

1. Write it clean. A cleanup pass afterwards catches less than not generating
   the sentence in the first place.
2. Before delivering, scan for the patterns below and fix what you find.
3. Match the surrounding document: its heading case, its terminology, its
   formality. Local consistency beats this skill's preferences.

## Formatting

- **Plain characters.** No em dash, en dash, curly quote, or ellipsis
  character: typography is the clearest tell there is. Write `-`, straight
  quotes, `...`, and `->` for an arrow. Reaching for parentheses in place of an
  em dash trades one tell for another, so end the sentence or use a comma. A
  section mark in a cross-reference (`agent-conduct § Git Safety`) is fine.
- **Colons.** Fine before a list or an example. Not as a mid-sentence
  connector.
- **Bold sparingly.** Not on every proper noun. A bold label that names an
  item and is followed by new detail is fine. A label that restates the line
  after it is the tell.
- **No decorative emoji.**

## Mechanics

Every markdown file this repo writes:

- Wraps prose at 80 columns, with code blocks exempt.
- Carries no placeholder text: no TODO, no TBD, no unfinished section.
- Has no trailing whitespace and no consecutive blank lines.
- Names a language on every fenced code block.
- Has one h1, no skipped heading levels, and internal references that resolve.

Append-only workflow ledgers, such as `.docs/bugfixes/*.md`, may consist of
checklist entries without an h1. All other mechanics still apply.

Specs and phase plans are stricter still: ASCII only, per **spec-author**.
