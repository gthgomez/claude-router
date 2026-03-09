# ADAPTER_PRISMATIX.md - Project Invariants (Prismatix)

Purpose: Repo-specific invariants and risk boundaries for Prismatix.

## Repo Scope

- Router backend: `supabase/functions/router/`
- Video intake/processing: `supabase/functions/video-intake/`, `supabase/functions/video-worker/`
- Frontend stream/auth path: `prismatix-frontend/src/`
- Migrations: `supabase/migrations/`

## Critical Invariants

1. Preserve conversation ownership checks in router and video intake flows.
2. Preserve normalized SSE contract between router and frontend parsing.
3. Preserve auth retry/signout behavior in `prismatix-frontend/src/smartFetch.ts`.
4. Preserve provider fallback and routing safety behavior.
5. Treat service-role usage in router/video paths as high risk; enforce strict ownership filters.

## High-Risk Zones

- `supabase/functions/router/index.ts`
- `supabase/functions/router/router_logic.ts`
- `supabase/functions/video-intake/index.ts`
- `prismatix-frontend/src/smartFetch.ts`
- `prismatix-frontend/src/components/ChatInterface.tsx`
- `supabase/migrations/*` (RLS/policy changes)

## Context Sync

On completion of substantial runs, sync `prismatix_PROJECT_CONTEXT.md` for drift in contracts/invariants/routing behavior.
