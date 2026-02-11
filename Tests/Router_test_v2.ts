import { assertEquals } from 'https://deno.land/std@0.168.0/testing/asserts.ts';
import {
  countTokens,
  determineRoute,
  type ImageAttachment,
  normalizeModelOverride,
  type RouterParams,
} from '../supabase/functions/router/router_logic.ts';

function params(
  userQuery: string,
  currentSessionTokens = 0,
  platform: 'web' | 'mobile' = 'web',
  images?: ImageAttachment[],
): RouterParams {
  return {
    userQuery,
    currentSessionTokens,
    platform,
    history: [],
    ...(images ? { images } : {}),
  };
}

Deno.test('determineRoute: manual override wins', () => {
  const decision = determineRoute(params('Hello'), 'opus-4.5');
  assertEquals(decision.modelTier, 'opus-4.5');
  assertEquals(decision.rationaleTag, 'manual-override');
  assertEquals(decision.budgetCap, 16000);
  assertEquals(decision.provider, 'anthropic');
});

Deno.test('determineRoute: images default to Gemini Flash when fast path applies', () => {
  const images: ImageAttachment[] = [{ data: 'base64', mediaType: 'image/png' }];
  const decision = determineRoute(params('What is this?', 0, 'web', images));
  assertEquals(decision.modelTier, 'gemini-3-flash');
  assertEquals(decision.rationaleTag, 'images-fast');
  assertEquals(decision.provider, 'google');
});

Deno.test('determineRoute: images route to Gemini Pro when context is large', () => {
  const images: ImageAttachment[] = [{ data: 'base64', mediaType: 'image/png' }];
  const decision = determineRoute(params('Please analyze this image.', 60000, 'web', images));
  assertEquals(decision.modelTier, 'gemini-3-pro');
  assertEquals(decision.rationaleTag, 'images-complex');
  assertEquals(decision.provider, 'google');
});

Deno.test('determineRoute: high total tokens trigger Opus', () => {
  const decision = determineRoute(params('Continue.', 120000, 'web'));
  assertEquals(decision.modelTier, 'opus-4.5');
  assertEquals(decision.rationaleTag, 'high-complexity');
});

Deno.test('determineRoute: low complexity can trigger Haiku', () => {
  const decision = determineRoute(params('Quick define.', 0, 'web'));
  assertEquals(decision.modelTier, 'haiku-4.5');
  assertEquals(decision.rationaleTag, 'low-complexity');
});

Deno.test('determineRoute: default web query routes to Gemini Flash', () => {
  const decision = determineRoute(params('Give me a summary of this release.'));
  assertEquals(decision.modelTier, 'gemini-3-flash');
  assertEquals(decision.rationaleTag, 'default-cost-optimized');
});

Deno.test('determineRoute: code-heavy complex query routes to Sonnet', () => {
  const decision = determineRoute(
    params(
      'Please debug this TypeScript code and explain why it crashes: ```ts function test(){return;} ```',
    ),
  );
  assertEquals(decision.modelTier, 'sonnet-4.5');
  assertEquals(decision.rationaleTag, 'code-quality-priority');
});

Deno.test('countTokens: non-empty returns positive', () => {
  assertEquals(countTokens('hello world') > 0, true);
});

Deno.test('normalizeModelOverride: supports provider-qualified OpenAI override', () => {
  assertEquals(normalizeModelOverride('openai:gpt-5-mini'), 'gpt-5-mini');
});

Deno.test('normalizeModelOverride: supports Gemini 3 Flash natural language override', () => {
  assertEquals(normalizeModelOverride('Use Gemini 3 Flash'), 'gemini-3-flash');
});

Deno.test('determineRoute: manual override can force GPT mini', () => {
  const decision = determineRoute(params('Simple status check'), 'gpt-5-mini');
  assertEquals(decision.modelTier, 'gpt-5-mini');
  assertEquals(decision.provider, 'openai');
  assertEquals(decision.rationaleTag, 'manual-override');
});
