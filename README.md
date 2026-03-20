# Agent Skills & Copilot Conductor

This repository contains two related but distinct things:

1. **Agent Skills** — a collection of
   [agentskills.io](https://agentskills.io/) skills that teach AI coding agents
   how to write specs, implement code with TDD, review changes, and fix bugs
   across multiple tech stacks.

2. **Copilot Conductor** — a VS Code extension that automates the
   implement → test → lint → review → PR review cycle by driving those skills
   with a deterministic state machine, replacing manual prompt-based
   orchestration. It also handles bugfix workflows, branch safety checks,
   per-phase git commits, and crash recovery.

You can use the skills without the extension (they work with any agentskills.io
compatible tool), and you can use the extension to automate the skills instead
of invoking them manually.

## Quick Start

### Skills only

Clone to `~/.agents` so compatible tools discover them automatically:

```bash
git clone https://github.com/wtsi-hgi/agentskills.git ~/.agents
```

Then ask your AI agent to use the **spec-writer**, **orchestrator**, or
**pr-reviewer** skills. See the [skills documentation](docs/skills.md) for the
full inventory and usage guide.

### Copilot Conductor extension

Install the `.vsix` in VS Code and run **Conductor: Start** — type your feature
description inline or point it at an existing `spec.md` + phase files. Conductor
auto-detects your conventions skill, extracts test/lint commands, and stores
everything per feature in `.conductor/state.json`. Use **Conductor: Fix Bugs**
for targeted bugfix workflows. See the
[extension guide](docs/extension-guide.md) for setup and usage.

## Documentation

| Document | Audience | Content |
|---|---|---|
| [Skills Reference](docs/skills.md) | All users | Skill inventory, setup, how the layered system works, adding new tech stacks. |
| [Extension Guide](docs/extension-guide.md) | End users | What Conductor does, why to use it, configuration, commands, monitoring. |
| [Extension Development](docs/extension-development.md) | Developers | Building, testing, running locally, packaging, and publishing the extension. |

## Repository Layout

```text
skills/                  agentskills.io skill definitions (SKILL.md per skill)
src/                     Copilot Conductor extension source (TypeScript)
docs/                    documentation
media/                   extension icons
.docs/conductor/         extension specification and phase plans
```

## License

See [LICENSE](LICENSE) for details.
