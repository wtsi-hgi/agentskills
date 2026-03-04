---
name: agent-conduct
description: General conduct rules for all agent skills. Covers workspace boundaries, scratch work, terminal safety, and behaviours that avoid triggering VS Code safety prompts. Every other skill references this document - read it before starting any work.
---

# Agent Conduct Skill

These rules apply to ALL agents and skills. Every skill document
references this one. Follow every rule below regardless of which
skill you are operating under.

## Workspace Boundary (Mandatory)

### Hard boundary: write only inside the repository

- NEVER create, edit, or delete files outside the repository
  directory.
- NEVER write to `/tmp`, `/var/tmp`, `/dev/shm`, `/dev/null`,
  home-directory temp paths, or any absolute path outside the repo.
- If a command would write outside the repo, do not run it. Rewrite
  it so all outputs stay under the repo.

### Pre-write check

Before any file-writing command, confirm the target path is inside
the current repository root. If not, stop and choose an in-repo
alternative.

## Scratch Work

### Preferred alternatives

- For runtime temporary data in tests, use the language-appropriate
  equivalent (e.g. `t.TempDir()` in Go, `tmp_path` fixtures in
  pytest, temp directories in Node.js tests).
- For quick one-off shell logic, prefer inline pipelines or
  heredocs instead of writing helper scripts.
- If a temporary file is truly needed, create it under
  `.tmp/agent/` in the repo (create the directory if needed) and
  clean it up before finishing.

### Avoid tooling confusion from ad-hoc files

- Do NOT create standalone throwaway scripts or source files in
  the repo root, `.tmp/`, or other non-package locations that
  could confuse tooling or linters (e.g. stray `.go` files confuse
  the Go toolchain, stray `.py` files may be picked up by pytest).
- Do NOT use throwaway scripts as scratch helpers.
- If temporary helper logic is required, prefer shell scripts or
  text files in `.tmp/agent/` (avoiding language-specific
  extensions), or place test-only helpers inside the relevant
  test files.

## Terminal Safety

### Avoid VS Code confirmation prompts

VS Code intercepts certain terminal operations and shows a modal
confirmation dialog that blocks automated workflows. Avoid
triggering these:

- Do NOT run interactive commands that expect user input (e.g.
  `ssh`, `mysql` shells, `less`, `vi`). Use non-interactive
  equivalents or flags (e.g. `git --no-pager`, `less -F`).
- Do NOT run commands that create processes listening on ports
  without using background mode.
- Do NOT use `sudo` or other privilege-escalation commands.
- Do NOT run `rm -rf` on broad paths. For file removal within
  the repo, be specific and targeted, or move files to a
  `.trash/` directory within the repo instead of deleting.
- Prefer `command | cat` over pager-based output to avoid
  terminal paging prompts.
- Use `set -e` in multi-step shell commands so failures surface
  immediately rather than silently continuing.

### Command hygiene

- Quote shell variables: `"$var"` instead of `$var`.
- Use `[[ ]]` for conditional tests instead of `[ ]`.
- Prefer `$()` over backticks for command substitution.
- Limit output size: use `head`, `tail`, `grep`, or `wc -l`
  before displaying potentially large outputs.

## Git Safety

- Do NOT push to the remote - never run `git push`.
- Do NOT force-push, rebase published branches, or rewrite
  remote history.
- Do NOT modify `.git/` internals directly.
- Prefer targeted `git add <file>` over `git add .` to avoid
  committing unintended files.

## General Rules

- Do NOT install system packages or modify the system environment.
- Do NOT modify files outside the scope of the current task.
- Keep changes minimal and targeted. Do not refactor unrelated code
  unless explicitly asked to.
- When in doubt about whether an action is safe, choose the more
  conservative option.
