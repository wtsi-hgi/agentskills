# Completion And Liveness

Workers wait for their own tests, tool sessions, and background children before
final handback. Return finally only when complete, blocked, or explicitly
paused. A tool yield is still live work; resume its wait within bounded calls.
Do not invent a harness requirement to finalize early. If an interim handback
is unavoidable, label it `INTERIM` and list live agent/process/job/wait IDs,
pending artifacts, ownership, and resume calls. The owner resumes that work
instead of counting it as success.

Before reporting running or waiting, inspect actual state and available
output. Silence and a prior promise are not evidence; unverifiable state is
unknown. Consume completed waits before the next update and report
user-relevant results through **final-response**. Read the semantic result;
exit 0 alone does not prove a gate passed.

Bound long or networked commands with `timeout` or native flags and use
interruptible waits. Report a real timeout. Do not interrupt required work
merely to end the turn.

Before final, blocked, or paused handback, stop unneeded background work and
verify it stopped, including nested work. Completed agents need no cleanup
if the harness exposes no close operation. For retained work, report current
state, exact IDs, owner, purpose, and resume or cleanup action.

Tag context updates to active agents `FYI, keep going`. Recipients incorporate
them and continue through completion. An explicit pause or stop ends work;
a real blocker or timeout still requires an honest report.
