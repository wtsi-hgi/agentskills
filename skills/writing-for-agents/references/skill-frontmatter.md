# Skill Frontmatter

Use this check whenever creating or editing `SKILL.md`.

## Portable Profile

This repository uses a subset of the Codex, Claude Code, and Agent Skills
formats. It is deliberately narrower than any one of them, so the same skill
passes every validator and presents the same name and description to each
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
- Put the action and trigger first. Keep the description concise, because a
  host may shorten descriptions when the skill list reaches its context
  budget, and what comes first is what survives.
- Use plain text without angle brackets. This is a house rule: no documented
  format forbids them, but Claude Code escapes them so they cannot carry
  markup anyway, and a description never needs any.

## Validate

Validate after every change to a skill. Take the first of these that the
environment offers.

1. **A validator the harness ships.** Any agent that packages or uploads
   skills validates on the way in, so run its checker rather than guessing at
   its rules. The Agent Skills reference library validates locally with
   `skills-ref validate skills/<name>`.
2. **A YAML parser.** Load the opening block in any language and check every
   Portable Profile rule against the parsed mapping. This is the portable
   fallback and it catches everything above except harness-specific limits.
3. **Inspection**, when neither is available. Check the two `---` delimiters,
   the two keys, one double-quoted physical line for `description`, and the
   `name` constraints. Report that parser validation was unavailable.

An unsupported key is a hard error rather than an ignored field when a skill
is packaged or uploaded:

```text
Unexpected key(s) in SKILL.md frontmatter: argument-hint. Allowed properties
are: allowed-tools, compatibility, description, license, metadata, name
```

The Portable Profile is narrower than that list on purpose. `license`,
`compatibility`, `metadata`, and `allowed-tools` are legal and simply unused
here, so a skill that needs one is making a deliberate exception rather than
breaking a format rule.

## Sources

- OpenAI documents `name` and `description` as required, recommends concise
  front-loaded descriptions because Codex shortens them first when the list
  grows, and puts Codex interface and invocation policy in
  `agents/openai.yaml`: https://learn.chatgpt.com/docs/build-skills
- Claude Code documents the same base fields, its own optional extensions, the
  unsupported-key error above, and angle-bracket escaping in descriptions that
  reach the model: https://code.claude.com/docs/en/skills
- The Agent Skills specification defines the common format, the six allowed
  keys, and the per-field limits: https://agentskills.io/specification
