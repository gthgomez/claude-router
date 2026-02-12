import { assertEquals } from 'https://deno.land/std@0.168.0/testing/asserts.ts';
import {
  calculateFinalCost,
  calculatePreFlightCost,
} from '../supabase/functions/router/cost_engine.ts';

Deno.test('calculatePreFlightCost returns positive token estimate and usd', () => {
  const result = calculatePreFlightCost(
    'gpt-5-mini',
    'Summarize this release and list potential risks.',
    0,
  );

  assertEquals(result.tokenEstimate > 0, true);
  assertEquals(result.estimatedUsd > 0, true);
  assertEquals(result.hasUnknownRate, false);
});

Deno.test('calculatePreFlightCost includes image token multiplier', () => {
  const noImage = calculatePreFlightCost('gemini-3-flash', 'Analyze', 0);
  const withImage = calculatePreFlightCost('gemini-3-flash', 'Analyze', 2);

  assertEquals(withImage.promptTokens > noImage.promptTokens, true);
});

Deno.test('calculateFinalCost uses prompt + completion + reasoning tokens', () => {
  const result = calculateFinalCost('gemini-3-flash', {
    promptTokens: 1200,
    completionTokens: 400,
    reasoningTokens: 300,
  });

  assertEquals(result.finalUsd > 0, true);
  assertEquals(result.hasUnknownRate, false);
});
