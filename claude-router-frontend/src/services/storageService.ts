// src/services/storageService.ts
// Handles file uploads to Supabase Storage with graceful error handling
// If bucket doesn't exist or upload fails, returns null (non-blocking)

import { supabase } from '../lib/supabase';
import type { FileUploadPayload } from '../types';

const BUCKET_NAME = 'chat-uploads';

/**
 * Uploads an image attachment to Supabase Storage
 * Returns the public URL on success, null on failure
 * 
 * IMPORTANT: This function is non-blocking - if storage fails,
 * the chat can still proceed with base64 data sent directly to Claude
 * 
 * @param file - The file payload with base64 image data
 * @param userId - The authenticated user's ID
 * @returns Public URL string or null if upload failed
 */
export async function uploadAttachment(
  file: FileUploadPayload, 
  userId: string
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
    const { data, error: uploadError } = await supabase.storage
      .from(BUCKET_NAME)
      .upload(filePath, blob, {
        cacheControl: '3600',
        upsert: false
      });

    if (uploadError) {
      // Check for specific error types
      if (uploadError.message?.includes('Bucket not found')) {
        console.warn('[Storage] Bucket "' + BUCKET_NAME + '" does not exist. Create it in Supabase Dashboard → Storage.');
        console.warn('[Storage] Continuing without persistent storage - image will be sent as base64.');
        return null;
      }
      
      console.error('[Storage] Upload error:', uploadError);
      return null;
    }

    // Get Public URL
    const { data: urlData } = supabase.storage
      .from(BUCKET_NAME)
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
    const { data, error } = await supabase.storage.getBucket(BUCKET_NAME);
    
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
║  The "${BUCKET_NAME}" bucket doesn't exist.                       ║
║                                                                  ║
║  To enable persistent image storage:                             ║
║  1. Go to your Supabase Dashboard                               ║
║  2. Navigate to Storage → New Bucket                             ║
║  3. Create bucket named: ${BUCKET_NAME}                          ║
║  4. Set it to "Public" for URL access                           ║
║  5. Add RLS policy:                                             ║
║     - INSERT: auth.uid() = (storage.foldername(name))[1]::uuid  ║
║     - SELECT: true (public read)                                 ║
║                                                                  ║
║  Without this, images are sent as base64 (still works, but      ║
║  not persisted for conversation history).                       ║
╚══════════════════════════════════════════════════════════════════╝
  `);
}
