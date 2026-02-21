import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config', () => ({
  CONFIG: {
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_ANON_KEY: 'anon-key',
    ROUTER_ENDPOINT: 'https://project.supabase.co/functions/v1/router',
  },
}));

const { getSessionMock, signOutMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  signOutMock: vi.fn(),
}));

vi.mock('./lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: getSessionMock,
      signOut: signOutMock,
    },
  },
}));

import { askPrismatix, resetConversation } from './smartFetch';

function createJwt(iss: string): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  const payload = btoa(JSON.stringify({ iss }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  return `${header}.${payload}.sig`;
}

function makeStream(content: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(content));
      controller.close();
    },
  });
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }
  return result;
}

describe('smartFetch debate support', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    resetConversation();

    getSessionMock.mockResolvedValue({
      data: {
        session: {
          access_token: createJwt('https://project.supabase.co/auth/v1'),
        },
      },
      error: null,
    });

    signOutMock.mockResolvedValue(undefined);
  });

  it('sends mode=debate and debateProfile when enabled and parses X-Debate-* headers', async () => {
    const sse = 'data: {"type":"content_block_delta","delta":{"text":"hello"}}\n\n';
    const response = new Response(makeStream(sse), {
      status: 200,
      headers: {
        'X-Router-Model': 'gemini-3-flash',
        'X-Complexity-Score': '55',
        'X-Debate-Mode': 'true',
        'X-Debate-Profile': 'code',
        'X-Debate-Trigger': 'auto',
        'X-Debate-Model': 'gemini-3.1-pro',
        'X-Debate-Cost-Note': 'dual model',
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetchMock);

    const result = await askPrismatix(
      'Implement this',
      [],
      [],
      null,
      'high',
      { mode: 'debate', debateProfile: 'code' },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCall = fetchMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    const init = firstCall![1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.mode).toBe('debate');
    expect(body.debateProfile).toBe('code');

    expect(result?.debateActive).toBe(true);
    expect(result?.debateProfile).toBe('code');
    expect(result?.debateTrigger).toBe('auto');
    expect(result?.debateModel).toBe('gemini-3.1-pro');
    expect(result?.debateCostNote).toBe('dual model');
    expect(result?.stream).toBeDefined();
    expect(await readStream(result!.stream)).toBe(sse);
  });

  it('omits debate request fields and metadata when debate is not enabled', async () => {
    const response = new Response(makeStream('data: {"type":"meta"}\n\n'), {
      status: 200,
      headers: {
        'X-Router-Model': 'gemini-3-flash',
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetchMock);

    const result = await askPrismatix('Hello world');

    const firstCall = fetchMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    const init = firstCall![1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.mode).toBeUndefined();
    expect(body.debateProfile).toBeUndefined();
    expect(result?.debateActive).toBeUndefined();
    expect(result?.debateProfile).toBeUndefined();
    expect(result?.debateTrigger).toBeUndefined();
    expect(result?.debateModel).toBeUndefined();
    expect(result?.debateCostNote).toBeUndefined();
  });
});
