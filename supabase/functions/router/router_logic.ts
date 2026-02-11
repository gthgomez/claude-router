// router_logic.ts - Pure routing + message transform logic (no Deno.serve side effects)

export type Provider = 'anthropic' | 'openai' | 'google';

export interface Message {
  role: 'user' | 'assistant';
  content: string;
  imageData?: string;
  mediaType?: string;
}

export interface ImageAttachment {
  data: string;
  mediaType: string;
}

export interface RouterParams {
  userQuery: string;
  currentSessionTokens: number;
  platform: 'web' | 'mobile';
  history: Message[];
  images?: ImageAttachment[];
}

interface ModelConfig {
  provider: Provider;
  modelId: string;
  budgetCap: number;
  supportsImages: boolean;
}

export const MODEL_REGISTRY = {
  'haiku-4.5': {
    provider: 'anthropic',
    modelId: 'claude-haiku-4-5-20251001',
    budgetCap: 4000,
    supportsImages: true,
  },
  'sonnet-4.5': {
    provider: 'anthropic',
    modelId: 'claude-sonnet-4-5-20250929',
    budgetCap: 8000,
    supportsImages: true,
  },
  'opus-4.5': {
    provider: 'anthropic',
    modelId: 'claude-opus-4-5-20251101',
    budgetCap: 16000,
    supportsImages: true,
  },
  'gpt-5-mini': {
    provider: 'openai',
    modelId: 'gpt-5-mini',
    budgetCap: 4096,
    supportsImages: true,
  },
  'gemini-3-flash': {
    provider: 'google',
    modelId: 'gemini-3.0-flash-preview-05-20',
    budgetCap: 8192,
    supportsImages: true,
  },
  'gemini-3-pro': {
    provider: 'google',
    modelId: 'gemini-3.0-pro-preview-05-20',
    budgetCap: 16384,
    supportsImages: true,
  },
} as const satisfies Record<string, ModelConfig>;

export type RouterModel = keyof typeof MODEL_REGISTRY;
export type ModelTier = RouterModel;

export interface RouteDecision {
  provider: Provider;
  model: string;
  modelTier: RouterModel;
  budgetCap: number;
  rationaleTag: string;
  complexityScore: number;
}

const OVERRIDE_SYNONYMS: Record<string, RouterModel> = {
  'anthropic:haiku': 'haiku-4.5',
  'anthropic:haiku-4.5': 'haiku-4.5',
  'anthropic:sonnet': 'sonnet-4.5',
  'anthropic:sonnet-4.5': 'sonnet-4.5',
  'anthropic:opus': 'opus-4.5',
  'anthropic:opus-4.5': 'opus-4.5',
  'openai:gpt-5-mini': 'gpt-5-mini',
  'openai:gpt-mini': 'gpt-5-mini',
  'google:gemini-3-pro': 'gemini-3-pro',
  'google:gemini-3-flash': 'gemini-3-flash',
};

export function normalizeModelOverride(input?: string): RouterModel | undefined {
  if (!input) return undefined;
  const value = String(input).toLowerCase().trim();
  if (!value || value === 'auto') return undefined;

  if (value in MODEL_REGISTRY) {
    return value as RouterModel;
  }

  if (value in OVERRIDE_SYNONYMS) {
    return OVERRIDE_SYNONYMS[value];
  }

  if (value.includes('haiku')) return 'haiku-4.5';
  if (value.includes('sonnet')) return 'sonnet-4.5';
  if (value.includes('opus')) return 'opus-4.5';

  if (value.includes('gpt-5-mini') || value.includes('gpt mini')) return 'gpt-5-mini';

  if (
    value.includes('gemini-3-flash') ||
    value.includes('gemini 3 flash') ||
    value.includes('gemini flash')
  ) {
    return 'gemini-3-flash';
  }

  if (
    value.includes('gemini-3-pro') ||
    value.includes('gemini 3 pro') ||
    value.includes('gemini pro')
  ) {
    return 'gemini-3-pro';
  }

  return undefined;
}

const COMPLEXITY_INDICATORS = {
  opus: [
    'analyze',
    'research',
    'comprehensive',
    'detailed analysis',
    'compare and contrast',
    'evaluate',
    'synthesize',
    'critique',
    'design',
    'architect',
    'strategy',
    'in-depth',
    'thorough',
    'explain why',
    'reasoning',
    'implications',
    'trade-offs',
    'debug this',
    'review this code',
    'optimize',
    'refactor',
  ],
  quick: [
    'quick',
    'simple',
    'short',
    'brief',
    'yes or no',
    'what time',
    'how many',
    'define',
    'spell',
    'calculate',
  ],
};

const tokenCache = new Map<string, number>();

export function countTokens(text: string): number {
  if (!text) return 0;
  if (tokenCache.has(text)) return tokenCache.get(text)!;

  const words = text.split(/\s+/).length;
  const chars = text.length;
  const count = Math.ceil((words + chars / 4) / 2);

  if (tokenCache.size < 100) tokenCache.set(text, count);
  return count;
}

export function countImageTokens(images?: ImageAttachment[]): number {
  if (!images || images.length === 0) return 0;
  return images.length * 1600;
}

interface ClaudeImageBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

interface ClaudeTextBlock {
  type: 'text';
  text: string;
}

type ClaudeContent = string | Array<ClaudeImageBlock | ClaudeTextBlock>;

export function transformMessagesForClaude(
  messages: Message[],
  currentImages?: ImageAttachment[],
): Array<{ role: 'user' | 'assistant'; content: ClaudeContent }> {
  return messages.map((msg, index) => {
    const isLastMessage = index === messages.length - 1;

    if (isLastMessage && msg.role === 'user' && currentImages && currentImages.length > 0) {
      const contentArray: Array<ClaudeImageBlock | ClaudeTextBlock> = [];

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

interface OpenAITextPart {
  type: 'text';
  text: string;
}

interface OpenAIImagePart {
  type: 'image_url';
  image_url: { url: string };
}

type OpenAIContent = string | Array<OpenAITextPart | OpenAIImagePart>;

export function transformMessagesForOpenAI(
  messages: Message[],
  currentImages?: ImageAttachment[],
): Array<{ role: 'user' | 'assistant'; content: OpenAIContent }> {
  return messages.map((msg, index) => {
    const isLastMessage = index === messages.length - 1;

    if (isLastMessage && msg.role === 'user' && currentImages && currentImages.length > 0) {
      const contentArray: Array<OpenAITextPart | OpenAIImagePart> = [
        { type: 'text', text: msg.content || 'Please analyze these images.' },
      ];

      for (const img of currentImages) {
        contentArray.push({
          type: 'image_url',
          image_url: {
            url: `data:${img.mediaType || 'image/jpeg'};base64,${img.data}`,
          },
        });
      }

      return { role: msg.role, content: contentArray };
    }

    if (msg.imageData) {
      return {
        role: msg.role,
        content: [
          { type: 'text', text: msg.content || 'Please analyze this image.' },
          {
            type: 'image_url',
            image_url: {
              url: `data:${msg.mediaType || 'image/jpeg'};base64,${msg.imageData}`,
            },
          },
        ],
      };
    }

    return { role: msg.role, content: msg.content || '' };
  });
}

interface GoogleInlineDataPart {
  inlineData: { mimeType: string; data: string };
}

interface GoogleTextPart {
  text: string;
}

type GooglePart = GoogleInlineDataPart | GoogleTextPart;

export function transformMessagesForGoogle(
  messages: Message[],
  currentImages?: ImageAttachment[],
): Array<{ role: 'user' | 'model'; parts: GooglePart[] }> {
  return messages.map((msg, index) => {
    const isLastMessage = index === messages.length - 1;
    const role = msg.role === 'assistant' ? 'model' : 'user';

    if (isLastMessage && msg.role === 'user' && currentImages && currentImages.length > 0) {
      const parts: GooglePart[] = [];
      for (const img of currentImages) {
        parts.push({
          inlineData: {
            mimeType: img.mediaType || 'image/jpeg',
            data: img.data,
          },
        });
      }
      parts.push({ text: msg.content || 'Please analyze these images.' });
      return { role, parts };
    }

    if (msg.imageData) {
      return {
        role,
        parts: [
          {
            inlineData: {
              mimeType: msg.mediaType || 'image/jpeg',
              data: msg.imageData,
            },
          },
          {
            text: msg.content || 'Please analyze this image.',
          },
        ],
      };
    }

    return {
      role,
      parts: [{ text: msg.content || '' }],
    };
  });
}

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
  for (const keyword of COMPLEXITY_INDICATORS.quick) {
    if (query.includes(keyword)) {
      score -= 5;
      if (score < 25) break;
    }
  }

  const questionWords =
    (query.match(/\b(why|how|what if|could|would|should|compare|versus|vs)\b/g) || []).length;
  if (questionWords >= 3) score += 15;
  else if (questionWords >= 2) score += 8;

  if (query.includes(' and ') && query.includes('?')) score += 10;

  const codeIndicators = [
    /```/,
    /\b(function|const|let|var|class|def|import|export)\b/,
    /[{}\[\]();]/,
    /\b(error|bug|fix|debug|crash|exception)\b/i,
  ];
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

function buildDecision(modelTier: RouterModel, rationaleTag: string, complexityScore: number): RouteDecision {
  const config = MODEL_REGISTRY[modelTier];
  return {
    provider: config.provider,
    model: config.modelId,
    modelTier,
    budgetCap: config.budgetCap,
    rationaleTag,
    complexityScore,
  };
}

export function isClaudeModel(modelTier: RouterModel): boolean {
  return MODEL_REGISTRY[modelTier].provider === 'anthropic';
}

export function determineRoute(params: RouterParams, modelOverride?: RouterModel): RouteDecision {
  const hasImages = params.images && params.images.length > 0;
  const complexityScore = analyzeComplexity(params);
  const queryTokens = countTokens(params.userQuery) + countImageTokens(params.images);
  const totalTokens = params.currentSessionTokens + queryTokens;

  if (modelOverride && MODEL_REGISTRY[modelOverride]) {
    return buildDecision(modelOverride, 'manual-override', complexityScore);
  }

  if (hasImages) {
    if (complexityScore >= 70 || totalTokens > 60000) {
      return buildDecision('gemini-3-pro', 'images-complex', complexityScore);
    }
    if (complexityScore <= 30 && totalTokens < 30000) {
      return buildDecision('gemini-3-flash', 'images-fast', complexityScore);
    }
    return buildDecision('sonnet-4.5', 'images-standard', complexityScore);
  }

  if (complexityScore >= 80 || totalTokens > 100000) {
    return buildDecision('opus-4.5', 'high-complexity', complexityScore);
  }

  if (complexityScore <= 18 && queryTokens < 80 && totalTokens < 12000) {
    return buildDecision('gpt-5-mini', 'ultra-low-latency', complexityScore);
  }

  if (complexityScore <= 25 && queryTokens < 100 && totalTokens < 10000) {
    return buildDecision('haiku-4.5', 'low-complexity', complexityScore);
  }

  return buildDecision('sonnet-4.5', 'default-balanced', complexityScore);
}
