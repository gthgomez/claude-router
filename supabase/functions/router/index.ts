// index.ts - Claude Router Edge Function
// FIXED: CORS now exposes custom headers

import { createClient } from 'npm:@supabase/supabase-js@2';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

interface Message {
  role: 'user' | 'assistant';
  content: string;
  imageData?: string;
  mediaType?: string;
}

interface ImageAttachment {
  data: string;
  mediaType: string;
}

interface RouterParams {
  userQuery: string;
  currentSessionTokens: number;
  platform: 'web' | 'mobile';
  history: Message[];
  images?: ImageAttachment[];
  imageStorageUrl?: string;
}

interface RouteDecision {
  model: string;
  modelTier: 'haiku-4.5' | 'sonnet-4.5' | 'opus-4.5';
  budgetCap: number;
  rationaleTag: string;
  complexityScore: number;
}

// ============================================================================
// CONSTANTS & CONFIGURATION
// ============================================================================

// âœ… FIX: Added Access-Control-Expose-Headers so frontend can read custom headers
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-client-info, apikey',
  'Access-Control-Expose-Headers': 'X-Claude-Model, X-Router-Rationale, X-Complexity-Score', // âœ… NEW
};

const FUNCTION_TIMEOUT_MS = 55000;
const MAX_QUERY_LENGTH = 50000;
const DEV_MODE = Deno.env.get('DEV_MODE') === 'true';
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY');

const MODELS = {
  'haiku-4.5': 'claude-haiku-4-5-20251001',
  'sonnet-4.5': 'claude-sonnet-4-5-20250929',
  'opus-4.5': 'claude-opus-4-5-20251101'
} as const;

type ModelTier = keyof typeof MODELS;

const COMPLEXITY_INDICATORS = {
  opus: [
    'analyze', 'research', 'comprehensive', 'detailed analysis',
    'compare and contrast', 'evaluate', 'synthesize', 'critique',
    'design', 'architect', 'strategy', 'in-depth', 'thorough',
    'explain why', 'reasoning', 'implications', 'trade-offs',
    'debug this', 'review this code', 'optimize', 'refactor'
  ],
  sonnet: [
    'write', 'create', 'generate', 'draft', 'compose',
    'explain', 'describe', 'summarize', 'translate',
    'help me', 'how do i', 'what is', 'code', 'function',
    'script', 'convert', 'format', 'list'
  ],
  haiku: [
    'quick', 'simple', 'short', 'brief', 'yes or no',
    'what time', 'how many', 'define', 'spell', 'calculate'
  ]
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function transformMessagesForClaude(
  messages: Message[], 
  currentImages?: ImageAttachment[]
) {
  return messages.map((msg, index) => {
    const isLastMessage = index === messages.length - 1;
    
    if (isLastMessage && msg.role === 'user' && currentImages && currentImages.length > 0) {
      const contentArray: any[] = [];
      
      for (const img of currentImages) {
        contentArray.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: img.mediaType || 'image/jpeg',
            data: img.data,
          },
        });
      }
      
      contentArray.push({
        type: 'text',
        text: msg.content || 'Please analyze these images.',
      });
      
      return { role: msg.role, content: contentArray };
    }
    
    if (msg.imageData) {
      return {
        role: msg.role,
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: msg.mediaType || 'image/jpeg',
              data: msg.imageData,
            },
          },
          {
            type: 'text',
            text: msg.content || 'Please analyze this image.',
          },
        ],
      };
    }
    
    return { role: msg.role, content: msg.content || '' };
  });
}

const tokenCache = new Map<string, number>();
function countTokens(text: string): number {
  if (!text) return 0;
  if (tokenCache.has(text)) return tokenCache.get(text)!;

  const words = text.split(/\s+/).length;
  const chars = text.length;
  const count = Math.ceil((words + chars / 4) / 2);

  if (tokenCache.size < 100) tokenCache.set(text, count);
  return count;
}

function countImageTokens(images?: ImageAttachment[]): number {
  if (!images || images.length === 0) return 0;
  return images.length * 1600;
}

// ============================================================================
// COMPLEXITY ANALYSIS
// ============================================================================

function analyzeComplexity(params: RouterParams): number {
  let score = 50;
  const query = params.userQuery.toLowerCase();
  const queryTokens = countTokens(params.userQuery);
  const historyTokens = params.currentSessionTokens;

  if (queryTokens < 20) score -= 20;
  else if (queryTokens < 50) score -= 10;
  else if (queryTokens > 500) score += 15;
  else if (queryTokens > 200) score += 10;

  for (const keyword of COMPLEXITY_INDICATORS.opus) {
    if (query.includes(keyword)) {
      score += 5;
      if (score > 75) break;
    }
  }
  for (const keyword of COMPLEXITY_INDICATORS.haiku) {
    if (query.includes(keyword)) {
      score -= 5;
      if (score < 25) break;
    }
  }

  const questionWords = (query.match(/\b(why|how|what if|could|would|should|compare|versus|vs)\b/g) || []).length;
  if (questionWords >= 3) score += 15;
  else if (questionWords >= 2) score += 8;

  if (query.includes(' and ') && query.includes('?')) score += 10;

  const codeIndicators = [/```/, /\b(function|const|let|var|class|def|import|export)\b/, /[{}\[\]();]/, /\b(error|bug|fix|debug|crash|exception)\b/i];
  let codeSignals = 0;
  for (const pattern of codeIndicators) {
    if (pattern.test(params.userQuery)) codeSignals++;
  }
  if (codeSignals >= 3) score += 15;
  else if (codeSignals >= 2) score += 10;

  const totalTokens = historyTokens + queryTokens;
  if (totalTokens > 100000) score += 10;
  else if (totalTokens > 50000) score += 5;

  if (/\b(json|list|bullet|table|csv)\b/i.test(query) && queryTokens < 100) {
    score -= 10;
  }

  if (/\b(write|story|poem|essay|blog|article|creative|fiction)\b/i.test(query)) {
    if (score < 50) score = 50;
    if (score > 70) score = 65;
  }

  return Math.max(0, Math.min(100, score));
}

// ============================================================================
// ROUTING LOGIC
// ============================================================================

function determineRoute(params: RouterParams, modelOverride?: ModelTier): RouteDecision {
  const hasImages = params.images && params.images.length > 0;
  const complexityScore = analyzeComplexity(params);
  const queryTokens = countTokens(params.userQuery) + countImageTokens(params.images);
  const totalTokens = params.currentSessionTokens + queryTokens;

  // Manual override
  if (modelOverride && MODELS[modelOverride]) {
    return {
      model: MODELS[modelOverride],
      modelTier: modelOverride,
      budgetCap: modelOverride === 'opus-4.5' ? 16000 : modelOverride === 'sonnet-4.5' ? 8000 : 4000,
      rationaleTag: 'manual-override',
      complexityScore
    };
  }

  // Auto-routing logic
  if (hasImages) {
    if (complexityScore > 60 || totalTokens > 50000) {
      return { model: MODELS['opus-4.5'], modelTier: 'opus-4.5', budgetCap: 16000, rationaleTag: 'images-complex', complexityScore };
    }
    return { model: MODELS['sonnet-4.5'], modelTier: 'sonnet-4.5', budgetCap: 8000, rationaleTag: 'images-standard', complexityScore };
  }

  if (complexityScore >= 75 || totalTokens > 100000) {
    return { model: MODELS['opus-4.5'], modelTier: 'opus-4.5', budgetCap: 16000, rationaleTag: 'high-complexity', complexityScore };
  }

  if (complexityScore <= 25 && queryTokens < 100 && totalTokens < 10000) {
    return { model: MODELS['haiku-4.5'], modelTier: 'haiku-4.5', budgetCap: 4000, rationaleTag: 'low-complexity', complexityScore };
  }

  return { model: MODELS['sonnet-4.5'], modelTier: 'sonnet-4.5', budgetCap: 8000, rationaleTag: 'default-balanced', complexityScore };
}

// ============================================================================
// JWT VERIFICATION
// ============================================================================

function extractBearerToken(authHeader: string): string | null {
  if (!authHeader.startsWith('Bearer ')) return null;
  return authHeader.substring(7);
}

function verifyJWT(token: string): { user_id: string; exp?: number } | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));

    if (payload.exp && payload.exp < Date.now() / 1000) {
      console.error('[JWT] Token expired');
      return null;
    }

    const userId = payload.sub || payload.user_id;
    if (!userId) return null;

    return { user_id: userId, exp: payload.exp };
  } catch (err) {
    console.error('[JWT] Verification failed:', err);
    return null;
  }
}

// ============================================================================
// DATABASE HELPERS
// ============================================================================

async function validateConversation(
  supabase: ReturnType<typeof createClient>,
  conversationId: string,
  userId: string
): Promise<{ valid: boolean; tokenCount: number }> {
  const { data: conv, error } = await supabase
    .from('conversations')
    .select('user_id, total_tokens')
    .eq('id', conversationId)
    .maybeSingle();

  if (error || !conv) {
    await supabase.from('conversations').insert({ id: conversationId, user_id: userId, total_tokens: 0 });
    return { valid: true, tokenCount: 0 };
  }

  if (conv.user_id !== userId) return { valid: false, tokenCount: 0 };
  return { valid: true, tokenCount: conv.total_tokens || 0 };
}

function persistMessageAsync(
  supabase: ReturnType<typeof createClient>,
  conversationId: string,
  role: 'user' | 'assistant',
  content: string,
  tokenCount: number,
  modelUsed?: string,
  imageUrl?: string
): void {
  (async () => {
    try {
      await Promise.all([
        supabase.from('messages').insert({
          conversation_id: conversationId,
          role, content, token_count: tokenCount,
          model_used: modelUsed, image_url: imageUrl
        }),
        supabase.rpc('increment_token_count', {
          p_conversation_id: conversationId,
          p_tokens: tokenCount
        })
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
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Unauthorized: Missing Authorization header' }), {
        status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      });
    }

    const token = extractBearerToken(authHeader);
    if (!token) {
      return new Response(JSON.stringify({ error: 'Unauthorized: Invalid token format' }), {
        status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      });
    }

    const jwtPayload = verifyJWT(token);
    if (!jwtPayload) {
      return new Response(JSON.stringify({ error: 'Unauthorized: Invalid or expired token' }), {
        status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      });
    }

    const userId = jwtPayload.user_id;

    let body: {
      query?: string;
      conversationId?: string;
      platform?: 'web' | 'mobile';
      history?: Message[];
      images?: ImageAttachment[];
      imageData?: string;
      mediaType?: string;
      imageStorageUrl?: string;
      modelOverride?: ModelTier;
    };

    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: 'Bad Request: Invalid JSON' }), {
        status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
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
      modelOverride 
    } = body;

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
        status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      });
    }

    if (!conversationId) {
      return new Response(JSON.stringify({ error: 'Bad Request: Missing conversationId' }), {
        status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      });
    }

    if (!query && hasImages) {
      query = imageAttachments.length === 1 
        ? 'Please analyze this image.' 
        : `Please analyze these ${imageAttachments.length} images.`;
    }

    if (query.length > MAX_QUERY_LENGTH) {
      return new Response(JSON.stringify({ error: 'Query exceeds maximum length' }), {
        status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      });
    }

    if (DEV_MODE) {
      console.log(`[DEV] Request:`, {
        userId: userId.slice(0, 8),
        conversationId: conversationId.slice(0, 8),
        imageCount: imageAttachments.length,
        queryLen: query.length,
        modelOverride: modelOverride || 'auto'
      });
    }

    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const ownership = await validateConversation(supabaseClient, conversationId, userId);
    if (!ownership.valid) {
      return new Response(JSON.stringify({ error: 'Forbidden: Invalid conversation ownership' }), {
        status: 403, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      });
    }

    const routerParams: RouterParams = {
      userQuery: query,
      currentSessionTokens: ownership.tokenCount,
      platform,
      history,
      images: imageAttachments,
      imageStorageUrl
    };

    const decision = determineRoute(routerParams, modelOverride);

    if (DEV_MODE) {
      console.log(`[ROUTER] Score: ${decision.complexityScore}, Model: ${decision.modelTier}, Reason: ${decision.rationaleTag}, Images: ${imageAttachments.length}`);
    }

    const userMsg: Message = {
      role: 'user',
      content: query,
    };

    const allMessages = [...history, userMsg];
    const claudeMessages = transformMessagesForClaude(allMessages, imageAttachments);

    const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY!,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: decision.model,
        max_tokens: decision.budgetCap,
        messages: claudeMessages,
        stream: true
      }),
      signal: controller.signal,
    });

    if (!anthropicResponse.ok) {
      const errorBody = await anthropicResponse.text();
      console.error(`[Anthropic] Error ${anthropicResponse.status}:`, errorBody);
      return new Response(JSON.stringify({ error: 'Upstream provider error', details: errorBody }), {
        status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      });
    }

    const userTokenCount = countTokens(query) + countImageTokens(imageAttachments);
    persistMessageAsync(
      supabaseClient,
      conversationId,
      'user',
      query,
      userTokenCount,
      decision.model,
      imageStorageUrl
    );

    return new Response(anthropicResponse.body, {
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'X-Claude-Model': decision.modelTier,
        'X-Router-Rationale': decision.rationaleTag,
        'X-Complexity-Score': decision.complexityScore.toString()
      }
    });

  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return new Response(JSON.stringify({ error: 'Request timeout' }), {
        status: 504, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      });
    }

    console.error('[Router] Critical error:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
    });
  } finally {
    clearTimeout(timeoutId);
  }
});