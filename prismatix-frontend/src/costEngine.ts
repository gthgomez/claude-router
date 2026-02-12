import type { RouterModel } from './types';
import { PRICING_REGISTRY, PRICING_VERSION } from './pricingRegistry';

const TOKENS_PER_MILLION = 1_000_000;

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function estimateTokenCount(text: string): number {
  if (!text) return 0;
  const words = text.trim().split(/\s+/).length;
  const chars = text.length;
  return Math.ceil((words + chars / 4) / 2);
}

export interface PreFlightCostResult {
  promptTokens: number;
  projectedOutputTokens: number;
  estimatedUsd: number;
  pricingVersion: string;
}

export interface FinalCostResult {
  finalUsd: number;
  pricingVersion: string;
}

export function calculatePreFlightCost(
  model: RouterModel,
  contextText: string,
  imageCount = 0,
): PreFlightCostResult {
  const pricing = PRICING_REGISTRY[model];
  const promptTokens = estimateTokenCount(contextText) + Math.max(0, imageCount) * 1600;
  const projectedOutputTokens = Math.max(64, Math.ceil(promptTokens * 0.35));

  const inputCost = (promptTokens / TOKENS_PER_MILLION) * pricing.inputRatePer1M;
  const outputCost = (projectedOutputTokens / TOKENS_PER_MILLION) * pricing.outputRatePer1M;

  return {
    promptTokens,
    projectedOutputTokens,
    estimatedUsd: roundUsd(inputCost + outputCost),
    pricingVersion: PRICING_VERSION,
  };
}

export function calculateFinalCost(
  model: RouterModel,
  usage: { promptTokens: number; completionTokens: number; reasoningTokens?: number },
): FinalCostResult {
  const pricing = PRICING_REGISTRY[model];
  const reasoningRate = pricing.reasoningRatePer1M ?? pricing.outputRatePer1M;

  const inputCost = (Math.max(0, usage.promptTokens) / TOKENS_PER_MILLION) * pricing.inputRatePer1M;
  const outputCost = (Math.max(0, usage.completionTokens) / TOKENS_PER_MILLION) * pricing.outputRatePer1M;
  const reasoningCost = (Math.max(0, usage.reasoningTokens || 0) / TOKENS_PER_MILLION) *
    reasoningRate;

  return {
    finalUsd: roundUsd(inputCost + outputCost + reasoningCost),
    pricingVersion: PRICING_VERSION,
  };
}
