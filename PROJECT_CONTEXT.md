# PROJECT_CONTEXT.md - First File To Read

Purpose: This file is the entrypoint for any human or LLM working in this repository for the first time.

Repository: `C:\Users\icbag\Desktop\Project_SaaS\Prismatix`
Product: Prismatix routed multi-provider chat platform with normalized SSE streaming.

## Required Startup Order

1. Read this file.
2. Read `prismatix_PROJECT_CONTEXT.md` (full architecture, contracts, and invariants).
3. Read `LLM_COLLABORATION_SYSTEM/README_FOR_HUMANS_AND_LLMS.md`.
4. Read your model manifest (`AGENTS.md`, `CLAUDE.md`, or `GEMINI.md`).

## Naming Conventions (Why the Folder Names Exist)

- `LLM_COLLABORATION_SYSTEM/` contains cross-model operating rules, handoff protocol, and web-upload guidance.
- `RULES_SHARED_ALL_MODELS.md` is the common policy surface for Codex, Claude, and Gemini.
- `RULES_MODEL_*.md` files contain model-specific strengths and style constraints.
- Root manifests (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`) are generated files used by each tool runtime.

## If You Are Using A Web LLM Without Repo Access

Upload in this order:
1. `PROJECT_CONTEXT.md`
2. `prismatix_PROJECT_CONTEXT.md`
3. `LLM_COLLABORATION_SYSTEM/WEB_UPLOAD_GUIDE.md`
4. Your latest handoff block from `LLM_COLLABORATION_SYSTEM/MODEL_SWITCH_HANDOFF_TEMPLATE.md`

This gives enough context for the web model to suggest file-level actions and verification targets.
