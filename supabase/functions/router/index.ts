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
  transformMessagesForClaude,
  transformMessagesForGoogle,
  transformMessagesForOpenAI,
} from './router_logic.ts';

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

type GeminiFlashThinkingLevel = 'low' | 'high';

// ============================================================================
// CONSTANTS & CONFIGURATION
// ============================================================================

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-client-info, apikey',
  'Access-Control-Expose-Headers':
    'X-Claude-Model, X-Claude-Model-Id, X-Router-Model, X-Router-Model-Id, X-Provider, X-Model-Override, X-Router-Rationale, X-Complexity-Score, X-Gemini-Thinking-Level',
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
      messages: transformMessagesForClaude(allMessages, images),
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

    const routerParams: RouterParams = {
      userQuery: query,
      currentSessionTokens: ownership.tokenCount,
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
      content: query,
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
        }
      },
    });

    return new Response(proxyStream, {
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'X-Claude-Model': decision.modelTier,
        'X-Claude-Model-Id': effectiveModelId,
        'X-Router-Model': decision.modelTier,
        'X-Router-Model-Id': effectiveModelId,
        'X-Provider': decision.provider,
        'X-Model-Override': normalizedOverride || 'auto',
        'X-Router-Rationale': decision.rationaleTag,
        'X-Complexity-Score': decision.complexityScore.toString(),
        'X-Gemini-Thinking-Level': upstream.effectiveGeminiFlashThinkingLevel || 'n/a',
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
