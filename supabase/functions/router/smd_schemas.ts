// smd_schemas.ts
// SMD v1.1 Light — Type definitions, Gemini responseSchema specs, and validation logic.
//
// Scope: General text, single-model (Gemini Flash), structured JSON for Skeptic + SynthDecision.
// This file has no side effects and no Deno/fetch dependencies.

// ============================================================================
// TYPESCRIPT TYPES
// ============================================================================

export interface SkepticIssue {
  id: string; // short identifier, e.g. "i1", "i2"
  title: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  category:
    | 'factuality'
    | 'logic'
    | 'completeness'
    | 'ambiguity'
    | 'risk'
    | 'tradeoff'
    | 'instruction_following'
    | 'other';
  why_it_matters: string;
  suggested_fix: string;
  confidence: 'low' | 'medium' | 'high';
}

export interface SkepticOutput {
  issues: SkepticIssue[];
}

export interface AcceptedChange {
  issue_id: string;
  summary: string;
}

export interface RejectedCriticism {
  issue_id: string;
  reason: string; // explicit reason, not just "not relevant"
}

export interface SynthDecision {
  accepted_changes: AcceptedChange[];
  rejected_criticisms: RejectedCriticism[];
  unresolved_risks: string[];
  rewrite_instructions: string[]; // concise directives for the Formatter
  should_rewrite: boolean;
  overall_confidence: 'low' | 'medium' | 'high';
}

// ============================================================================
// GEMINI responseSchema DEFINITIONS
// Gemini uses OpenAPI 3.0 format with uppercase type names.
// ============================================================================

export const SKEPTIC_GEMINI_SCHEMA: Record<string, unknown> = {
  type: 'OBJECT',
  properties: {
    issues: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          id: { type: 'STRING' },
          title: { type: 'STRING' },
          severity: {
            type: 'STRING',
            enum: ['low', 'medium', 'high', 'critical'],
          },
          category: {
            type: 'STRING',
            enum: [
              'factuality',
              'logic',
              'completeness',
              'ambiguity',
              'risk',
              'tradeoff',
              'instruction_following',
              'other',
            ],
          },
          why_it_matters: { type: 'STRING' },
          suggested_fix: { type: 'STRING' },
          confidence: { type: 'STRING', enum: ['low', 'medium', 'high'] },
        },
        required: ['id', 'title', 'severity', 'category', 'why_it_matters', 'suggested_fix', 'confidence'],
      },
    },
  },
  required: ['issues'],
};

export const SYNTH_DECISION_GEMINI_SCHEMA: Record<string, unknown> = {
  type: 'OBJECT',
  properties: {
    accepted_changes: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          issue_id: { type: 'STRING' },
          summary: { type: 'STRING' },
        },
        required: ['issue_id', 'summary'],
      },
    },
    rejected_criticisms: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          issue_id: { type: 'STRING' },
          reason: { type: 'STRING' },
        },
        required: ['issue_id', 'reason'],
      },
    },
    unresolved_risks: {
      type: 'ARRAY',
      items: { type: 'STRING' },
    },
    rewrite_instructions: {
      type: 'ARRAY',
      items: { type: 'STRING' },
    },
    should_rewrite: { type: 'BOOLEAN' },
    overall_confidence: { type: 'STRING', enum: ['low', 'medium', 'high'] },
  },
  required: [
    'accepted_changes',
    'rejected_criticisms',
    'unresolved_risks',
    'rewrite_instructions',
    'should_rewrite',
    'overall_confidence',
  ],
};

// ============================================================================
// VALIDATION UTILITIES
// ============================================================================

export type ValidationResult<T> =
  | { valid: true; data: T }
  | { valid: false; error: string };

const SEVERITY_SET = new Set(['low', 'medium', 'high', 'critical']);
const CATEGORY_SET = new Set([
  'factuality', 'logic', 'completeness', 'ambiguity',
  'risk', 'tradeoff', 'instruction_following', 'other',
]);
const CONFIDENCE_SET = new Set(['low', 'medium', 'high']);

export function validateSkepticOutput(raw: unknown): ValidationResult<SkepticOutput> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, error: 'root must be a non-array object' };
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.issues)) {
    return { valid: false, error: 'issues must be an array' };
  }
  for (let i = 0; i < (obj.issues as unknown[]).length; i++) {
    const issue = (obj.issues as unknown[])[i];
    if (!issue || typeof issue !== 'object' || Array.isArray(issue)) {
      return { valid: false, error: `issues[${i}] must be an object` };
    }
    const iss = issue as Record<string, unknown>;
    if (typeof iss.id !== 'string' || !iss.id.trim()) {
      return { valid: false, error: `issues[${i}].id must be a non-empty string` };
    }
    if (typeof iss.title !== 'string' || !iss.title.trim()) {
      return { valid: false, error: `issues[${i}].title must be a non-empty string` };
    }
    if (!SEVERITY_SET.has(iss.severity as string)) {
      return { valid: false, error: `issues[${i}].severity invalid: "${iss.severity}"` };
    }
    if (!CATEGORY_SET.has(iss.category as string)) {
      return { valid: false, error: `issues[${i}].category invalid: "${iss.category}"` };
    }
    if (typeof iss.why_it_matters !== 'string') {
      return { valid: false, error: `issues[${i}].why_it_matters must be string` };
    }
    if (typeof iss.suggested_fix !== 'string') {
      return { valid: false, error: `issues[${i}].suggested_fix must be string` };
    }
    if (!CONFIDENCE_SET.has(iss.confidence as string)) {
      return { valid: false, error: `issues[${i}].confidence invalid: "${iss.confidence}"` };
    }
  }
  return { valid: true, data: obj as unknown as SkepticOutput };
}

export function validateSynthDecision(raw: unknown): ValidationResult<SynthDecision> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, error: 'root must be a non-array object' };
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.accepted_changes)) {
    return { valid: false, error: 'accepted_changes must be an array' };
  }
  if (!Array.isArray(obj.rejected_criticisms)) {
    return { valid: false, error: 'rejected_criticisms must be an array' };
  }
  if (!Array.isArray(obj.unresolved_risks)) {
    return { valid: false, error: 'unresolved_risks must be an array' };
  }
  if (!Array.isArray(obj.rewrite_instructions)) {
    return { valid: false, error: 'rewrite_instructions must be an array' };
  }
  if (typeof obj.should_rewrite !== 'boolean') {
    return { valid: false, error: 'should_rewrite must be boolean' };
  }
  if (!CONFIDENCE_SET.has(obj.overall_confidence as string)) {
    return { valid: false, error: `overall_confidence invalid: "${obj.overall_confidence}"` };
  }
  for (let i = 0; i < (obj.accepted_changes as unknown[]).length; i++) {
    const ac = (obj.accepted_changes as unknown[])[i] as Record<string, unknown>;
    if (!ac || typeof ac.issue_id !== 'string' || typeof ac.summary !== 'string') {
      return { valid: false, error: `accepted_changes[${i}] must have string issue_id and summary` };
    }
  }
  for (let i = 0; i < (obj.rejected_criticisms as unknown[]).length; i++) {
    const rc = (obj.rejected_criticisms as unknown[])[i] as Record<string, unknown>;
    if (!rc || typeof rc.issue_id !== 'string' || typeof rc.reason !== 'string') {
      return { valid: false, error: `rejected_criticisms[${i}] must have string issue_id and reason` };
    }
  }
  return { valid: true, data: obj as unknown as SynthDecision };
}

/**
 * Validates the high/critical issue survival rule:
 * Every high/critical Skeptic issue must appear in exactly one of:
 *   accepted_changes, rejected_criticisms (with reason), or unresolved_risks.
 *
 * Returns issue IDs that violate the rule (should be empty for a good run).
 */
export function validateHighCriticalSurvival(
  skeptic: SkepticOutput,
  synth: SynthDecision,
): string[] {
  const highCritical = skeptic.issues.filter(
    (i) => i.severity === 'high' || i.severity === 'critical',
  );
  if (highCritical.length === 0) return [];

  const acceptedIds = new Set(synth.accepted_changes.map((ac) => ac.issue_id));
  const rejectedIds = new Set(synth.rejected_criticisms.map((rc) => rc.issue_id));
  // unresolved_risks is free-text; match by issue id or title (case-insensitive)
  const unresolvedText = synth.unresolved_risks.join('\n').toLowerCase();

  const missing: string[] = [];
  for (const issue of highCritical) {
    const inAccepted = acceptedIds.has(issue.id);
    const inRejected = rejectedIds.has(issue.id);
    const inUnresolved =
      unresolvedText.includes(issue.id.toLowerCase()) ||
      unresolvedText.includes(issue.title.toLowerCase().slice(0, 30));
    if (!inAccepted && !inRejected && !inUnresolved) {
      missing.push(issue.id);
    }
  }
  return missing;
}

/** Count issues with severity high or critical. */
export function countHighCriticalIssues(skeptic: SkepticOutput): number {
  return skeptic.issues.filter((i) => i.severity === 'high' || i.severity === 'critical').length;
}
