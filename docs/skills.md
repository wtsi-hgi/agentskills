# Agent Skills

A collection of [agentskills.io](https://agentskills.io/) skills for AI coding
agents. These skills provide structured workflows for specification writing, TDD
implementation, code review, and PR review across multiple tech stacks.

## Compatibility

The [agentskills.io](https://agentskills.io/) format is supported by a growing
number of AI coding tools:

- **VS Code** with GitHub Copilot (agent mode)
- **Claude Code** (Anthropic CLI)
- **Cursor**
- **Windsurf**

The examples below use VS Code, but the concepts apply to any supported tool.
Check your tool's documentation for details on skill discovery paths and
configuration.

## Setup

Clone this repository to `~/.agents`:

```bash
git clone https://github.com/wtsi-hgi/agentskills.git ~/.agents
```

Tools that support agentskills.io automatically discover skills in
`~/.agents/skills/`. For example, VS Code with GitHub Copilot picks them up
immediately across all workspaces.

### Per-project overrides

Projects can also have their own skills in `.github/skills/`. Any project-level
skills supplement or override the global ones from `~/.agents/skills/`. This is
useful for project-specific conventions that don't belong in the shared set.

## Skill Inventory

### Shared Building Blocks

These skills are tech-stack-agnostic and used across all projects:

| Skill | Purpose |
|---|---|
| **agent-conduct** | Universal safety rules: workspace boundaries, scratch work, terminal safety, git safety. Referenced by every other skill. |
| **bugfix** | Orchestrates bug fixes via implementor and reviewer subagents using TDD. Handles one or many bugs sequentially with human verification between each. |
| **frontend-design** | Guidelines for creating distinctive, production-grade frontend interfaces with high design quality. |
| **orchestrator** | Coordinates implementation and review of phase plans by launching implementor and reviewer subagents. |
| **pr-reviewer** | Reviews PR diffs for code quality, subtle bugs, real-world usability, and optionally spec conformance. Fixes issues via implementor subagents. |
| **spec-writer** | Orchestrates creation and review of feature specifications by coordinating spec-author, spec-reviewer, and spec-proofreader subagents. |
| **spec-author** | Writes or revises a feature specification with user stories and acceptance tests. |
| **spec-reviewer** | Reviews a specification against the feature description for completeness. |
| **spec-proofreader** | Reviews a specification for text quality issues (repetition, contradictions, formatting). |
| **phase-creator** | Creates phase plan documents from a spec's Implementation Order. |
| **phase-reviewer** | Reviews phase plan documents for correctness and consistency. |

### Go

Skills for Go projects using GoConvey testing:

| Skill | Purpose |
|---|---|
| **go-conventions** | Code quality standards, GoConvey testing patterns, copyright boilerplate, architecture principles, and tool commands for Go projects. |
| **go-implementor** | TDD implementation cycle for Go code. References go-conventions. |
| **go-reviewer** | Review checklist for Go implementations against spec acceptance tests. References go-conventions. |

### Next.js + FastAPI

Skills for full-stack projects with Next.js 16 (App Router) + FastAPI:

| Skill | Purpose |
|---|---|
| **nextjs-fastapi-conventions** | Architecture principles (BFF pattern, Zod contracts), code quality for Python and TypeScript, testing standards, and commands. |
| **nextjs-fastapi-implementor** | TDD implementation cycle for full-stack features (pytest + Vitest). References nextjs-fastapi-conventions. |
| **nextjs-fastapi-reviewer** | Review checklist for full-stack implementations including BFF and contract integrity. References nextjs-fastapi-conventions. |

### Python

Skills for Python 3.14 projects:

| Skill | Purpose |
|---|---|
| **python-conventions** | Project layout, typing, linting, testing, and commands for modern Python projects. |
| **python-implementor** | TDD implementation cycle for Python code. References python-conventions. |
| **python-reviewer** | Review checklist for Python implementations against spec acceptance tests. References python-conventions. |

## How It Works

The skills form a layered system:

1. **agent-conduct** provides universal safety rules that all other skills
   reference.
2. **Conventions skills** (`go-conventions`, `python-conventions`,
   `nextjs-fastapi-conventions`) define tech-stack-specific standards, acting as
   a single source of truth for code quality, testing patterns, and commands.
3. **Implementor/reviewer skills** provide the TDD cycle and review checklists,
   referencing their conventions skill to avoid duplicating rules.
4. **Workflow skills** (`orchestrator`, `pr-reviewer`, `spec-writer`, etc.)
   coordinate multi-step processes by launching subagents with the appropriate
   tech-stack skills.

The workflow skills are generic — they discover which
implementor/reviewer/conventions skills to use based on the project context.
This means the same orchestrator can drive a Go project, a Python project, or a
Next.js+FastAPI project without modification.

### Typical workflow

1. **spec-writer** takes a feature description and produces a detailed spec with
   acceptance tests, then creates phase plan documents.
2. **orchestrator** processes each phase: launches implementor subagents for TDD
   implementation, then reviewer subagents for verification.
3. **pr-reviewer** performs a final holistic review of all changes, fixing
   issues via implementor subagents.

### Skills used by Copilot Conductor

The [Copilot Conductor extension](extension-guide.md) automates the orchestrator
and pr-reviewer workflow with a deterministic state machine. It uses skills
differently from the manual workflow:

| Skill category | Manual workflow | Conductor |
|---|---|---|
| Conventions (`*-conventions`) | Loaded by agents | Loaded by extension |
| Implementor/reviewer (`*-implementor`, `*-reviewer`) | Loaded by agents | Loaded by extension |
| Orchestrator, pr-reviewer | Agent reads and follows | Replaced by extension code |
| Spec-writer | Agent reads and follows | Used manually before starting Conductor |
| Agent-conduct | Referenced by all agents | Enforced by extension's bash security |

## Adding New Tech Stacks

To add support for a new tech stack (e.g. Rust, Django):

1. Create a `<stack>-conventions` skill with code quality standards, testing
   patterns, architecture principles, and commands.
2. Create a `<stack>-implementor` skill with the TDD cycle, referencing your
   conventions skill and agent-conduct.
3. Create a `<stack>-reviewer` skill with the review checklist, referencing your
   conventions skill and agent-conduct.

The generic workflow skills (orchestrator, pr-reviewer, spec-writer, etc.) and
the Conductor extension will automatically work with the new stack.
