// smartFetch.ts - Frontend API utility for Prismatix router communication
// FIXED: Supports multiple file attachments in a single message

import { supabase } from './lib/supabase';
import { CONFIG } from './config';
import type {
  DebateProfile,
  FileUploadPayload,
  GeminiFlashThinkingLevel,
  Message,
  RouterModel,
  RouterProvider,
} from './types';

const STORAGE_KEY = 'prismatix_conversation_id';
const MAX_ROUTER_QUERY_LENGTH = 50000;
const QUERY_SAFETY_MARGIN = 2000;
const MAX_CLIENT_QUERY_LENGTH = MAX_ROUTER_QUERY_LENGTH - QUERY_SAFETY_MARGIN;

export interface DebateRequestOptions {
  mode?: 'debate';
  debateProfile?: DebateProfile;
}

export interface DebateResponseMetadata {
  debateActive?: boolean;
  debateProfile?: DebateProfile;
  debateTrigger?: string;
  debateModel?: string;
  debateCostNote?: string;
}

function base64UrlDecode(input: string): string {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return atob(padded);
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  const payloadPart = parts[1];
  if (!payloadPart) return null;
  try {
    const json = base64UrlDecode(payloadPart);
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function hostOf(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return '';
  }
}

async function signOutLocal(context: string): Promise<void> {
  try {
    console.warn('[smartFetch] Local sign-out:', context);
    await supabase.auth.signOut({ scope: 'local' });
  } catch (err) {
    console.warn('[smartFetch] Local sign-out failed:', err);
  }
}

/**
 * Generates a valid UUID v4
 */
function generateUUID(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

/**
 * Generates or retrieves conversation ID from localStorage
 */
export function getConversationId(): string {
  let conversationId = localStorage.getItem(STORAGE_KEY);

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  if (!conversationId || !uuidRegex.test(conversationId)) {
    conversationId = generateUUID();
    localStorage.setItem(STORAGE_KEY, conversationId);
    console.log('[smartFetch] Generated new conversation UUID:', conversationId);
  }

  return conversationId;
}

/**
 * Resets the conversation by clearing the stored ID
 */
export function resetConversation(): void {
  localStorage.removeItem(STORAGE_KEY);
  console.log('[smartFetch] Conversation reset');
}

/**
 * Converts Message[] to router history format
 */
function messagesToHistory(messages: Message[]) {
  return messages.map(msg => ({
    role: msg.role,
    content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
    ...(msg.imageData && { imageData: msg.imageData }),
    ...(msg.mediaType && { mediaType: msg.mediaType })
  }));
}

/**
 * Retrieve environment variables from Vite
 */
function getEnvVar(key: string): string {
  const value = import.meta.env[key];
  if (!value) {
    throw new Error(`Missing environment variable: ${key}. Check your .env file.`);
  }
  return value;
}

/**
 * Gets the current user's access token from Supabase session
 * Includes automatic token refresh if expired or expiring soon
 */
async function getAccessToken(): Promise<string> {
  const { data: { session }, error } = await supabase.auth.getSession();
  
  if (error) {
    console.error('[smartFetch] Session error:', error);
    const lowered = String(error.message || '').toLowerCase();
    if (lowered.includes('invalid refresh token') || lowered.includes('refresh token not found')) {
      await signOutLocal('invalid-refresh-token');
      throw new Error('Session expired. Please sign in again.');
    }
    throw new Error('Failed to get session: ' + error.message);
  }
  
  if (!session?.access_token) {
    throw new Error('No active session. Please sign in.');
  }

  const expectedHost = hostOf(CONFIG.SUPABASE_URL);
  const payload = decodeJwtPayload(session.access_token);
  const issuer = typeof payload?.iss === 'string' ? payload.iss : '';
  const issuerHost = issuer ? hostOf(issuer) : '';

  if (expectedHost && issuerHost && expectedHost !== issuerHost) {
    console.error('[smartFetch] Token issuer mismatch:', { issuerHost, expectedHost });
    await signOutLocal('token-issuer-mismatch');
    throw new Error(
      `Session token is for ${issuerHost}, but app is configured for ${expectedHost}. ` +
      'Clear site data and sign in again.'
    );
  }

  return session.access_token;
}

/**
 * Calls the Prismatix router and returns a ReadableStream for streaming responses
 * 
 * ✅ FIX: Now accepts array of attachments and builds proper multimodal content
 * 
 * @param query - The user's message text
 * @param history - Previous messages in the conversation
 * @param attachments - Array of file attachments (images or text files)
 * @param modelOverride - Optional manual model selection (bypasses auto-routing)
 */
export async function askPrismatix(
  query: string,
  history: Message[] = [],
  attachments: FileUploadPayload[] = [], // ✅ Changed from single to array
  modelOverride?: RouterModel | null,
  geminiFlashThinkingLevel: GeminiFlashThinkingLevel = 'high',
  debateOptions?: DebateRequestOptions,
): Promise<{
  stream: ReadableStream<Uint8Array>;
  model: RouterModel;
  provider?: RouterProvider;
  complexityScore: number;
  modelId?: string;
  modelOverride?: string;
  geminiFlashThinkingLevel?: GeminiFlashThinkingLevel;
  costEstimateUsd?: number;
  costPricingVersion?: string;
  debateActive?: boolean;
  debateProfile?: DebateProfile;
  debateTrigger?: string;
  debateModel?: string;
  debateCostNote?: string;
} | null> {
  try {
    const routerEndpoint = CONFIG.ROUTER_ENDPOINT || getEnvVar('VITE_ROUTER_ENDPOINT');
    if (!routerEndpoint) {
      throw new Error('Missing VITE_ROUTER_ENDPOINT. Check your Vercel env vars.');
    }
    let accessToken = await getAccessToken();
    const conversationId = getConversationId();
    
    // ✅ FIX: Build arrays for multiple images and text file content
    const imageAttachments = attachments.filter((f) => f.isImage && f.imageData);
    const videoAttachments = attachments.filter(
      (f) => f.kind === 'video' && f.videoAssetId && f.status === 'ready',
    );
    const textAttachments = attachments.filter((f) => f.kind !== 'video' && !f.isImage && f.content);
    
    // Append text file contents to query
    let finalQuery = query;
    if (textAttachments.length > 0) {
      const textContent = textAttachments
        .map(f => `\n\n--- File: ${f.name} ---\n${f.content}`)
        .join('');
      finalQuery = query + textContent;
    }

    if (finalQuery.length > MAX_CLIENT_QUERY_LENGTH) {
      throw new Error(
        `Request is too large (${finalQuery.length} characters). ` +
        `Please reduce text attachment size and keep total prompt content under ${MAX_CLIENT_QUERY_LENGTH} characters.`
      );
    }

    // Build payload with image array
    const payload: Record<string, any> = {
      query: finalQuery,
      conversationId,
      platform: 'web',
      history: messagesToHistory(history),
    };

    // ✅ FIX: Send array of images instead of single image
    if (imageAttachments.length > 0) {
      payload.images = imageAttachments.map(img => ({
        data: img.imageData,
        mediaType: img.mediaType || 'image/png'
      }));
      
      // Also send first image in legacy format for backwards compatibility
      payload.imageData = imageAttachments[0]?.imageData;
      payload.mediaType = imageAttachments[0]?.mediaType || 'image/png';
    }

    if (videoAttachments.length > 0) {
      payload.videoAssetIds = videoAttachments
        .map((video) => video.videoAssetId)
        .filter((assetId): assetId is string => typeof assetId === 'string' && assetId.length > 0);
    }

    // Add manual model override if specified
    if (modelOverride) {
      payload.modelOverride = modelOverride;
      console.log('[smartFetch] Manual model override:', modelOverride);
    }

    payload.geminiFlashThinkingLevel = geminiFlashThinkingLevel;
    if (debateOptions?.mode === 'debate' && debateOptions.debateProfile) {
      payload.mode = 'debate';
      payload.debateProfile = debateOptions.debateProfile;
    }

    console.log('[smartFetch] Request:', {
      endpoint: routerEndpoint,
      conversationId,
      queryLength: finalQuery.length,
      historyLength: history.length,
      imageCount: imageAttachments.length,
      videoCount: videoAttachments.length,
      textFileCount: textAttachments.length,
      modelOverride: modelOverride || 'auto',
      geminiFlashThinkingLevel,
      debateMode: payload.mode || 'off',
      debateProfile: payload.debateProfile || 'off',
    });

    const doFetch = (token: string) => fetch(routerEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        ...(CONFIG.SUPABASE_ANON_KEY ? { 'apikey': CONFIG.SUPABASE_ANON_KEY } : {})
      },
      body: JSON.stringify(payload)
    });

    let response = await doFetch(accessToken);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[smartFetch] Router Error:', response.status, errorText);
      
      if (response.status === 401) {
        console.warn('[smartFetch] 401 from router, retrying once with latest session');
        accessToken = await getAccessToken();
        response = await doFetch(accessToken);

        if (!response.ok) {
          const retryText = await response.text();
          console.error('[smartFetch] Router Error (after retry):', response.status, retryText);
          if (response.status === 401) {
            await signOutLocal('router-401-after-retry');
            throw new Error('Session expired. Please sign in again.');
          }
          try {
            const errorJson = JSON.parse(retryText);
            if (errorJson.error === 'video_not_ready') {
              throw new Error('One or more videos are still processing. Please wait and try again.');
            }
            throw new Error(errorJson.error || `Router returned ${response.status}`);
          } catch (e) {
            if (e instanceof SyntaxError) {
              throw new Error(`Router returned ${response.status}: ${retryText}`);
            }
            throw e;
          }
        } else {
          // proceed to success path
        }
      } else {
        try {
          const errorJson = JSON.parse(errorText);
          if (errorJson.error === 'video_not_ready') {
            throw new Error('One or more videos are still processing. Please wait and try again.');
          }
          throw new Error(errorJson.error || `Router returned ${response.status}`);
        } catch (e) {
          if (e instanceof SyntaxError) {
            throw new Error(`Router returned ${response.status}: ${errorText}`);
          }
          throw e;
        }
      }
      
      if (!response.ok) {
        // Should be unreachable, but keep a final guard.
        if (response.status === 401) {
          await signOutLocal('router-401-guard');
          throw new Error('Session expired. Please sign in again.');
        }
        throw new Error(`Router returned ${response.status}`);
      }
    }

    // Extract model info from headers
    const modelHeader = (
      response.headers.get('X-Router-Model') ||
      'gemini-3-flash'
    ) as RouterModel;
    const modelIdHeader = response.headers.get('X-Router-Model-Id') || '';
    const providerHeader = response.headers.get('X-Provider') as RouterProvider | null;
    const overrideHeader = response.headers.get('X-Model-Override') || '';
    const geminiThinkingHeader = response.headers.get('X-Gemini-Thinking-Level') || '';
    const complexityHeader = response.headers.get('X-Complexity-Score');
    const rationaleHeader = response.headers.get('X-Router-Rationale');
    const costEstimateHeader = response.headers.get('X-Cost-Estimate-USD');
    const costPricingVersion = response.headers.get('X-Cost-Pricing-Version') || undefined;
    const debateModeHeader = response.headers.get('X-Debate-Mode');
    const debateProfileHeader = response.headers.get('X-Debate-Profile');
    const debateTriggerHeader = response.headers.get('X-Debate-Trigger');
    const debateModelHeader = response.headers.get('X-Debate-Model');
    const debateCostNoteHeader = response.headers.get('X-Debate-Cost-Note');
    const complexityScore = complexityHeader ? parseInt(complexityHeader, 10) : 50;
    const parsedCostEstimate = costEstimateHeader ? Number(costEstimateHeader) : Number.NaN;
    const costEstimateUsd = Number.isFinite(parsedCostEstimate) ? parsedCostEstimate : undefined;
    const appliedGeminiThinkingLevel = geminiThinkingHeader === 'low' || geminiThinkingHeader === 'high'
      ? geminiThinkingHeader
      : undefined;
    const normalizedDebateProfile = debateProfileHeader === 'general' ||
      debateProfileHeader === 'code' ||
      debateProfileHeader === 'video_ui'
      ? debateProfileHeader
      : undefined;
    const debateModeValue = debateModeHeader?.toLowerCase();
    const debateMetadata: DebateResponseMetadata = {
      debateActive: debateModeValue === 'debate' || debateModeValue === 'true' ? true : undefined,
      debateProfile: normalizedDebateProfile,
      debateTrigger: debateTriggerHeader || undefined,
      debateModel: debateModelHeader || undefined,
      debateCostNote: debateCostNoteHeader || undefined,
    };

    console.log('[smartFetch] Response:', {
      model: modelHeader,
      provider: providerHeader || undefined,
      modelId: modelIdHeader,
      override: overrideHeader,
      geminiThinking: appliedGeminiThinkingLevel,
      costEstimateUsd,
      costPricingVersion,
      debateMode: debateModeHeader || undefined,
      debateProfile: debateMetadata.debateProfile,
      debateTrigger: debateMetadata.debateTrigger,
      debateModel: debateMetadata.debateModel,
      debateCostNote: debateMetadata.debateCostNote,
      complexity: complexityScore,
      rationale: rationaleHeader,
      status: response.status
    });

    if (!response.body) {
      throw new Error('Response body is null');
    }

    return {
      stream: response.body,
      model: modelHeader,
      provider: providerHeader || undefined,
      complexityScore,
      modelId: modelIdHeader || undefined,
      modelOverride: overrideHeader || undefined,
      geminiFlashThinkingLevel: appliedGeminiThinkingLevel,
      costEstimateUsd,
      costPricingVersion,
      debateActive: debateMetadata.debateActive,
      debateProfile: debateMetadata.debateProfile,
      debateTrigger: debateMetadata.debateTrigger,
      debateModel: debateMetadata.debateModel,
      debateCostNote: debateMetadata.debateCostNote,
    };
  } catch (error) {
    console.error('[smartFetch] Error:', error);
    throw error;
  }
}

/**
 * Non-streaming version for simple requests
 */
export async function askPrismatixSync(
  query: string,
  history: Message[] = [],
  attachments: FileUploadPayload[] = [],
  modelOverride?: RouterModel | null,
  geminiFlashThinkingLevel: GeminiFlashThinkingLevel = 'high',
  debateOptions?: DebateRequestOptions,
): Promise<{
  content: string;
  model: RouterModel;
  provider?: RouterProvider;
  complexityScore: number;
  modelId?: string;
  modelOverride?: string;
  geminiFlashThinkingLevel?: GeminiFlashThinkingLevel;
  costEstimateUsd?: number;
  costPricingVersion?: string;
  debateActive?: boolean;
  debateProfile?: DebateProfile;
  debateTrigger?: string;
  debateModel?: string;
  debateCostNote?: string;
} | null> {
  const result = await askPrismatix(
    query,
    history,
    attachments,
    modelOverride,
    geminiFlashThinkingLevel,
    debateOptions,
  );
  if (!result) return null;

  const reader = result.stream.getReader();
  const decoder = new TextDecoder();
  let content = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      content += decoder.decode(value, { stream: true });
    }

    return {
      content,
      model: result.model,
      provider: result.provider,
      complexityScore: result.complexityScore,
      modelId: result.modelId,
      modelOverride: result.modelOverride,
      geminiFlashThinkingLevel: result.geminiFlashThinkingLevel,
      costEstimateUsd: result.costEstimateUsd,
      costPricingVersion: result.costPricingVersion,
      debateActive: result.debateActive,
      debateProfile: result.debateProfile,
      debateTrigger: result.debateTrigger,
      debateModel: result.debateModel,
      debateCostNote: result.debateCostNote,
    };
  } catch (error) {
    console.error('[smartFetch] Stream reading error:', error);
    return null;
  }
}
