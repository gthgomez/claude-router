import { countTokens, type RouterModel } from './router_logic.ts';
import { getModelPricing, PRICING_VERSION } from './pricing_registry.ts';

const TOKENS_PER_MILLION = 1_000_000;

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export interface PreFlightCostResult {
  tokenEstimate: number;
  promptTokens: number;
  projectedOutputTokens: number;
  estimatedUsd: number;
  pricingVersion: string;
  hasUnknownRate: boolean;
}

export interface UsageStats {
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
}

export interface FinalCostResult {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  finalUsd: number;
  pricingVersion: string;
  hasUnknownRate: boolean;
}

export interface CostBreakdownResult {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  inputCostUsd: number;
  outputCostUsd: number;
  reasoningCostUsd: number;
  totalUsd: number;
  pricingVersion: string;
  hasUnknownRate: boolean;
}

export function calculatePreFlightCost(
  modelTier: RouterModel,
  contextText: string,
  images: number,
  additionalPromptTokens = 0,
): PreFlightCostResult {
  const imageTokens = Math.max(0, images) * 1600;
  const promptTokens = countTokens(contextText) + imageTokens + Math.max(0, additionalPromptTokens);
  const projectedOutputTokens = Math.max(64, Math.ceil(promptTokens * 0.35));
  const pricing = getModelPricing(modelTier);

  if (!pricing) {
    return {
      tokenEstimate: promptTokens + projectedOutputTokens,
      promptTokens,
      projectedOutputTokens,
      estimatedUsd: 0,
      pricingVersion: PRICING_VERSION,
      hasUnknownRate: true,
    };
  }

  const inputCost = (promptTokens / TOKENS_PER_MILLION) * pricing.inputRatePer1M;
  const outputCost = (projectedOutputTokens / TOKENS_PER_MILLION) * pricing.outputRatePer1M;

  return {
    tokenEstimate: promptTokens + projectedOutputTokens,
    promptTokens,
    projectedOutputTokens,
    estimatedUsd: roundUsd(inputCost + outputCost),
    pricingVersion: PRICING_VERSION,
    hasUnknownRate: false,
  };
}

export function calculateFinalCost(
  modelTier: RouterModel,
  usage: UsageStats,
): FinalCostResult {
  const promptTokens = Math.max(0, usage.promptTokens || 0);
  const completionTokens = Math.max(0, usage.completionTokens || 0);
  const reasoningTokens = Math.max(0, usage.reasoningTokens || 0);
  const pricing = getModelPricing(modelTier);

  if (!pricing) {
    return {
      promptTokens,
      completionTokens,
      reasoningTokens,
      finalUsd: 0,
      pricingVersion: PRICING_VERSION,
      hasUnknownRate: true,
    };
  }

  const inputCost = (promptTokens / TOKENS_PER_MILLION) * pricing.inputRatePer1M;
  const outputCost = (completionTokens / TOKENS_PER_MILLION) * pricing.outputRatePer1M;
  const reasoningRate = pricing.reasoningRatePer1M ?? pricing.outputRatePer1M;
  const reasoningCost = (reasoningTokens / TOKENS_PER_MILLION) * reasoningRate;

  return {
    promptTokens,
    completionTokens,
    reasoningTokens,
    finalUsd: roundUsd(inputCost + outputCost + reasoningCost),
    pricingVersion: PRICING_VERSION,
    hasUnknownRate: false,
  };
}

export function calculateCostBreakdown(
  modelTier: RouterModel,
  usage: UsageStats,
): CostBreakdownResult {
  const promptTokens = Math.max(0, usage.promptTokens || 0);
  const completionTokens = Math.max(0, usage.completionTokens || 0);
  const reasoningTokens = Math.max(0, usage.reasoningTokens || 0);
  const pricing = getModelPricing(modelTier);

  if (!pricing) {
    return {
      promptTokens,
      completionTokens,
      reasoningTokens,
      inputCostUsd: 0,
      outputCostUsd: 0,
      reasoningCostUsd: 0,
      totalUsd: 0,
      pricingVersion: PRICING_VERSION,
      hasUnknownRate: true,
    };
  }

  const inputCost = roundUsd((promptTokens / TOKENS_PER_MILLION) * pricing.inputRatePer1M);
  const outputCost = roundUsd((completionTokens / TOKENS_PER_MILLION) * pricing.outputRatePer1M);
  const reasoningRate = pricing.reasoningRatePer1M ?? pricing.outputRatePer1M;
  const reasoningCost = roundUsd((reasoningTokens / TOKENS_PER_MILLION) * reasoningRate);

  return {
    promptTokens,
    completionTokens,
    reasoningTokens,
    inputCostUsd: inputCost,
    outputCostUsd: outputCost,
    reasoningCostUsd: reasoningCost,
    totalUsd: roundUsd(inputCost + outputCost + reasoningCost),
    pricingVersion: PRICING_VERSION,
    hasUnknownRate: false,
  };
}
