// smartFetch.ts - Frontend API utility for Claude Router communication
// FIXED: Supports multiple file attachments in a single message

import { supabase } from './lib/supabase';
import type { Message, ClaudeModel, FileUploadPayload } from './types';

/**
 * Generates a valid UUID v4
 */
function generateUUID(): string {
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
    throw new Error('Failed to get session: ' + error.message);
  }
  
  if (!session?.access_token) {
    throw new Error('No active session. Please sign in.');
  }
  
  // Check if token is expired or about to expire (less than 60 seconds remaining)
  if (session.expires_at) {
    const expiresIn = session.expires_at * 1000 - Date.now();
    
    if (expiresIn < 60000) {
      console.log('[smartFetch] Token expiring soon, refreshing...');
      
      const { data: { session: refreshedSession }, error: refreshError } = await supabase.auth.refreshSession();
      
      if (refreshError || !refreshedSession?.access_token) {
        console.error('[smartFetch] Token refresh failed:', refreshError);
        throw new Error('Session expired. Please sign in again.');
      }
      
      console.log('[smartFetch] Token refreshed successfully');
      return refreshedSession.access_token;
    }
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
  modelOverride?: ClaudeModel | null
): Promise<{
  stream: ReadableStream<Uint8Array>;
  model: ClaudeModel;
  complexityScore: number;
} | null> {
  try {
    const routerEndpoint = getEnvVar('VITE_ROUTER_ENDPOINT');
    const accessToken = await getAccessToken();
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
      payload.imageData = imageAttachments[0].imageData;
      payload.mediaType = imageAttachments[0].mediaType || 'image/png';
    }

    // Add manual model override if specified
    if (modelOverride) {
      payload.modelOverride = modelOverride;
      console.log('[smartFetch] Manual model override:', modelOverride);
    }

    console.log('[smartFetch] Request:', {
      endpoint: routerEndpoint,
      conversationId,
      queryLength: finalQuery.length,
      historyLength: history.length,
      imageCount: imageAttachments.length,
      textFileCount: textAttachments.length,
      modelOverride: modelOverride || 'auto'
    });

    const response = await fetch(routerEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[smartFetch] Router Error:', response.status, errorText);
      
      if (response.status === 401) {
        throw new Error('Session expired. Please sign in again.');
      }
      
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

    // Extract model info from headers
    const modelHeader = response.headers.get('X-Claude-Model') as ClaudeModel || 'sonnet-4.5';
    const complexityHeader = response.headers.get('X-Complexity-Score');
    const rationaleHeader = response.headers.get('X-Router-Rationale');
    const complexityScore = complexityHeader ? parseInt(complexityHeader, 10) : 50;

    console.log('[smartFetch] Response:', {
      model: modelHeader,
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
      complexityScore
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
  modelOverride?: ClaudeModel | null
): Promise<{ content: string; model: ClaudeModel; complexityScore: number } | null> {
  const result = await askClaude(query, history, attachments, modelOverride);
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
      complexityScore: result.complexityScore
    };
  } catch (error) {
    console.error('[smartFetch] Stream reading error:', error);
    return null;
  }
}
