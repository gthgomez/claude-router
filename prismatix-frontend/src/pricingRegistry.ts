import type { RouterModel } from './types';

export interface ModelPricing {
  inputRatePer1M: number;
  outputRatePer1M: number;
  reasoningRatePer1M?: number;
  isEstimated: boolean;
}

export const PRICING_VERSION = '2026-02-12-v1';

export const PRICING_REGISTRY: Record<RouterModel, ModelPricing> = {
  'haiku-4.5': {
    inputRatePer1M: 1.0,
    outputRatePer1M: 5.0,
    isEstimated: true,
  },
  'sonnet-4.5': {
    inputRatePer1M: 3.0,
    outputRatePer1M: 15.0,
    isEstimated: true,
  },
  'opus-4.5': {
    inputRatePer1M: 15.0,
    outputRatePer1M: 75.0,
    isEstimated: true,
  },
  'gpt-5-mini': {
    inputRatePer1M: 0.25,
    outputRatePer1M: 2.0,
    isEstimated: false,
  },
  'gemini-3-flash': {
    inputRatePer1M: 0.1,
    outputRatePer1M: 0.4,
    reasoningRatePer1M: 0.4,
    isEstimated: true,
  },
  'gemini-3-pro': {
    inputRatePer1M: 1.25,
    outputRatePer1M: 10.0,
    isEstimated: true,
  },
};
