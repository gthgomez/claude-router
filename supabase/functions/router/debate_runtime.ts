// debate_runtime.ts
// Shared pure helpers for Debate Mode runtime decisions.

import type { DebateProfile, DebateTrigger } from './debate_profiles.ts';
import type { Message } from './router_logic.ts';

export function selectDebateWorkerMaxTokens(
  profile: DebateProfile,
  generalCap: number,
  codeCap: number,
  videoUiCap: number,
): number {
  if (profile === 'code') return codeCap;
  if (profile === 'video_ui') return videoUiCap;
  return generalCap;
}

export function computeDebateEligibility(params: {
  profile: DebateProfile;
  enableDebateMode: boolean;
  enableDebateAuto: boolean;
  debateRequested: boolean;
  hasImages: boolean;
  hasVideoAssets: boolean;
  complexityScore: number;
  threshold: number;
}): {
  hasAnyMedia: boolean;
  shouldAutoDebate: boolean;
  doDebate: boolean;
  trigger: DebateTrigger;
} {
  if (params.profile === 'video_ui') {
    const hasAnyMedia = params.hasImages || params.hasVideoAssets;
    const doDebate = params.enableDebateMode &&
      params.debateRequested &&
      params.hasVideoAssets &&
      !params.hasImages;
    const trigger: DebateTrigger = params.debateRequested ? 'explicit' : 'off';
    return { hasAnyMedia, shouldAutoDebate: false, doDebate, trigger };
  }

  const hasAnyMedia = params.hasImages || params.hasVideoAssets;
  const shouldAutoDebate = params.enableDebateMode &&
    params.enableDebateAuto &&
    !params.debateRequested &&
    !hasAnyMedia &&
    params.complexityScore >= params.threshold;
  const doDebate = params.enableDebateMode &&
    (params.debateRequested || shouldAutoDebate) &&
    !hasAnyMedia;
  const trigger: DebateTrigger = params.debateRequested
    ? 'explicit'
    : shouldAutoDebate
    ? 'auto'
    : 'off';
  return { hasAnyMedia, shouldAutoDebate, doDebate, trigger };
}

export function buildDebateHeaders(params: {
  debateActive: boolean;
  debateProfile: DebateProfile;
  debateTrigger: DebateTrigger;
  debateModelTier?: string;
}): Record<string, string> {
  if (!params.debateActive) return {};
  return {
    'X-Debate-Mode': 'true',
    'X-Debate-Profile': params.debateProfile,
    'X-Debate-Trigger': params.debateTrigger,
    ...(params.debateModelTier ? { 'X-Debate-Model': params.debateModelTier } : {}),
    // Challenger costs are not included in the estimate; flag it.
    'X-Debate-Cost-Note': 'partial',
  };
}

export function serializeMessagesForCost(messages: Message[]): string {
  return messages.map((m) => `${m.role}: ${m.content}`).join('\n');
}

export async function runDebateStageWithTimeout<T>(params: {
  parentSignal: AbortSignal;
  timeoutMs: number;
  run: (signal: AbortSignal) => Promise<T>;
}): Promise<T | null> {
  if (params.timeoutMs <= 0) {
    return await params.run(params.parentSignal);
  }

  const stageController = new AbortController();
  let timedOut = false;

  const onParentAbort = () => {
    stageController.abort();
  };
  params.parentSignal.addEventListener('abort', onParentAbort, { once: true });

  let tid: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<{ kind: 'timeout' }>((resolve) => {
    tid = setTimeout(() => {
      timedOut = true;
      stageController.abort();
      resolve({ kind: 'timeout' });
    }, params.timeoutMs);
  });

  const runPromise = params.run(stageController.signal)
    .then((value) => ({ kind: 'value' as const, value }))
    .catch((error) => ({ kind: 'error' as const, error }));

  try {
    const winner = await Promise.race([runPromise, timeoutPromise]);
    if (winner.kind === 'timeout') return null;
    if (winner.kind === 'error') {
      if (timedOut || stageController.signal.aborted) return null;
      throw winner.error;
    }
    return winner.value;
  } catch (error) {
    if (timedOut || stageController.signal.aborted) {
      return null;
    }
    throw error;
  } finally {
    if (tid) clearTimeout(tid);
    params.parentSignal.removeEventListener('abort', onParentAbort);
  }
}
