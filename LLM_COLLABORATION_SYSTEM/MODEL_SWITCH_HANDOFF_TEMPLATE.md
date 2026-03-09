# Model Switch Handoff Template

Copy this block when switching between Claude Code, Codex, Gemini CLI, or a web LLM.

```text
[MODEL_SWITCH_HANDOFF]
project: Prismatix
task_purpose: <UI_UX|Coding|Safety_Governance|Research|Compliance_Regulatory|General_Intelligence|Other>
current_phase: <plan|implement|verify|review>
completed_steps:
- ...
pending_steps:
- ...
key_decisions:
- ...
constraints:
- ...
overlay_status: <loaded|missing|outside_workspace>
path_corrections:
- original -> corrected (reason)
command_rewrites:
- original -> rewritten (reason)
context_inject:
- source + summary if overlay unavailable
files_touched:
- relative/path.ext
verification_run:
- command + key result
next_action: <single next action>
[/MODEL_SWITCH_HANDOFF]
```
