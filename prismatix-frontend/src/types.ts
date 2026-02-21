// src/types.ts

export type AnthropicModel = 'opus-4.6' | 'sonnet-4.6' | 'haiku-4.5';
export type RouterModel = AnthropicModel | 'gpt-5-mini' | 'gemini-3-flash' | 'gemini-3.1-pro';
export type RouterProvider = 'anthropic' | 'openai' | 'google';
export type GeminiFlashThinkingLevel = 'low' | 'high';
export type DebateProfile = 'general' | 'code' | 'video_ui';
export type AttachmentKind = 'image' | 'text' | 'video';
export type VideoAssetStatus =
  | 'pending_upload'
  | 'uploaded'
  | 'processing'
  | 'ready'
  | 'failed'
  | 'expired';

export interface MessageCost {
  estimatedUsd?: number;
  finalUsd?: number;
  pricingVersion?: string;
}

export interface Message {
  role: 'user' | 'assistant';
  content: string | any[]; // Supports multimodal content
  timestamp: number;
  model?: RouterModel;
  provider?: RouterProvider;
  modelId?: string;
  modelOverride?: string;
  geminiFlashThinkingLevel?: GeminiFlashThinkingLevel;
  debateActive?: boolean;
  debateProfile?: DebateProfile;
  debateTrigger?: string;
  debateModel?: string;
  debateCostNote?: string;
  imageData?: string;            // Base64 image data (first image for display)
  mediaType?: string;            // MIME type
  imageStorageUrl?: string;      // Supabase storage URL
  attachments?: FileUploadPayload[]; // ✅ NEW: All attachments for reference
  thinkingLog?: string[];
  thinkingDurationMs?: number;
  cost?: MessageCost;
}

export interface FileUploadPayload {
  clientId?: string;
  name: string;
  kind?: AttachmentKind;
  isImage: boolean;
  imageData?: string;   // Base64 (without data URL prefix)
  mediaType?: string;   // e.g., "image/png"
  content?: string;     // For text files
  size?: number;        // File size in bytes
  file?: File;
  videoAssetId?: string;
  durationMs?: number;
  status?: VideoAssetStatus;
  thumbnailUrl?: string;
  uploadProgress?: number;
  errorCode?: string;
}

export interface ContextAnalysis {
  messageCount: number;
  tokenEstimate: number;
  utilizationPercent: number;
  shouldReset: boolean;
  summary?: string;
  keyDecisions: string[];
  recentContext: { role: string; preview: string }[];
}

// API payload types
export interface ImageAttachment {
  data: string;       // Base64 image data
  mediaType: string;  // MIME type
}

export interface RouterPayload {
  query: string;
  conversationId: string;
  platform: 'web' | 'mobile';
  history: { role: string; content: string }[];
  images?: ImageAttachment[];     // Multiple images
  videoAssetIds?: string[];
  imageData?: string;             // Legacy single image
  mediaType?: string;
  imageStorageUrl?: string;
  modelOverride?: RouterModel;
  geminiFlashThinkingLevel?: GeminiFlashThinkingLevel;
  mode?: 'debate';
  debateProfile?: DebateProfile;
}
