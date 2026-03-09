# v7 Activation Contract - Prismatix

Purpose: Deterministic load policy for Core, Guard, and Adapter layers.

## Load Policy

| Layer | Condition | File(s) |
| :--- | :--- | :--- |
| **Core** | Always Loaded | `RULES_CORE.md`, `RULES_CORE_MODEL_AGNOSTIC.md` |
| **Adapter** | Always Loaded | `ADAPTER_PRISMATIX.md`, `ADAPTER_PRISMATIX_PROJECT_INVARIANTS.md` |
| **Guard** | Execution/Write Risk | `RULES_GUARD.md`, `RULES_GUARD_EXECUTION_GATES.md` |

## Conditional Activation (Guard)
The **Guard** layer is activated when any of the following signals are detected:
- `tool_can_write_files: true`
- `approval_mode` is `auto_edit` or `yolo`
- `task_mode` is `implement`, `migrate`, `deploy`, or `hotfix`

## Fallback Behavior
If load signals are ambiguous, the system defaults to:
- `RULES_CORE.md`
- `ADAPTER_PRISMATIX.md`
*(Guard is NOT loaded by default to prevent eager execution)*

## Verification
Load status must be reported in the `overlay_status` field of every handoff.
