# Agent Skills

This repository contains [agentskills.io](https://agentskills.io/) skills for
AI coding agents. The skills provide structured workflows for specification
writing, TDD implementation, code review, test-suite verification, PR review,
PR comment resolution, and bug fixing across Go, Nextflow, Next.js + FastAPI,
and Python projects.

## Quick Start

Clone to `~/.agents` so compatible tools discover them automatically:

```bash
git clone https://github.com/wtsi-hgi/agentskills.git ~/.agents
```

Then ask your AI agent to use the **spec-writer**, **orchestrator**, or
**pr-reviewer** skills. See the [skills documentation](docs/skills.md) for the
full inventory and usage guide.

### Claude Code

Claude Code does **not** look in `~/.agents/skills`; it discovers personal
skills only under `~/.claude/skills/`. The simplest bridge is a one-time symlink
so every skill in this repo, including any added later, shows up automatically:

```bash
ln -s ~/.agents/skills ~/.claude/skills
```

If `~/.claude/skills/` already exists with skills of your own, symlink the
individual skills instead so you keep both:

```bash
mkdir -p ~/.claude/skills
for d in ~/.agents/skills/*/; do
  ln -s "$d" ~/.claude/skills/"$(basename "$d")"
done
```

Start a new Claude Code session and the skills are available. Skills update in
place because they are symlinked, so a `git pull` in `~/.agents` is all it takes
to get the latest versions.

### Every Chat Message

A skill applies only once the agent loads it, so an agent can skip
**final-response** on some turns. To apply it to every message, including
progress updates on long tasks, add this line to your global instructions:
`~/.claude/CLAUDE.md` for Claude Code, `~/.codex/AGENTS.md` for Codex.

```markdown
- Before sending any chat message, including progress updates, read and follow `~/.agents/skills/final-response/SKILL.md`. End every message with a `**Your next action:**` line that restates any open blocker.
```

Every message then ends with what the user must do next, so a pending blocker
never hides in the scrollback.

## Documentation

See [docs/skills.md](docs/skills.md) for the full skill inventory, setup notes,
and guidance for adding new tech stacks.

## Repository Layout

```text
skills/<name>/SKILL.md            agentskills.io skill definition
skills/<name>/agents/openai.yaml  Codex interface descriptor
skills/<name>/references/         detail linked from SKILL.md, loaded on demand
docs/skills.md                    skill inventory and usage guide
```

## License

See [LICENSE](LICENSE) for details.
