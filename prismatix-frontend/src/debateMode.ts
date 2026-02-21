import type { DebateProfile, FileUploadPayload, Message } from './types';

export type DebateSelection = 'off' | DebateProfile;

export const DEBATE_SELECTIONS: Array<{ value: DebateSelection; label: string }> = [
  { value: 'off', label: 'Debate Off' },
  { value: 'general', label: 'General' },
  { value: 'code', label: 'Code' },
  { value: 'video_ui', label: 'Video UI' },
];

export function hasReadyVideoAttachment(attachments: FileUploadPayload[]): boolean {
  return attachments.some((file) => file.kind === 'video' && file.status === 'ready');
}

export function getDebatePayload(
  selection: DebateSelection,
): { mode?: 'debate'; debateProfile?: DebateProfile } {
  if (selection === 'off') {
    return {};
  }
  return {
    mode: 'debate',
    debateProfile: selection,
  };
}

export function shouldShowDebateBadges(msg: Message): boolean {
  return Boolean(
    msg.debateActive ||
    msg.debateProfile ||
    msg.debateTrigger ||
    msg.debateModel ||
    msg.debateCostNote,
  );
}
