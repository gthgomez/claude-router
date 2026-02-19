// debate_profiles.ts
// Debate Mode is a router "tool": run 1-2 challenger critiques, then ask the primary model to synthesize.
// This file contains ONLY config + pure helpers (no fetch side effects).

import type { RouterModel } from './router_logic.ts';

export type DebateProfile = 'general' | 'code';
export type DebateTrigger = 'off' | 'explicit' | 'auto';

export interface DebatePlan {
  profile: DebateProfile;
  challengers: Array<{ role: string; modelTier: RouterModel }>;
  maxChallengerChars: number;
}

export const DEFAULT_DEBATE_THRESHOLD = 85;

function uniq<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

/**
 * Choose challengers based on profile + primary model.
 * Goal: keep it cheap + diverse, but never require frontend RouterModel changes.
 */
export function getDebatePlan(profile: DebateProfile, primary: RouterModel): DebatePlan {
  // Keep challengers capped to 2 for cost/perf. Diversity > quantity.
  // NOTE: All tiers must exist in MODEL_REGISTRY; do not invent keys here.
  const base =
    profile === 'code'
      ? [
          { role: 'critic', modelTier: 'gpt-5-mini' as RouterModel },
          { role: 'implementer', modelTier: 'haiku-4.5' as RouterModel },
        ]
      : [
          { role: 'skeptic', modelTier: 'gpt-5-mini' as RouterModel },
          { role: 'synthesist', modelTier: 'gemini-3-flash' as RouterModel },
        ];

  // Avoid duplicating the primary tier as a challenger.
  const challengers = uniq(base.filter((c) => c.modelTier !== primary)).slice(0, 2);

  return {
    profile,
    challengers,
    // Keep worker outputs bounded so synthesis prompt doesn't explode.
    maxChallengerChars: profile === 'code' ? 2400 : 2000,
  };
}
