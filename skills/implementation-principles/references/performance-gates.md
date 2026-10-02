# Performance Gates

Discover project performance policy alongside other quality gates, including
applicable paths, commands, workloads, baseline, and regression thresholds.
Pass that policy and relevant evidence to implementors and reviewers. An
unrelated change needs no benchmark suite unless project policy requires one.

For an applicable comparison, measure the changed revision against the
project-defined baseline under comparable conditions, separate from dirty
user work. Record immutable revisions (plus the diff for uncommitted work),
command, workload/environment, result artifact, deltas, and policy verdict.
Refresh affected evidence when code, baseline, workload, or environment
changes. Reviewers inspect the actual results and scope; reuse valid evidence.

A benchmark process exiting successfully proves only that it ran. A required
performance gate must pass under its policy, even when correctness tests are
green. Route failures through
[bugfix routing](../../bugfix/references/incidental-issues.md); they cannot be
deferred as independent optimization. Missing required evidence remains
unresolved. Never invent thresholds or call an unjudged measurement a pass.

Without a project gate, meaningful added cost on a repeated runtime path
without coverage is review input. Assess whether a focused measurement is
needed; this does not impose benchmarks on every changed call.

Include required comparison evidence and its policy verdict in the PR body,
or in completion evidence when there is no PR. Explain inapplicability when
an expected gate does not cover the change.
