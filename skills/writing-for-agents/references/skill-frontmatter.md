# Skill Frontmatter

Use this check whenever creating or editing `SKILL.md`.

## Write

Treat the opening block as YAML, not Markdown prose. Keep the description
concise and put its trigger in the first clause: a crowded skill listing gets
shortened to fit a character budget, and the text that goes first is the text
that survives.

Use a plain scalar only when it has no YAML-significant punctuation. Quote a
short description otherwise. To wrap a longer one while retaining one string,
use a folded scalar:

```yaml
description: >-
  Describe what the skill does and when to use it.
```

Never leave `: ` or ` #` inside a plain scalar. The first invalidates the YAML,
and the second starts a comment.

Angle brackets are legal but inert. Claude Code escapes them in text that
reaches the model, so the description cannot imitate the harness's own
formatting. Write plain words rather than depending on markup.

## Validate

Run the available skill validator after changing a skill. If none exists,
parse the opening block with any installed YAML parser and check:

- It is a mapping whose keys are drawn from `name`, `description`, `license`,
  `compatibility`, `metadata`, and `allowed-tools`. Any other key fails
  packaging and upload with a hard error; `docs/skills.md` under Skill File
  Conventions quotes the message.
- `name` and `description` each occur once as non-empty strings.
- `name` matches the skill directory, is at most 64 characters, uses lowercase
  letters, digits, and single hyphens, and has no edge hyphen.
- `description` is at most 1024 characters.

If no YAML parser is available, use a quoted or folded description, check both
`---` delimiters and indentation, and report that parser validation was
unavailable.

## Sources

- Frontmatter fields, the escaping of angle brackets, and the skill listing
  budget: https://code.claude.com/docs/en/skills
- The six spec-allowed keys and the per-field constraints:
  https://agentskills.io/specification
