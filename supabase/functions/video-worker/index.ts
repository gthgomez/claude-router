
// index.ts - native Gemini File API integration
import { createClient } from 'npm:@supabase/supabase-js@2';
import { GoogleAIFileManager, FileState } from 'npm:@google/generative-ai/server';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-client-info, apikey, x-worker-secret',
};

const ENABLE_VIDEO_PIPELINE = envFlag('ENABLE_VIDEO_PIPELINE', false);
const GOOGLE_API_KEY = Deno.env.get('GOOGLE_API_KEY') || '';

type VideoJobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

interface VideoJobRow {
  id: string;
  asset_id: string;
  status: VideoJobStatus;
  attempt: number;
  created_at?: string;
}

interface VideoAssetRow {
  id: string;
  user_id: string;
  storage_bucket: string;
  storage_path: string;
  mime_type: string;
  status: string;
  metadata?: {
    gemini_file_name?: string;
    gemini_file_uri?: string;
    gemini_state?: string;
  } | null;
}

function envFlag(name: string, defaultValue: boolean): boolean {
  const raw = Deno.env.get(name);
  if (!raw) return defaultValue;
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

function getWorkerSecretValid(req: Request): boolean {
  const expected = Deno.env.get('VIDEO_WORKER_SECRET');
  if (!expected) return true;
  const provided = req.headers.get('x-worker-secret') || '';
  return provided === expected;
}

async function markJobFailed(
  supabase: ReturnType<typeof createClient>,
  jobId: string,
  assetId: string,
  code: string,
  message: string,
): Promise<void> {
  const nowIso = new Date().toISOString();
  await Promise.all([
    supabase
      .from('video_jobs')
      .update({ status: 'failed', finished_at: nowIso, error_code: code, error_message: message } as never)
      .eq('id', jobId),
    supabase
      .from('video_assets')
      .update({ status: 'failed', error_code: code, error_message: message, updated_at: nowIso } as never)
      .eq('id', assetId),
  ]);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  if (!ENABLE_VIDEO_PIPELINE) {
    return new Response(JSON.stringify({ error: 'video_pipeline_disabled' }), {
      status: 404,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  if (!getWorkerSecretValid(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !supabaseServiceRoleKey) {
    return new Response(JSON.stringify({ error: 'Server misconfigured' }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  if (!GOOGLE_API_KEY) {
    return new Response(JSON.stringify({ error: 'Google API Key missing' }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const fileManager = new GoogleAIFileManager(GOOGLE_API_KEY);
  const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false },
    db: { schema: 'public' },
  });

  const { data: queuedJobRaw, error: queuedError } = await supabase
    .from('video_jobs')
    .select('id, asset_id, status, attempt, created_at')
    .eq('status', 'queued')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (queuedError) {
    return new Response(JSON.stringify({ error: 'Failed to read queue' }), { status: 500 });
  }

  if (!queuedJobRaw) {
    return new Response(JSON.stringify({ ok: true, processed: 0, message: 'No queued jobs' }), { status: 200, headers: CORS_HEADERS });
  }

  const queuedJob = queuedJobRaw as VideoJobRow;
  const nowIso = new Date().toISOString();

  const { data: runningJob, error: lockError } = await supabase
    .from('video_jobs')
    .update({ status: 'running', attempt: queuedJob.attempt + 1, started_at: nowIso, error_code: null, error_message: null })
    .eq('id', queuedJob.id)
    .eq('status', 'queued')
    .select()
    .maybeSingle();

  if (lockError || !runningJob) {
    return new Response(JSON.stringify({ ok: true, processed: 0, message: 'Job lock lost' }), { status: 200, headers: CORS_HEADERS });
  }

  const job = runningJob as VideoJobRow;

  try {
    const { data: asset, error: assetError } = await supabase
      .from('video_assets')
      .select('id, user_id, storage_bucket, storage_path, mime_type, status, metadata')
      .eq('id', job.asset_id)
      .maybeSingle();

    if (assetError || !asset) {
      await markJobFailed(supabase, job.id, job.asset_id, 'asset_not_found', 'Asset not found');
      return new Response(JSON.stringify({ ok: false, error: 'asset_not_found' }), { status: 404 });
    }

    const assetRow = asset as VideoAssetRow;
    const metadata = assetRow.metadata || {};

    // PHASE 2: Polling (File already uploaded)
    if (metadata.gemini_file_name) {
      console.log('[video-worker] Polling Gemini File API for state:', metadata.gemini_file_name);
      const geminiFile = await fileManager.getFile(metadata.gemini_file_name);
      
      if (geminiFile.state === FileState.ACTIVE) {
        // Processing Complete!
        const doneAt = new Date().toISOString();
        const updatedMetadata = { ...metadata, gemini_state: 'ACTIVE' };
        
        await Promise.all([
          supabase.from('video_assets').update({ status: 'ready', metadata: updatedMetadata, updated_at: doneAt } as never).eq('id', job.asset_id),
          supabase.from('video_jobs').update({ status: 'succeeded', finished_at: doneAt } as never).eq('id', job.id),
        ]);
        
        return new Response(JSON.stringify({ ok: true, state: 'ACTIVE' }), { status: 200, headers: CORS_HEADERS });
        
      } else if (geminiFile.state === FileState.FAILED) {
        throw new Error('Gemini API failed to process video.');
      } else {
        // Still PROCESSING. Re-queue for next cron tick.
        await supabase.from('video_jobs').update({ status: 'queued', attempt: 0 } as never).eq('id', job.id);
        return new Response(JSON.stringify({ ok: true, state: 'PROCESSING', re_queued: true }), { status: 200, headers: CORS_HEADERS });
      }
    }

    // PHASE 1: Upload (File not yet uploaded)
    console.log('[video-worker] Uploading video to Gemini File API:', job.asset_id);
    await supabase.from('video_assets').update({ status: 'processing', updated_at: new Date().toISOString() } as never).eq('id', job.asset_id);

    const { data: blob, error: downloadError } = await supabase.storage.from(assetRow.storage_bucket).download(assetRow.storage_path);
    if (downloadError || !blob) throw new Error('Failed to download video blob from storage');

    // Create a temporary file locally for @google/generative-ai upload (it expects a path)
    const tempPath = '/tmp/' + assetRow.id + '.tmp';
    await Deno.writeFile(tempPath, new Uint8Array(await blob.arrayBuffer()));
    
    const uploadResult = await fileManager.uploadFile(tempPath, {
      mimeType: assetRow.mime_type,
      displayName: assetRow.id,
    });
    
    // Clean up
    await Deno.remove(tempPath);

    // Save metadata and requeue immediately for polling
    const newMetadata = { 
        ...metadata, 
        gemini_file_name: uploadResult.file.name, 
        gemini_file_uri: uploadResult.file.uri,
        gemini_state: 'PROCESSING'
    };

    await supabase.from('video_assets').update({ metadata: newMetadata } as never).eq('id', job.asset_id);
    await supabase.from('video_jobs').update({ status: 'queued', attempt: 0 } as never).eq('id', job.id);

    return new Response(JSON.stringify({ ok: true, state: 'UPLOADED_REQUEUED' }), { status: 200, headers: CORS_HEADERS });

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[video-worker] failed processing job:', job.id, message);
    await markJobFailed(supabase, job.id, job.asset_id, 'video_processing_failed', message.slice(0, 500));
    return new Response(JSON.stringify({ ok: false, error: 'video_processing_failed', details: message }), { status: 500, headers: CORS_HEADERS });
  }
});

