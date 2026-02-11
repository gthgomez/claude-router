# Claude Router - Project Context

Last updated: 2026-02-11
Repository root: `C:\Users\icbag\Desktop\Project_SaaS\Claude_Router`

## 1) Project Scope
Claude Router is a full-stack chat app that currently routes requests across Claude 4.5 tiers (Haiku, Sonnet, Opus) based on query complexity, token context, and image usage.

## 2) Tech Stack
- Frontend: React 18 + Vite + TypeScript (`claude-router-frontend`)
- Backend: Supabase Edge Function on Deno (`supabase/functions/router`)
- Database: Supabase Postgres (`conversations`, `messages`, `increment_token_count` RPC)
- Auth: Supabase Auth JWT
- Storage: Supabase Storage bucket `chat-uploads` (optional/non-blocking)
- Upstream LLM provider (current): Anthropic Messages API

## 3) Current Runtime Architecture
- Client sends `query`, `history`, optional image attachments, and optional manual `modelOverride`.
- Edge Function validates auth token, validates/creates conversation ownership, computes route decision, calls Anthropic stream API, proxies SSE back to client.
- Request and response text are persisted to `messages`; tokens are rolled up to `conversations.total_tokens`.

## 4) Key Directories
- `claude-router-frontend/src/components/ChatInterface.tsx`: main chat UI, model selector, streaming rendering
- `claude-router-frontend/src/smartFetch.ts`: auth-aware router calls, payload construction, response-header parsing
- `claude-router-frontend/src/types.ts`: shared frontend model/types contract
- `supabase/functions/router/router_logic.ts`: routing algorithm + model map + override normalization + multimodal transforms
- `supabase/functions/router/index.ts`: edge function entrypoint, auth/DB checks, upstream call, SSE proxy
- `supabase/migrations/20260210000000_init_conversations_messages.sql`: schema, RLS, token RPC
- `Tests/Router_test_v2.ts`: routing logic tests

## 5) Current Model Routing (As Implemented)
Model keys in router logic:
- `haiku-4.5` -> `claude-haiku-4-5-20251001`
- `sonnet-4.5` -> `claude-sonnet-4-5-20250929`
- `opus-4.5` -> `claude-opus-4-5-20251101`

Behavior summary:
- Manual override wins when valid.
- Images bias toward Sonnet/Opus depending on complexity and token load.
- High complexity or very high context routes to Opus.
- Low complexity/short prompts can route to Haiku.
- Default fallback is Sonnet.

## 6) Contracts to Preserve
Backend response headers currently consumed by frontend:
- `X-Claude-Model`
- `X-Claude-Model-Id`
- `X-Model-Override`
- `X-Router-Rationale`
- `X-Complexity-Score`

Frontend type coupling:
- `ClaudeModel` union in `src/types.ts`
- `MODEL_CONFIG` map in `ChatInterface.tsx`
- `askClaude()` return model typing in `smartFetch.ts`

## 7) Data + Security Constraints
- Conversations/messages enforce RLS by `auth.uid()` ownership.
- Edge function currently uses service role for DB operations and validates ownership in code.
- Function rejects missing auth, missing conversation ID, invalid JSON, oversized query.
- Image storage upload failure is non-blocking (chat still works via base64 payload).

## 8) Known Gaps / Technical Debt
- Provider naming is Claude-specific in both types and headers (`ClaudeModel`, `X-Claude-*`).
- Router currently hardwired to Anthropic endpoint and message schema.
- No provider abstraction layer (transform + stream parser + error mapping).
- Test coverage is mostly routing logic; limited provider-integration coverage.
- Existing root `CONTEXT_OPTIMIZED_PATCHED.json` contains stale/duplicated sections and should not be treated as canonical source without refresh.

## 9) Planned Expansion Context (Next Milestone)
Goal: add multi-provider routing with Gemini 3 family and latest GPT mini while keeping current Claude path stable.

As of 2026-02-11, provider docs indicate:
- Gemini 3 Pro / Gemini 3 Flash are available as preview models.
- GPT-5 mini exists in OpenAI model docs with current snapshot notation.

Action implication:
- Keep Claude path as baseline.
- Add provider registry + adapters.
- Preserve existing frontend contract first, then introduce provider-generic naming.

## 10) New Chat Onboarding Checklist
If starting a fresh coding session, do this first:
1. Read `supabase/functions/router/router_logic.ts` and `supabase/functions/router/index.ts`.
2. Read `claude-router-frontend/src/types.ts`, `claude-router-frontend/src/smartFetch.ts`, and `claude-router-frontend/src/components/ChatInterface.tsx`.
3. Confirm which contract changes are allowed (headers, model enum, override format).
4. Run focused tests (`Tests/Router_test_v2.ts`) before and after routing changes.
5. Keep backward compatibility for existing frontend parsing unless explicitly migrating to v2 contract.

## 11) Suggested Prompt For A New Chat
"Use `PROJECT_CONTEXT.md` as source-of-truth. Plan and implement multi-provider routing in Claude Router with backward-compatible response headers, adding Gemini 3 (preview family) and GPT-5 mini. Start with contract-safe backend adapter architecture, then update frontend model typing and selector. Include tests and migration notes."