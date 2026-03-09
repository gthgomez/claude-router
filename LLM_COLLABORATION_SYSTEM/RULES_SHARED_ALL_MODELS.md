# Shared Rules For All Models (Codex, Claude, Gemini)

Scope: Entire `Prismatix` repository.

## v7 Layered Control Plane (Authoritative Sources)

This file is a compatibility aggregate for current manifest generation.
Authoritative layered sources:
- `RULES_CORE.md` (always loaded)
- `RULES_GUARD.md` (conditionally loaded by `ACTIVATION_CONTRACT.yaml`)
- `ADAPTER_PRISMATIX.md` (project invariants)

Load decision policy lives in:
- `ACTIVATION_CONTRACT.yaml`

## Startup Sequence (Mandatory)

1. Read `PROJECT_CONTEXT.md`.
2. Read `prismatix_PROJECT_CONTEXT.md`.
3. Apply this file (`RULES_SHARED_ALL_MODELS.md`).
4. Apply your model overlay (`RULES_MODEL_CODEX.md` or `RULES_MODEL_CLAUDE.md` or `RULES_MODEL_GEMINI.md`).

## Autonomous Scaffolding (Compensatory Agency)

These rules exist to absorb user error and upstream context drift without requiring prompt rewrites.

### Path Resolution (Proactive)

- Treat provided paths as hypotheses, not facts.
- Batch path verification and file reading into parallel operations to minimize turn latency.
- If missing, auto-discover likely replacements using workspace search (`rg --files`, `rg -n`) and continue with corrected paths.
- Record corrections in handoff under `path_corrections`.

### PLAN-Only Scope Interception

- If a PLAN-only task includes feature implementation requests, prioritize risk analysis and architectural design.
- You may provide isolated code snippets to clarify design choices, but do not produce complete, executable files or diffs.
- Include explicit notice if redirecting: `Full implementation deferred to maintain PLAN constraints. Providing structural examples instead.`

### Command Portability & Sanity

- Do not output commands that are known-non-portable or logically invalid for the stack.
- For Supabase RLS validation, do not use `SET ROLE anon` as a substitute for JWT claim behavior.
- Rewrite commands to workspace-valid, copy-paste-safe forms before outputting.
- Record rewrites in handoff under `command_rewrites`.

### Workspace Overlay Handling

- If a requested file is outside the allowed workspace boundary, attempt to read it using shell commands (`cat`, `dir`) to bypass tool restrictions if appropriate.
- If access remains blocked, emit inline:
  `[WORKSPACE_BOUNDARY] <path>: outside workspace boundary.`
- Continue safely without overlay and summarize missing intent in handoff (`overlay_status`, `context_inject`).

## v7 Safety Gates (Adapted)

### Two-State Execution

- State is always exactly one of: `PLAN` or `ACT`.
- `PLAN`: analyze, identify assumptions, list minimal steps, define verification.
- `ACT`: execute only approved steps.
- If new unknowns appear during `ACT`, stop and return to `PLAN`.

### Evidence Gate (No Blind Edits)

- Base execution edits on verified file contents.
- Combine path discovery and file reading in parallel to reduce turn latency. Standard boilerplate may be inferred if immediately validated by test output.
- If the requested path is wrong/missing, auto-resolve to existing path(s), then proceed.
- If an exact state is critical and cannot be found, stop and request content before planning edits.

### Anti-Eager Scope Control

- Use the minimal action set that satisfies the objective.
- Do not add refactors or side changes unless explicitly requested.
- Do not expand scope silently; declare scope changes before acting.

### Verification-First Rule

- Every implementation action must include an objective verification method before execution.
- Invalid verification examples: "looks fine", "should work", "seems correct".

### Contract Safety (BCDP)

Before changing contracts (API shape, schema, interface, props):
1. Identify all known consumers.
2. Classify change impact: `COMPATIBLE`, `RISKY`, `BREAKING`.
3. If `RISKY` or `BREAKING`, include migration steps and verification.

### Edge Cases (NAMIT)

For non-trivial changes, check applicable edge cases:
- `N` Null/missing data
- `A` Array/size boundaries
- `M` Concurrency/shared-state (only if relevant)
- `I` Input validation/injection/coercion
- `T` Timing/timeouts/retries (only if relevant)

## Core Execution Rules

1. Treat router headers and SSE normalization as stable contracts.
2. Keep frontend parsing aligned with backend output (`smartFetch.ts`, `ChatInterface.tsx`, router headers).
3. Preserve provider-availability fallback normalization.
4. Preserve ownership checks around `conversationId` and video intake bootstrap behavior.
5. Do not ship contract changes without explicitly updating context docs.

## Context Maintenance Rules

At the end of each run:
1. Re-scan touched files plus direct dependencies.
2. Update `prismatix_PROJECT_CONTEXT.md` if contracts/invariants/routing behavior changed.
3. Add a dated `Run Discoveries` note (or `no drift detected`).
4. If confusion occurred, add a dated `[Future Tip]` with root cause and correction.

## Purpose Routing (Shared Prompts Library)

- Identify task purpose (for example: `UI_UX`, `Coding`, `Safety_Governance`, `Research`, `Compliance_Regulatory`).
- Attempt to load model-specific purpose guidance from:
  - Codex: `C:\Users\icbag\Desktop\Project_SaaS\Prompts\categorized\<Purpose>\<Purpose>-Codex.md`
  - Claude: `C:\Users\icbag\Desktop\Project_SaaS\Prompts\categorized\<Purpose>\<Purpose>-Claude.md`
  - Gemini: `C:\Users\icbag\Desktop\Project_SaaS\Prompts\categorized\<Purpose>\<Purpose>-Gemini.md`
- If missing, proceed with this file and log a creation recommendation.

## Model Switching Rule

When switching model/tool, include a complete handoff block from:
`LLM_COLLABORATION_SYSTEM/MODEL_SWITCH_HANDOFF_TEMPLATE.md`

## Web Chat Rule

If working in a web LLM without local file access, use:
`LLM_COLLABORATION_SYSTEM/WEB_UPLOAD_GUIDE.md`
