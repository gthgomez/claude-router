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
  transformMessagesForAnthropic,
  transformMessagesForGoogle,
  transformMessagesForOpenAI,
} from './router_logic.ts';
import { calculatePreFlightCost } from './cost_engine.ts';

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

type GeminiFlashThinkingLevel = 'low' | 'high';

// ============================================================================
// CONSTANTS & CONFIGURATION
// ============================================================================

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-client-info, apikey',
  'Access-Control-Expose-Headers':
    'X-Router-Model, X-Router-Model-Id, X-Provider, X-Model-Override, X-Router-Rationale, X-Complexity-Score, X-Gemini-Thinking-Level, X-Memory-Hits, X-Memory-Tokens, X-Cost-Estimate-USD, X-Cost-Pricing-Version',
};

const FUNCTION_TIMEOUT_MS = 55000;
const MAX_QUERY_LENGTH = 50000;
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
  if (isProviderReady('anthropic')) return 'sonnet-4.5';
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

  if (normalizedAlias === 'gemini-3-flash') {
    if (normalizedName.includes('flash')) score += 300;
    if (normalizedName.includes('gemini-3')) score += 200;
    if (normalizedName.includes('gemini-2.5')) score += 100;
    if (!normalizedName.includes('flash')) score -= 400;
  }

  if (normalizedAlias === 'gemini-3-pro') {
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
    body: JSON.stringify({
      model: decision.model,
      max_tokens: decision.budgetCap,
      messages: transformMessagesForAnthropic(allMessages, images),
      stream: true,
    }),
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
  const messages = transformMessagesForOpenAI(allMessages, images);
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

  let openaiResponse = await doCall({
    model: decision.model,
    messages,
    stream: true,
    max_completion_tokens: decision.budgetCap,
  });

  if (openaiResponse.status === 400) {
    const bodyText = await openaiResponse.text();
    if (bodyText.toLowerCase().includes('max_completion_tokens')) {
      openaiResponse = await doCall({
        model: decision.model,
        messages,
        stream: true,
        max_tokens: decision.budgetCap,
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
  const toApiThinkingLevel = geminiFlashThinkingLevel === 'low' ? 'LOW' : 'HIGH';

  const doCall = (includeThinkingConfig: boolean) =>
    fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: transformMessagesForGoogle(allMessages, images),
        generationConfig: {
          maxOutputTokens: decision.budgetCap,
          ...(includeThinkingConfig && isGeminiFlash
            ? {
              thinkingConfig: {
                thinkingLevel: toApiThinkingLevel,
              },
            }
            : {}),
        },
      }),
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
// STREAM NORMALIZATION
// ============================================================================

function tryParseJson(input: string): unknown | undefined {
  try {
    return JSON.parse(input);
  } catch {
    return undefined;
  }
}

function createNormalizedProxyStream(params: {
  upstreamBody: ReadableStream<Uint8Array>;
  extractDeltas: (payload: unknown) => string[];
  onDelta: (delta: string) => void;
  onComplete: () => void;
}): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let sseBuffer = '';
  let completed = false;

  const emitDelta = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    delta: string,
  ) => {
    if (!delta) return;
    params.onDelta(delta);
    controller.enqueue(
      encoder.encode(
        `data: ${JSON.stringify({ type: 'content_block_delta', delta: { text: delta } })}\n\n`,
      ),
    );
  };

  const processDataLine = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    line: string,
  ) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;

    const dataStr = trimmed.slice(5).trim();
    if (!dataStr || dataStr === '[DONE]') return;

    const payload = tryParseJson(dataStr);
    if (!payload) return;

    const deltas = params.extractDeltas(payload);
    for (const delta of deltas) {
      emitDelta(controller, delta);
    }
  };

  const finalize = () => {
    if (completed) return;
    completed = true;
    params.onComplete();
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      reader = params.upstreamBody.getReader();

      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;

            sseBuffer += decoder.decode(value, { stream: true });

            const lines = sseBuffer.split('\n');
            sseBuffer = lines.pop() ?? '';

            for (const line of lines) {
              processDataLine(controller, line);
            }
          }

          const tail = sseBuffer.trim();
          if (tail) processDataLine(controller, tail);

          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        } catch (err) {
          controller.error(err);
        } finally {
          try {
            decoder.decode(new Uint8Array(), { stream: false });
          } catch {
            // ignore
          }
          finalize();
        }
      })();
    },
    async cancel(reason) {
      try {
        if (reader) await reader.cancel(reason);
      } catch {
        // ignore
      } finally {
        finalize();
      }
    },
  });
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
    const model = await resolveGoogleModelAlias('gemini-3-flash', signal);
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
      imageData?: string;
      mediaType?: string;
      imageStorageUrl?: string;
      modelOverride?: string;
      geminiFlashThinkingLevel?: string;
    };

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
      imageData,
      mediaType,
      imageStorageUrl,
      modelOverride,
      geminiFlashThinkingLevel,
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

    if (!query && !hasImages) {
      return new Response(JSON.stringify({ error: 'Bad Request: Missing query or image' }), {
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

    if (!query && hasImages) {
      query = imageAttachments.length === 1
        ? 'Please analyze this image.'
        : `Please analyze these ${imageAttachments.length} images.`;
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

    const effectiveQuery = memoryRetrieval.contextBlock
      ? `${memoryRetrieval.contextBlock}\n\nCurrent request:\n${query}`
      : query;

    const routerParams: RouterParams = {
      userQuery: query,
      currentSessionTokens: ownership.tokenCount + memoryRetrieval.tokenCount,
      platform,
      history,
      images: imageAttachments,
    };

    const normalizedOverride = normalizeModelOverride(modelOverride);
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
    const preFlightCost = calculatePreFlightCost(
      decision.modelTier,
      `${historyContext}\nuser: ${effectiveQuery}`,
      imageAttachments.length,
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

    let upstream: UpstreamCallResult;
    try {
      upstream = await callProviderStream(
        decision,
        allMessages,
        imageAttachments,
        controller.signal,
        normalizedGeminiFlashThinkingLevel,
      );
    } catch (upstreamError) {
      const message = upstreamError instanceof Error
        ? upstreamError.message
        : String(upstreamError);
      return new Response(
        JSON.stringify({
          error: 'Upstream provider error',
          provider: decision.provider,
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
        `[Upstream:${decision.provider}] Error ${upstream.response.status}:`,
        errorBody,
      );
      return new Response(
        JSON.stringify({
          error: 'Upstream provider error',
          provider: decision.provider,
          details: errorBody,
        }),
        {
          status: 502,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        },
      );
    }

    const effectiveModelId = upstream.effectiveModelId || decision.model;

    const userTokenCount = countTokens(query) + countImageTokens(imageAttachments);
    persistMessageAsync(
      supabaseClient as unknown as ReturnType<typeof createClient>,
      conversationId,
      'user',
      query,
      userTokenCount,
      `${decision.provider}:${effectiveModelId}`,
      imageStorageUrl,
    );

    if (!upstream.response.body) {
      return new Response(JSON.stringify({ error: 'Upstream provider returned empty stream' }), {
        status: 502,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    let assistantText = '';

    const proxyStream = createNormalizedProxyStream({
      upstreamBody: upstream.response.body,
      extractDeltas: upstream.extractDeltas,
      onDelta: (delta) => {
        assistantText += delta;
      },
      onComplete: () => {
        const assistantTokenCount = countTokens(assistantText);
        if (assistantText.trim()) {
          persistMessageAsync(
            supabaseClient as unknown as ReturnType<typeof createClient>,
            conversationId,
            'assistant',
            assistantText,
            assistantTokenCount,
            `${decision.provider}:${effectiveModelId}`,
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
        'X-Router-Model': decision.modelTier,
        'X-Router-Model-Id': effectiveModelId,
        'X-Provider': decision.provider,
        'X-Model-Override': normalizedOverride || 'auto',
        'X-Router-Rationale': decision.rationaleTag,
        'X-Complexity-Score': decision.complexityScore.toString(),
        'X-Gemini-Thinking-Level': upstream.effectiveGeminiFlashThinkingLevel || 'n/a',
        'X-Memory-Hits': String(memoryRetrieval.hits),
        'X-Memory-Tokens': String(memoryRetrieval.tokenCount),
        'X-Cost-Estimate-USD': preFlightCost.estimatedUsd.toFixed(6),
        'X-Cost-Pricing-Version': preFlightCost.pricingVersion,
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
