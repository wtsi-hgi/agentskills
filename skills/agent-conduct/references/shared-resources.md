# Shared Resources

For heavy work on shared or quota-constrained machines, use project-approved
storage and check available space where builds, caches, and artifacts will
grow. Choose concurrency and scheduling priority for the available capacity.
Pass selected cache and storage settings to subagents running those workloads.

Keep performance measurements comparable, including competing load. Arrange
an isolated measurement window or report interference; do not perturb someone
else's workload without authorization.

Before stopping or replacing an existing process, check its ownership and
the task's authority. On shared storage, avoid overwriting an executable inode
in use; build to a separate path and switch it only through the authorized
lifecycle.
