import type { RouterModel } from './router_logic.ts';

export interface ModelPricing {
  inputRatePer1M: number;
  outputRatePer1M: number;
  reasoningRatePer1M?: number;
  asOfDate: string;
  sourceRef: string;
  isEstimated: boolean;
}

export const PRICING_VERSION = '2026-02-12-v1';

// Conservative, model-key-aligned pricing table for budget estimation and UX guidance.
export const PRICING_REGISTRY: Record<RouterModel, ModelPricing> = {
  'haiku-4.5': {
    inputRatePer1M: 1.0,
    outputRatePer1M: 5.0,
    asOfDate: '2026-02-12',
    sourceRef: 'anthropic-docs',
    isEstimated: true,
  },
  'sonnet-4.5': {
    inputRatePer1M: 3.0,
    outputRatePer1M: 15.0,
    asOfDate: '2026-02-12',
    sourceRef: 'anthropic-docs',
    isEstimated: true,
  },
  'opus-4.5': {
    inputRatePer1M: 15.0,
    outputRatePer1M: 75.0,
    asOfDate: '2026-02-12',
    sourceRef: 'anthropic-docs',
    isEstimated: true,
  },
  'gpt-5-mini': {
    inputRatePer1M: 0.25,
    outputRatePer1M: 2.0,
    asOfDate: '2026-02-12',
    sourceRef: 'openai-pricing',
    isEstimated: false,
  },
  'gemini-3-flash': {
    inputRatePer1M: 0.1,
    outputRatePer1M: 0.4,
    reasoningRatePer1M: 0.4,
    asOfDate: '2026-02-12',
    sourceRef: 'google-pricing',
    isEstimated: true,
  },
  'gemini-3-pro': {
    inputRatePer1M: 1.25,
    outputRatePer1M: 10.0,
    asOfDate: '2026-02-12',
    sourceRef: 'google-pricing',
    isEstimated: true,
  },
};

export function getModelPricing(modelTier: RouterModel): ModelPricing | undefined {
  return PRICING_REGISTRY[modelTier];
}
