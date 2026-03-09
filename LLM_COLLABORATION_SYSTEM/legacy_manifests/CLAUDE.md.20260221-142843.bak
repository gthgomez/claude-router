# Claude.md

## Prismatix Working Rules (Repo-Specific)

Scope: `C:\Users\icbag\Desktop\Project_SaaS\Prismatix`

### 1) Always Start With Context

Read `prismatix_PROJECT_CONTEXT.md` before non-trivial edits:
- Tier 1 for execution-critical constraints and contracts.
- Tier 2 for file map, migrations, and deeper architecture.

### 2) Contract-First Change Discipline

When backend/edge behavior changes, verify and sync:
- Router request payload fields.
- Router response headers.
- SSE normalized event format.
- Frontend parsing in `prismatix-frontend/src/smartFetch.ts` and `prismatix-frontend/src/components/ChatInterface.tsx`.

### 3) Context Maintenance Every Run

At the end of every run:
1. Re-scan touched files and direct dependencies.
2. Update Tier 1 and/or Tier 2 in `prismatix_PROJECT_CONTEXT.md` if drift is found.
3. Add a dated note under `Run Discoveries`.
4. If confusion occurred, add a dated `[Future Tip]` note using the template in `prismatix_PROJECT_CONTEXT.md`.
5. If no updates are needed, add a dated `no drift detected` note.

### 4) High-Signal File Map Standard

- Keep file map curated and purpose-driven (avoid full tree dumps).
- Prioritize runtime-critical modules, migrations, and debugging anchors.
- Flag duplicate/ambiguous paths that can cause deploy/runtime confusion.

### 5) Priority Files

- Backend: `supabase/functions/router/index.ts`, `supabase/functions/router/router_logic.ts`
- Frontend: `prismatix-frontend/src/smartFetch.ts`, `prismatix-frontend/src/components/ChatInterface.tsx`
- Context source of truth: `prismatix_PROJECT_CONTEXT.md`
