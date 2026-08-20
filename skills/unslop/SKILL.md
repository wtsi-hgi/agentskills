---
name: unslop
description: Remove AI tells from markdown this repo writes (specs, phase plans, checklists, docs, READMEs) and from the closing summary given to the user in chat. Use when writing or revising a markdown document, and before delivering a turn's final report.
---

# Unslop Skill

Cut the patterns that mark text as machine-written. Applies to markdown you
create or revise, and to the closing summary you give the user in chat.

Out of scope: code, code comments, test names, quoted text, and text you were
not asked to change. Structure, pointers, and completion criteria in
agent-facing documents belong to **writing-for-agents**. This skill owns
sentence-level tells in both.

## Process

1. Write it clean. A cleanup pass afterwards catches less than not generating
   the sentence in the first place.
2. Before delivering, scan for the patterns below and fix what you find.
3. Match the surrounding document: its heading case, its terminology, its
   formality. Local consistency beats this skill's preferences.

## Content

- **Puffery.** "pivotal moment", "testament to", "evolving landscape",
  "setting the stage for". State what happened.
- **Vague attribution.** "experts believe", "studies suggest". Name the source
  or cut the claim.
- **Superficial -ing clauses.** "...highlighting the need for", "...ensuring
  reliability". Delete, or name the concrete consequence.
- **Formulaic contrast.** "not just X, but Y". "Despite challenges, X
  continues to thrive." State the point directly.
- **Generic conclusions.** "The future looks bright." Give the next action, or
  cut the paragraph.
- **Feelings instead of facts.** "types that follow your schema" names a
  feeling. "A column rename fails the build" names the mechanism. A sentence
  that would read the same in another project's document says nothing about
  this one.

## Language

- **AI vocabulary.** additionally, crucial, delve, enhance, foster, garner,
  interplay, intricate, landscape, leverage, pivotal, robust, seamless,
  showcase, tapestry, testament, underscore, utilize. Use the plain word:
  "use", not "utilize"; "help", not "facilitate".
- **Fancy ways to say "is".** "serves as", "stands as", "boasts",
  "features". Write "is" or "has".
- **Filler.** "in order to" is "to". "due to the fact that" is "because". "it
  is important to note that" is nothing.
- **Hedge stacks.** "could potentially possibly" is "may".
- **Abstract metaphor nouns.** substrate, wedge, vector, nexus, bedrock,
  flywheel, north star, endgame, gold-plating, plus "ratchet",
  "scaffolding", and "surface" used as metaphors. Pick the concrete word:
  "base", "add", "way", "the last phase". A word used literally is fine; the
  agent harness in this repo is a real thing, not a metaphor.
- **Synonym cycling.** One name per thing, repeated. Three names teach three
  things.
- **Forced counts.** Use the natural number of items, not three. Drop "from X
  to Y" when X and Y are not on one scale; list them instead.

## Sentences

- **Active voice.** "the compiler validates queries", not "queries are
  validated". Passive is fine when the actor is unknown or beside the point.
- **One idea per sentence.** If the reader has to backtrack to parse it, split
  it.
- **Cut the adverb or use a stronger verb.** "significantly improves" is the
  measured number.

## Formatting

- **No em dashes.** Use a period or a comma. Reaching for parentheses instead
  trades one tell for another. ASCII only: straight quotes, `-`, `...`.
- **Colons.** Fine before a list or an example. Not as a mid-sentence
  connector.
- **Bold sparingly.** Not on every proper noun. A bold label that names an
  item and is followed by new detail is fine. A label that restates the line
  after it is the tell.
- **No decorative emoji.**

## Chat Summaries

The closing summary is the only part of a run most users read.

- No preamble and no sign-off. "I hope this helps", "Let me know if", "Great
  question", "You're absolutely right" all go.
- Lead with what changed or what was found, not with what you were asked.
- Name the evidence: paths, commands run, commit SHAs, verdicts.
- Say what is still open, and what you did not do.
- Claim no success without the check that proves it.
