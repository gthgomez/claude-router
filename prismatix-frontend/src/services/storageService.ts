// src/services/storageService.ts
// Handles file uploads to Supabase Storage and video pipeline orchestration.

import { supabase } from '../lib/supabase';
import { CONFIG } from '../config';
import type { FileUploadPayload, VideoAssetStatus } from '../types';

const IMAGE_BUCKET_NAME = 'chat-uploads';
const VIDEO_UPLOAD_TIMEOUT_MS = 60_000;
const VIDEO_STATUS_POLL_INTERVAL_MS = 2_500;
const VIDEO_STATUS_POLL_MAX_ATTEMPTS = 120;

interface VideoInitResponse {
  assetId: string;
  bucket: string;
  path: string;
  signedUploadUrl: string;
  expiresAt: string;
}

interface VideoStatusResponse {
  assetId: string;
  status: VideoAssetStatus;
  progress: number;
  durationMs: number | null;
  error: { code?: string; message?: string } | null;
  artifactsReady: boolean;
}

export interface VideoUploadResult {
  assetId: string;
  status: VideoAssetStatus;
}

async function getAccessToken(): Promise<string> {
  const {
    data: { session },
    error,
  } = await supabase.auth.getSession();

  if (error || !session?.access_token) {
    throw new Error('No active session. Please sign in again.');
  }

  return session.access_token;
}

function requireVideoEndpoints(): { intakeEndpoint: string; statusEndpoint: string } {
  if (!CONFIG.VIDEO_INTAKE_ENDPOINT || !CONFIG.VIDEO_STATUS_ENDPOINT) {
    throw new Error('Video endpoints are not configured.');
  }
  return {
    intakeEndpoint: CONFIG.VIDEO_INTAKE_ENDPOINT,
    statusEndpoint: CONFIG.VIDEO_STATUS_ENDPOINT,
  };
}

function uploadViaSignedUrl(
  signedUploadUrl: string,
  file: File,
  onProgress?: (progressPercent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const timeout = window.setTimeout(() => {
      xhr.abort();
      reject(new Error('Video upload timed out.'));
    }, VIDEO_UPLOAD_TIMEOUT_MS);

    xhr.upload.onprogress = (evt) => {
      if (!evt.lengthComputable || !onProgress) return;
      const percent = Math.max(0, Math.min(100, Math.round((evt.loaded / evt.total) * 100)));
      onProgress(percent);
    };

    xhr.onerror = () => {
      window.clearTimeout(timeout);
      reject(new Error('Video upload failed.'));
    };

    xhr.onabort = () => {
      window.clearTimeout(timeout);
      reject(new Error('Video upload aborted.'));
    };

    xhr.onload = () => {
      window.clearTimeout(timeout);
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(100);
        resolve();
        return;
      }
      reject(new Error(`Video upload failed with status ${xhr.status}.`));
    };

    xhr.open('PUT', signedUploadUrl, true);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.send(file);
  });
}

async function initVideoUpload(params: {
  file: File;
  conversationId?: string;
}): Promise<VideoInitResponse> {
  const { intakeEndpoint } = requireVideoEndpoints();
  const token = await getAccessToken();
  console.log('[Storage][Video] Init upload:', {
    fileName: params.file.name,
    mimeType: params.file.type || 'unknown',
    sizeBytes: params.file.size,
  });

  const response = await fetch(`${intakeEndpoint}/init`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(CONFIG.SUPABASE_ANON_KEY ? { apikey: CONFIG.SUPABASE_ANON_KEY } : {}),
    },
    body: JSON.stringify({
      fileName: params.file.name,
      mimeType: params.file.type,
      fileSizeBytes: params.file.size,
      conversationId: params.conversationId || null,
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = String(payload?.error || 'video_upload_init_failed');
    throw new Error(code);
  }

  if (!payload?.assetId || !payload?.signedUploadUrl) {
    throw new Error('video_upload_init_invalid_response');
  }

  return payload as VideoInitResponse;
}

async function completeVideoUpload(assetId: string): Promise<void> {
  const { intakeEndpoint } = requireVideoEndpoints();
  const token = await getAccessToken();

  const response = await fetch(`${intakeEndpoint}/complete`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(CONFIG.SUPABASE_ANON_KEY ? { apikey: CONFIG.SUPABASE_ANON_KEY } : {}),
    },
    body: JSON.stringify({ assetId }),
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const code = String(payload?.error || 'video_upload_complete_failed');
    throw new Error(code);
  }
}

export async function getVideoStatus(assetId: string): Promise<VideoStatusResponse> {
  const { statusEndpoint } = requireVideoEndpoints();
  const token = await getAccessToken();

  const response = await fetch(`${statusEndpoint}?assetId=${encodeURIComponent(assetId)}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(CONFIG.SUPABASE_ANON_KEY ? { apikey: CONFIG.SUPABASE_ANON_KEY } : {}),
    },
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = String(payload?.error || 'video_status_failed');
    throw new Error(code);
  }

  return payload as VideoStatusResponse;
}

export async function waitForVideoReady(
  assetId: string,
  onStatus?: (status: VideoStatusResponse) => void,
): Promise<VideoStatusResponse> {
  for (let attempt = 0; attempt < VIDEO_STATUS_POLL_MAX_ATTEMPTS; attempt++) {
    const status = await getVideoStatus(assetId);
    onStatus?.(status);

    if (status.status === 'ready' || status.status === 'failed' || status.status === 'expired') {
      return status;
    }

    await new Promise((resolve) => setTimeout(resolve, VIDEO_STATUS_POLL_INTERVAL_MS));
  }

  throw new Error('video_processing_timeout');
}

export async function uploadVideoAttachment(
  file: File,
  conversationId: string,
  onProgress?: (progressPercent: number) => void,
): Promise<VideoUploadResult> {
  console.log('[Storage][Video] Uploading to signed URL for:', file.name);
  const init = await initVideoUpload({ file, conversationId });
  await uploadViaSignedUrl(init.signedUploadUrl, file, onProgress);
  console.log('[Storage][Video] Signed upload complete. Finalizing asset:', init.assetId);
  await completeVideoUpload(init.assetId);
  console.log('[Storage][Video] Finalized asset:', init.assetId);
  return {
    assetId: init.assetId,
    status: 'uploaded',
  };
}

/**
 * Uploads an image attachment to Supabase Storage
 * Returns the public URL on success, null on failure
 *
 * IMPORTANT: This function is non-blocking - if storage fails,
 * the chat can still proceed with base64 data sent directly to the selected provider
 *
 * @param file - The file payload with base64 image data
 * @param userId - The authenticated user's ID
 * @returns Public URL string or null if upload failed
 */
export async function uploadAttachment(
  file: FileUploadPayload,
  userId: string,
): Promise<string | null> {
  // Only handle images with valid data
  if (!file.isImage || !file.imageData) {
    console.log('[Storage] Skipping non-image file');
    return null;
  }

  try {
    // Convert Base64 back to Blob for upload
    const byteCharacters = atob(file.imageData);
    const byteNumbers = new Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
      byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    const blob = new Blob([byteArray], { type: file.mediaType || 'application/octet-stream' });

    // Generate unique path: user_id/timestamp_filename
    const timestamp = Date.now();
    const safeName = file.name.replace(/[^a-zA-Z0-9.-]/g, '_');
    const filePath = `${userId}/${timestamp}_${safeName}`;

    console.log('[Storage] Uploading to:', filePath);

    // Attempt upload
    const { error: uploadError } = await supabase.storage
      .from(IMAGE_BUCKET_NAME)
      .upload(filePath, blob, {
        cacheControl: '3600',
        upsert: false,
      });

    if (uploadError) {
      // Check for specific error types
      if (uploadError.message?.includes('Bucket not found')) {
        console.warn(
          '[Storage] Bucket "' +
            IMAGE_BUCKET_NAME +
            '" does not exist. Create it in Supabase Dashboard -> Storage.',
        );
        console.warn(
          '[Storage] Continuing without persistent storage - image will be sent as base64.',
        );
        return null;
      }

      console.error('[Storage] Upload error:', uploadError);
      return null;
    }

    // Get Public URL
    const { data: urlData } = supabase.storage
      .from(IMAGE_BUCKET_NAME)
      .getPublicUrl(filePath);

    console.log('[Storage] Upload successful:', urlData.publicUrl);
    return urlData.publicUrl;
  } catch (error) {
    console.error('[Storage] Unexpected error:', error);
    // Return null instead of throwing - allow chat to continue
    return null;
  }
}

/**
 * Checks if the storage bucket exists and is accessible
 * Useful for showing a warning in the UI if storage isn't configured
 */
export async function checkBucketExists(): Promise<boolean> {
  try {
    const { data, error } = await supabase.storage.getBucket(IMAGE_BUCKET_NAME);

    if (error) {
      console.warn('[Storage] Bucket check failed:', error.message);
      return false;
    }

    return !!data;
  } catch (error) {
    console.warn('[Storage] Bucket check error:', error);
    return false;
  }
}

/**
 * Instructions for setting up the storage bucket
 * Call this to log setup instructions when bucket doesn't exist
 */
export function logBucketSetupInstructions(): void {
  console.info(`
╔══════════════════════════════════════════════════════════════════╗
║                    SUPABASE STORAGE SETUP                        ║
╠══════════════════════════════════════════════════════════════════╣
║  The "${IMAGE_BUCKET_NAME}" bucket doesn't exist.                 ║
║                                                                  ║
║  To enable persistent image storage:                             ║
║  1. Go to your Supabase Dashboard                               ║
║  2. Navigate to Storage -> New Bucket                            ║
║  3. Create bucket named: ${IMAGE_BUCKET_NAME}                    ║
║  4. Set it to "Public" for URL access                           ║
║  5. Add RLS policy:                                              ║
║     - INSERT: auth.uid() = (storage.foldername(name))[1]::uuid  ║
║     - SELECT: true (public read)                                 ║
║                                                                  ║
║  Without this, images are sent as base64 (still works, but      ║
║  not persisted for conversation history).                        ║
╚══════════════════════════════════════════════════════════════════╝
  `);
}
