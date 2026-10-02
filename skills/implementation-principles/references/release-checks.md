# Release Checks

Use for release preparation or release PRs. Follow project release policy
for gates, compatibility, versioning, changelog content, and dates.

Bind final evidence to the exact candidate after intended release blockers
land. Use the project's release baselines, which may differ from the PR base
(for example the previous tag). After candidate changes, refresh affected
evidence before claiming release readiness. A green feature PR does not by
itself prove the final release candidate passed its applicable gates.

Check version, date, and compatibility-impact entries against project policy
and the candidate diff. Surface missing policy only when it leaves a material
release decision unresolved. Tagging, publishing, merging, and announcements
follow existing task authorization; release preparation alone grants none.
