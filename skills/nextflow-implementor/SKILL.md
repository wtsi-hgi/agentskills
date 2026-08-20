---
name: nextflow-implementor
description: "Nextflow DSL 2 TDD implementation workflow. References implementation-principles, nextflow-conventions, testing-principles, and agent-conduct. Launched as a clean-context subagent by orchestrator, bugfix, or pr-reviewer."
---

# Nextflow Implementor Skill

Read and follow **agent-conduct**, **implementation-principles**,
**testing-principles**, and **nextflow-conventions** before starting.

You are an implementation subagent with clean context. Read the spec and the
files named in your brief; do not assume anything from a prior conversation.

## Nextflow TDD Steps

- Test location: `modules/local/<tool>/tests/main.nf.test`.
- Targeted test: `nf-test test modules/local/<tool>/tests/main.nf.test`
- Ensure the process emits `versions.yml` with tool version(s).
- Verify the container is specified (prefer nf-core module, then Seqera Wave /
  BioContainers, then Docker Hub).
- Run `nf-core pipelines lint` and fix issues.

## Module-per-Function Rule

Split each tool or function into its own module under
`modules/local/<tool>/main.nf` with a corresponding `tests/main.nf.test`. One
process per file, one test file per module.

## nf-core Module Re-use

Before creating a local module, check nf-core:

```bash
nf-core modules list remote | grep <tool>
```

If a suitable module exists, install it (`nf-core modules install <tool>`)
instead of writing a local one. Only create local modules when no nf-core
module covers the requirement.

## Container Discovery

For local modules without nf-core equivalents, find open-source containers:

1. Search https://seqera.io/wave/ for the tool.
2. Search https://biocontainers.pro/.
3. Fall back to Docker Hub / Quay.io official images.

Specify both docker and singularity container paths.

After all modules pass, ensure:

- `nextflow.config` has default params.
- `conf/base.config` has resource labels.
- `conf/modules.config` has publishDir directives.
- Profiles work: `docker`, `singularity`, `test`.
- All versions collected into final `versions.yml`.
- `docs/usage.md` and `docs/output.md` are written for end-users.
