# Agent Skills

A collection of [agentskills.io](https://agentskills.io/) skills for AI coding
agents. These skills provide structured workflows for specification writing, TDD
implementation, code review, PR review, PR comment resolution, and bug fixing
across multiple tech stacks.

## Setup

Clone this repository to `~/.agents`:

```bash
git clone https://github.com/wtsi-hgi/agentskills.git ~/.agents
```

Tools that support agentskills.io automatically discover skills in
`~/.agents/skills/`. Projects can also add their own skills in
`.github/skills/`; project-level skills supplement or override the global ones.

## Skill Inventory

This inventory corresponds to the directories under `skills/`.

### Shared Building Blocks and Workflows

These skills are tech-stack-agnostic and used across all projects:

| Skill | Purpose |
|---|---|
| **agent-conduct** | Mandatory safety rules for all agents. Read before starting any work. |
| **implementation-principles** | Shared cross-language delivery workflow for the simplest sufficient solution, maximum semantic reuse, and avoiding speculative abstractions. |
| **testing-principles** | Shared guidance for behaviour-focused tests, regression coverage, and stable test design. |
| **code-smells** | Named code smell baseline for reviewing changed code. Referenced by pr-reviewer and the per-stack reviewer skills. |
| **writing-for-agents** | Standards for documents agents read and act on: skill files, subagent briefings, AGENTS.md/CLAUDE.md, and docs a skill points at. |
| **unslop** | Removes AI tells from markdown this repo writes and from the closing summary given in chat. Referenced by spec-author, spec-proofreader, and subagents. |
| **subagents** | Shared rules for orchestrating agents that delegate work to subagents. Referenced by orchestrator, bugfix, spec-writer, pr-reviewer, and pr-resolver. |
| **bugfix** | Orchestrates bug fixes via implementor and reviewer subagents using TDD. Reproduces each bug with a red command before fixing it, handles bugs sequentially, tracks them in a dated checklist, and commits each fix. |
| **frontend-design** | Create distinctive, production-grade frontend interfaces that avoid generic AI aesthetics. Use when building web components, pages, dashboards, or styling web UI. |
| **orchestrator** | Orchestrates implementation and review of phase plans via subagents, and drives the real app through the project's verify skill when one exists. Use when given a phase MD file to complete. |
| **verification** | Creates, proves, and maintains a project-local skill that drives the real app the way a user does and captures evidence. Use when a project has no scripted way to prove user-visible behaviour. |
| **pr-reviewer** | Reviews changes on current branch vs base. Checks code quality, bugs, usability, and optionally spec conformance. Fixes issues via implementor subagents. |
| **pr-resolver** | Resolve GitHub PR review comments from humans and Copilot. Use when asked to address PR comments, distinguish required human change requests from questions or suggestions, evaluate invalid or low-value comments, reply and resolve threads, and push only when needed for Copilot re-review. |
| **spec-writer** | Orchestrates spec creation and review via subagents. Use when designing a new feature or writing a spec. |
| **spec-author** | Writes or revises feature specs with user stories and acceptance tests for TDD implementation. Invoked by spec-writer, not directly. |
| **spec-reviewer** | Reviews a spec against the feature description for completeness. Returns PASS or FAIL. Invoked by spec-writer, not directly. |
| **spec-proofreader** | Reviews spec documents for text quality issues without knowledge of the feature description. Fixes errors directly. Invoked by spec-writer, not directly. |
| **phase-creator** | Creates phase plan documents from a spec.md Implementation Order. Invoked by spec-writer, not directly. |
| **phase-reviewer** | Reviews phase plan documents for correctness against spec.md and text quality. Fixes errors directly. Invoked by spec-writer, not directly. |

### Go

Skills for Go projects using GoConvey testing:

| Skill | Purpose |
|---|---|
| **go-conventions** | Shared conventions for Go projects. Copyright boilerplate, code quality, GoConvey testing, architecture, and commands. Referenced by go-implementor, go-reviewer, and workflow skills. |
| **go-implementor** | Go TDD implementation workflow. References shared implementation and testing principles, go-conventions, and agent-conduct. |
| **go-reviewer** | Review Go implementations against spec acceptance tests and shared implementation principles. |

### Nextflow

Skills for Nextflow DSL 2 workflows:

| Skill | Purpose |
|---|---|
| **nextflow-conventions** | Shared conventions for Nextflow DSL 2 workflows. Project layout, modules, nf-test testing, config, containers, and commands. Referenced by nextflow-implementor, nextflow-reviewer, and workflow skills. |
| **nextflow-implementor** | Nextflow DSL 2 TDD implementation workflow. References shared implementation and testing principles, nextflow-conventions, and agent-conduct. |
| **nextflow-reviewer** | Review Nextflow DSL 2 implementations against spec acceptance tests and shared implementation principles. |

### Next.js + FastAPI

Skills for full-stack projects with Next.js 16 and FastAPI:

| Skill | Purpose |
|---|---|
| **nextjs-fastapi-conventions** | Shared conventions for Next.js 16 + FastAPI full-stack projects. Architecture, code quality, testing, styling, and commands. Referenced by nextjs-fastapi-implementor and nextjs-fastapi-reviewer. |
| **nextjs-fastapi-implementor** | Full-stack TDD implementation. References shared implementation and testing principles, stack conventions, and agent-conduct. |
| **nextjs-fastapi-reviewer** | Review Next.js + FastAPI implementations against spec acceptance tests and shared implementation principles. |

### Python

Skills for modern Python projects:

| Skill | Purpose |
|---|---|
| **python-conventions** | Shared conventions for modern Python 3.14 projects. Project layout, typing, linting, testing, and commands. Referenced by python-implementor, python-reviewer, and workflow skills. |
| **python-implementor** | Python TDD implementation workflow. References shared implementation and testing principles, python-conventions, and agent-conduct. |
| **python-reviewer** | Review Python implementations against spec acceptance tests and shared implementation principles. |

## How It Works

The skills form a layered system:

1. **agent-conduct** provides universal safety rules that all other skills
   reference.
2. **implementation-principles** and **testing-principles** provide shared,
   cross-language implementation and test guidance. **code-smells** provides
   the review vocabulary for design problems a linter cannot name.
3. **writing-for-agents** and **unslop** govern the prose the skills produce:
   the first for documents an agent acts on, the second for AI tells in
   markdown and in chat summaries.
4. **Conventions skills** define tech-stack-specific standards and commands.
5. **Implementor/reviewer skills** provide TDD cycles and review checklists.
6. **Workflow skills** coordinate multi-step processes using the appropriate
   tech-stack skills.

The workflow skills are generic. They discover which implementor, reviewer, and
conventions skills to use based on project context, so the same workflow can
drive Go, Nextflow, Next.js + FastAPI, or Python projects.

## Adding New Tech Stacks

Write every new or edited skill against **writing-for-agents**, and apply
**unslop** to its prose.

To add support for a new tech stack:

1. Create a `<stack>-conventions` skill with code quality standards, testing
   patterns, architecture principles, and commands.
2. Create a `<stack>-implementor` skill with the TDD cycle, referencing
   implementation-principles, testing-principles, the conventions skill, and
   agent-conduct.
3. Create a `<stack>-reviewer` skill with the review checklist, referencing the
   same shared skills, conventions skill, and agent-conduct.

The generic workflow skills will automatically work with the new stack.

## Credits

Some skills here started from other people's MIT-licensed collections and were
rewritten for this repo's conventions and multi-harness workflow:

- **unslop** and **verification** derive from the `pstack` plugin in
  [cursor/plugins](https://github.com/cursor/plugins) (Lauren Tan).
  `verification` merges that plugin's `create-verification-skill` and
  `maintain-verification-skill`.
- **writing-for-agents** derives from Matt Pocock's
  [skills](https://github.com/mattpocock/skills) collection.
- **code-smells** is a labelled subset of Fowler's *Refactoring* chapter 3,
  taken via the same collection's `code-review` skill.
- The red feedback loop in **bugfix** and the frontier rounds in
  **spec-writer** come from that collection's `diagnosing-bugs` and `grilling`
  skills.
