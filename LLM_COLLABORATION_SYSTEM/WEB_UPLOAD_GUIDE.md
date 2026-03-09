# Web Upload Guide (No Local File Access)

Use this when asking GPT/Claude/Gemini on the web about Prismatix.

## Minimum Upload Pack

1. `PROJECT_CONTEXT.md`
2. `prismatix_PROJECT_CONTEXT.md`
3. One manifest (`AGENTS.md` or `CLAUDE.md` or `GEMINI.md`)
4. Latest handoff block from `MODEL_SWITCH_HANDOFF_TEMPLATE.md`

## Task-Specific Additions

- Router/backend issue:
  - `supabase/functions/router/index.ts`
  - `supabase/functions/router/router_logic.ts`
  - related helper (`cost_engine.ts`, `pricing_registry.ts`)

- Frontend stream/render issue:
  - `prismatix-frontend/src/smartFetch.ts`
  - `prismatix-frontend/src/components/ChatInterface.tsx`
  - `prismatix-frontend/src/modelCatalog.ts`

- Migration/schema issue:
  - relevant file(s) under `supabase/migrations/`

## Prompt Header For Web LLM

Paste this before your question:

```text
Context: You do not have repository access. Use only uploaded files.
Goal: Provide file-level recommendations and verification commands.
Constraint: Distinguish facts from assumptions.
```
