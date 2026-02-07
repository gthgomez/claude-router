# React Hook Context: useRouterStream for Claude AI Router

## Project Overview
Custom React hook for a **Claude AI model routing system** built on Supabase Edge Functions. Routes user queries to appropriate Claude models (Haiku/Sonnet/Opus) based on complexity analysis.

## Current Status
✅ Fixed TypeScript/Deno linting errors  
⚠️ **Blocked on npm resolution issue**: `"nodeModules": "manual"` incompatible with npm specifier entrypoints

### Error Received
```
Resolving npm specifier entrypoints this way is currently not supported with "nodeModules": "manual". 
In the meantime, try with --node-modules-dir=auto instead
```

## Fixed Code (Latest Version)
```typescript
import { useState, useCallback } from 'npm:react@18.2.0';
import { createClient } from 'npm:@supabase/supabase-js@2.39.0';

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

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error("No active session");

    const res = await fetch(`${Deno.env.get('NEXT_PUBLIC_SUPABASE_URL')}/functions/v1/router`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`
      },
      body: JSON.stringify({
        query,
        conversationId,
        platform: 'web',
        history
      })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Router failed');
    }

    const model = res.headers.get('X-Router-Model');
    const rationale = res.headers.get('X-Rationale');
    const score = Number(res.headers.get('X-Complexity-Score') || 0);

    setState((prev: StreamState) => ({ ...prev, modelUsed: model, rationale, complexityScore: score }));

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
```

## What Was Fixed
1. ✅ Added `npm:` prefix to React and Supabase imports
2. ✅ Replaced `process.env` with `Deno.env.get()`
3. ✅ Added explicit `StreamState` typing to all setState `prev` parameters
4. ✅ Created `Message` interface replacing `any[]` for history
5. ✅ Renamed unused catch variable from `e` to `_`

## Known Issues & Blockers

### 1. npm Resolution Configuration
**Problem**: Deno config has `"nodeModules": "manual"` which blocks npm specifier resolution  
**Solutions**:
- Add `--node-modules-dir=auto` flag when running
- Update `deno.json` to use `"nodeModules": "auto"`
- Use CDN imports instead: `https://esm.sh/react@18.2.0`

### 2. Environment Variable Pattern
Currently using `Deno.env.get()` with `!` assertion. May need validation/fallbacks.

### 3. Error Handling
No retry logic or exponential backoff for failed streams.

## Architecture Notes

### Data Flow
```
User Query → useRouterStream hook → Supabase Auth → 
Router Edge Function → Complexity Analysis → Model Selection → 
Anthropic API Stream → Real-time UI Updates
```

### Key Features
- **Streaming Responses**: Uses Anthropic's SSE format (`data: {...}`)
- **Metadata Exposure**: Returns model selection rationale via headers
- **RLS Security**: Requires Supabase session token for authorization
- **Conversation Context**: Maintains message history across turns

### Router Edge Function Contract
**Expected Headers Returned**:
- `X-Router-Model`: Which Claude model was selected (haiku/sonnet/opus)
- `X-Rationale`: Human-readable explanation for model choice
- `X-Complexity-Score`: Numeric score (0-100) from analysis

**Request Body**:
```typescript
{
  query: string;
  conversationId: string;
  platform: 'web' | 'mobile';
  history: Message[];
}
```

## Production Improvement Opportunities

### High Priority
1. **Error boundaries** for stream failures
2. **Retry logic** with exponential backoff
3. **Stream reconnection** on disconnect
4. **Abort controller** for cancellation
5. **Type safety** for SSE event parsing

### Medium Priority
6. **Token counting** & cost tracking
7. **Latency metrics** (TTFT, tokens/sec)
8. **Fallback models** on rate limits
9. **Message validation** before sending
10. **Environment variable** validation layer

### Low Priority
11. **Request deduplication**
12. **Optimistic UI updates**
13. **Stream compression** support
14. **Debug mode** with detailed logging

## Next Steps
1. **Resolve npm configuration issue** (deno.json adjustment or CDN imports)
2. **Add comprehensive error handling**
3. **Implement cancellation support**
4. **Add production monitoring hooks**
5. **Write unit tests for state management**

## Questions for Next Session
- Should we migrate to CDN imports (esm.sh) or fix Deno nodeModules config?
- Do we need conversation persistence (local storage/IndexedDB)?
- Should abort controllers expose through the hook interface?
- Any specific performance requirements (TTFT targets)?

---

**Developer**: Jonathan (Chicago-based software engineer, SNHU student)  
**Tech Stack**: Deno, TypeScript, React, Supabase, Anthropic Claude API  
**Project**: Claude Router - Multi-model AI routing SaaS
