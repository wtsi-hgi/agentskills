# Performance Gates

Discover performance commands and policy alongside lint, test, and fixture
commands. Read project instructions, README/CONTRIBUTING, build targets and
scripts (for example `make speed` or `make bench`), CI, and performance docs.
Record commands, policy source, project-defined hot paths, and applicability
to the actual changed paths and callers. Pass that record and this reference
to implementors and reviewers. An unrelated change needs no full benchmark
suite unless project policy requires one.

When a change touches a project-defined hot path, its required comparison
against the resolved base must pass before completion. Use the project's
workloads, measurement method, and regression policy; never invent thresholds.
Compare the actual changed revision and immutable base SHA under comparable
conditions. Keep base measurements separate from dirty user work. Record both
revisions, commands, workload/environment, result artifact, measured deltas,
and the policy verdict. For uncommitted work, identify the measured diff too;
refresh evidence after code, base, workload, or relevant environment changes.

A benchmark process exiting successfully proves only that it ran. Read its
comparison and apply the policy. Green tests cannot waive a speed regression.
A failing required performance gate stays in the current fix queue under
[bugfix routing](../../bugfix/references/incidental-issues.md); it cannot be
deferred as an independent optimization. An unavailable comparison or missing
acceptance policy is unresolved evidence, not a passing gate.

If the project has no gate and the change adds work on a per-request or
repeated runtime path, flag missing benchmark coverage with the affected path
so a focused benchmark can be added for this change. When adding coverage,
measure against base and report the delta; without a project policy, do not
claim that measurement establishes an acceptable regression. A one-off setup
call alone does not trigger this coverage rule.

Reviewers verify that the gate actually ran, that its workload covers the
changed scope, and that base and measured revision match the current review.
Inspect results rather than accepting the implementor's summary. Reuse valid
evidence; rerun missing, stale, or inapplicable comparisons. Required evidence
and its policy verdict must appear in the PR body before reporting readiness;
with no PR, return it in the checklist or completion evidence. Record an
inapplicability reason when no performance gate applies.
