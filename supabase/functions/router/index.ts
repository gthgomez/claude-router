// index.ts - Multi-provider Router Edge Function (Anthropic + OpenAI + Google)

import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  countImageTokens,
  countTokens,
  determineRoute,
  type ImageAttachment,
  type Message,
  MODEL_REGISTRY,
  normalizeModelOverride,
  type Provider,
  type RouteDecision,
  type RouterModel,
  type RouterParams,
} from './router_logic.ts';
import { calculateCostBreakdown, calculatePreFlightCost } from './cost_engine.ts';
import {
  DEFAULT_DEBATE_THRESHOLD,
  getDebatePlan,
  type DebateProfile,
  type DebateTrigger,
} from './debate_profiles.ts';
import {
  buildChallengerPrompt,
  buildSynthesisPrompt,
  type ChallengerOutput,
} from './debate_prompts.ts';
import { createNormalizedProxyStream } from './sse_normalizer.ts';
import {
  type GeminiFlashThinkingLevel,
  buildAnthropicStreamPayload,
  buildGoogleStreamPayload,
  buildOpenAILegacyStreamPayload,
  buildOpenAIStreamPayload,
} from './provider_payloads.ts';
import {
  buildDebateHeaders,
  computeDebateEligibility,
  runDebateStageWithTimeout,
  selectDebateWorkerMaxTokens,
  serializeMessagesForCost,
} from './debate_runtime.ts';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

interface Conversation {
  id: string;
  user_id: string;
  total_tokens: number;
  created_at?: string;
}

interface MessageRecord {
  id?: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  token_count: number;
  model_used?: string | undefined;
  image_url?: string | undefined;
  created_at?: string;
}

interface CostLogRecord {
  id?: string;
  user_id: string;
  conversation_id: string;
  model: string;
  provider: string;
  input_tokens: number;
  output_tokens: number;
  thinking_tokens: number;
  input_cost: number;
  output_cost: number;
  thinking_cost: number;
  total_cost: number;
  pricing_version?: string;
  created_at?: string;
}

interface ConversationMessageRecord {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
}

interface UpstreamCallResult {
  response: Response;
  extractDeltas: (payload: unknown) => string[];
  effectiveModelId: string;
  effectiveGeminiFlashThinkingLevel?: GeminiFlashThinkingLevel;
}

interface GoogleModelRecord {
  name: string;
  supportedGenerationMethods: string[];
}

interface UserMemoryRecord {
  id: string;
  user_id: string;
  conversation_id: string | null;
  source_window_end_at: string;
  summary_text: string;
  tags: string[] | null;
  created_at: string;
}

interface ConversationMemoryStateRecord {
  conversation_id: string;
  user_id: string;
  last_summarized_at: string | null;
  last_summarized_message_created_at: string | null;
  last_summarized_total_tokens: number | null;
  updated_at: string;
}

interface MemoryRetrievalResult {
  contextBlock: string;
  hits: number;
  tokenCount: number;
}

interface VideoAssetReadyRecord {
  id: string;
  user_id: string;
  status: 'pending_upload' | 'uploaded' | 'processing' | 'ready' | 'failed' | 'expired';
}

interface VideoArtifactRecord {
  asset_id: string;
  kind: 'thumbnail' | 'frame' | 'transcript' | 'summary';
  seq: number | null;
  text_content: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

interface VideoAssetContextRecord {
  id: string;
  status: 'pending_upload' | 'uploaded' | 'processing' | 'ready' | 'failed' | 'expired';
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  updated_at: string | null;
}

// ============================================================================
// CONSTANTS & CONFIGURATION
// ============================================================================

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-client-info, apikey',
  'Access-Control-Expose-Headers':
    'X-Router-Model, X-Router-Model-Id, X-Provider, X-Model-Override, X-Router-Rationale, X-Complexity-Score, X-Gemini-Thinking-Level, X-Memory-Hits, X-Memory-Tokens, X-Cost-Estimate-USD, X-Cost-Pricing-Version, X-Debate-Mode, X-Debate-Profile, X-Debate-Trigger, X-Debate-Model, X-Debate-Cost-Note',
};

const FUNCTION_TIMEOUT_MS = 55000;
const MAX_QUERY_LENGTH = 50000;
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_VIDEO_ASSETS_PER_REQUEST = 4;
const VIDEO_IMAGE_TOKEN_ESTIMATE = 1600;
const VIDEO_TRANSCRIPT_TOKEN_ESTIMATE = 3000;
const VIDEO_MAX_FRAME_TOKENS = 8 * VIDEO_IMAGE_TOKEN_ESTIMATE;
const VIDEO_CONTEXT_MAX_CHARS = 5000;
const VIDEO_CONTEXT_MAX_ARTIFACT_ROWS = 36;
const DEV_MODE = Deno.env.get('DEV_MODE') === 'true';

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') || '';
const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY') || '';
const GOOGLE_API_KEY = Deno.env.get('GOOGLE_API_KEY') || '';

function envFlag(name: string, defaultValue: boolean): boolean {
  const raw = Deno.env.get(name);
  if (raw === null || raw === undefined || raw.trim() === '') return defaultValue;
  const normalized = raw.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  return defaultValue;
}

const ENABLE_ANTHROPIC = envFlag('ENABLE_ANTHROPIC', true);
const ENABLE_OPENAI = envFlag('ENABLE_OPENAI', true);
const ENABLE_GOOGLE = envFlag('ENABLE_GOOGLE', true);
const ENABLE_VIDEO_PIPELINE = envFlag('ENABLE_VIDEO_PIPELINE', false);

// Debate Mode flags (router "tool" toggle)
const ENABLE_DEBATE_MODE = envFlag('ENABLE_DEBATE_MODE', false);
const ENABLE_DEBATE_AUTO = envFlag('ENABLE_DEBATE_AUTO', false);
const DEBATE_COMPLEXITY_THRESHOLD = Number(Deno.env.get('DEBATE_COMPLEXITY_THRESHOLD') || '') ||
  DEFAULT_DEBATE_THRESHOLD;
// Per-challenger token budget caps — prevents cost runaway regardless of text truncation.
const DEBATE_WORKER_MAX_TOKENS_GENERAL = Number(Deno.env.get('DEBATE_WORKER_MAX_TOKENS_GENERAL') || '') || 400;
const DEBATE_WORKER_MAX_TOKENS_CODE = Number(Deno.env.get('DEBATE_WORKER_MAX_TOKENS_CODE') || '') || 700;
const DEBATE_WORKER_MAX_TOKENS_VIDEO_UI = Number(Deno.env.get('DEBATE_WORKER_MAX_TOKENS_VIDEO_UI') || '') || 420;
const DEBATE_VIDEO_UI_SYNTHESIS_MAX_TOKENS = Number(Deno.env.get('DEBATE_VIDEO_UI_SYNTHESIS_MAX_TOKENS') || '') || 900;
const DEBATE_VIDEO_UI_STAGE_TIMEOUT_MS = Number(Deno.env.get('DEBATE_VIDEO_UI_STAGE_TIMEOUT_MS') || '') || 18000;
const DEBATE_VIDEO_UI_NOTES_MAX_CHARS = Number(Deno.env.get('DEBATE_VIDEO_UI_NOTES_MAX_CHARS') || '') || 8000;

const GOOGLE_MODELS_CACHE_TTL_MS = 10 * 60 * 1000;
let googleModelsCache: { fetchedAt: number; models: GoogleModelRecord[] } | null = null;

const MEMORY_MAX_CANDIDATES = 24;
const MEMORY_MAX_INJECT = 3;
const MEMORY_MAX_CONTEXT_CHARS = 1500;
const MEMORY_SUMMARY_MIN_INTERVAL_MS = 10 * 60 * 1000;
const MEMORY_SUMMARY_MIN_TOKEN_DELTA = 2200;
const MEMORY_SUMMARY_MAX_MESSAGES = 24;
const MEMORY_SUMMARY_MIN_TRANSCRIPT_TOKENS = 220;

const MEMORY_STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'have',
  'your',
  'you',
  'are',
  'was',
  'were',
  'but',
  'not',
  'all',
  'any',
  'can',
  'will',
  'just',
  'about',
  'into',
  'over',
  'when',
  'what',
  'where',
  'how',
  'why',
  'use',
  'using',
  'need',
  'please',
]);

// ============================================================================
// PROVIDER HELPERS
// ============================================================================

function isProviderEnabled(provider: Provider): boolean {
  switch (provider) {
    case 'anthropic':
      return ENABLE_ANTHROPIC;
    case 'openai':
      return ENABLE_OPENAI;
    case 'google':
      return ENABLE_GOOGLE;
  }
}

function hasProviderCredentials(provider: Provider): boolean {
  switch (provider) {
    case 'anthropic':
      return !!ANTHROPIC_API_KEY;
    case 'openai':
      return !!OPENAI_API_KEY;
    case 'google':
      return !!GOOGLE_API_KEY;
  }
}

function isProviderReady(provider: Provider): boolean {
  return isProviderEnabled(provider) && hasProviderCredentials(provider);
}

function hasAtLeastOneProviderConfigured(): boolean {
  return isProviderReady('anthropic') || isProviderReady('openai') || isProviderReady('google');
}

function fallbackModel(): RouterModel | undefined {
  if (isProviderReady('google')) return 'gemini-3-flash';
  if (isProviderReady('openai')) return 'gpt-5-mini';
  if (isProviderReady('anthropic')) return 'sonnet-4.6';
  return undefined;
}

function normalizeGeminiFlashThinkingLevel(input?: string): GeminiFlashThinkingLevel {
  const normalized = String(input || '').trim().toLowerCase();
  if (normalized === 'low') return 'low';
  return 'high';
}

function decisionFromModel(
  modelTier: RouterModel,
  complexityScore: number,
  rationaleTag: string,
): RouteDecision {
  const modelCfg = MODEL_REGISTRY[modelTier];
  return {
    provider: modelCfg.provider,
    model: modelCfg.modelId,
    modelTier,
    budgetCap: modelCfg.budgetCap,
    rationaleTag,
    complexityScore,
  };
}

function normalizeDecisionAgainstProviderAvailability(
  decision: RouteDecision,
  normalizedOverride: RouterModel | undefined,
): { decision: RouteDecision; error?: string } {
  if (isProviderReady(decision.provider)) {
    return { decision };
  }

  if (normalizedOverride) {
    return {
      decision,
      error: `Requested model '${normalizedOverride}' requires provider '${decision.provider}', ` +
        `but it is not configured or enabled on the server.`,
    };
  }

  const fallback = fallbackModel();
  if (!fallback) {
    return {
      decision,
      error: 'No enabled provider has valid credentials configured on the server.',
    };
  }

  const fallbackDecision = decisionFromModel(
    fallback,
    decision.complexityScore,
    `provider-unavailable-fallback-${decision.provider}`,
  );

  return {
    decision: fallbackDecision,
  };
}

// ============================================================================
// DEBATE MODE HELPERS
// ============================================================================

function normalizeDebateProfile(input?: string): DebateProfile {
  const v = String(input || '').trim().toLowerCase();
  if (v === 'video_ui' || v === 'video-ui' || v === 'videoui') return 'video_ui';
  if (v === 'code' || v === 'coding') return 'code';
  return 'general';
}

function parseVideoUiModelLadder(input?: string): RouterModel[] {
  const fallback: RouterModel[] = ['gemini-3.1-pro', 'gemini-3-flash'];
  const raw = String(input || '')
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  if (raw.length === 0) return fallback;

  const out: RouterModel[] = [];
  for (const item of raw) {
    // Accept both new and old env var values for backwards compat
    if (item === 'gemini-3.1-pro' || item === 'gemini-3-pro') out.push('gemini-3.1-pro');
    if (item === 'gemini-3-flash') out.push('gemini-3-flash');
  }
  return out.length > 0 ? out : fallback;
}

const DEBATE_VIDEO_UI_MODEL_LADDER = parseVideoUiModelLadder(
  Deno.env.get('DEBATE_VIDEO_UI_MODEL_LADDER'),
);

function resolveVideoUiDebateModelTier(): RouterModel | null {
  for (const tier of DEBATE_VIDEO_UI_MODEL_LADDER) {
    if (isProviderReadyForModelTier(tier)) return tier;
  }
  return null;
}

function parseDebateRequest(inputMode?: string, rawModelOverride?: string, profile?: string): {
  requested: boolean;
  profile: DebateProfile;
  trigger: DebateTrigger;
  // If modelOverride is being used as a "debate toggle", suppress it from normalizeModelOverride()
  suppressModelOverride: boolean;
  overrideHeaderValue: string; // used for X-Model-Override when debate is explicit
} {
  const p = normalizeDebateProfile(profile);
  const mode = String(inputMode || '').trim().toLowerCase();
  const raw = String(rawModelOverride || '').trim().toLowerCase();

  // Explicit via body.mode = "debate"
  if (mode === 'debate') {
    return {
      requested: true,
      profile: p,
      trigger: 'explicit',
      suppressModelOverride: false,
      overrideHeaderValue: `debate:${p}`,
    };
  }

  // Compatibility: allow modelOverride = "debate" or "debate:<profile>"
  if (raw === 'debate' || raw.startsWith('debate:')) {
    const maybeProfile = raw.split(':')[1] || '';
    const pp = normalizeDebateProfile(maybeProfile);
    return {
      requested: true,
      profile: pp,
      trigger: 'explicit',
      suppressModelOverride: true,
      overrideHeaderValue: `debate:${pp}`,
    };
  }

  return {
    requested: false,
    profile: p,
    trigger: 'off',
    suppressModelOverride: false,
    overrideHeaderValue: '',
  };
}

function tryParseJson(input: string): unknown | undefined {
  try {
    return JSON.parse(input);
  } catch {
    return undefined;
  }
}

async function consumeUpstreamToText(
  upstream: UpstreamCallResult,
  signal: AbortSignal,
  maxChars: number,
): Promise<string> {
  if (!upstream.response.ok) return '';
  const body = upstream.response.body;
  if (!body) return '';

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let acc = '';

  try {
    while (true) {
      if (signal.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const dataStr = trimmed.slice(5).trim();
        if (!dataStr || dataStr === '[DONE]') continue;
        const payload = tryParseJson(dataStr);
        if (!payload) continue;
        const deltas = upstream.extractDeltas(payload);
        for (const d of deltas) {
          if (!d) continue;
          acc += d;
          if (acc.length >= maxChars) return acc.slice(0, maxChars - 1) + '…';
        }
      }
    }
  } catch {
    // ignore; treat as partial
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  }

  return acc.trim();
}

function isProviderReadyForModelTier(modelTier: RouterModel): boolean {
  const provider = MODEL_REGISTRY[modelTier].provider;
  return isProviderReady(provider);
}

interface DebateRunResult {
  upstream: UpstreamCallResult;
  synthesisMessages: Message[];
  debateModelTier: RouterModel;
  synthesisDecision: RouteDecision;
}

async function maybeRunDebateMode(params: {
  decision: RouteDecision;
  allMessages: Message[];
  images: ImageAttachment[];
  hasVideo: boolean;
  signal: AbortSignal;
  geminiFlashThinkingLevel: GeminiFlashThinkingLevel;
  debateProfile: DebateProfile;
  workerMaxTokens: number;
  forcedModelTier?: RouterModel;
  synthesisMaxTokens?: number;
  videoNotesJson?: string;
}): Promise<DebateRunResult | null> {
  const isVideoUi = params.debateProfile === 'video_ui';
  if (!isVideoUi && (params.images.length > 0 || params.hasVideo)) return null;
  if (isVideoUi && (params.images.length > 0 || !params.hasVideo || !params.videoNotesJson || !params.forcedModelTier)) {
    return null;
  }

  const basePrimaryDecision = params.forcedModelTier
    ? decisionFromModel(
      params.forcedModelTier,
      params.decision.complexityScore,
      `debate-${params.debateProfile}-synthesis`,
    )
    : params.decision;
  const synthesisBudgetCap = params.synthesisMaxTokens
    ? Math.min(basePrimaryDecision.budgetCap, params.synthesisMaxTokens)
    : basePrimaryDecision.budgetCap;
  const synthesisDecision: RouteDecision = {
    ...basePrimaryDecision,
    budgetCap: synthesisBudgetCap,
  };

  const primaryTier = synthesisDecision.modelTier;
  const plan = getDebatePlan(params.debateProfile, primaryTier);

  // Readiness gating: every model tier we will call must have provider ready.
  if (!isProviderReadyForModelTier(primaryTier)) return null;
  for (const c of plan.challengers) {
    const tier = params.forcedModelTier || c.modelTier;
    if (!isProviderReadyForModelTier(tier)) return null;
  }

  // Run challengers in parallel (streaming, consumed to text, bounded timeout).
  const challengerRuns = plan.challengers.map(async (c): Promise<ChallengerOutput | null> => {
    const workerController = new AbortController();
    const timeoutMs = params.debateProfile === 'code'
      ? 12000
      : params.debateProfile === 'video_ui'
      ? 9000
      : 10000;
    const tid = setTimeout(() => workerController.abort(), timeoutMs);
    const onStageAbort = () => workerController.abort();
    params.signal.addEventListener('abort', onStageAbort, { once: true });
    try {
      const baseUserQuery = params.allMessages.at(-1)?.content || '';
      const enrichedUserQuery = isVideoUi
        ? `${baseUserQuery}\n\nVIDEO_NOTES_JSON:\n${params.videoNotesJson}`
        : baseUserQuery;
      const workerPrompt = buildChallengerPrompt(
        params.debateProfile,
        c.role,
        enrichedUserQuery,
      );
      const workerMessages: Message[] = [
        // Keep context small: last 6 turns + challenger prompt as final user msg.
        ...params.allMessages.slice(Math.max(0, params.allMessages.length - 6)),
        { role: 'user', content: workerPrompt },
      ];

      // Cap challenger budget to prevent cost runaway; text truncation alone is insufficient.
      const workerTier = params.forcedModelTier || c.modelTier;
      const workerDecision: RouteDecision = {
        ...decisionFromModel(workerTier, params.decision.complexityScore, `debate-worker-${c.role}`),
        budgetCap: params.workerMaxTokens,
      };

      const upstream = await callProviderStream(
        workerDecision,
        workerMessages,
        [],
        workerController.signal,
        params.geminiFlashThinkingLevel,
      );

      const text = await consumeUpstreamToText(
        upstream,
        workerController.signal,
        plan.maxChallengerChars,
      );
      if (!text) return null;
      return { role: c.role, modelTier: workerTier, text };
    } catch {
      return null;
    } finally {
      clearTimeout(tid);
      params.signal.removeEventListener('abort', onStageAbort);
    }
  });

  const challengerResults = (await Promise.all(challengerRuns)).filter(Boolean) as ChallengerOutput[];

  // If no challengers succeed, fall back to the normal single-provider path.
  if (challengerResults.length === 0) return null;

  // Synthesis: ask the PRIMARY decision model to produce a final answer using debate notes.
  const baseUserQuery = params.allMessages.at(-1)?.content || '';
  const userQuery = isVideoUi
    ? `${baseUserQuery}\n\nVIDEO_NOTES_JSON:\n${params.videoNotesJson}`
    : baseUserQuery;
  const synthesisPrompt = buildSynthesisPrompt(
    params.debateProfile,
    userQuery,
    challengerResults,
    plan.maxChallengerChars,
  );

  const synthesisMessages: Message[] = [
    ...params.allMessages,
    { role: 'user', content: synthesisPrompt },
  ];

  const upstream = await callProviderStream(
    synthesisDecision,
    synthesisMessages,
    [],
    params.signal,
    params.geminiFlashThinkingLevel,
  );

  return {
    upstream,
    synthesisMessages,
    debateModelTier: synthesisDecision.modelTier,
    synthesisDecision,
  };
}

// ============================================================================
// UPSTREAM DELTA EXTRACTORS
// ============================================================================

function extractAnthropicDeltas(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const data = payload as { type?: string; delta?: { text?: string } };
  if (data.type === 'content_block_delta' && typeof data.delta?.text === 'string') {
    return [data.delta.text];
  }
  return [];
}

function extractOpenAIDeltas(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];

  const data = payload as {
    choices?: Array<{ delta?: { content?: string | Array<{ text?: string }> } }>;
  };

  const deltas: string[] = [];
  for (const choice of data.choices || []) {
    const content = choice.delta?.content;
    if (typeof content === 'string' && content) {
      deltas.push(content);
      continue;
    }
    if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part?.text === 'string' && part.text) {
          deltas.push(part.text);
        }
      }
    }
  }

  return deltas;
}

function extractGoogleDeltas(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];

  const data = payload as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };

  const deltas: string[] = [];
  for (const candidate of data.candidates || []) {
    for (const part of candidate.content?.parts || []) {
      if (typeof part?.text === 'string' && part.text) {
        deltas.push(part.text);
      }
    }
  }

  return deltas;
}

function normalizeGoogleModelName(rawName: string): string {
  return rawName.startsWith('models/') ? rawName.slice('models/'.length) : rawName;
}

function hasGenerateContentSupport(model: GoogleModelRecord): boolean {
  return model.supportedGenerationMethods.includes('generateContent');
}

async function listGoogleModels(signal: AbortSignal): Promise<GoogleModelRecord[]> {
  const now = Date.now();
  if (googleModelsCache && now - googleModelsCache.fetchedAt < GOOGLE_MODELS_CACHE_TTL_MS) {
    return googleModelsCache.models;
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models?key=${
    encodeURIComponent(GOOGLE_API_KEY)
  }`;
  const response = await fetch(endpoint, { method: 'GET', signal });
  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(`Google ListModels failed (${response.status}): ${responseText}`);
  }

  let payload: { models?: Array<{ name?: string; supportedGenerationMethods?: string[] }> } = {};
  try {
    payload = JSON.parse(responseText) as typeof payload;
  } catch {
    throw new Error('Google ListModels returned invalid JSON payload');
  }

  const models = (payload.models || [])
    .filter((item): item is { name: string; supportedGenerationMethods?: string[] } =>
      typeof item?.name === 'string' && item.name.length > 0
    )
    .map((item) => ({
      name: normalizeGoogleModelName(item.name),
      supportedGenerationMethods: Array.isArray(item.supportedGenerationMethods)
        ? item.supportedGenerationMethods
        : [],
    }))
    .filter(hasGenerateContentSupport);

  googleModelsCache = { fetchedAt: now, models };
  return models;
}

function googleAliasScore(alias: string, modelName: string): number {
  const normalizedAlias = alias.toLowerCase();
  const normalizedName = modelName.toLowerCase();

  let score = 0;

  if (normalizedAlias === normalizedName) score += 1000;
  if (normalizedName.includes(normalizedAlias)) score += 500;

  if (normalizedAlias === 'gemini-3-flash' || normalizedAlias === 'gemini-3-flash-preview') {
    if (normalizedName.includes('flash')) score += 300;
    if (normalizedName.includes('gemini-3')) score += 200;
    if (normalizedName.includes('gemini-2.5')) score += 100;
    if (!normalizedName.includes('flash')) score -= 400;
  }

  if (
    normalizedAlias === 'gemini-3.1-pro-preview' ||
    normalizedAlias === 'gemini-3.1-pro' ||
    normalizedAlias === 'gemini-3-pro'
  ) {
    if (normalizedName.includes('pro')) score += 300;
    if (normalizedName.includes('gemini-3')) score += 200;
    if (normalizedName.includes('gemini-2.5')) score += 100;
    if (!normalizedName.includes('pro')) score -= 400;
  }

  if (normalizedName.includes('preview')) score -= 10;
  if (normalizedName.includes('exp')) score -= 15;

  return score;
}

async function resolveGoogleModelAlias(alias: string, signal: AbortSignal): Promise<string> {
  const models = await listGoogleModels(signal);
  if (models.length === 0) {
    throw new Error('Google ListModels returned no models with generateContent support');
  }

  const exact = models.find((m) => m.name.toLowerCase() === alias.toLowerCase());
  if (exact) return exact.name;

  const ranked = models
    .map((model) => ({ model, score: googleAliasScore(alias, model.name) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  if (ranked.length > 0) {
    return ranked[0]!.model.name;
  }

  throw new Error(
    `No Google model available for alias '${alias}'. ` +
      `Query ListModels and verify current Gemini model naming.`,
  );
}

// ============================================================================
// UPSTREAM CALLS
// ============================================================================

async function callAnthropic(
  decision: RouteDecision,
  allMessages: Message[],
  images: ImageAttachment[],
  signal: AbortSignal,
): Promise<UpstreamCallResult> {
  const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(buildAnthropicStreamPayload(decision, allMessages, images)),
    signal,
  });

  return {
    response: anthropicResponse,
    extractDeltas: extractAnthropicDeltas,
    effectiveModelId: decision.model,
  };
}

async function callOpenAI(
  decision: RouteDecision,
  allMessages: Message[],
  images: ImageAttachment[],
  signal: AbortSignal,
): Promise<UpstreamCallResult> {
  const endpoint = 'https://api.openai.com/v1/chat/completions';

  const doCall = (payload: Record<string, unknown>) =>
    fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal,
    });

  let openaiResponse = await doCall(
    buildOpenAIStreamPayload(decision, allMessages, images),
  );

  if (openaiResponse.status === 400) {
    const bodyText = await openaiResponse.text();
    if (bodyText.toLowerCase().includes('max_completion_tokens')) {
      openaiResponse = await doCall({
        ...buildOpenAILegacyStreamPayload(decision, allMessages, images),
      });
    } else {
      openaiResponse = new Response(bodyText, {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }
  }

  return {
    response: openaiResponse,
    extractDeltas: extractOpenAIDeltas,
    effectiveModelId: decision.model,
  };
}

async function callGoogle(
  decision: RouteDecision,
  allMessages: Message[],
  images: ImageAttachment[],
  signal: AbortSignal,
  geminiFlashThinkingLevel: GeminiFlashThinkingLevel,
): Promise<UpstreamCallResult> {
  const resolvedModel = await resolveGoogleModelAlias(decision.model, signal);

  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(resolvedModel)}` +
    `:streamGenerateContent?alt=sse&key=${encodeURIComponent(GOOGLE_API_KEY)}`;

  const isGeminiFlash = decision.modelTier === 'gemini-3-flash';

  const doCall = (includeThinkingConfig: boolean) =>
    fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(
        buildGoogleStreamPayload(
          decision,
          allMessages,
          images,
          includeThinkingConfig,
          geminiFlashThinkingLevel,
        ),
      ),
      signal,
    });

  let effectiveGeminiFlashThinkingLevel: GeminiFlashThinkingLevel | undefined = isGeminiFlash
    ? geminiFlashThinkingLevel
    : undefined;

  let googleResponse = await doCall(isGeminiFlash);

  if (googleResponse.status === 400 && isGeminiFlash) {
    const responseText = await googleResponse.text();
    const lowered = responseText.toLowerCase();
    const looksLikeThinkingConfigError = lowered.includes('thinking') ||
      lowered.includes('thinkingconfig') ||
      lowered.includes('thinking_level');

    if (looksLikeThinkingConfigError) {
      googleResponse = await doCall(false);
      effectiveGeminiFlashThinkingLevel = undefined;
    } else {
      googleResponse = new Response(responseText, {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }
  }

  const result: UpstreamCallResult = {
    response: googleResponse,
    extractDeltas: extractGoogleDeltas,
    effectiveModelId: resolvedModel,
  };
  if (effectiveGeminiFlashThinkingLevel) {
    result.effectiveGeminiFlashThinkingLevel = effectiveGeminiFlashThinkingLevel;
  }
  return result;
}

async function callProviderStream(
  decision: RouteDecision,
  allMessages: Message[],
  images: ImageAttachment[],
  signal: AbortSignal,
  geminiFlashThinkingLevel: GeminiFlashThinkingLevel,
): Promise<UpstreamCallResult> {
  switch (decision.provider) {
    case 'anthropic':
      return await callAnthropic(decision, allMessages, images, signal);
    case 'openai':
      return await callOpenAI(decision, allMessages, images, signal);
    case 'google':
      return await callGoogle(decision, allMessages, images, signal, geminiFlashThinkingLevel);
  }
}

// ============================================================================
// JWT VERIFICATION
// ============================================================================

function extractBearerToken(authHeader: string): string | null {
  if (!authHeader.startsWith('Bearer ')) return null;
  return authHeader.substring(7);
}

function extractKeywords(input: string): string[] {
  const words = input
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 3 && !MEMORY_STOP_WORDS.has(word));
  return [...new Set(words)].slice(0, 20);
}

function truncateWithEllipsis(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1)}…`;
}

function scoreMemory(summary: string, tags: string[] | null, keywords: string[]): number {
  if (keywords.length === 0) return 1;
  const haystack = summary.toLowerCase();
  const tagSet = new Set((tags || []).map((tag) => tag.toLowerCase()));
  let score = 0;

  for (const keyword of keywords) {
    if (haystack.includes(keyword)) score += 2;
    if (tagSet.has(keyword)) score += 3;
  }
  return score;
}

function buildMemoryContextBlock(memories: UserMemoryRecord[]): string {
  const lines = memories.map((memory, idx) => {
    const stamp = memory.created_at ? memory.created_at.slice(0, 10) : 'unknown-date';
    return `- [${idx + 1}] (${stamp}) ${truncateWithEllipsis(memory.summary_text.trim(), 420)}`;
  });

  const block = [
    '### Long-Term User Memory',
    'Use this memory only when relevant to the current request.',
    ...lines,
    '### End Memory',
  ].join('\n');

  return truncateWithEllipsis(block, MEMORY_MAX_CONTEXT_CHARS);
}

async function fetchRelevantMemories(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  query: string,
): Promise<MemoryRetrievalResult> {
  const { data, error } = await supabase
    .from('user_memories')
    .select('id, user_id, conversation_id, source_window_end_at, summary_text, tags, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(MEMORY_MAX_CANDIDATES);

  if (error || !data || data.length === 0) {
    return { contextBlock: '', hits: 0, tokenCount: 0 };
  }

  const memories = data as UserMemoryRecord[];
  const keywords = extractKeywords(query);
  const ranked = memories
    .map((memory, index) => ({
      memory,
      index,
      score: scoreMemory(memory.summary_text, memory.tags, keywords),
    }))
    .sort((a, b) => {
      if (b.score === a.score) return a.index - b.index;
      return b.score - a.score;
    });

  const selected = ranked
    .filter((entry) => entry.score > 0)
    .slice(0, MEMORY_MAX_INJECT)
    .map((entry) => entry.memory);

  if (selected.length === 0) {
    selected.push(memories[0]!);
  }

  const contextBlock = buildMemoryContextBlock(selected);
  return {
    contextBlock,
    hits: selected.length,
    tokenCount: countTokens(contextBlock),
  };
}

function normalizeSummary(text: string): string {
  return truncateWithEllipsis(text.replace(/\s+/g, ' ').trim(), 1200);
}

function extractSummaryFromOpenAI(payload: unknown): string | undefined {
  const data = payload as {
    choices?: Array<{
      message?: { content?: string | Array<{ text?: string; type?: string }> };
    }>;
  };
  const first = data.choices?.[0]?.message?.content;
  if (typeof first === 'string') return first;
  if (Array.isArray(first)) {
    const parts = first
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .filter(Boolean);
    if (parts.length > 0) return parts.join(' ');
  }
  return undefined;
}

function extractSummaryFromAnthropic(payload: unknown): string | undefined {
  const data = payload as { content?: Array<{ type?: string; text?: string }> };
  const parts = (data.content || [])
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text || '');
  if (parts.length === 0) return undefined;
  return parts.join(' ');
}

function extractSummaryFromGoogle(payload: unknown): string | undefined {
  const data = payload as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const firstCandidate = data.candidates?.[0];
  if (!firstCandidate) return undefined;
  const parts = (firstCandidate.content?.parts || [])
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean);
  if (parts.length === 0) return undefined;
  return parts.join(' ');
}

async function summarizeConversationWindow(
  transcript: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const prompt = [
    'Summarize key persistent facts about the user from this transcript.',
    'Prioritize: preferences, projects, constraints, deadlines, recurring goals.',
    'Exclude small talk and one-off ephemeral details.',
    'Return plain text in 4-8 bullet points, max 120 words.',
    '',
    transcript,
  ].join('\n');

  if (OPENAI_API_KEY) {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-5-mini',
        messages: [
          { role: 'system', content: 'You extract durable user memory for future chat context.' },
          { role: 'user', content: prompt },
        ],
        max_tokens: 220,
      }),
      signal,
    });
    if (response.ok) {
      const payload = await response.json();
      const summary = extractSummaryFromOpenAI(payload);
      if (summary) return normalizeSummary(summary);
    }
  }

  if (ANTHROPIC_API_KEY) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL_REGISTRY['haiku-4.5'].modelId,
        max_tokens: 220,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal,
    });
    if (response.ok) {
      const payload = await response.json();
      const summary = extractSummaryFromAnthropic(payload);
      if (summary) return normalizeSummary(summary);
    }
  }

  if (GOOGLE_API_KEY) {
    const model = await resolveGoogleModelAlias(MODEL_REGISTRY['gemini-3-flash'].modelId, signal);
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${
      encodeURIComponent(model)
    }:generateContent?key=${encodeURIComponent(GOOGLE_API_KEY)}`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 220 },
      }),
      signal,
    });
    if (response.ok) {
      const payload = await response.json();
      const summary = extractSummaryFromGoogle(payload);
      if (summary) return normalizeSummary(summary);
    }
  }

  return undefined;
}

async function maybeSummarizeConversationAsync(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  conversationId: string,
  totalTokens: number,
): Promise<void> {
  try {
    const { data: stateRaw } = await supabase
      .from('conversation_memory_state')
      .select(
        'conversation_id, user_id, last_summarized_at, last_summarized_message_created_at, last_summarized_total_tokens, updated_at',
      )
      .eq('conversation_id', conversationId)
      .maybeSingle();

    const state = (stateRaw as ConversationMemoryStateRecord | null) || null;
    const lastSummarizedAtMs = state?.last_summarized_at ? Date.parse(state.last_summarized_at) : 0;
    const lastSummarizedTokens = state?.last_summarized_total_tokens || 0;
    const nowMs = Date.now();
    const dueByTime = !lastSummarizedAtMs ||
      nowMs - lastSummarizedAtMs >= MEMORY_SUMMARY_MIN_INTERVAL_MS;
    const dueByTokenDelta = totalTokens - lastSummarizedTokens >= MEMORY_SUMMARY_MIN_TOKEN_DELTA;

    if (!dueByTime && !dueByTokenDelta) return;

    let query = supabase
      .from('messages')
      .select('id, conversation_id, role, content, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
      .limit(MEMORY_SUMMARY_MAX_MESSAGES);

    if (state?.last_summarized_message_created_at) {
      query = query.gt('created_at', state.last_summarized_message_created_at);
    }

    const { data: rowsRaw, error: rowsError } = await query;
    if (rowsError || !rowsRaw || rowsRaw.length < 2) return;

    const rows = rowsRaw as ConversationMessageRecord[];
    const transcript = rows
      .map((row) => `${row.role.toUpperCase()}: ${row.content}`)
      .join('\n');

    if (countTokens(transcript) < MEMORY_SUMMARY_MIN_TRANSCRIPT_TOKENS && !dueByTime) return;

    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), 15000);
    let summary: string | undefined;
    try {
      summary = await summarizeConversationWindow(transcript, abortController.signal);
    } finally {
      clearTimeout(timer);
    }
    if (!summary) return;

    const sourceWindowEndAt = rows[rows.length - 1]!.created_at;
    const tags = extractKeywords(summary).slice(0, 8);

    await supabase.from('user_memories').upsert(
      {
        user_id: userId,
        conversation_id: conversationId,
        source_window_end_at: sourceWindowEndAt,
        summary_text: summary,
        tags,
      } as never,
      { onConflict: 'conversation_id,source_window_end_at' },
    );

    const nowIso = new Date().toISOString();
    await supabase.from('conversation_memory_state').upsert(
      {
        conversation_id: conversationId,
        user_id: userId,
        last_summarized_at: nowIso,
        last_summarized_message_created_at: sourceWindowEndAt,
        last_summarized_total_tokens: totalTokens,
        updated_at: nowIso,
      } as never,
      { onConflict: 'conversation_id' },
    );
  } catch (error) {
    console.warn('[Memory] summarize skipped:', error);
  }
}

// ============================================================================
// DATABASE HELPERS
// ============================================================================

async function validateConversation(
  supabase: ReturnType<typeof createClient>,
  conversationId: string,
  userId: string,
): Promise<{ valid: boolean; tokenCount: number }> {
  const { data: conv, error } = await supabase
    .from('conversations')
    .select('user_id, total_tokens')
    .eq('id', conversationId)
    .maybeSingle();

  if (error || !conv) {
    const newConv: Conversation = { id: conversationId, user_id: userId, total_tokens: 0 };
    await supabase.from('conversations').insert(newConv as never);
    return { valid: true, tokenCount: 0 };
  }

  const conversation = conv as Conversation;
  if (conversation.user_id !== userId) return { valid: false, tokenCount: 0 };
  return { valid: true, tokenCount: conversation.total_tokens || 0 };
}

function persistMessageAsync(
  supabase: ReturnType<typeof createClient>,
  conversationId: string,
  role: 'user' | 'assistant',
  content: string,
  tokenCount: number,
  modelUsed?: string,
  imageUrl?: string,
): void {
  (async () => {
    try {
      const messageRecord: MessageRecord = {
        conversation_id: conversationId,
        role,
        content,
        token_count: tokenCount,
        model_used: modelUsed || undefined,
        image_url: imageUrl || undefined,
      };

      await Promise.all([
        supabase.from('messages').insert(messageRecord as never),
        supabase.rpc('increment_token_count', {
          p_conversation_id: conversationId,
          p_tokens: tokenCount,
        } as never),
      ]);
    } catch (err) {
      console.error('[DB] Persist failed:', err);
    }
  })();
}

function estimateVideoPromptTokens(videoAssetCount: number): number {
  if (videoAssetCount <= 0) return 0;
  const estimatedFrameCount = Math.min(videoAssetCount * 4, 8);
  const estimatedFrameTokens = Math.min(
    estimatedFrameCount * VIDEO_IMAGE_TOKEN_ESTIMATE,
    VIDEO_MAX_FRAME_TOKENS,
  );
  return estimatedFrameTokens + VIDEO_TRANSCRIPT_TOKEN_ESTIMATE;
}

async function validateReadyVideoAssets(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  videoAssetIds: string[],
): Promise<{ ok: true; ids: string[] } | { ok: false; error: string }> {
  if (videoAssetIds.length === 0) {
    return { ok: true, ids: [] };
  }

  const uniqueIds = [...new Set(videoAssetIds.filter((id) => typeof id === 'string' && id.trim()))];
  if (uniqueIds.length === 0) {
    return { ok: true, ids: [] };
  }

  if (!ENABLE_VIDEO_PIPELINE) {
    return { ok: false, error: 'video_pipeline_disabled' };
  }

  if (uniqueIds.length > MAX_VIDEO_ASSETS_PER_REQUEST) {
    return { ok: false, error: 'video_too_many_assets' };
  }

  const { data, error } = await supabase
    .from('video_assets')
    .select('id, user_id, status')
    .in('id', uniqueIds);

  if (error) {
    console.error('[Video] validate assets query failed:', error);
    return { ok: false, error: 'video_validation_failed' };
  }

  const rows = (data || []) as VideoAssetReadyRecord[];
  if (rows.length !== uniqueIds.length) {
    return { ok: false, error: 'video_not_ready' };
  }

  const allReady = rows.every((row) => row.user_id === userId && row.status === 'ready');
  if (!allReady) {
    return { ok: false, error: 'video_not_ready' };
  }

  return { ok: true, ids: uniqueIds };
}

function resolveArtifactTimestampSec(
  metadata: Record<string, unknown> | null,
  seq: number | null,
): number | null {
  const fromSec = metadata?.timestamp_sec ?? metadata?.timestamp_s ?? metadata?.time_sec;
  if (typeof fromSec === 'number' && Number.isFinite(fromSec) && fromSec >= 0) return fromSec;

  const fromMs = metadata?.timestamp_ms ?? metadata?.time_ms;
  if (typeof fromMs === 'number' && Number.isFinite(fromMs) && fromMs >= 0) return fromMs / 1000;

  if (typeof seq === 'number' && Number.isFinite(seq) && seq >= 0) {
    // Heuristic fallback only when artifact metadata doesn't include a timestamp.
    return seq * 5;
  }
  return null;
}

function clampText(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  return `${input.slice(0, maxChars)}...`;
}

function compactVideoStatusLine(asset: VideoAssetContextRecord): string {
  const durationSec = typeof asset.duration_ms === 'number' && Number.isFinite(asset.duration_ms)
    ? Math.max(0, Math.round(asset.duration_ms / 1000))
    : null;
  const dim = asset.width && asset.height ? `${asset.width}x${asset.height}` : 'unknown-dimensions';
  const durationLabel = durationSec !== null ? `${durationSec}s` : 'unknown-duration';
  return `asset=${asset.id} status=${asset.status} duration=${durationLabel} dimensions=${dim}`;
}

function compactArtifactLine(row: VideoArtifactRecord): string | null {
  const textFromMetadata = typeof row.metadata?.caption === 'string'
    ? row.metadata.caption
    : typeof row.metadata?.summary === 'string'
    ? row.metadata.summary
    : '';
  const rawText = (row.text_content || textFromMetadata || '').trim();
  if (!rawText) return null;
  const timestampSec = resolveArtifactTimestampSec(row.metadata, row.seq);
  const tsLabel = typeof timestampSec === 'number' ? `t=${timestampSec.toFixed(1)}s ` : '';
  return `[${row.asset_id}] ${row.kind} ${tsLabel}${clampText(rawText, 240)}`;
}

async function buildVideoContextBlock(
  supabase: ReturnType<typeof createClient>,
  videoAssetIds: string[],
  maxChars: number,
): Promise<string> {
  if (videoAssetIds.length === 0) return '';

  const lines: string[] = [];

  const { data: assetsData, error: assetsError } = await supabase
    .from('video_assets')
    .select('id, status, duration_ms, width, height, updated_at')
    .in('id', videoAssetIds)
    .order('updated_at', { ascending: false });

  if (assetsError) {
    console.warn('[Video] asset context lookup failed:', assetsError);
  } else {
    const assets = (assetsData || []) as VideoAssetContextRecord[];
    for (const asset of assets) {
      lines.push(compactVideoStatusLine(asset));
    }
  }

  const { data: artifactsData, error: artifactsError } = await supabase
    .from('video_artifacts')
    .select('asset_id, kind, seq, text_content, metadata, created_at')
    .in('asset_id', videoAssetIds)
    .order('asset_id', { ascending: true })
    .order('seq', { ascending: true, nullsFirst: true })
    .order('created_at', { ascending: true })
    .limit(VIDEO_CONTEXT_MAX_ARTIFACT_ROWS);

  if (artifactsError) {
    console.warn('[Video] artifact context lookup failed:', artifactsError);
  } else {
    const rows = (artifactsData || []) as VideoArtifactRecord[];
    for (const row of rows) {
      const line = compactArtifactLine(row);
      if (line) lines.push(line);
    }
  }

  if (lines.length === 0) {
    return '';
  }

  const block = [
    '### Video Context',
    'Use these extracted video artifacts as ground truth context.',
    ...lines,
    '### End Video Context',
  ].join('\n');

  return truncateWithEllipsis(block, maxChars);
}

async function buildVideoUiNotesJson(
  supabase: ReturnType<typeof createClient>,
  videoAssetIds: string[],
  maxChars: number,
): Promise<string | null> {
  if (videoAssetIds.length === 0) return null;

  const { data, error } = await supabase
    .from('video_artifacts')
    .select('asset_id, kind, seq, text_content, metadata, created_at')
    .in('asset_id', videoAssetIds)
    .order('asset_id', { ascending: true })
    .order('seq', { ascending: true, nullsFirst: true })
    .order('created_at', { ascending: true });

  if (error) {
    console.warn('[Debate][video_ui] artifact lookup failed:', error);
    return null;
  }

  const rows = (data || []) as VideoArtifactRecord[];
  const artifacts = rows.slice(0, 48).map((row) => {
    const textFromMetadata = typeof row.metadata?.caption === 'string'
      ? row.metadata.caption
      : typeof row.metadata?.summary === 'string'
      ? row.metadata.summary
      : '';
    const text = clampText((row.text_content || textFromMetadata || '').trim(), 260);
    return {
      asset_id: row.asset_id,
      kind: row.kind,
      seq: row.seq,
      timestamp_sec: resolveArtifactTimestampSec(row.metadata, row.seq),
      created_at: row.created_at,
      text,
    };
  }).filter((a) => a.text.length > 0);

  const payload = {
    schema_version: 'video_ui_notes_v1',
    video_asset_ids: videoAssetIds,
    artifacts,
    note: 'Use only these extracted notes. Unseen footage should be marked unknown.',
  };

  let json = JSON.stringify(payload);
  if (json.length <= maxChars) return json;

  const compact = {
    schema_version: 'video_ui_notes_v1',
    video_asset_ids: videoAssetIds,
    artifacts: artifacts.slice(0, 12).map((a) => ({ ...a, text: clampText(a.text, 120) })),
    truncated: true,
  };
  json = JSON.stringify(compact);
  if (json.length <= maxChars) return json;

  return JSON.stringify({
    schema_version: 'video_ui_notes_v1',
    video_asset_ids: videoAssetIds,
    artifacts: [],
    truncated: true,
  });
}

async function persistCostLog(
  supabase: ReturnType<typeof createClient>,
  record: CostLogRecord,
): Promise<void> {
  try {
    await supabase.from('cost_logs').insert(record as never);
  } catch (err) {
    console.error('[DB] Cost log persist failed:', err);
  }
}

// ============================================================================
// MAIN HANDLER
// ============================================================================

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FUNCTION_TIMEOUT_MS);

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !supabaseServiceRoleKey) {
      return new Response(
        JSON.stringify({ error: 'Server misconfigured: missing Supabase env vars' }),
        {
          status: 500,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        },
      );
    }

    if (!hasAtLeastOneProviderConfigured()) {
      return new Response(
        JSON.stringify({
          error:
            'Server misconfigured: no provider credentials available. Configure ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_API_KEY.',
        }),
        {
          status: 500,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        },
      );
    }

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Unauthorized: Missing Authorization header' }), {
        status: 401,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    const token = extractBearerToken(authHeader);
    if (!token) {
      return new Response(JSON.stringify({ error: 'Unauthorized: Invalid token format' }), {
        status: 401,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    const supabaseClient = createClient(
      supabaseUrl,
      supabaseServiceRoleKey,
      {
        db: { schema: 'public' },
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
      },
    );

    const { data: { user }, error: userError } = await supabaseClient.auth.getUser(token);
    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized: Invalid or expired token' }), {
        status: 401,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    const userId = user.id;

    let body: {
      query?: string;
      conversationId?: string;
      platform?: 'web' | 'mobile';
      history?: Message[];
      images?: ImageAttachment[];
      videoAssetIds?: string[];
      imageData?: string;
      mediaType?: string;
      imageStorageUrl?: string;
      modelOverride?: string;
      geminiFlashThinkingLevel?: string;
      // Debate Mode tool toggle
      mode?: string; // "debate" to enable
      debateProfile?: string; // "general" | "code" | "video_ui"
    };

    const contentLengthHeader = req.headers.get('content-length');
    if (contentLengthHeader) {
      const contentLength = Number(contentLengthHeader);
      if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
        return new Response(
          JSON.stringify({
            error: `Payload too large. Max allowed size is ${Math.round(MAX_REQUEST_BYTES / (1024 * 1024))}MB.`,
          }),
          {
            status: 413,
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
          },
        );
      }
    }

    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: 'Bad Request: Invalid JSON' }), {
        status: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    const {
      query: rawQuery,
      conversationId,
      platform = 'web',
      history = [],
      images,
      videoAssetIds = [],
      imageData,
      mediaType,
      imageStorageUrl,
      modelOverride,
      geminiFlashThinkingLevel,
      mode,
      debateProfile,
    } = body;

    const normalizedGeminiFlashThinkingLevel = normalizeGeminiFlashThinkingLevel(
      geminiFlashThinkingLevel,
    );

    let imageAttachments: ImageAttachment[] = [];

    if (images && images.length > 0) {
      imageAttachments = images;
    } else if (imageData) {
      imageAttachments = [{ data: imageData, mediaType: mediaType || 'image/png' }];
    }

    let query = rawQuery?.trim() || '';
    const hasImages = imageAttachments.length > 0;
    const hasVideoAssets = Array.isArray(videoAssetIds) && videoAssetIds.length > 0;

    if (!query && !hasImages && !hasVideoAssets) {
      return new Response(JSON.stringify({ error: 'Bad Request: Missing query, image, or videoAssetIds' }), {
        status: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    if (!conversationId) {
      return new Response(JSON.stringify({ error: 'Bad Request: Missing conversationId' }), {
        status: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    if (!query && (hasImages || hasVideoAssets)) {
      if (hasImages && hasVideoAssets) {
        query = 'Please analyze these images and videos.';
      } else if (hasVideoAssets) {
        query = videoAssetIds.length === 1
          ? 'Please analyze this video.'
          : `Please analyze these ${videoAssetIds.length} videos.`;
      } else {
        query = imageAttachments.length === 1
          ? 'Please analyze this image.'
          : `Please analyze these ${imageAttachments.length} images.`;
      }
    }

    if (query.length > MAX_QUERY_LENGTH) {
      return new Response(JSON.stringify({ error: 'Query exceeds maximum length' }), {
        status: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    if (DEV_MODE) {
      console.log('[DEV] Request:', {
        userId: userId.slice(0, 8),
        conversationId: conversationId.slice(0, 8),
        imageCount: imageAttachments.length,
        videoCount: videoAssetIds.length,
        queryLen: query.length,
        modelOverride: modelOverride || 'auto',
        geminiFlashThinkingLevel: normalizedGeminiFlashThinkingLevel,
      });
    }

    const ownership = await validateConversation(
      supabaseClient as unknown as ReturnType<typeof createClient>,
      conversationId,
      userId,
    );
    if (!ownership.valid) {
      return new Response(JSON.stringify({ error: 'Forbidden: Invalid conversation ownership' }), {
        status: 403,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    const videoValidation = await validateReadyVideoAssets(
      supabaseClient as unknown as ReturnType<typeof createClient>,
      userId,
      Array.isArray(videoAssetIds) ? videoAssetIds : [],
    );
    if (!videoValidation.ok) {
      return new Response(JSON.stringify({ error: videoValidation.error }), {
        status: videoValidation.error === 'video_not_ready' ? 409 : 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    let memoryRetrieval: MemoryRetrievalResult = {
      contextBlock: '',
      hits: 0,
      tokenCount: 0,
    };
    try {
      memoryRetrieval = await fetchRelevantMemories(
        supabaseClient as unknown as ReturnType<typeof createClient>,
        userId,
        query,
      );
    } catch (memoryError) {
      console.warn('[Memory] retrieval skipped:', memoryError);
    }

    let videoContextBlock = '';
    if (videoValidation.ids.length > 0) {
      try {
        videoContextBlock = await buildVideoContextBlock(
          supabaseClient as unknown as ReturnType<typeof createClient>,
          videoValidation.ids,
          VIDEO_CONTEXT_MAX_CHARS,
        );
      } catch (videoContextError) {
        console.warn('[Video] context injection skipped:', videoContextError);
      }
    }

    const effectiveQuery = [memoryRetrieval.contextBlock, videoContextBlock, `Current request:\n${query}`]
      .filter((part) => typeof part === 'string' && part.trim().length > 0)
      .join('\n\n');

    const routerParams: RouterParams = {
      userQuery: query,
      currentSessionTokens: ownership.tokenCount + memoryRetrieval.tokenCount,
      platform,
      history,
      images: imageAttachments,
      hasVideoAssets,
    };

    const debateReq = parseDebateRequest(mode, modelOverride, debateProfile);
    const normalizedOverride = normalizeModelOverride(
      debateReq.suppressModelOverride ? undefined : modelOverride,
    );
    let decision = determineRoute(routerParams, normalizedOverride);

    const availabilityCheck = normalizeDecisionAgainstProviderAvailability(
      decision,
      normalizedOverride,
    );
    if (availabilityCheck.error) {
      return new Response(JSON.stringify({ error: availabilityCheck.error }), {
        status: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }
    decision = availabilityCheck.decision;

    const historyContext = history
      .map((msg) => `${msg.role}: ${msg.content}`)
      .join('\n');
    const estimatedVideoPromptTokens = estimateVideoPromptTokens(videoValidation.ids.length);
    const preFlightCost = calculatePreFlightCost(
      decision.modelTier,
      `${historyContext}\nuser: ${effectiveQuery}`,
      imageAttachments.length,
      estimatedVideoPromptTokens,
    );

    if (DEV_MODE) {
      console.log('[ROUTER] Decision:', {
        provider: decision.provider,
        modelTier: decision.modelTier,
        modelId: decision.model,
        score: decision.complexityScore,
        rationale: decision.rationaleTag,
      });
    }

    const userMsg: Message = {
      role: 'user',
      content: effectiveQuery,
    };

    const allMessages = [...history, userMsg];

    // Debate state — declared before try so both the catch and response-building can see them.
    let debateActive = false;
    let debateProfileEffective: DebateProfile = 'general';
    let debateTriggerEffective: DebateTrigger = 'off';
    let debateOverrideHeader = '';
    let debateSynthesisMessages: Message[] | null = null;
    let debateModelTierEffective = '';
    let responseDecision: RouteDecision = decision;

    let upstream: UpstreamCallResult;
    try {
      const debateEligibility = computeDebateEligibility({
        profile: debateReq.profile,
        enableDebateMode: ENABLE_DEBATE_MODE,
        enableDebateAuto: ENABLE_DEBATE_AUTO,
        debateRequested: debateReq.requested,
        hasImages,
        hasVideoAssets,
        complexityScore: decision.complexityScore,
        threshold: DEBATE_COMPLEXITY_THRESHOLD,
      });

      // Worker token cap: challenger budget by profile (not synthesis model).
      const workerMaxTokens = selectDebateWorkerMaxTokens(
        debateReq.profile,
        DEBATE_WORKER_MAX_TOKENS_GENERAL,
        DEBATE_WORKER_MAX_TOKENS_CODE,
        DEBATE_WORKER_MAX_TOKENS_VIDEO_UI,
      );

      if (debateEligibility.doDebate) {
        const forcedVideoUiTier = debateReq.profile === 'video_ui'
          ? resolveVideoUiDebateModelTier()
          : undefined;
        const videoUiNotesJson = debateReq.profile === 'video_ui' && forcedVideoUiTier
          ? await buildVideoUiNotesJson(
            supabaseClient as unknown as ReturnType<typeof createClient>,
            videoValidation.ids,
            DEBATE_VIDEO_UI_NOTES_MAX_CHARS,
          )
          : undefined;

        const debateResult = await runDebateStageWithTimeout({
          parentSignal: controller.signal,
          timeoutMs: debateReq.profile === 'video_ui' ? DEBATE_VIDEO_UI_STAGE_TIMEOUT_MS : 0,
          run: async (debateStageSignal) => await maybeRunDebateMode({
            decision,
            allMessages,
            images: imageAttachments,
            hasVideo: hasVideoAssets,
            signal: debateStageSignal,
            geminiFlashThinkingLevel: normalizedGeminiFlashThinkingLevel,
            debateProfile: debateReq.profile,
            workerMaxTokens,
            ...(forcedVideoUiTier ? { forcedModelTier: forcedVideoUiTier } : {}),
            ...(debateReq.profile === 'video_ui'
              ? { synthesisMaxTokens: DEBATE_VIDEO_UI_SYNTHESIS_MAX_TOKENS }
              : {}),
            ...(videoUiNotesJson ? { videoNotesJson: videoUiNotesJson } : {}),
          }),
        });
        // On failure (no challengers succeeded), fall through silently to the normal path.
        if (debateResult) {
          upstream = debateResult.upstream;
          debateSynthesisMessages = debateResult.synthesisMessages;
          debateActive = true;
          debateProfileEffective = debateReq.profile;
          debateTriggerEffective = debateEligibility.trigger;
          debateOverrideHeader = debateReq.requested ? debateReq.overrideHeaderValue : '';
          debateModelTierEffective = debateResult.debateModelTier;
          responseDecision = debateResult.synthesisDecision;
        } else {
          upstream = await callProviderStream(
            decision,
            allMessages,
            imageAttachments,
            controller.signal,
            normalizedGeminiFlashThinkingLevel,
          );
        }
      } else {
        upstream = await callProviderStream(
          decision,
          allMessages,
          imageAttachments,
          controller.signal,
          normalizedGeminiFlashThinkingLevel,
        );
      }
    } catch (upstreamError) {
      const message = upstreamError instanceof Error
        ? upstreamError.message
        : String(upstreamError);
      return new Response(
        JSON.stringify({
          error: 'Upstream provider error',
          provider: responseDecision.provider,
          details: message,
        }),
        {
          status: 502,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        },
      );
    }

    if (!upstream.response.ok) {
      const errorBody = await upstream.response.text();
      console.error(
        `[Upstream:${responseDecision.provider}] Error ${upstream.response.status}:`,
        errorBody,
      );
      return new Response(
        JSON.stringify({
          error: 'Upstream provider error',
          provider: responseDecision.provider,
          details: errorBody,
        }),
        {
          status: 502,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        },
      );
    }

    const effectiveModelId = upstream.effectiveModelId || responseDecision.model;

    const userTokenCount = countTokens(query) +
      countImageTokens(imageAttachments) +
      estimatedVideoPromptTokens;
    persistMessageAsync(
      supabaseClient as unknown as ReturnType<typeof createClient>,
      conversationId,
      'user',
      query,
      userTokenCount,
      `${responseDecision.provider}:${effectiveModelId}`,
      imageStorageUrl,
    );

    if (!upstream.response.body) {
      return new Response(JSON.stringify({ error: 'Upstream provider returned empty stream' }), {
        status: 502,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    // When debate ran, synthesis messages are longer than the original prompt.
    // Recompute the cost estimate so X-Cost-Estimate-USD reflects the actual synthesis call.
    // Challenger costs remain excluded (noted by X-Debate-Cost-Note: partial).
    const effectiveCostEstimateUsd = debateSynthesisMessages
      ? calculatePreFlightCost(
          responseDecision.modelTier,
          serializeMessagesForCost(debateSynthesisMessages),
          0, // synthesis call has no image attachments
          0,
        ).estimatedUsd
      : preFlightCost.estimatedUsd;

    let assistantText = '';

    const proxyStream = createNormalizedProxyStream({
      upstreamBody: upstream.response.body,
      extractDeltas: upstream.extractDeltas,
      onDelta: (delta) => {
        assistantText += delta;
      },
      onComplete: async () => {
        const assistantTokenCount = countTokens(assistantText);
        const costBreakdown = calculateCostBreakdown(responseDecision.modelTier, {
          promptTokens: userTokenCount,
          completionTokens: assistantTokenCount,
          reasoningTokens: 0,
        });

        await persistCostLog(
          supabaseClient as unknown as ReturnType<typeof createClient>,
          {
            user_id: userId,
            conversation_id: conversationId,
            model: responseDecision.modelTier,
            provider: responseDecision.provider,
            input_tokens: costBreakdown.promptTokens,
            output_tokens: costBreakdown.completionTokens,
            thinking_tokens: costBreakdown.reasoningTokens,
            input_cost: costBreakdown.inputCostUsd,
            output_cost: costBreakdown.outputCostUsd,
            thinking_cost: costBreakdown.reasoningCostUsd,
            total_cost: costBreakdown.totalUsd,
            pricing_version: costBreakdown.pricingVersion,
          },
        );

        if (assistantText.trim()) {
          persistMessageAsync(
            supabaseClient as unknown as ReturnType<typeof createClient>,
            conversationId,
            'assistant',
            assistantText,
            assistantTokenCount,
            `${responseDecision.provider}:${effectiveModelId}`,
          );
          void maybeSummarizeConversationAsync(
            supabaseClient as unknown as ReturnType<typeof createClient>,
            userId,
            conversationId,
            ownership.tokenCount + userTokenCount + assistantTokenCount,
          );
        }
      },
    });

    return new Response(proxyStream, {
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'X-Router-Model': responseDecision.modelTier,
        'X-Router-Model-Id': effectiveModelId,
        'X-Provider': responseDecision.provider,
        // Preserve semantics: "override used or auto".
        // If debate was explicitly requested, reflect that in X-Model-Override.
        'X-Model-Override': debateOverrideHeader || normalizedOverride || 'auto',
        'X-Router-Rationale': responseDecision.rationaleTag,
        'X-Complexity-Score': responseDecision.complexityScore.toString(),
        'X-Gemini-Thinking-Level': upstream.effectiveGeminiFlashThinkingLevel || 'n/a',
        'X-Memory-Hits': String(memoryRetrieval.hits),
        'X-Memory-Tokens': String(memoryRetrieval.tokenCount),
        'X-Cost-Estimate-USD': effectiveCostEstimateUsd.toFixed(6),
        'X-Cost-Pricing-Version': preFlightCost.pricingVersion,
        // Debate headers are emitted ONLY when debate ran (absent = debate did not run).
        ...buildDebateHeaders({
          debateActive,
          debateProfile: debateProfileEffective,
          debateTrigger: debateTriggerEffective,
          ...(debateModelTierEffective ? { debateModelTier: debateModelTierEffective } : {}),
        }),
      },
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return new Response(JSON.stringify({ error: 'Request timeout' }), {
        status: 504,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    console.error('[Router] Critical error:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  } finally {
    clearTimeout(timeoutId);
  }
});
