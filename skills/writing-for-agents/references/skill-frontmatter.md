# Skill Frontmatter

Use this check whenever creating or editing `SKILL.md`.

## Portable Profile

This repository uses a subset of the Codex, Claude Code, and Agent Skills
formats. It is deliberately narrower than any one format so the same skill
passes their validators and presents the same name and description to each
harness.

Write exactly this shape:

```yaml
---
name: skill-name
description: "State what the skill does. Use when its trigger applies."
---
```

- Use only `name` and `description`. Put Codex interface and invocation policy
  in `agents/openai.yaml`. Express orchestration in the body rather than with
  Claude-only frontmatter.
- Make `name` match the directory. Limit it to 64 lowercase ASCII letters,
  digits, and single hyphens, with no hyphen at either edge.
- Write `description` as one non-empty, double-quoted physical line of at most
  1024 characters. Escape a literal `"` or `\` using YAML double-quoted scalar
  syntax.
- Put the action and trigger first. Keep the description concise because
  Codex may shorten descriptions when the skill list reaches its context
  budget.
- Use plain text without angle brackets. Codex's bundled validator rejects
  them, and Claude Code escapes them in synced skill descriptions.

## Validate

Run every available skill validator after changing a skill. A skill that uses
this profile should not need a validator-specific exception.

If an agent has no validator, parse the opening block with an installed YAML
parser and check every Portable Profile rule. If it also has no YAML parser,
check the two `---` delimiters, the two keys, the quoted one-line description,
and the name constraints by inspection. Report that parser validation was
unavailable.

## Sources

- OpenAI documents `name` and `description` as required, recommends concise
  front-loaded descriptions, and puts Codex policy in `agents/openai.yaml`:
  https://learn.chatgpt.com/docs/build-skills
- Claude Code documents the same base fields, its optional extensions, and
  angle-bracket escaping for synced skill descriptions:
  https://code.claude.com/docs/en/skills
- The Agent Skills specification defines the common format and field limits:
  https://agentskills.io/specification
