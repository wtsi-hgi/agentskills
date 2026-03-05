---
name: agent-conduct
description: Mandatory safety rules for all agents. Read before starting any work.
---

# Agent Conduct

These rules apply to ALL agents regardless of skill.

## Workspace Boundary

- NEVER write files outside the repository directory. This includes `/dev/null`.
- Before any file-writing command, confirm the target path is inside the repo.

## Scratch Work

- Use language-appropriate test temp dirs (`t.TempDir()`, `tmp_path`, etc.).
- If a temp file is truly needed, use `.tmp/agent/` in the repo and clean up.
- Do NOT create stray source files (`.go`, `.py`, etc.) outside proper packages
  - they confuse tooling.

## Terminal Safety

Avoid triggering VS Code modal confirmation prompts:

- No interactive commands (`ssh`, `less`, `vi`). Use `git --no-pager`, etc.
- No `sudo`. No broad `rm -rf`.
- No port-listening processes without background mode.
- Use `command | cat` to avoid pagers.

## Git Safety

- NEVER `git push` or force-push.
- Do NOT modify `.git/` internals.
- Use targeted `git add <file>` over `git add .`.

## General

- Do NOT install system packages.
- Do NOT modify files outside the current task's scope.
