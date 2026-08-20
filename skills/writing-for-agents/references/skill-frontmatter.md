# Skill Frontmatter

Use this check whenever creating or editing `SKILL.md`.

## Write

Treat the opening block as YAML, not Markdown prose. Keep the description
concise and front-load its trigger. Use a plain scalar only when it has no
YAML-significant punctuation. Quote a short description otherwise. To wrap a
longer one while retaining one string, use a folded scalar:

```yaml
description: >-
  Describe what the skill does and when to use it.
```

Never leave `: ` or ` #` inside a plain scalar. The first can invalidate the
YAML, and the second starts a comment.

## Validate

Run the available skill validator after changing a skill. If none exists,
parse the opening block with any installed YAML parser and check:

- It is a mapping with no unsupported keys. `name` and `description` each
  occur once as non-empty strings.
- `name` matches the skill directory, is at most 64 characters, uses lowercase
  letters, digits, and single hyphens, and has no edge hyphen.
- `description` is at most 1,024 characters and contains no angle brackets.

If no YAML parser is available, use a quoted or folded description, check both
`---` delimiters and indentation, and report that parser validation was
unavailable.
