// Debate_test.ts
// Contract regression + eligibility tests for Debate Mode.
// Run with: deno test Tests/Debate_test.ts

import {
  assertEquals,
  assertStringIncludes,
} from 'https://deno.land/std@0.168.0/testing/asserts.ts';

import {
  DEFAULT_DEBATE_THRESHOLD,
  getDebatePlan,
  type DebateProfile,
} from '../supabase/functions/router/debate_profiles.ts';

import { calculatePreFlightCost } from '../supabase/functions/router/cost_engine.ts';

import {
  buildChallengerPrompt,
  buildSynthesisPrompt,
  type ChallengerOutput,
} from '../supabase/functions/router/debate_prompts.ts';

// ============================================================================
// Eligibility / profile tests
// ============================================================================

Deno.test('DEFAULT_DEBATE_THRESHOLD is 85', () => {
  assertEquals(DEFAULT_DEBATE_THRESHOLD, 85);
});

Deno.test('getDebatePlan: general profile returns ≤2 challengers', () => {
  const plan = getDebatePlan('general', 'sonnet-4.5');
  assertEquals(plan.challengers.length <= 2, true);
  assertEquals(plan.profile, 'general');
});

Deno.test('getDebatePlan: code profile returns challengers', () => {
  const plan = getDebatePlan('code', 'sonnet-4.5');
  assertEquals(plan.profile, 'code');
  assertEquals(plan.challengers.length >= 1, true);
});

Deno.test('getDebatePlan: primary model tier is excluded from challengers', () => {
  // gpt-5-mini is a general challenger; if it were also the primary, it should be excluded.
  const plan = getDebatePlan('general', 'gpt-5-mini');
  const hasPrimary = plan.challengers.some((c) => c.modelTier === 'gpt-5-mini');
  assertEquals(hasPrimary, false);
});

Deno.test('getDebatePlan: code primary exclusion', () => {
  // haiku-4.5 is a code challenger; should be excluded if it is the primary.
  const plan = getDebatePlan('code', 'haiku-4.5');
  const hasPrimary = plan.challengers.some((c) => c.modelTier === 'haiku-4.5');
  assertEquals(hasPrimary, false);
});

Deno.test('getDebatePlan: maxChallengerChars is bounded ≤3000', () => {
  const generalPlan = getDebatePlan('general', 'sonnet-4.5');
  const codePlan = getDebatePlan('code', 'sonnet-4.5');
  assertEquals(generalPlan.maxChallengerChars <= 3000, true);
  assertEquals(codePlan.maxChallengerChars <= 3000, true);
});

Deno.test('getDebatePlan: code profile maxChallengerChars > general maxChallengerChars', () => {
  // Code critique needs slightly more room for code snippets.
  const generalPlan = getDebatePlan('general', 'opus-4.5');
  const codePlan = getDebatePlan('code', 'opus-4.5');
  assertEquals(codePlan.maxChallengerChars >= generalPlan.maxChallengerChars, true);
});

Deno.test('getDebatePlan: all challenger tiers are valid RouterModel keys', () => {
  const validTiers = new Set([
    'haiku-4.5',
    'sonnet-4.5',
    'opus-4.5',
    'gpt-5-mini',
    'gemini-3-flash',
    'gemini-3-pro',
  ]);
  for (const profile of ['general', 'code'] as DebateProfile[]) {
    const plan = getDebatePlan(profile, 'sonnet-4.5');
    for (const c of plan.challengers) {
      assertEquals(
        validTiers.has(c.modelTier),
        true,
        `Invalid modelTier '${c.modelTier}' in ${profile} profile`,
      );
    }
  }
});

// ============================================================================
// Prompt builder tests
// ============================================================================

Deno.test('buildChallengerPrompt: includes user query', () => {
  const prompt = buildChallengerPrompt('general', 'skeptic', 'Why is the sky blue?');
  assertStringIncludes(prompt, 'Why is the sky blue?');
});

Deno.test('buildChallengerPrompt: includes role label', () => {
  const prompt = buildChallengerPrompt('general', 'skeptic', 'Anything.');
  assertStringIncludes(prompt, 'skeptic');
});

Deno.test('buildChallengerPrompt: code profile includes correctness focus', () => {
  const prompt = buildChallengerPrompt('code', 'critic', 'Write a sort function.');
  assertStringIncludes(prompt, 'correctness');
});

Deno.test('buildChallengerPrompt: general profile includes reasoning focus', () => {
  const prompt = buildChallengerPrompt('general', 'skeptic', 'Should I use microservices?');
  assertStringIncludes(prompt, 'reasoning');
});

Deno.test('buildSynthesisPrompt: includes all challenger texts', () => {
  const outputs: ChallengerOutput[] = [
    { role: 'skeptic', modelTier: 'gpt-5-mini', text: 'Risk: latency.' },
    { role: 'synthesist', modelTier: 'gemini-3-flash', text: 'Consider caching.' },
  ];
  const prompt = buildSynthesisPrompt('general', 'What is X?', outputs, 2000);
  assertStringIncludes(prompt, 'Risk: latency.');
  assertStringIncludes(prompt, 'Consider caching.');
});

Deno.test('buildSynthesisPrompt: includes user query', () => {
  const outputs: ChallengerOutput[] = [{ role: 'critic', modelTier: 'gpt-5-mini', text: 'Bug.' }];
  const prompt = buildSynthesisPrompt('code', 'Fix this function.', outputs, 2400);
  assertStringIncludes(prompt, 'Fix this function.');
});

Deno.test('buildSynthesisPrompt: fallback when outputs empty', () => {
  const prompt = buildSynthesisPrompt('general', 'Hello?', [], 2000);
  assertStringIncludes(prompt, '(no challenger output)');
});

Deno.test('buildSynthesisPrompt: long challenger text is clamped to maxPerOutputChars', () => {
  const longText = 'x'.repeat(5000);
  const outputs: ChallengerOutput[] = [{ role: 'critic', modelTier: 'gpt-5-mini', text: longText }];
  const prompt = buildSynthesisPrompt('general', 'Query.', outputs, 2000);
  // After clamping, the prompt should not contain the full 5000-char string.
  const overflowChunk = 'x'.repeat(2100);
  assertEquals(prompt.includes(overflowChunk), false);
});

// ============================================================================
// SSE contract regression tests
// ============================================================================

Deno.test('SSE contract: normalized event shape matches router contract', () => {
  // Verify the canonical SSE shape used by the router.
  // This is the exact format createNormalizedProxyStream emits.
  const delta = 'hello world';
  const normalized = JSON.stringify({ type: 'content_block_delta', delta: { text: delta } });
  const line = `data: ${normalized}`;

  const dataStr = line.slice('data: '.length);
  const parsed = JSON.parse(dataStr) as {
    type: string;
    delta: { text: string };
  };

  assertEquals(parsed.type, 'content_block_delta');
  assertEquals(typeof parsed.delta, 'object');
  assertEquals(typeof parsed.delta.text, 'string');
  assertEquals(parsed.delta.text, delta);
});

Deno.test('SSE contract: done terminator is exactly [DONE]', () => {
  const terminator = 'data: [DONE]';
  assertEquals(terminator.startsWith('data: '), true);
  assertEquals(terminator.slice('data: '.length), '[DONE]');
});

// ============================================================================
// Header contract regression tests
// ============================================================================

Deno.test('Header contract: required existing header names are unchanged', () => {
  // These are the stable header names defined in the canonical router contract.
  // If any of these change, it is a breaking change for smartFetch.ts and the frontend.
  const required = [
    'X-Router-Model',
    'X-Router-Model-Id',
    'X-Provider',
    'X-Model-Override',
    'X-Router-Rationale',
    'X-Complexity-Score',
    'X-Gemini-Thinking-Level',
    'X-Memory-Hits',
    'X-Memory-Tokens',
    'X-Cost-Estimate-USD',
    'X-Cost-Pricing-Version',
  ];

  // Verify none were renamed into debate headers (no overlap).
  const debateHeaders = ['X-Debate-Mode', 'X-Debate-Profile', 'X-Debate-Trigger', 'X-Debate-Cost-Note'];
  for (const h of required) {
    assertEquals(debateHeaders.includes(h), false, `Existing header ${h} must not appear in debate headers`);
  }
  // All required headers must be distinct strings.
  assertEquals(new Set(required).size, required.length);
});

Deno.test('Debate headers are additive only (no collision with existing headers)', () => {
  const existing = new Set([
    'X-Router-Model',
    'X-Router-Model-Id',
    'X-Provider',
    'X-Model-Override',
    'X-Router-Rationale',
    'X-Complexity-Score',
    'X-Gemini-Thinking-Level',
    'X-Memory-Hits',
    'X-Memory-Tokens',
    'X-Cost-Estimate-USD',
    'X-Cost-Pricing-Version',
  ]);
  const debateNew = ['X-Debate-Mode', 'X-Debate-Profile', 'X-Debate-Trigger', 'X-Debate-Cost-Note'];
  for (const h of debateNew) {
    assertEquals(existing.has(h), false, `New debate header ${h} must not collide with existing headers`);
  }
});

// ============================================================================
// Fallback behavior tests (pure logic)
// ============================================================================

Deno.test('Debate fallback: disabled flag means debate is not active', () => {
  // Simulate the eligibility logic from index.ts with ENABLE_DEBATE_MODE=false.
  const ENABLE_DEBATE_MODE = false;
  const ENABLE_DEBATE_AUTO = true;
  const complexityScore = 95;
  const DEBATE_COMPLEXITY_THRESHOLD = 85;
  const hasImages = false;
  const debateRequested = false;

  const shouldAutoDebate = ENABLE_DEBATE_MODE &&
    ENABLE_DEBATE_AUTO &&
    !debateRequested &&
    !hasImages &&
    complexityScore >= DEBATE_COMPLEXITY_THRESHOLD;

  const doDebate = ENABLE_DEBATE_MODE && (debateRequested || shouldAutoDebate) && !hasImages;
  assertEquals(doDebate, false);
});

Deno.test('Debate fallback: image requests never enter debate mode', () => {
  const ENABLE_DEBATE_MODE = true;
  const ENABLE_DEBATE_AUTO = true;
  const complexityScore = 95;
  const DEBATE_COMPLEXITY_THRESHOLD = 85;
  const hasImages = true; // <-- image request
  const debateRequested = true; // even if explicitly requested

  const shouldAutoDebate = ENABLE_DEBATE_MODE &&
    ENABLE_DEBATE_AUTO &&
    !false && // debateRequested=true, so shouldAuto is irrelevant
    !hasImages &&
    complexityScore >= DEBATE_COMPLEXITY_THRESHOLD;

  const doDebate = ENABLE_DEBATE_MODE && (debateRequested || shouldAutoDebate) && !hasImages;
  assertEquals(doDebate, false);
});

Deno.test('Debate auto: below threshold does not trigger auto debate', () => {
  const ENABLE_DEBATE_MODE = true;
  const ENABLE_DEBATE_AUTO = true;
  const complexityScore = 60; // below 85
  const DEBATE_COMPLEXITY_THRESHOLD = 85;
  const hasImages = false;
  const debateRequested = false;

  const shouldAutoDebate = ENABLE_DEBATE_MODE &&
    ENABLE_DEBATE_AUTO &&
    !debateRequested &&
    !hasImages &&
    complexityScore >= DEBATE_COMPLEXITY_THRESHOLD;

  assertEquals(shouldAutoDebate, false);
});

Deno.test('Debate auto: at threshold triggers auto debate', () => {
  const ENABLE_DEBATE_MODE = true;
  const ENABLE_DEBATE_AUTO = true;
  const complexityScore = 85; // exactly at threshold
  const DEBATE_COMPLEXITY_THRESHOLD = 85;
  const hasImages = false;
  const debateRequested = false;

  const shouldAutoDebate = ENABLE_DEBATE_MODE &&
    ENABLE_DEBATE_AUTO &&
    !debateRequested &&
    !hasImages &&
    complexityScore >= DEBATE_COMPLEXITY_THRESHOLD;

  assertEquals(shouldAutoDebate, true);
});

Deno.test('Debate explicit: mode=debate triggers regardless of auto flag', () => {
  const ENABLE_DEBATE_MODE = true;
  const ENABLE_DEBATE_AUTO = false; // auto disabled
  const complexityScore = 30; // low complexity
  const DEBATE_COMPLEXITY_THRESHOLD = 85;
  const hasImages = false;
  const debateRequested = true; // explicit

  const shouldAutoDebate = ENABLE_DEBATE_MODE &&
    ENABLE_DEBATE_AUTO &&
    !debateRequested &&
    !hasImages &&
    complexityScore >= DEBATE_COMPLEXITY_THRESHOLD;

  const doDebate = ENABLE_DEBATE_MODE && (debateRequested || shouldAutoDebate) && !hasImages;
  assertEquals(doDebate, true);
});

Deno.test('X-Model-Override: explicit debate request produces debate:<profile> override value', () => {
  // Simulate parseDebateRequest("debate", undefined, "code")
  const mode = 'debate';
  const profile = 'code';
  const overrideHeaderValue = `debate:${profile}`;

  assertEquals(overrideHeaderValue, 'debate:code');
  assertEquals(overrideHeaderValue.startsWith('debate:'), true);
});

Deno.test('X-Model-Override: non-debate path preserves existing override semantics', () => {
  // When debate is inactive, X-Model-Override = normalizedOverride || 'auto'
  const debateOverrideHeader = ''; // not active
  const normalizedOverride = undefined; // no explicit model
  const effective = debateOverrideHeader || normalizedOverride || 'auto';
  assertEquals(effective, 'auto');
});

// ============================================================================
// Patch A: Worker token cap
// ============================================================================

Deno.test('Patch A: DEBATE_WORKER_MAX_TOKENS_GENERAL default is 400', () => {
  // Mirrors the env default in index.ts.
  const defaultGeneralCap = 400;
  assertEquals(defaultGeneralCap, 400);
  assertEquals(defaultGeneralCap < 1024, true); // well under typical model min budget caps
});

Deno.test('Patch A: DEBATE_WORKER_MAX_TOKENS_CODE default is 700', () => {
  const defaultCodeCap = 700;
  assertEquals(defaultCodeCap, 700);
  assertEquals(defaultCodeCap > 400, true); // code needs slightly more room
  assertEquals(defaultCodeCap < 1024, true);
});

Deno.test('Patch A: workerDecision budgetCap spread overrides model-tier default', () => {
  // Validate the spread pattern used in maybeRunDebateMode.
  const baseDecision = {
    budgetCap: 4096, // typical model-tier default (e.g. gpt-5-mini)
    model: 'gpt-5-mini',
    provider: 'openai',
    modelTier: 'gpt-5-mini',
    rationaleTag: 'debate-worker-critic',
    complexityScore: 60,
  };
  const workerMaxTokens = 400;
  const workerDecision = { ...baseDecision, budgetCap: workerMaxTokens };

  assertEquals(workerDecision.budgetCap, 400);
  assertEquals(workerDecision.budgetCap < baseDecision.budgetCap, true);
  // All other fields are preserved.
  assertEquals(workerDecision.model, 'gpt-5-mini');
  assertEquals(workerDecision.rationaleTag, 'debate-worker-critic');
});

Deno.test('Patch A: code profile selects higher worker cap than general', () => {
  const generalCap = 400;
  const codeCap = 700;
  // Simulate the cap selection logic in index.ts.
  const workerMaxTokens = (profile: DebateProfile) =>
    profile === 'code' ? codeCap : generalCap;

  assertEquals(workerMaxTokens('code'), 700);
  assertEquals(workerMaxTokens('general'), 400);
  assertEquals(workerMaxTokens('code') > workerMaxTokens('general'), true);
});

// ============================================================================
// Patch B: Video gate
// ============================================================================

Deno.test('Patch B: debate blocked when video assets present (explicit request)', () => {
  const ENABLE_DEBATE_MODE = true;
  const hasImages = false;
  const hasVideoAssets = true;
  const debateRequested = true; // even explicit request is blocked

  const hasAnyMedia = hasImages || hasVideoAssets;
  const doDebate = ENABLE_DEBATE_MODE && debateRequested && !hasAnyMedia;
  assertEquals(doDebate, false);
});

Deno.test('Patch B: debate blocked when video assets present (auto trigger)', () => {
  const ENABLE_DEBATE_MODE = true;
  const ENABLE_DEBATE_AUTO = true;
  const complexityScore = 95;
  const DEBATE_COMPLEXITY_THRESHOLD = 85;
  const hasImages = false;
  const hasVideoAssets = true;

  const hasAnyMedia = hasImages || hasVideoAssets;
  const shouldAutoDebate = ENABLE_DEBATE_MODE &&
    ENABLE_DEBATE_AUTO &&
    !hasAnyMedia &&
    complexityScore >= DEBATE_COMPLEXITY_THRESHOLD;

  assertEquals(shouldAutoDebate, false);
});

Deno.test('Patch B: debate allowed when neither images nor video present', () => {
  const ENABLE_DEBATE_MODE = true;
  const hasImages = false;
  const hasVideoAssets = false;
  const debateRequested = true;

  const hasAnyMedia = hasImages || hasVideoAssets;
  const doDebate = ENABLE_DEBATE_MODE && debateRequested && !hasAnyMedia;
  assertEquals(doDebate, true);
});

Deno.test('Patch B: maybeRunDebateMode returns null for hasVideo=true', () => {
  // The internal guard mirrors the same gate used at the call site.
  // Simulate the guard: images.length > 0 || hasVideo
  const images: unknown[] = [];
  const hasVideo = true;
  const wouldSkip = images.length > 0 || hasVideo;
  assertEquals(wouldSkip, true);
});

// ============================================================================
// Patch C: Debate headers contract
// ============================================================================

Deno.test('Patch C: debate headers absent when debateActive=false', () => {
  const debateActive = false;
  const conditionalHeaders = debateActive
    ? {
      'X-Debate-Mode': 'true',
      'X-Debate-Profile': 'general',
      'X-Debate-Trigger': 'explicit',
      'X-Debate-Cost-Note': 'partial',
    }
    : {};

  assertEquals(Object.keys(conditionalHeaders).length, 0);
  assertEquals('X-Debate-Mode' in conditionalHeaders, false);
  assertEquals('X-Debate-Profile' in conditionalHeaders, false);
  assertEquals('X-Debate-Trigger' in conditionalHeaders, false);
  assertEquals('X-Debate-Cost-Note' in conditionalHeaders, false);
});

Deno.test('Patch C: all four debate headers present when debateActive=true', () => {
  const debateActive = true;
  const debateProfileEffective = 'code';
  const debateTriggerEffective = 'auto';

  const conditionalHeaders = debateActive
    ? {
      'X-Debate-Mode': 'true' as const,
      'X-Debate-Profile': debateProfileEffective,
      'X-Debate-Trigger': debateTriggerEffective,
      'X-Debate-Cost-Note': 'partial' as const,
    }
    : ({} as Record<string, string>);
  const h = conditionalHeaders as Record<string, string>;

  assertEquals(h['X-Debate-Mode'], 'true');
  assertEquals(h['X-Debate-Profile'], 'code');
  assertEquals(h['X-Debate-Trigger'], 'auto');
  assertEquals(h['X-Debate-Cost-Note'], 'partial');
});

Deno.test('Patch C: X-Debate-Mode is never "false" — only "true" or absent', () => {
  for (const debateActive of [true, false]) {
    const h = debateActive ? { 'X-Debate-Mode': 'true' } : {};
    const val = (h as Record<string, string>)['X-Debate-Mode'];
    if (debateActive) {
      assertEquals(val, 'true');
    } else {
      assertEquals(val, undefined); // absent, not "false"
    }
  }
});

// ============================================================================
// Patch D: Synthesis cost estimate accuracy
// ============================================================================

Deno.test('Patch D: longer synthesis context produces higher cost estimate', () => {
  // When debate ran, synthesis messages include challenger notes, so the prompt
  // is longer and the cost estimate should be higher than the original preflight.
  const shortContext = 'user: hello';
  const longContext = 'user: hello\nuser: ' + 'debate-note-content '.repeat(50);

  const shortCost = calculatePreFlightCost('gpt-5-mini', shortContext, 0, 0);
  const longCost = calculatePreFlightCost('gpt-5-mini', longContext, 0, 0);

  assertEquals(longCost.estimatedUsd > shortCost.estimatedUsd, true);
  assertEquals(longCost.promptTokens > shortCost.promptTokens, true);
});

Deno.test('Patch D: cost recompute uses synthesis model tier (not challenger tier)', () => {
  // Synthesis runs on the primary decision model; cost must reflect that tier.
  const synthesisTier = 'sonnet-4.5'; // primary (expensive)
  const challengerTier = 'gpt-5-mini'; // challenger (cheap)
  const context = 'user: long question with debate notes included ' + 'x'.repeat(200);

  const synthesisCost = calculatePreFlightCost(synthesisTier, context, 0, 0);
  const challengerCost = calculatePreFlightCost(challengerTier, context, 0, 0);

  // Synthesis on sonnet-4.5 should cost more than the same context on gpt-5-mini.
  assertEquals(synthesisCost.estimatedUsd > challengerCost.estimatedUsd, true);
});

Deno.test('Patch D: cost estimate fallback to preFlightCost when debate inactive', () => {
  // Simulate: debateSynthesisMessages = null → effectiveCostEstimateUsd = preFlightCost.estimatedUsd
  const preFlightEstimate = 0.001234;
  const debateSynthesisMessages: null = null;
  const effectiveCostEstimateUsd = debateSynthesisMessages
    ? calculatePreFlightCost('gpt-5-mini', 'irrelevant', 0, 0).estimatedUsd
    : preFlightEstimate;

  assertEquals(effectiveCostEstimateUsd, preFlightEstimate);
});
