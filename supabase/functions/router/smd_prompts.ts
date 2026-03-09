// smd_prompts.ts
// SMD v1.1 Light — Prompt builders for the four pipeline stages.
//
// Scope: General text tasks, single-model, no multimodal.
// Critical design rules enforced here:
//   - Authorship masking (Skeptic never knows it's reviewing the same model's output)
//   - No critique laundering (Formatter only receives filtered SynthDecision fields)
//   - Context compactness (each stage receives only what it needs)

import type { SkepticOutput, SynthDecision } from './smd_schemas.ts';

// ============================================================================
// STAGE 1: DRAFT
// ============================================================================

/**
 * Builds the Draft stage prompt.
 * Goal: produce a direct, useful candidate answer.
 * No mention of any review or debate process.
 */
export function buildSmdDraftPrompt(userQuery: string): string {
  return [
    'Answer the following request directly and usefully.',
    'Be accurate. Briefly state assumptions only if necessary.',
    'Do not hedge unnecessarily. Do not mention any review process.',
    '',
    'REQUEST:',
    userQuery.trim(),
  ].join('\n');
}

// ============================================================================
// STAGE 2: SKEPTIC
// ============================================================================

/**
 * Builds the Skeptic stage prompt.
 *
 * Critical authorship masking: the draft is always presented as "a candidate answer"
 * written by someone else. This is mandatory to reduce same-model self-validation bias.
 *
 * Diversity-forcing rules are embedded in the prompt to compensate for same-model
 * correlation collapse.
 */
export function buildSmdSkepticPrompt(userQuery: string, draftText: string): string {
  return [
    'You are an expert critical reviewer evaluating a candidate answer.',
    '',
    'IMPORTANT: You did NOT write this answer. Evaluate it as if reviewing someone else\'s work.',
    '',
    'REVIEW RULES:',
    '- Identify at least 2 substantive weaknesses. More if genuinely present.',
    '- Focus on: factual errors, logical gaps, missing tradeoffs, overconfident claims,',
    '  overlooked failure modes, incomplete coverage, ambiguous framing.',
    '- Prefer non-obvious issues over surface-level style nitpicks.',
    '- Look for what a careful, domain-expert reader would immediately spot.',
    '- If the answer looks strong, identify what could still fail in practice or',
    '  what is missing for edge cases.',
    '- Do NOT rewrite the answer or suggest how to improve phrasing.',
    '- Do NOT include praise or filler.',
    '- Do NOT repeat the question back.',
    '- Assign each issue a unique short id (e.g. "i1", "i2", ...).',
    '',
    'ORIGINAL REQUEST:',
    userQuery.trim(),
    '',
    'CANDIDATE ANSWER TO EVALUATE:',
    draftText.trim(),
    '',
    'Output strictly valid JSON matching the SkepticOutput schema. No other text.',
    'Every issue must have all required fields: id, title, severity, category,',
    'why_it_matters, suggested_fix, confidence.',
  ].join('\n');
}

// ============================================================================
// STAGE 3: SYNTH DECISION
// ============================================================================

/**
 * Builds the SynthDecision prompt.
 *
 * Receives compact Skeptic JSON (not the full verbose essay).
 * Must output ONLY machine-readable JSON — no prose answer.
 * The high/critical survival rule is explicitly stated here and enforced in validation.
 */
export function buildSmdSynthDecisionPrompt(
  userQuery: string,
  draftText: string,
  skepticOutput: SkepticOutput,
): string {
  // Compact serialization: truncate long fields to keep context tight.
  const compactIssues = skepticOutput.issues.map((i) => ({
    id: i.id,
    title: i.title,
    severity: i.severity,
    category: i.category,
    confidence: i.confidence,
    why_it_matters: i.why_it_matters.slice(0, 220),
    suggested_fix: i.suggested_fix.slice(0, 160),
  }));

  return [
    'You are an expert adjudicator reviewing critique of a candidate answer.',
    'Decide what must change and what can be safely dismissed.',
    '',
    'HARD RULES:',
    '- Every issue with severity "high" or "critical" MUST appear in exactly one of:',
    '  accepted_changes, rejected_criticisms (with explicit non-vague reason),',
    '  or unresolved_risks.',
    '- It cannot silently disappear.',
    '- rejected_criticisms.reason must be a specific argument, not just "not relevant".',
    '- rewrite_instructions must be concise directives (not prose paragraphs).',
    '- Do NOT generate any final answer or prose here. Output the SynthDecision JSON ONLY.',
    '- If no critique is worth addressing, set should_rewrite=false and leave accepted_changes empty.',
    '',
    'ORIGINAL REQUEST:',
    userQuery.trim(),
    '',
    'CANDIDATE ANSWER EXCERPT (for reference, first 600 chars):',
    draftText.slice(0, 600).trim(),
    '',
    'CRITIQUE JSON:',
    JSON.stringify({ issues: compactIssues }),
    '',
    'Output strictly valid JSON matching the SynthDecision schema. No other text.',
  ].join('\n');
}

// ============================================================================
// STAGE 4: FORMATTER
// ============================================================================

/**
 * Builds the Formatter prompt.
 *
 * Critical context sanitation:
 *   - Only accepted_changes, unresolved_risks, and rewrite_instructions reach the Formatter.
 *   - rejected_criticisms are EXCLUDED to prevent context bleed
 *     (LLMs synthesize across all context; rejected issues must not appear in output).
 *   - The draft is included so the Formatter can improve from a concrete base.
 */
export function buildSmdFormatterPrompt(
  userQuery: string,
  draftText: string,
  synthDecision: SynthDecision,
): string {
  const lines: string[] = [
    'Produce the final answer to the request below.',
    'You are improving a candidate answer based on a set of rewrite instructions.',
    '',
    'RULES:',
    '- Apply all rewrite instructions faithfully.',
    '- If any unresolved risks are listed and are relevant to the answer, surface them clearly.',
    '- Do NOT mention the review process, critique, or any internal pipeline.',
    '- Do NOT add unnecessary hedging or caveats beyond what the content genuinely requires.',
    '- Do NOT pad the answer with extra length for completeness theater.',
    '- Do NOT introduce new information that was not present in the original request or draft.',
    '- Output the final answer only. No preamble.',
    '',
    'ORIGINAL REQUEST:',
    userQuery.trim(),
    '',
    'CANDIDATE ANSWER (improve this):',
    draftText.trim(),
  ];

  if (synthDecision.rewrite_instructions.length > 0) {
    lines.push('', 'REWRITE INSTRUCTIONS (apply all):');
    synthDecision.rewrite_instructions.forEach((inst, i) => {
      lines.push(`${i + 1}. ${inst.trim()}`);
    });
  } else {
    // No instructions: formatter should confirm the draft is acceptable and return it cleanly.
    lines.push('', 'No rewrite instructions. The candidate answer was deemed acceptable.');
    lines.push('Return it cleanly without additions or alterations.');
  }

  if (synthDecision.unresolved_risks.length > 0) {
    lines.push('', 'UNRESOLVED RISKS (surface in your answer if directly relevant):');
    synthDecision.unresolved_risks.forEach((risk) => {
      lines.push(`- ${risk.trim()}`);
    });
  }

  lines.push('', 'Now produce the final answer.');
  return lines.join('\n');
}
