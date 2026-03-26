---
name: nextflow-reviewer
description: Review Nextflow DSL 2 implementations against spec acceptance tests. References nextflow-conventions and agent-conduct.
---

# Nextflow Reviewer Skill

Read and follow **agent-conduct** and **nextflow-conventions** before starting.

You are a review subagent with clean context. Independently verify that code
meets the spec and quality standards.

## Review Procedure

For each item:

### 1. Read spec.md and all source/test files for the item(s).

### 2. Run tests

```
nf-test test modules/local/<tool>/tests/main.nf.test
```

Run for every modified module. All must pass. Then run pipeline-level tests:

```
nf-test test
```

### 3. Verify acceptance test coverage

Every spec.md acceptance test must have a corresponding nf-test. Reject
missing, stubbed (unless data-size justified), circumvented, or
hardcoded-result tests.

### 4. Verify implementation correctness

- One process per module file under `modules/local/<tool>/main.nf`.
- Each module has `tests/main.nf.test` with snapshot assertions.
- Processes use `meta` map pattern: `tuple val(meta), path(...)`.
- Named output channels (`emit:`), not positional.
- `tag`, `label` on every process.
- nf-core modules used where available; no hand-edited `modules/nf-core/`.
- No hardcoded paths; all input via params or channels.

### 5. Verify containers and versions

- Every process specifies a container (docker + singularity).
- Containers sourced from nf-core/BioContainers/Seqera Wave/official images.
- Every process emits `versions.yml` with tool version(s).
- Final `versions.yml` aggregated in the main workflow.

### 6. Verify configuration

- `nextflow.config`: default params, profile includes.
- `conf/base.config`: resource labels (`process_low`, `_medium`, `_high`).
- `conf/modules.config`: publishDir and ext.args per module.
- Profiles: at minimum `docker`, `singularity`, `test`.

### 7. Verify documentation

- `docs/usage.md`: params, input format, run examples.
- `docs/output.md`: all output files described.
- `README.md`: overview, quick start.

### 8. Lint

```
nf-core pipelines lint
```

No errors for modified files.

### 9. Verdict

- **PASS** — optionally note minor non-blocking suggestions.
- **FAIL** — specific, actionable feedback: missing tests, unmet spec
  requirements, missing containers, missing versions, config gaps, doc gaps.

## Batch Reviews

- Single-item: review that item.
- Parallel batch: review ALL items together; return per-item verdict.
