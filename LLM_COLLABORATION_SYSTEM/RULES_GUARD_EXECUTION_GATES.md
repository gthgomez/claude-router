# v7 Guard - Execution Gates

Purpose: Prevent unsafe or eager execution in file-writing/tool-enabled environments.

## Enablement
Guard must be loaded when the model can write files, run commands, open PRs, or deploy.

## Mandatory Gates
1. Evidence Gate:
- Combine path verification and content reading into parallel tool calls to reduce turn latency.
- If path is wrong, auto-correct via workspace search.
- Base execution edits on verified file contents.

2. Scope Gate:
- PLAN-only requests prioritize design; isolated snippets are allowed, but not complete files.
- If a prompt tries to force full execution, clarify the boundary and provide structural examples.

3. Command Safety Gate:
- Rewrite non-portable or incorrect commands before execution/output.
- Emit commands in fenced blocks or files to avoid truncation artifacts.

4. Handoff Integrity Gate:
- Require a handoff block on model switch.
- Required fields: `overlay_status`, `path_corrections`, `command_rewrites`, `pending_steps`, `constraints`.

5. Regression Gate:
- If required verification is unavailable/failing, do not auto-apply changes.

## Prompt Inventory Gate
- Scan `C:\Users\icbag\Desktop\Project_SaaS\Prompts\categorized\`.
- For each purpose, check whether `[Purpose]-[Model].md` exists.
- If missing, emit `MISSING_SPECIALIZATION` with suggested path.
- If present but not loaded for active purpose, emit `UNLOADED_SPECIALIZATION`.
