import { useState, useCallback } from 'react';
import { createClient } from '@supabase/supabase-js';

// Initialize Supabase Client (Tier 3 Pattern)
const supabase = createClient(
  Deno.env.get('NEXT_PUBLIC_SUPABASE_URL')!,
  Deno.env.get('NEXT_PUBLIC_SUPABASE_ANON_KEY')!
);

interface StreamState {
  response: string;
  isLoading: boolean;
  modelUsed: string | null;
  rationale: string | null;
  complexityScore: number | null;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export function useRouterStream() {
  const [state, setState] = useState<StreamState>({
    response: '',
    isLoading: false,
    modelUsed: null,
    rationale: null,
    complexityScore: null
  });

  const streamMessage = useCallback(async (
    query: string, 
    conversationId: string, 
    history: Message[] = []
  ) => {
    setState((prev: StreamState) => ({ ...prev, isLoading: true, response: '' }));

    // 1. GET SESSION TOKEN
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error("No active session");

    // 2. CALL ROUTER EDGE FUNCTION
    const res = await fetch(`${Deno.env.get('NEXT_PUBLIC_SUPABASE_URL')}/functions/v1/router`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}` // Critical for RLS
      },
      body: JSON.stringify({
        query,
        conversationId,
        platform: 'web', // or 'mobile'
        history
      })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Router failed');
    }

    // 3. CAPTURE METADATA HEADERS (The "Why")
    const model = res.headers.get('X-Router-Model');
    const rationale = res.headers.get('X-Rationale');
    const score = Number(res.headers.get('X-Complexity-Score') || 0);

    setState((prev: StreamState) => ({ ...prev, modelUsed: model, rationale, complexityScore: score }));

    // 4. STREAM PARSING (Anthropic Format)
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      const chunk = decoder.decode(value);
      const lines = chunk.split('\n');
      
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const dataStr = line.slice(6);
          if (dataStr === '[DONE]') break;
          
          try {
            const data = JSON.parse(dataStr);
            // Handle Content Blocks
            if (data.type === 'content_block_delta' && data.delta.text) {
              setState((prev: StreamState) => ({ ...prev, response: prev.response + data.delta.text }));
            }
          } catch (_) {
            // Ignore parse errors for partial chunks
          }
        }
      }
    }
    
    setState((prev: StreamState) => ({ ...prev, isLoading: false }));
  }, []);

  return { ...state, streamMessage };
}