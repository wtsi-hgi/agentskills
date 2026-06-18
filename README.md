# Agent Skills

This repository contains [agentskills.io](https://agentskills.io/) skills for
AI coding agents. The skills provide structured workflows for specification
writing, TDD implementation, code review, PR review, PR comment resolution, and
bug fixing across Go, Nextflow, Next.js + FastAPI, and Python projects.

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

## Documentation

See [docs/skills.md](docs/skills.md) for the full skill inventory, setup notes,
and guidance for adding new tech stacks.

## Repository Layout

```text
skills/                  agentskills.io skill definitions (SKILL.md per skill)
docs/skills.md           skill inventory and usage guide
```

## License

See [LICENSE](LICENSE) for details.
