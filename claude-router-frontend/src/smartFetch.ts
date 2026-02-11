// smartFetch.ts - Frontend API utility for Claude Router communication
// FIXED: Supports multiple file attachments in a single message

import { supabase } from './lib/supabase';
import { CONFIG } from './config';
import type {
  FileUploadPayload,
  GeminiFlashThinkingLevel,
  Message,
  RouterModel,
  RouterProvider,
} from './types';

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
  const STORAGE_KEY = 'claude_router_conversation_id';
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
  localStorage.removeItem('claude_router_conversation_id');
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
 * Calls the Claude Router and returns a ReadableStream for streaming responses
 * 
 * ✅ FIX: Now accepts array of attachments and builds proper multimodal content
 * 
 * @param query - The user's message text
 * @param history - Previous messages in the conversation
 * @param attachments - Array of file attachments (images or text files)
 * @param modelOverride - Optional manual model selection (bypasses auto-routing)
 */
export async function askClaude(
  query: string,
  history: Message[] = [],
  attachments: FileUploadPayload[] = [], // ✅ Changed from single to array
  modelOverride?: RouterModel | null,
  geminiFlashThinkingLevel: GeminiFlashThinkingLevel = 'high',
): Promise<{
  stream: ReadableStream<Uint8Array>;
  model: RouterModel;
  provider?: RouterProvider;
  complexityScore: number;
  modelId?: string;
  modelOverride?: string;
  geminiFlashThinkingLevel?: GeminiFlashThinkingLevel;
} | null> {
  try {
    const routerEndpoint = CONFIG.ROUTER_ENDPOINT || getEnvVar('VITE_ROUTER_ENDPOINT');
    if (!routerEndpoint) {
      throw new Error('Missing VITE_ROUTER_ENDPOINT. Check your Vercel env vars.');
    }
    let accessToken = await getAccessToken();
    const conversationId = getConversationId();
    
    // ✅ FIX: Build arrays for multiple images and text file content
    const imageAttachments = attachments.filter(f => f.isImage && f.imageData);
    const textAttachments = attachments.filter(f => !f.isImage && f.content);
    
    // Append text file contents to query
    let finalQuery = query;
    if (textAttachments.length > 0) {
      const textContent = textAttachments
        .map(f => `\n\n--- File: ${f.name} ---\n${f.content}`)
        .join('');
      finalQuery = query + textContent;
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

    // Add manual model override if specified
    if (modelOverride) {
      payload.modelOverride = modelOverride;
      console.log('[smartFetch] Manual model override:', modelOverride);
    }

    payload.geminiFlashThinkingLevel = geminiFlashThinkingLevel;

    console.log('[smartFetch] Request:', {
      endpoint: routerEndpoint,
      conversationId,
      queryLength: finalQuery.length,
      historyLength: history.length,
      imageCount: imageAttachments.length,
      textFileCount: textAttachments.length,
      modelOverride: modelOverride || 'auto',
      geminiFlashThinkingLevel,
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
      response.headers.get('X-Claude-Model') ||
      'gemini-3-flash'
    ) as RouterModel;
    const modelIdHeader = response.headers.get('X-Router-Model-Id') || response.headers.get('X-Claude-Model-Id') || '';
    const providerHeader = response.headers.get('X-Provider') as RouterProvider | null;
    const overrideHeader = response.headers.get('X-Model-Override') || '';
    const geminiThinkingHeader = response.headers.get('X-Gemini-Thinking-Level') || '';
    const complexityHeader = response.headers.get('X-Complexity-Score');
    const rationaleHeader = response.headers.get('X-Router-Rationale');
    const complexityScore = complexityHeader ? parseInt(complexityHeader, 10) : 50;
    const appliedGeminiThinkingLevel = geminiThinkingHeader === 'low' || geminiThinkingHeader === 'high'
      ? geminiThinkingHeader
      : undefined;

    console.log('[smartFetch] Response:', {
      model: modelHeader,
      provider: providerHeader || undefined,
      modelId: modelIdHeader,
      override: overrideHeader,
      geminiThinking: appliedGeminiThinkingLevel,
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
    };
  } catch (error) {
    console.error('[smartFetch] Error:', error);
    throw error;
  }
}

/**
 * Non-streaming version for simple requests
 */
export async function askClaudeSync(
  query: string,
  history: Message[] = [],
  attachments: FileUploadPayload[] = [],
  modelOverride?: RouterModel | null,
  geminiFlashThinkingLevel: GeminiFlashThinkingLevel = 'high',
): Promise<{
  content: string;
  model: RouterModel;
  provider?: RouterProvider;
  complexityScore: number;
  modelId?: string;
  modelOverride?: string;
  geminiFlashThinkingLevel?: GeminiFlashThinkingLevel;
} | null> {
  const result = await askClaude(
    query,
    history,
    attachments,
    modelOverride,
    geminiFlashThinkingLevel,
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
    };
  } catch (error) {
    console.error('[smartFetch] Stream reading error:', error);
    return null;
  }
}
