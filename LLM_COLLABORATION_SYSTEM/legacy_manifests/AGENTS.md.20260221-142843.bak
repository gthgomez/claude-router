# AGENTS.md

## Prismatix Local Agent Rules

Scope: Entire repository rooted at `C:\Users\icbag\Desktop\Project_SaaS\Prismatix`.

### 1) Mandatory Context Sync Every Run

At the end of every run, you must perform a context sync in `prismatix_PROJECT_CONTEXT.md`.

Required actions each run:

1. Re-scan files touched in the run plus directly related dependencies.
2. Update Tier 1 if any core behavior changed (contracts, invariants, routing, auth, fallback, stream shape).
3. Update Tier 2 file map if you discovered better project structure knowledge.
4. Add a dated note under `Run Discoveries` describing what changed or what was learned.
5. If you encountered confusion, add a dated "future tips" note with the root cause and resolution path.
6. If nothing changed, append a dated "no drift detected" entry.

### 2) File Map Discipline

Maintain a high-signal file map for LLM use:

- Include only files/modules that materially affect runtime behavior or debugging.
- Prefer concise purpose statements over exhaustive listings.
- Call out duplicate or ambiguous paths that may cause deployment/runtime confusion.
- Keep migration order and key tables/functions current.

### 3) Contract-First Updates

When backend/edge changes occur, always verify and sync:

- Router request payload fields.
- Router response headers.
- SSE event format expectations.
- Frontend parsing points in `prismatix-frontend/src/smartFetch.ts` and `prismatix-frontend/src/components/ChatInterface.tsx`.

### 4) Suggested Verification Commands

Run from repo root when updating context docs:

```powershell
rg --files | rg "prismatix_PROJECT_CONTEXT.md|router_logic.ts|supabase\\functions\\router\\index.ts|prismatix-frontend\\src\\smartFetch.ts|prismatix-frontend\\src\\components\\ChatInterface.tsx"
rg -n "X-Router-Model|X-Router-Model-Id|X-Provider|X-Model-Override|X-Router-Rationale|X-Complexity-Score|X-Gemini-Thinking-Level|X-Memory-Hits|X-Memory-Tokens|X-Cost-Estimate-USD|X-Cost-Pricing-Version" supabase/functions/router/index.ts prismatix-frontend/src/smartFetch.ts
rg -n "determineRoute|normalizeDecisionAgainstProviderAvailability|fallbackModel" supabase/functions/router/router_logic.ts supabase/functions/router/index.ts
```

### 5) Quality Bar for Context Docs

- Keep Tier 1 compact and execution-focused.
- Keep Tier 2 detailed but factual and code-verifiable.
- Mark unverified deployment data explicitly.
- Avoid stale speculative notes without a verification anchor.
