# Skill Frontmatter

Use this check whenever creating or editing `SKILL.md`.

Use the smallest common form:

```yaml
---
name: skill-name
description: "State what the skill does. Use when its trigger applies."
---
```

- Use only `name` and `description`. Put harness-specific settings elsewhere,
  such as Codex interface and invocation policy in `agents/openai.yaml`.
  Express orchestration in the skill body.
- Make `name` match the directory. Limit it to 64 lowercase ASCII letters,
  digits, and single hyphens, with no hyphen at either edge.
- Write `description` as one non-empty, double-quoted physical line of at most
  1024 characters. Say what the skill does and when to use it. Put the most
  useful trigger words first.

Compare the raw block with the template, then run the skill validators
available in the environment. If none is available, parse the block as YAML.
If neither a validator nor a parser is available, inspect the delimiters,
keys, name, and description, then report that machine validation was
unavailable.

Format references: [OpenAI](https://learn.chatgpt.com/docs/build-skills),
[Claude Code](https://code.claude.com/docs/en/skills), and [Agent
Skills](https://agentskills.io/specification).
