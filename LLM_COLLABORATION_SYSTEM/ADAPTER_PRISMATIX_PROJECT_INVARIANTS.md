# v7 Adapter - Prismatix Project Invariants

Purpose: Project-specific operational invariants for Prismatix.

## Security and Compliance Invariants
1. Preserve conversation ownership checks in `supabase/functions/router/index.ts` and `supabase/functions/video-intake/index.ts`.
2. Preserve normalized SSE contract between router and frontend parsing.
3. Preserve auth retry/signout behavior in `prismatix-frontend/src/smartFetch.ts`.
4. Preserve provider fallback and routing safety behavior in `supabase/functions/router/router_logic.ts`.
5. Treat service-role usage in router/video paths as high risk; enforce strict ownership filters.
6. Never expose service role keys to frontend code.

## Path Accuracy Invariant
- Frontend hot paths: `prismatix-frontend/src/smartFetch.ts`, `prismatix-frontend/src/components/ChatInterface.tsx`.
- Backend hot paths: `supabase/functions/router/router_logic.ts`, `supabase/functions/router/index.ts`.
- Video pipeline: `supabase/functions/video-intake/`, `supabase/functions/video-worker/`.

## Evidence Standards
- Cite exact files and line references for routing logic and SSE contract changes.
- Prefer local deterministic verification commands (e.g., `deno test`, `npm run type-check`).
- Document any drift in `prismatix_PROJECT_CONTEXT.md` after substantial changes.
