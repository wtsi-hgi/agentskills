---
name: phase-creator
description: Creates phase plan documents from a spec.md Implementation Order. Invoked by spec-writer, not directly.
---

# Phase Creator Skill

Read and follow **agent-conduct** before starting.

You create one phase file per phase from a spec's Implementation Order, formatted
for use by the orchestrator skill.

## Input

- **Spec path** - path to spec.md.
- **Output directory** - for phase files (normally same dir as spec).
- **Implementor/reviewer skill names** - e.g. `go-implementor`/`go-reviewer`
  (determine from project context if not provided).

## Procedure

1. Read spec's Implementation Order. Note every phase, title, and story IDs.
2. Analyse dependencies: group independent items into parallel batches; dependent
   items go into later batches.
3. Create `phase<N>.md` per phase in the output directory (format below).
4. Return summary of files created and their items.

## Phase File Format

```markdown
# Phase <N>: <Phase title from spec>

Ref: [spec.md](spec.md) sections <comma-separated story IDs>

## Instructions

Use the `orchestrator` skill to complete this phase, coordinating
subagents with the `<implementor-skill>` and `<reviewer-skill>`
skills.

## Items

<items - see below>
```

### Sequential items

```markdown
### Item <N>.<M>: <Story ID> - <Story title>

spec.md section: <Story ID>

<Brief description referencing acceptance test count from spec.>

- [ ] implemented
- [ ] reviewed
```

### Parallel batches

```markdown
### Batch <B> (parallel)

#### Item <N>.<M>: <Story ID> - <Title> [parallel with <others>]

spec.md section: <Story ID>

<Brief description.>

- [ ] implemented
- [ ] reviewed
```

If a batch depends on a prior batch: `### Batch <B> (parallel, after batch
<B-1> is reviewed)`.

After all parallel items, include:

```markdown
For parallel batch items, use separate subagents per item.
Launch review subagents using the `<reviewer-skill>` skill
(review all items in the batch together in a single review
pass).
```

### Item descriptions

- Name functions, types, or files to implement.
- Reference spec.md section for full details.
- State acceptance test count (e.g. "covering all 5 acceptance tests from A1").
- Note dependencies on other items if relevant.

### Numbering

- Items: `<phase>.<sequence>` (e.g. 4.1, 4.2).
- Batches: sequential within phase.
- Sequence numbers continuous across batches.

## Rules

- NEVER invent items not in the spec's Implementation Order.
- ALWAYS include both `- [ ] implemented` and `- [ ] reviewed` checkboxes.
- ALWAYS identify parallel items and group them into batches.
- ASCII only (no em dashes, no smart quotes). Wrap at 80 columns.
