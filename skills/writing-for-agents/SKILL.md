---
name: writing-for-agents
description: Standards for documents agents read and act on - skill files, subagent briefings, AGENTS.md/CLAUDE.md, and repo docs a skill points at. Use when creating or editing a skill, wording a subagent briefing, or auditing agent-facing prose for bloat, duplication, weak triggers, or vague completion criteria.
---

# Writing For Agents Skill

Every line an agent reads costs attention. This skill covers documents an
agent reads and acts on: skill files, subagent briefings, `AGENTS.md` and
`CLAUDE.md`, and repo docs a skill points at.

Sentence-level tells in any markdown this repo writes are **unslop**'s job.
This skill owns structure, triggers, and completion criteria. Both apply to a
document an agent acts on.

For skill creation or edits, read
[frontmatter rules](references/skill-frontmatter.md).

## Core Rule

A line earns its place by changing behaviour. An instruction the agent already
follows by default costs tokens and says nothing.

## The Two Costs

- **Context cost** is paid on every turn by always-loaded text: a skill
  `description`, an `AGENTS.md` line, anything in the window whether or not it
  fires.
- **Human cost** is paid by the person who has to remember which document
  exists and when to reach for it. Spend it where human judgement matters.

Text reached only through a pointer escapes context cost at the price of the
pointer's own line.

## Pointers

A **pointer** is a reference held in context that names material outside it
and encodes when to reach it. A skill's `description` is one. So is a
briefing's list of skill names and paths, and a `Read <path>` line inside a
procedure.

The pointer's wording, not its target, decides when the material is reached.
Material that must be read, sitting behind a vague pointer, is a variance bug:
the agent reaches it on some runs and not others. Sharpen the wording first.
Inline the material only when sharpening fails.

- Lead with the trigger words. A pointer does its work in its first clause.
- One trigger per branch. Synonyms for one case are that case written twice.
- Cut identity the target already carries.
- An explicit path in a briefing is the strongest pointer available. Prefer it
  over hoping a description matches.

## Information Hierarchy

Rank content by how immediately the agent needs it:

1. **Steps** - what the agent does, in order. The primary tier.
2. **In-file reference** - definitions, rules, and checklists consulted on
   demand. A flat set of peer rules is a fine shape, not a smell.
3. **Another skill** - reference that several skills need, extracted once and
   reached by name and path. **agent-conduct**,
   **implementation-principles**, **testing-principles**, and **subagents**
   exist for this reason.

Inline what every path through the document needs. Extract what only some
paths reach. Bury steps under reference and attending to them becomes a coin
flip.

**Sprawl** is the failure mode: a document too long even when every line is
live. Attention thins across the excess. The cure is extraction, or splitting
by branch.

**Co-location** is the companion move. Keep a rule, its exception, and its
example under one heading. Scattering one meaning across a document costs more
than stating it once in an imperfect place.

## Completion Criteria

Every step ends on a condition that tells the agent it is done. Two properties
make that condition a lever:

- **Checkable.** Can the agent tell done from not-done? "Understanding
  reached" invites stopping early. "Every acceptance test in spec.md section C
  has a failing test" does not.
- **Demanding.** How much does it require? "Every modified package's tests
  pass" forces more work than "run the tests", and the extra work is where the
  value is.

Prefer criteria that are both checkable and exhaustive.

## Prompt The Positive

Steering by prohibition makes the forbidden behaviour more available, not
less. State the target behaviour so the wrong one is never named. "Write the
failing test first" beats "do not write the implementation first".

Keep a prohibition only as a hard guardrail you cannot phrase positively, such
as the git and workspace rules in **agent-conduct**. Pair it with the positive
target so attention lands on what to do.

## Leading Words

A **leading word** is a compact term the model already holds, repeated as a
token until it anchors a whole region of behaviour. This repo already uses
several: a **red** loop, a **blocker**, a **quality gate**, **clean context**,
a **verdict**. Reuse them instead of paraphrasing.

Coining a term costs the tokens needed to define it and recruits nothing from
the model's priors, so reach for the existing word first. Use one name per
thing across every skill. Three names for one concept teach three things.

## Pruning

- **One source of truth.** Say each thing once, in one skill, and point at it.
  Duplication drifts, and it inflates a rule's apparent rank.
- **The environment is a source of truth.** `Makefile` targets, package
  scripts, `--help` output, and the directory layout can be looked up. Text
  that restates them goes stale. Write down only what the agent cannot find by
  looking: the unwritten convention, the reason behind a choice, the gotcha.
- **Relevance.** Does the line still bear on what the document does? Stale
  layers accumulate because adding feels safe and removing feels risky.
- **No-ops.** Sentence by sentence, does it change behaviour versus the
  agent's default? If not, delete the whole sentence rather than trimming
  words from it.

## Writing Subagent Briefings

A briefing is agent-facing prose with a lifetime of one task. **subagents**
owns what goes in it; this section covers how to word it.

- The subagent has clean context and one job, so it needs no trigger words.
  State the task directly.
- Pass skill names and absolute paths. That is the strongest pointer
  available. Never paste skill text (see **subagents**).
- Leave a skill's rules in the skill. The subagent reads both, and a restated
  copy drifts from the original.
- Make the completion criterion checkable and name the return contract
  exactly: "return PASS or FAIL with file:line feedback", not "review it".
- State the demand. "Run the project's lint and test commands; both must
  pass" outperforms "check quality".
- Give the caller's constraints and nothing else. Context the subagent cannot
  act on is load without effect.
- Prompt the positive here too. Keep only the guardrails that must not be
  crossed, such as "do not push".

## Review Checklist

Apply when creating or editing any document in this repo:

1. Does every line change behaviour versus the agent's default?
2. Is anything said twice, here or in a skill this one points at?
3. Does each pointer lead with its trigger and name one trigger per branch?
4. Is each step's completion criterion checkable and demanding?
5. Are prohibitions limited to hard guardrails, each paired with a positive
   target?
6. Does each thing have one name, here and across the other skills?
7. Does the document restate anything the environment already answers?
