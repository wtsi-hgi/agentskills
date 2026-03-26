---
name: nextflow-conventions
description: Shared conventions for Nextflow DSL 2 workflows. Project layout, modules, nf-test testing, config, containers, and commands. Referenced by nextflow-implementor, nextflow-reviewer, and workflow skills.
---

# Nextflow Conventions

Single source of truth for Nextflow DSL 2 workflow standards. Other skills
reference this. Follow nf-core guidance: https://nf-co.re/docs/tutorials/.

## Copyright Boilerplate

All new `.nf` and `.config` files must start with:

```
// Copyright (c) 2026 Genome Research Ltd.
//
// Author: Sendu Bala <sb10@sanger.ac.uk>
//
// Permission is hereby granted, free of charge, to any person obtaining
// a copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to
// permit persons to whom the Software is furnished to do so, subject to
// the following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
// EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
// IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
// CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
// TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
// SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## Project Layout

```
main.nf                     # entry workflow, includes subworkflows
nextflow.config             # default params + profile includes
conf/
  base.config               # default resource labels (process, memory, cpus, time)
  modules.config            # per-module publishDir and ext.args
  profiles.config           # profile definitions (docker, singularity, conda, test)
modules/
  local/                    # project-specific modules (one process per file)
    <tool>/
      main.nf
      meta.yml
      tests/
        main.nf.test
        nextflow.config     # test-specific config (ext.args etc.)
  nf-core/                  # installed nf-core modules (do not hand-edit)
subworkflows/
  local/                    # project-specific subworkflows
    <name>.nf
workflows/
  <pipeline>.nf             # main workflow logic
lib/                        # Groovy helper classes/functions if needed
assets/                     # schemas, multiqc config etc.
docs/
  usage.md                  # end-user documentation: params, inputs, outputs
  output.md                 # description of all output files
```

## DSL 2 Style

- `nextflow.enable.dsl = 2` (implicit in modern Nextflow, but be explicit).
- **One process per module file** in `modules/local/<tool>/main.nf`.
- Processes take tuple inputs with a `meta` map: `tuple val(meta), path(reads)`.
- Emit named output channels: `emit: bam`, not positional.
- Use `tag "${meta.id}"` in every process for clear logging.
- Use `label` for resource classes: `label 'process_low'`, `'process_medium'`,
  `'process_high'`.
- Early `check` / `error` for required params at workflow entry, not inside
  processes.
- Prefer channel operators (`map`, `combine`, `join`, `groupTuple`) over
  Groovy logic in processes.
- No hardcoded paths. All input via params or channels.

## nf-core Module Re-use

Before writing a local module, check if an nf-core module exists:

```bash
nf-core modules list remote | grep <tool>
nf-core modules install <tool>
```

Use nf-core modules where possible. Only create local modules when no
suitable nf-core module exists. Do not hand-edit files under `modules/nf-core/`.

## Containers

Every process must specify a container. Preference order:

1. **nf-core module** — container defined by the module already.
2. **Seqera Wave / BioContainers** — find at https://seqera.io/wave/ or
   https://biocontainers.pro/. Prefer multi-tool BioContainers if available.
3. **Docker Hub / Quay.io official images** — for common tools.

Specify both docker and singularity in the process or config:

```groovy
container "${ workflow.containerEngine == 'singularity'
    ? 'https://depot.galaxyproject.org/singularity/TOOL:VERSION'
    : 'biocontainers/TOOL:VERSION' }"
```

## Software Versions

Every process must emit a versions channel. Use the `eval` output qualifier
or capture version in the script block:

```groovy
output:
tuple val(meta), path("*.bam"), emit: bam
path "versions.yml",            emit: versions

script:
"""
<tool> --version 2>&1 | sed 's/.*//; s/ .*//' > versions.yml
cat <<-END_VERSIONS > versions.yml
"${task.process}":
    <tool>: \$(echo \$(<tool> --version 2>&1) | sed 's/.*v//')
END_VERSIONS
"""
```

Collect all versions into a single `versions.yml` in the main workflow using
`CUSTOM_DUMPSOFTWAREVERSIONS` or equivalent aggregation.

## Configuration

### `nextflow.config` — default params

```groovy
params {
    input       = null
    outdir      = './results'
    // ... pipeline-specific defaults
}

// Include config files
includeConfig 'conf/base.config'
includeConfig 'conf/modules.config'

profiles {
    docker {
        docker.enabled = true
        singularity.enabled = false
    }
    singularity {
        singularity.enabled = true
        docker.enabled = false
    }
    conda {
        conda.enabled = true
    }
    test {
        includeConfig 'conf/test.config'
    }
}
```

### `conf/base.config` — default resources

```groovy
process {
    cpus   = { 1 * task.attempt }
    memory = { 6.GB * task.attempt }
    time   = { 4.h * task.attempt }

    errorStrategy = { task.exitStatus in [143,137,104,134,139,140] ? 'retry' : 'finish' }
    maxRetries    = 1
    maxErrors     = '-1'

    withLabel: 'process_low'    { cpus = 2;  memory = 12.GB; time = 4.h  }
    withLabel: 'process_medium' { cpus = 6;  memory = 36.GB; time = 8.h  }
    withLabel: 'process_high'   { cpus = 12; memory = 72.GB; time = 16.h }
}
```

### Profiles

Profiles allow switching execution environments. Always support at minimum:
`docker`, `singularity`, `test`. Institutional profiles can be added as
needed.

## Documentation

- `docs/usage.md`: describe all params, expected input format (e.g. samplesheet
  CSV columns), how to run with examples.
- `docs/output.md`: describe every output file/directory produced.
- `README.md`: pipeline overview, quick start, link to docs.

## Testing (nf-test)

- Framework: [nf-test](https://code.askimed.com/nf-test/).
- Each local module has `tests/main.nf.test` beside its `main.nf`.
- Use snapshot assertions: `assert snapshot(process.out).match()`.
- Wrap assertions in `assertAll()`.
- Use minimal test data; for large data use `-stub` mode with stub blocks.
- Test both single-sample and multi-sample cases where applicable.
- Pipeline-level tests in `tests/` at project root.
- Every spec.md acceptance test MUST have a corresponding nf-test. No stubs
  for logic tests, no hardcoded results, no swallowed failures.

### nf-test file structure

```groovy
nextflow_process {
    name "Test <TOOL>"
    script "../main.nf"
    process "<TOOL>"

    test("descriptive test name") {
        when {
            process {
                """
                input[0] = [
                    [ id:'test' ],
                    file(params.test_data['species']['type']['file'], checkIfExists: true)
                ]
                """
            }
        }
        then {
            assertAll(
                { assert process.success },
                { assert snapshot(process.out).match() }
            )
        }
    }
}
```

## Commands

```bash
# Install nf-core modules
nf-core modules install <tool>
nf-core modules list remote | grep <tool>

# Run pipeline
nextflow run main.nf -profile test,docker --outdir results

# Run nf-test (all)
nf-test test

# Run nf-test (specific module)
nf-test test modules/local/<tool>/tests/main.nf.test

# Lint
nf-core pipelines lint
nextflow run main.nf -profile test,docker -stub

# Clean work directory
nextflow clean -f
```
