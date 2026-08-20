---
name: prose-principles
description: >-
  Sentence-level prose rules: words to replace, filler to cut, and weak
  constructions to fix. Use when writing or reviewing any prose.
---

# Prose Principles

Rules for the sentences themselves, whatever the container. **unslop** applies
these to a Markdown file and adds document mechanics. **final-response**
applies them to a chat turn and adds what a response owes its reader.
**writing-for-agents** covers a different axis: the structure of a document an
agent acts on.

## Core Rule

Name the mechanism, the number, or the action. A sentence that would read the
same in another project's document says nothing about this one: cut it, or
replace it with the concrete fact.

## Words To Replace

- **AI vocabulary.** additionally, comprehensive, crucial, delve, enhance,
  intricate, leverage, robust, seamless, showcase, underscore, utilize. Use
  the plain word: "use", not "utilize"; "help", not "facilitate"; "many", not
  "numerous".
- **Fancy ways to say "is".** "serves as", "stands as", "boasts", "features".
  Write "is" or "has".
- **Filler.** "in order to" is "to". "due to the fact that" is "because". "in
  the event that" is "if". "it is important to note that" is nothing.
- **Hedge stacks.** "could potentially possibly" is "may". Keep one
  calibrated qualifier.
- **Abstract metaphor nouns.** substrate, wedge, vector, nexus, bedrock,
  flywheel, north star, endgame, plus "ratchet", "scaffolding", and "surface"
  used as metaphors. Pick the concrete word: "base", "add", "way", "the last
  phase". A word used literally is fine, so the agent harness in this repo is
  a real thing rather than a metaphor.
- **Puffery.** "pivotal", "testament to", "evolving landscape", "setting the
  stage for", and "production-ready" or "best practice" with no evidence
  behind them. State what happened or what was measured.

## Constructions To Avoid

- **Superficial -ing clauses.** "...highlighting the need for", "...ensuring
  reliability". Delete them, or name the mechanism that follows.
- **Formulaic contrast.** "not just X, but Y". "Despite challenges, X
  continues to thrive." State the point directly.
- **Passive voice with a hidden actor.** "queries are validated" becomes "the
  compiler validates queries". Passive is fine when the actor is unknown or
  beside the point.
- **An adverb propping up a weak verb.** "significantly improves" is the
  measured delta. "runs quickly" is the number.
- **Dense sentences.** One idea per sentence. If the reader has to backtrack
  to parse it, split it.
- **Synonym cycling.** Pick one name for a thing and repeat it. Three names
  teach three things.
- **Forced counts.** Use the natural number of items, not three.

## Check

Read the draft once more. For each sentence, ask whether it names something
concrete, and whether the reader would act differently without it. If neither
holds, cut it.
