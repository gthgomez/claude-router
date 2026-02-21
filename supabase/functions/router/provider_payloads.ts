// provider_payloads.ts
// Build provider request payloads from a RouteDecision.

import {
  type ImageAttachment,
  type Message,
  type RouteDecision,
  transformMessagesForAnthropic,
  transformMessagesForGoogle,
  transformMessagesForOpenAI,
} from './router_logic.ts';

export type GeminiFlashThinkingLevel = 'low' | 'high';

export function buildAnthropicStreamPayload(
  decision: RouteDecision,
  allMessages: Message[],
  images: ImageAttachment[],
): Record<string, unknown> {
  return {
    model: decision.model,
    max_tokens: decision.budgetCap,
    messages: transformMessagesForAnthropic(allMessages, images),
    stream: true,
  };
}

export function buildOpenAIStreamPayload(
  decision: RouteDecision,
  allMessages: Message[],
  images: ImageAttachment[],
): Record<string, unknown> {
  return {
    model: decision.model,
    messages: transformMessagesForOpenAI(allMessages, images),
    stream: true,
    max_completion_tokens: decision.budgetCap,
  };
}

export function buildOpenAILegacyStreamPayload(
  decision: RouteDecision,
  allMessages: Message[],
  images: ImageAttachment[],
): Record<string, unknown> {
  return {
    model: decision.model,
    messages: transformMessagesForOpenAI(allMessages, images),
    stream: true,
    max_tokens: decision.budgetCap,
  };
}

export function buildGoogleStreamPayload(
  decision: RouteDecision,
  allMessages: Message[],
  images: ImageAttachment[],
  includeThinkingConfig: boolean,
  geminiFlashThinkingLevel: GeminiFlashThinkingLevel,
): Record<string, unknown> {
  const isGeminiFlash = decision.modelTier === 'gemini-3-flash';
  const toApiThinkingLevel = geminiFlashThinkingLevel === 'low' ? 'LOW' : 'HIGH';
  return {
    contents: transformMessagesForGoogle(allMessages, images),
    generationConfig: {
      maxOutputTokens: decision.budgetCap,
      ...(includeThinkingConfig && isGeminiFlash
        ? {
          thinkingConfig: {
            thinkingLevel: toApiThinkingLevel,
          },
        }
        : {}),
    },
  };
}
