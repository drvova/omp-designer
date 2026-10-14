---
type: trace_event
event: prompt_injected
min: 1
---
The extension actually ran in this arm: the prompt injection is in the project's
trace. A print-mode session does not emit `session_stop`, so the stop-time
delivery path cannot be graded here — this proves the arm was armed, which is the
precondition every other grader on this case depends on.
