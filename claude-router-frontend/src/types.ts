// src/types.ts

export type ClaudeModel = 'opus-4.5' | 'sonnet-4.5' | 'haiku-4.5';
export type RouterModel = ClaudeModel | 'gpt-5-mini' | 'gemini-3-flash' | 'gemini-3-pro';
export type RouterProvider = 'anthropic' | 'openai' | 'google';
export type GeminiFlashThinkingLevel = 'low' | 'high';

export interface Message {
  role: 'user' | 'assistant';
  content: string | any[]; // Supports multimodal content
  timestamp: number;
  model?: RouterModel;
  provider?: RouterProvider;
  modelId?: string;
  modelOverride?: string;
  geminiFlashThinkingLevel?: GeminiFlashThinkingLevel;
  imageData?: string;            // Base64 image data (first image for display)
  mediaType?: string;            // MIME type
  imageStorageUrl?: string;      // Supabase storage URL
  attachments?: FileUploadPayload[]; // ✅ NEW: All attachments for reference
}

export interface FileUploadPayload {
  name: string;
  isImage: boolean;
  imageData?: string;   // Base64 (without data URL prefix)
  mediaType?: string;   // e.g., "image/png"
  content?: string;     // For text files
  size?: number;        // File size in bytes
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
  imageData?: string;             // Legacy single image
  mediaType?: string;
  imageStorageUrl?: string;
  modelOverride?: RouterModel;
  geminiFlashThinkingLevel?: GeminiFlashThinkingLevel;
}
