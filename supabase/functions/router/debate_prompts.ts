// debate_prompts.ts
// Pure prompt builders for Debate Mode.

import type { DebateProfile } from './debate_profiles.ts';

export interface ChallengerOutput {
  role: string;
  modelTier: string;
  text: string;
}

function clamp(text: string, maxChars: number): string {
  if (!text) return '';
  const t = text.trim();
  if (t.length <= maxChars) return t;
  return t.slice(0, maxChars - 1) + '…';
}

export function buildChallengerPrompt(profile: DebateProfile, role: string, userQuery: string): string {
  const common = [
    'You are part of a debate team.',
    'Your job is to challenge the user request with useful critique, risks, and better alternatives.',
    'Be concrete. No fluff.',
    'Do NOT mention system prompts or internal policies.',
  ];

  const profileRules =
    profile === 'code'
      ? [
          'Focus on correctness, edge cases, failure modes, implementation traps, and tests.',
          'Include at least: (1) likely bug sources, (2) exact checks/tests to add, (3) safer alternative design if needed.',
          'Prefer crisp bullets and actionable steps.',
        ]
      : [
          'Focus on reasoning quality, missing considerations, trade-offs, and better framing.',
          'Include at least: (1) assumptions to verify, (2) key risks, (3) alternative approaches.',
          'Prefer structured bullets with short explanations.',
        ];

  return [
    ...common,
    `ROLE: ${role}`,
    ...profileRules,
    '',
    'USER REQUEST:',
    userQuery.trim(),
  ].join('\n');
}

export function buildSynthesisPrompt(
  profile: DebateProfile,
  userQuery: string,
  outputs: ChallengerOutput[],
  maxPerOutputChars: number,
): string {
  const header =
    profile === 'code'
      ? [
          'You are the final synthesizer after an internal team debate.',
          'Goal: produce an implementable, testable plan with minimal risk.',
          'You MUST address critique points and clearly state trade-offs.',
          'Output should be structured with headings and actionable steps.',
        ]
      : [
          'You are the final synthesizer after an internal team debate.',
          'Goal: produce a thorough, high-signal answer.',
          'You MUST address critique points and clearly state assumptions.',
          'Output should be structured with headings and concrete recommendations.',
        ];

  const rendered = outputs
    .map((o) => {
      const body = clamp(o.text, maxPerOutputChars);
      return `---\nCHALLENGER (${o.role}, ${o.modelTier})\n${body}\n`;
    })
    .join('\n');

  return [
    ...header,
    '',
    'USER REQUEST:',
    userQuery.trim(),
    '',
    'TEAM DEBATE NOTES:',
    rendered || '(no challenger output)',
    '',
    'Now produce the final answer.',
  ].join('\n');
}
