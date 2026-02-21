# Prismatix - Project Context (Two-Tier LLM Format)

Last updated: 2026-02-20
Repository root: `C:\Users\icbag\Desktop\Project_SaaS\Prismatix`
Verification basis: Local workspace code scan on 2026-02-20 (not a production deployment verification).

## Tier 1: Core Context (Load First)

Use this tier for most coding tasks. It is optimized for fast orientation and minimal token cost.

### 1) System Snapshot

Prismatix is a routed chat system:

1. Authenticated frontend sends a request to the Supabase `router` Edge Function.
2. Router chooses provider/model (Anthropic, OpenAI, Google) using deterministic routing logic.
3. Router calls upstream provider stream API and normalizes output into provider-agnostic SSE events.
4. Frontend renders normalized stream and uses router response headers for model/provider/cost metadata.
5. Router persists messages, token counts, memory snapshots, and cost logs.

### 2) Primary Invariants

- Frontend must parse only the normalized SSE contract, not provider-native stream shapes.
- Router response headers are a stable API contract and must be updated in lockstep with frontend parsing.
- `conversationId` ownership must always be verified server-side before reading/writing data.
- `video-intake/init` ownership check is conditional: if `conversationId` exists in DB, it must match `auth.user.id`; if missing, allow upload for authenticated users (new conversation bootstrap path), and persist `video_assets.conversation_id = null` until the conversation row exists (avoids FK insert failure).
- `smartFetch` one-time 401 retry then local sign-out behavior must remain intact.
- Provider availability normalization (post-route fallback) must remain active.
- Video requests (`videoAssetIds` present) default to `gemini-3.1-pro` unless a manual model override is supplied; normal provider-availability fallback still applies.
- Timeout behavior must keep `AbortError -> HTTP 504` mapping.

### 3) Canonical Router Contract

#### Request payload (router)

Required:
- `query: string`
- `conversationId: string`
- `platform: 'web' | 'mobile'`
- `history: Array<{ role, content }>`

Optional:
- `images: Array<{ data, mediaType }>`
- `videoAssetIds: string[]`
- `modelOverride: RouterModel`
- `geminiFlashThinkingLevel: 'low' | 'high'`
- `mode: 'debate'` — activate Debate Mode (ship-safe, off by default via env flag)
- `debateProfile: 'general' | 'code' | 'video_ui'` — challenger set for debate (default: `'general'`)
- Legacy image compatibility fields: `imageData`, `mediaType`, `imageStorageUrl`

#### Response headers (router)

Stable contract (frontend parsing):
- `X-Router-Model`
- `X-Router-Model-Id`
- `X-Provider`
- `X-Model-Override` — value is `"debate:<profile>"` only when debate is explicitly requested and debate actually runs; `"auto"` or override value otherwise
- `X-Router-Rationale`
- `X-Complexity-Score`
- `X-Gemini-Thinking-Level`
- `X-Memory-Hits`
- `X-Memory-Tokens`
- `X-Cost-Estimate-USD`
- `X-Cost-Pricing-Version`

Additive (debate mode, present only when debate is active; absent otherwise):
- `X-Debate-Mode` — `"true"`
- `X-Debate-Profile` — `"general"` | `"code"` | `"video_ui"`
- `X-Debate-Trigger` — `"explicit"` | `"auto"`
- `X-Debate-Model` — synthesis model tier used for debate response (debug header; emitted only when debate ran)
- `X-Debate-Cost-Note` — `"partial"` when debate is active (synthesis cost only tracked)

#### SSE stream shape

Normalized event payload:
- `data: { "type": "content_block_delta", "delta": { "text": "..." } }`

Stream terminator:
- `data: [DONE]`

### 4) Routing Rules (Current)

Manual override wins first.

If request has video assets:
- Default to `gemini-3.1-pro` (`video-default-pro`)

If request has images (and no video assets):
- Complexity >= 70 or totalTokens > 60000 -> `gemini-3.1-pro` (`images-complex`)
- Complexity <= 30 and totalTokens < 30000 -> `gemini-3-flash` (`images-fast`)
- Else -> `gemini-3-flash` (`images-default-flash`)

If request has no images and no video assets:
- Code-heavy + complexity >= 45 + totalTokens < 90000 -> `sonnet-4.6` (`code-quality-priority`)
- Complexity >= 80 or totalTokens > 100000 -> `opus-4.6` (`high-complexity`)
- Complexity <= 18 + queryTokens < 80 + totalTokens < 12000 -> `gpt-5-mini` (`ultra-low-latency`)
- Complexity <= 25 + queryTokens < 100 + totalTokens < 10000 -> `haiku-4.5` (`low-complexity`)
- Else -> `gemini-3-flash` (`default-cost-optimized`)

Provider readiness fallback order:
- `gemini-3-flash` -> `gpt-5-mini` -> `sonnet-4.6`

### 5) Start Here (Hot Paths)

Backend hot files:
- `supabase/functions/router/router_logic.ts`
- `supabase/functions/router/index.ts`
- `supabase/functions/router/cost_engine.ts`
- `supabase/functions/router/pricing_registry.ts`

Frontend hot files:
- `prismatix-frontend/src/smartFetch.ts`
- `prismatix-frontend/src/components/ChatInterface.tsx`
- `prismatix-frontend/src/modelCatalog.ts`
- `prismatix-frontend/src/types.ts`
- `prismatix-frontend/src/services/storageService.ts`

### 6) Fast Validation Commands (PowerShell)

```powershell
# Core file anchors
rg --files | rg "prismatix_PROJECT_CONTEXT.md|router_logic.ts|supabase\\functions\\router\\index.ts|prismatix-frontend\\src\\smartFetch.ts|prismatix-frontend\\src\\components\\ChatInterface.tsx"

# Route decisions and rationale tags
rg -n "determineRoute|manual-override|video-default-pro|images-complex|images-fast|code-quality-priority|high-complexity|ultra-low-latency|low-complexity|default-cost-optimized" supabase/functions/router/router_logic.ts

# Header contract and timeout/upstream error paths
rg -n "X-Router-Model|X-Router-Model-Id|X-Provider|X-Model-Override|X-Router-Rationale|X-Complexity-Score|X-Gemini-Thinking-Level|X-Memory-Hits|X-Memory-Tokens|X-Cost-Estimate-USD|X-Cost-Pricing-Version|Upstream provider error|Request timeout" supabase/functions/router/index.ts prismatix-frontend/src/smartFetch.ts

# Frontend retry and stream parsing behavior
rg -n "401 from router, retrying once|router-401-after-retry|content_block_delta|Stream error" prismatix-frontend/src/smartFetch.ts prismatix-frontend/src/components/ChatInterface.tsx
```

## Tier 2: Extended Context (Load As Needed)

Use this tier for architecture changes, debugging unfamiliar areas, onboarding, and refactors.

### 7) Architecture and Trust Boundaries

Request path:

```text
Browser (authenticated)
  -> prismatix-frontend (smartFetch + ChatInterface)
  -> Supabase Edge Function router
      - auth + ownership checks
      - route decision + provider readiness normalization
      - upstream stream call + SSE normalization
      - persistence (messages, tokens, memory, cost logs)
  -> Supabase Postgres + Storage
```

Trust boundaries:
- Browser input is untrusted.
- Router is enforcement boundary for auth/ownership and payload constraints.
- Provider APIs are unreliable external dependencies.
- Frontend trusts router-normalized contract, not provider payloads.

### 8) Practical File Map

#### Repository roots

- `prismatix-frontend/`: React + Vite + TypeScript frontend.
- `supabase/functions/`: Edge Functions runtime.
- `supabase/migrations/`: schema evolution.
- `Tests/`: Deno unit tests for routing and cost logic.
- `.gemini/settings.json`: workspace Gemini CLI overrides for this repo (currently pins `model.name` to `gemini-3.1-pro-preview` to avoid auto-selection of the `-customtools` 3.1 variant in API-key auth sessions).
- `SQL/`: helper snippets/exported diagnostics (not canonical schema source).

#### Backend function map

- `supabase/functions/router/index.ts`: Router runtime entrypoint (auth, fallback, provider calls, stream normalization, persistence, memory, cost, headers).
- `supabase/functions/router/router_logic.ts`: Pure routing logic, model registry, override normalization, token heuristics, provider payload transforms.
- `supabase/functions/router/provider_payloads.ts`: Provider request payload builders used by router call adapters (Anthropic/OpenAI/Google).
- `supabase/functions/router/sse_normalizer.ts`: Canonical normalized SSE stream builder (`content_block_delta` + single `[DONE]` terminator).
- `supabase/functions/router/debate_runtime.ts`: Debate eligibility/media gating, debate header emission, synthesis-cost message serialization.
- `supabase/functions/router/cost_engine.ts`: server-side cost estimation/finalization using pricing registry.
- `supabase/functions/router/pricing_registry.ts`: model price table and pricing version.
- `supabase/functions/video-intake/index.ts`: video upload init/complete API, signed upload URL flow.
- `supabase/functions/video-status/index.ts`: polling endpoint for video processing status.
- `supabase/functions/video-worker/index.ts`: queue worker; now runs a staged extraction scaffold (`thumbnail`, `transcript`, `frame`, `summary`) with optional Gemini summary synthesis hook and metadata for later ffmpeg/STT integration.
- `supabase/functions/spend_stats/index.ts`: spend stats endpoint (underscore name).
- `supabase/functions/spend-stats/index.ts`: spend stats endpoint (hyphen name); currently near-duplicate of underscore variant.

#### Frontend map

- `prismatix-frontend/src/App.tsx`: auth gating and recovery flow switch.
- `prismatix-frontend/src/hooks/useAuth.ts`: session state, stale refresh-token handling, auth APIs.
- `prismatix-frontend/src/lib/supabase.ts`: singleton Supabase client.
- `prismatix-frontend/src/smartFetch.ts`: authenticated router calls, 401 retry, payload build, header parse.
- `prismatix-frontend/src/debateMode.ts`: debate-mode UI helpers (selector payload mapping, ready-video eligibility, badge visibility guard).
- `prismatix-frontend/src/components/ChatInterface.tsx`: main UI orchestration, streaming read loop, model override UI, attachment handling, budget/cost display.
- `prismatix-frontend/src/services/storageService.ts`: image upload + video upload/poll orchestration.
- `prismatix-frontend/src/services/financeTracker.ts`: local spend cache helpers.
- `prismatix-frontend/src/costEngine.ts`: client-side cost estimation/final calculation.
- `prismatix-frontend/src/modelCatalog.ts`: model metadata used by UI.
- `prismatix-frontend/src/types.ts`: shared front-end type contracts.

### 9) Database and Migration Map

Migration order (current files):

1. `supabase/migrations/20260210000000_init_conversations_messages.sql`
2. `supabase/migrations/20260211070000_add_user_memory.sql`
3. `supabase/migrations/20260212090000_add_cost_logs.sql`
4. `supabase/migrations/20260216100000_add_video_pipeline.sql`
5. `supabase/migrations/20260216103000_schedule_video_worker_cron.sql`

Primary tables/functions:
- Chat: `public.conversations`, `public.messages`, `public.increment_token_count(...)`
- Memory: `public.user_memories`, `public.conversation_memory_state`
- Spend: `public.cost_logs`, `public.get_spend_stats(...)`
- Video: `public.video_assets`, `public.video_jobs`, `public.video_artifacts`

Storage buckets referenced:
- `chat-uploads`
- `video-uploads`
- `video-artifacts`

### 10) Environment Variable Matrix

Backend (`supabase/functions/router/index.ts` and related functions):

Required baseline:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Provider credentials (at least one provider must be ready):
- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `GOOGLE_API_KEY`

Feature flags:
- `ENABLE_ANTHROPIC` (default true)
- `ENABLE_OPENAI` (default true)
- `ENABLE_GOOGLE` (default true)
- `ENABLE_VIDEO_PIPELINE` (default false)
- `DEV_MODE` (default false)
- `ENABLE_DEBATE_MODE` (default false) — master switch for Debate Mode
- `ENABLE_DEBATE_AUTO` (default false) — auto-trigger when complexity ≥ threshold
- `DEBATE_COMPLEXITY_THRESHOLD` (default 85) — auto-trigger threshold
- `DEBATE_WORKER_MAX_TOKENS_GENERAL` (default 400) — challenger token budget cap for general profile
- `DEBATE_WORKER_MAX_TOKENS_CODE` (default 700) — challenger token budget cap for code profile
- Debate Mode is also triggerable explicitly via request body `mode: "debate"`

Video worker:
- `VIDEO_WORKER_SECRET` (optional; if unset, worker allows requests without secret)

Frontend (`prismatix-frontend/src/config.ts`):

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_ROUTER_ENDPOINT` (if omitted, derived from `VITE_SUPABASE_URL`)
- `VITE_ENABLE_VIDEO_PIPELINE`

### 11) Test Map

- `Tests/Router_test_v2.ts`: route selection and override behavior.
- `Tests/CostEngine_test.ts`: cost estimator behavior.
- `Tests/Router_test_UPDATED.ts`: secondary/legacy router test file (review before relying on it as canonical).

Recommended checks:

```powershell
cd prismatix-frontend
npm run build
npm run type-check

cd ..
deno check supabase/functions/router/index.ts
deno test Tests/Router_test_v2.ts
deno test Tests/CostEngine_test.ts
```

### 12) Known Drift Risks

- Header contract drift: if backend adds/removes headers, update `smartFetch.ts` and UI metadata usage together.
- Duplicate spend stats folders: `spend_stats` and `spend-stats` can cause deployment ambiguity.
- Non-canonical docs: some frontend docs are stale versus current file layout (`src/components/ChatInterface.tsx` is current path).
- Cron migration hardcodes a Supabase function URL; treat as environment-specific.

### 13) Extension Playbooks

#### Add model in existing provider

1. Update `MODEL_REGISTRY` in `router_logic.ts`.
2. Extend override mapping in `normalizeModelOverride`/`OVERRIDE_SYNONYMS`.
3. Adjust `determineRoute` thresholds/branches if needed.
4. Update frontend types/catalog (`types.ts`, `modelCatalog.ts`).
5. Add tests in `Tests/Router_test_v2.ts`.

#### Add new provider

1. Extend provider union and model registry in `router_logic.ts`.
2. Add provider adapter + delta extraction in `router/index.ts`.
3. Wire provider into `callProviderStream` and readiness checks.
4. Preserve normalized SSE output contract.
5. Extend frontend provider/model types and UI.
6. Add route/fallback and failure-path tests.

### 14) Context Refresh Protocol (Per-Run Maintenance)

This repository uses an explicit context maintenance cycle.

At the end of each coding run:

1. Re-scan touched files and adjacent dependencies.
2. Update Tier 1 if contracts, invariants, hot paths, or core flow changed.
3. Update Tier 2 file map when you discover new critical modules, endpoints, migrations, or data flows.
4. Append a short note in "Run Discoveries" with date and what was learned or changed.
5. If you encountered confusion, add a dated "future tips" note describing the root cause and fastest resolution path.
6. If no changes were needed, append a "no drift detected" note.

### 15) Future Tips Entry Template

Use this format when adding a confusion-resolution note:

```text
- YYYY-MM-DD [Future Tip] Area: <module/path>
  Trigger: <what caused confusion/failure>
  Root cause: <actual reason>
  Resolution path: <fastest steps/commands/files to resolve>
  Guardrail: <what to check next time to avoid repeat>
```

Example:

```text
- 2026-02-19 [Future Tip] Area: supabase/functions
  Trigger: spend stats endpoint changed but deploy target was unclear.
  Root cause: both spend_stats and spend-stats directories exist.
  Resolution path: verify active function name in deploy command and dashboard, then update docs.
  Guardrail: check for duplicate function folders before release.
```

### 17) Debate Mode Architecture (added 2026-02-19)

#### Design

Debate Mode is a router "tool" (like streaming or thinking level) that runs multi-model critique before synthesis. All of it is server-side and transparent to frontend contract parsing.

**Flow when active:**
1. `parseDebateRequest()` reads `mode` and `modelOverride` from body to detect explicit request.
2. `getDebatePlan()` selects 1–2 cheap challenger models (never the same tier as primary).
3. Challengers run in parallel via `Promise.all`; each has its own `AbortController` with bounded timeout (10–12 s).
4. Challenger streams are consumed to text via `consumeUpstreamToText()` and bounded by `maxChallengerChars`.
5. If zero challengers succeed → silent fallback to normal single-provider path.
6. `buildSynthesisPrompt()` injects debate notes into a new user message.
7. Synthesis calls `callProviderStream(decision, synthesisMessages, ...)` — the PRIMARY decision model, reusing the existing normalization chain.
8. `createNormalizedProxyStream` + persistence pipeline run unchanged.

**Profiles:**
- `general`: skeptic (gpt-5-mini) + synthesist (gemini-3-flash)
- `code`: critic (gpt-5-mini) + implementer (haiku-4.5)
- `video_ui`: UI Designer Critic + Product QA / UX Researcher + Customer Persona (workers + synthesis forced to Gemini ladder; video-only eligibility)

**Image/video requests:** never enter debate mode (MVP gate).

**Files:**
- `supabase/functions/router/debate_profiles.ts` — profile configs, pure helpers
- `supabase/functions/router/debate_prompts.ts` — prompt builders
- `supabase/functions/router/debate_runtime.ts` — debate eligibility/gating, debate header construction, synthesis cost serialization
- `supabase/functions/router/debate_runtime.ts` — debate eligibility/gating (including `video_ui`), timeout fallback helper, debate header construction, synthesis cost serialization
- `supabase/functions/router/provider_payloads.ts` — provider max-token payload mapping helpers
- `supabase/functions/router/sse_normalizer.ts` — normalized stream helper shared by router/tests
- `supabase/functions/router/index.ts` — integration (imports, env flags, helpers, branch logic, headers)
- `Tests/Debate_test.ts` — 55 tests (eligibility, prompts, SSE contract, header regression, runtime helper contract checks including `video_ui` + timeout fallback)

### 16) Run Discoveries

- 2026-02-19: Added missing cost headers (`X-Cost-Estimate-USD`, `X-Cost-Pricing-Version`) to canonical contract.
- 2026-02-19: Expanded map to include video pipeline (`video-intake`, `video-status`, `video-worker`) and spend stats endpoints.
- 2026-02-19: Noted duplicate function directories (`spend_stats` and `spend-stats`) that may create deployment ambiguity.
- 2026-02-19: Updated command examples for PowerShell-friendly path matching.
- 2026-02-19: Marked older frontend structure docs as non-canonical when they conflict with `src/components/*` layout.
- 2026-02-19: Added a reusable "Future Tips entry template" section to standardize confusion-resolution notes.
- 2026-02-19: Added root `Claude.md` aligned with current context-sync and contract-first workflow.
- 2026-02-19: Implemented Debate Mode (ship-safe multi-model critique + synthesis). New files: `debate_profiles.ts`, `debate_prompts.ts`. Modified: `index.ts` (imports, CORS expose headers, env flags, helper functions, upstream branch, response headers). Updated `router_logic.ts` sonnet-4.5 modelId to `claude-sonnet-4-6-20260218`. Added `Tests/Debate_test.ts` (27 tests, all green). Contract regression confirmed: `deno check` clean, all 41 tests pass. Debate headers are additive only; SSE format and all 11 existing response headers unchanged.
- 2026-02-19: Patched Debate Mode (A/B/C/D correctness gaps). A: Added worker token budget caps (DEBATE_WORKER_MAX_TOKENS_GENERAL=400, DEBATE_WORKER_MAX_TOKENS_CODE=700) applied via `budgetCap` spread on `workerDecision`; prevents cost runaway independent of text truncation. B: Extended media gate to include video assets (`hasAnyMedia = hasImages || hasVideoAssets`); both explicit and auto debate are blocked when video is present. C: Debate headers (`X-Debate-Mode/Profile/Trigger/Cost-Note`) now emitted only via conditional spread when `debateActive===true`; absent (not "false") when debate inactive — matches spec. D: When debate ran, `X-Cost-Estimate-USD` is recomputed from actual `synthesisMessages` using `calculatePreFlightCost`; challenger costs remain excluded and flagged by `X-Debate-Cost-Note: partial`. Also added `DebateRunResult` interface to carry `synthesisMessages` back to the call site without globalThis or re-mutation. Tests: 41/41 pass (14 new patch tests added); all existing router+cost tests unaffected.
- 2026-02-19: no drift detected during working-tree status check run (no code/document contract changes applied in this run).
- 2026-02-19: Working-tree hygiene pass: ran 'git add -A' to collapse delete/add churn into rename tracking (entries reduced 109 -> 82; many claude-router-frontend -> prismatix-frontend renames now explicit).
- 2026-02-19: Resolved duplicate edge function naming by standardizing on 'spend_stats' (matches supabase/config.toml and frontend endpoint). Removed secondary 'spend-stats' path fallback from frontend and retired duplicate function folder.
- 2026-02-19: no drift detected during branch/deployment audit run (validated main vs origin/main divergence and deployment workflow signals; no code/config changes applied).
- 2026-02-19: Validated Debate Mode patch claims A/B/C/D against runtime code and upgraded tests to cover real helpers used by `index.ts`. Added `provider_payloads.ts`, `sse_normalizer.ts`, and `debate_runtime.ts` to centralize request payload mapping, normalized SSE output, and debate gating/header/cost helper logic without changing router contracts. Updated `Tests/Debate_test.ts` with runtime helper assertions (SSE `[DONE]` once, provider token param mapping, media gating, header absence rules, synthesis-only cost serialization). Verification: `deno check` (targeted files), `deno lint` (targeted files), and `deno test` (Debate/Cost/Router suites) all green.
- 2026-02-19 [Future Tip] Area: repo docs (`OLS-v5-STREAMLINED.md`)
  Trigger: User requested OLS-v5-STREAMLINED rules but file was not present in workspace.
  Root cause: File naming drift (`OLS_V5_MULTI_PROVIDER_PLAN.md` exists instead, with different content scope).
  Resolution path: run `rg --files | rg "OLS|STREAMLINED"` first, then confirm intended file with user before applying doc-specific compliance gates.
  Guardrail: treat missing mandated docs as a blocking ambiguity for validation/reporting style, and record the fallback source used.
- 2026-02-19: Added Debate profile `video_ui` for video-only explicit debate requests. Request parsing now accepts `debateProfile: "video_ui"` and `modelOverride: "debate:video_ui"`. Debate eligibility for this profile requires video assets and no images; non-eligible requests silently follow the normal non-debate path. Implemented Gemini-only debate model ladder (`DEBATE_VIDEO_UI_MODEL_LADDER`, default `gemini-3-pro,gemini-3-flash`), strict worker/synthesis caps, one-time video artifact note extraction (structured JSON with timestamps), and stage wall-clock timeout fallback (`DEBATE_VIDEO_UI_STAGE_TIMEOUT_MS`). Added optional debug header `X-Debate-Model` emitted only when debate runs. Verified with `deno check`, `deno lint`, and `deno test` (72 passing tests across Debate/Cost/Router suites).
- 2026-02-19: no drift detected during frontend planning-only run for Debate Mode UI integration (no code changes applied in this run).
- 2026-02-19: Frontend Debate Mode UI integration shipped additively. Updated `types.ts` with optional `mode: 'debate'` + `debateProfile` request fields and assistant message debate metadata fields. `smartFetch.ts` now sends debate fields only when enabled, parses `X-Debate-*` headers (including `X-Debate-Mode: true`), and keeps existing SSE/normalized stream handling untouched. `ChatInterface.tsx` now includes Debate selector (Off/General/Code/Video UI), enforces `video_ui` ready-video eligibility before send with explicit UI error text, and renders compact assistant-only debate badges (profile/trigger/model/cost note) when debate metadata exists. Added targeted tests: `src/smartFetch.test.ts` and `src/components/ChatInterface.test.ts` (6 passing via Vitest). `npm run type-check` and `npm run test` pass in `prismatix-frontend`; `npm run lint` is currently blocked because no ESLint config file exists in this package.
- 2026-02-19 [Future Tip] Area: `prismatix-frontend` verification
  Trigger: `npm run lint` failed immediately despite code changes being type-safe and test-clean.
  Root cause: No ESLint config is present in `prismatix-frontend` (script exists, config file missing).
  Resolution path: either add the project-standard ESLint config (recommended) or mark lint as intentionally unavailable in CI/local docs until config is restored.
  Guardrail: when reporting validation results, explicitly distinguish "code lint errors" from "tooling not configured" to avoid false regression signals.
- 2026-02-19: no drift detected during preview deployment run. Deployed current HEAD to Vercel preview for manual QA (`vercel --yes`) and verified successful build/deploy output with a live preview URL.
- 2026-02-19: Fixed frontend video attachment classification and upload handoff diagnostics for manual QA findings. `ChatInterface.tsx` now normalizes video detection by `kind` + MIME + filename extension before queuing uploads, logs the real attachment kind (no longer labeling all non-images as "text"), and excludes videos from `hasTextFiles` prompt heuristics. `FileUpload.tsx` expanded video MIME recognition (`video/*` plus explicit fallbacks like `application/mp4`) and now carries the original `file` reference/`mediaType` in non-video payloads so kind normalization can recover safely. `storageService.ts` gained explicit `[Storage][Video]` init/upload/finalize logs to distinguish video pipeline path from image bucket uploads. Validation: `npm run type-check` and `npm run test` both pass in `prismatix-frontend`.
- 2026-02-19: no drift detected during fresh preview deployment run for live QA. Deployed latest workspace state via `vercel --yes` and verified successful build/deploy output with a new preview URL.
- 2026-02-19: Updated `supabase/functions/video-intake/index.ts` init ownership logic for new-conversation uploads. Kept `.maybeSingle()` lookup, changed behavior to: 500 on lookup error, 403 only when conversation exists and belongs to a different user, and allow (with explicit log) when conversation row does not yet exist for an authenticated user. Verified with `deno check supabase/functions/video-intake/index.ts`.
- 2026-02-19: no drift detected during preview deployment run. Deployed latest workspace state via `vercel --yes` and confirmed successful build/output publish with a new preview URL.
- 2026-02-19: Deployed updated `video-intake` Edge Function to project `sqjfbqjogylkfwzsyprd` via `supabase functions deploy video-intake` after confirming local code had new-conversation ownership fallback (`maybeSingle` + allow missing conversation rows for authenticated users). This resolved stale-runtime mismatch where preview frontend was still hitting an older function version returning `403 Forbidden: Invalid conversation ownership` for first-upload/new-chat video init.
- 2026-02-19: Fixed `video-intake/init` insert failure for new conversations. Root cause: `video_assets.conversation_id` has FK to `conversations.id`; when conversation row was missing, insert still attempted `conversation_id=<new uuid>` and returned `500 Failed to create upload session`. Patch: introduced `conversationIdForAsset`, set to `null` when lookup returns no row, keep strict 403 for cross-user ownership, and use resolved value for insert. Verified with `deno check` and deployed via `supabase functions deploy video-intake` to `sqjfbqjogylkfwzsyprd`.
- 2026-02-19: Fixed video request ingestion gap in router and upload-progress UX jitter. Router previously validated `videoAssetIds` but did not inject video artifact content into non-debate prompts, causing models to report no video visibility. Added compact `Video Context` block assembly from `video_assets` + `video_artifacts` and inject it into `effectiveQuery` for any request with ready video assets. Frontend `ChatInterface.tsx` video status polling now keeps `uploadProgress` monotonic (`max(current, polled)`) so progress no longer drops from 100% back to 30% while worker transitions uploaded -> processing -> ready. Validation: `deno check supabase/functions/router/index.ts`, `npm run type-check`, `npm run test` all pass.
- 2026-02-19: Deployed updated `router` Edge Function to project `sqjfbqjogylkfwzsyprd` and deployed fresh Vercel preview containing frontend progress fix (`vercel --yes`).
- 2026-02-19: no drift detected during architecture-claim validation run. Re-scanned `video-intake`, `video-status`, `video-worker`, router video validation/context-injection path, and video pipeline migrations to verify actual runtime behavior versus external claim wording; no code changes were applied in this run.
- 2026-02-19: Implemented video-first routing and worker extraction scaffold. Routing now defaults to `gemini-3-pro` for requests with `videoAssetIds` via `determineRoute` (`video-default-pro`) while preserving manual override and provider fallback behavior. Added router parameter `hasVideoAssets` and regression test coverage in `Tests/Router_test_v2.ts`. `video-worker` now builds staged scaffold artifacts (`thumbnail`, `transcript`, `frame`, `summary`) with structured metadata and optional Gemini summary synthesis (`ENABLE_VIDEO_WORKER_GEMINI_SUMMARY`) to provide a concrete integration path for future ffmpeg/STT stages. Validation: `deno check` on router/worker files and `deno test Tests/Router_test_v2.ts Tests/Router_test_UPDATED.ts` all green. Deployed updated `router` and `video-worker` to project `sqjfbqjogylkfwzsyprd`.
- 2026-02-19: no drift detected during architecture/advisory run on full ffmpeg/STT roadmap and UI-analysis strategy tradeoffs (guidance-only; no additional code changes beyond prior deployed state).
- 2026-02-20: Added workspace Gemini CLI override at `.gemini/settings.json` with `model.name = gemini-3.1-pro-preview` to force the regular Gemini 3.1 Pro Preview model for this repository instead of the API-key-auth auto-selected `gemini-3.1-pro-preview-customtools` variant.
- 2026-02-20 [Future Tip] Area: Gemini CLI model selection (`.gemini/settings.json`, `~/.gemini/settings.json`)
  Trigger: Selecting "Gemini 3.1 Pro Preview" via `/model` still resulted in `gemini-3.1-pro-preview-customtools` and quota exhaustion.
  Root cause: In Gemini CLI `0.29.5`, manual model selection maps the preview Pro option to the `-customtools` model value for `gemini-api-key` auth, while displaying the non-suffixed title.
  Resolution path: pin `model.name` to `gemini-3.1-pro-preview` in workspace settings or launch with `gemini --model gemini-3.1-pro-preview`; verify active model in session stats/log output.
  Guardrail: for API-key auth sessions, do not rely on `/model` label text alone when debugging quota issues; verify the concrete model id used in runtime/session logs.
- 2026-02-20: no drift detected during cross-repo Gemini settings/install audit. Verified `GPCGuard` already had the workspace model pin at `.gemini/settings.json` (`gemini-3.1-pro-preview`), confirmed core toolchain availability (`node`, `npm`, `deno`, `python`, `pip`, `gemini`, `supabase`), and validated repo dependency health via `npm ls` + type-checks (both repos), plus `python -m pytest scanners/tests -q` (GPCGuard, 264 passed). Noted Python package gaps versus listed requirements (`google-generativeai`, `pytest-timeout`, `pytest-html`) while current scanner tests still pass.
- 2026-02-20: no drift detected for Prismatix runtime contracts during GPCGuard package-install run. Installed previously missing GPCGuard Python dependencies (`google-generativeai`, `pytest-timeout`, `pytest-html`), verified with `pip show`, and re-ran `python -m pytest scanners/tests -q` (264 passed).
- 2026-02-20: no drift detected during Gemini project-identity fix run. Validated installed Gemini CLI (`0.29.5`) does not expose a documented `projectId` settings key in `.gemini/settings.json`; applied supported user-scope environment overrides instead: `GOOGLE_CLOUD_PROJECT=gen-lang-client-0908185798` and `GOOGLE_CLOUD_PROJECT_ID=gen-lang-client-0908185798` (plus `GEMINI_PROJECT_ID` for compatibility with external guidance).
- 2026-02-20: no drift detected in Prismatix runtime code during Gemini CLI quota/auth troubleshooting. Cleared local Gemini state by moving `%USERPROFILE%\\.gemini` to backup, verified API-key mode still fails on `gemini-3.1-pro-preview` with `generate_requests_per_model_per_day, limit: 0`, and re-created user settings with `security.auth.selectedType = oauth-personal` to force Google-login auth path instead of `gemini-api-key`.
- 2026-02-20 [Future Tip] Area: Gemini CLI auth mode (`%USERPROFILE%\\.gemini\\settings.json`)
  Trigger: Resetting local Gemini cache/state did not fix `429` quota errors (`limit: 0`) after first/early turns.
  Root cause: API-key auth path remained active and hit a per-model entitlement/quota ceiling; local state reset alone cannot bypass upstream model-tier limits.
  Resolution path: set user auth mode to `oauth-personal`, restart CLI in an interactive terminal, complete `/auth` Google login flow, then re-test model call.
  Guardrail: treat `limit: 0` as an upstream entitlement signal first; verify active auth mode (`gemini-api-key` vs `oauth-personal`) before spending time on local cache resets.
- 2026-02-20: no drift detected in Prismatix runtime code during post-login 403 troubleshooting. Verified user-scoped project override env vars were cleared, but OAuth requests still resolve to project `gen-lang-client-0908185798` and fail with `PERMISSION_DENIED` / `SERVICE_DISABLED` for `cloudaicompanion.googleapis.com` (Gemini for Google Cloud API). This confirms current blocker is API enablement/permission on the bound Google Cloud project, not local CLI cache.
- 2026-02-21: Model upgrade pass — all RouterModel keys and underlying API modelIds updated to latest versions. Renames: `opus-4.5`→`opus-4.6` (modelId: `claude-opus-4-6`), `sonnet-4.5`→`sonnet-4.6` (modelId: `claude-sonnet-4-6`), `gemini-3-pro`→`gemini-3.1-pro` (modelId: `gemini-3.1-pro-preview`), `gemini-3-flash` modelId→`gemini-3-flash-preview`. `haiku-4.5` and `gpt-5-mini` unchanged. Backwards-compat synonyms added in `OVERRIDE_SYNONYMS` and `parseVideoUiModelLadder` so existing client overrides and env vars using old strings still resolve. `googleAliasScore` fuzzy branches updated to cover both old and new alias strings. All tests in Router/Debate/Cost suites updated accordingly. `prismatix_PROJECT_CONTEXT.md` routing rules synced.
- 2026-02-20 [Future Tip] Area: Gemini CLI OAuth project binding (`cloudcode-pa.googleapis.com`)
  Trigger: After successful `/auth` login, requests failed with 403 `SERVICE_DISABLED` for `cloudaicompanion.googleapis.com` on project `gen-lang-client-0908185798`.
  Root cause: OAuth path is bound to a GCP project where Gemini for Google Cloud API is disabled; local model/env tweaks cannot bypass service-level deny.
  Resolution path: enable `cloudaicompanion.googleapis.com` on the bound project (or switch to a different enabled project/account), wait for propagation, then re-test.
  Guardrail: distinguish auth failures from service-enablement failures: `429 limit: 0` indicates quota/entitlement, while `403 SERVICE_DISABLED` indicates API activation missing for the resolved project.
