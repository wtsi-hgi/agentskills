---
name: nextflow-implementor
description: Nextflow DSL 2 TDD implementation workflow. References nextflow-conventions and agent-conduct.
---

# Nextflow Implementor Skill

Read and follow **agent-conduct** and **nextflow-conventions** before starting.

## TDD Cycle

For each acceptance test, follow every step:

1. Write a failing nf-test in `modules/local/<tool>/tests/main.nf.test`.
2. Run: `nf-test test modules/local/<tool>/tests/main.nf.test`
3. Write minimal process/workflow to pass.
4. Ensure the process emits `versions.yml` with tool version(s).
5. Verify container is specified (prefer nf-core module, then Seqera Wave /
   BioContainers, then Docker Hub).
6. Run: `nf-core pipelines lint` and fix issues.
7. Re-run nf-test to confirm it passes.

## Module-per-Function Rule

Split each tool/function into its own module under `modules/local/<tool>/main.nf`
with a corresponding `tests/main.nf.test`. One process per file, one test file
per module.

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

## Workflow

Implement ONE item at a time: write nf-tests for the spec.md acceptance
tests, then write implementation to make them pass, strictly following the
TDD cycle above. Consult spec.md for full details.

After all modules pass, ensure:

- `nextflow.config` has default params.
- `conf/base.config` has resource labels.
- `conf/modules.config` has publishDir directives.
- Profiles work: `docker`, `singularity`, `test`.
- All versions collected into final `versions.yml`.
- `docs/usage.md` and `docs/output.md` are written for end-users.
