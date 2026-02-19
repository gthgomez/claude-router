import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-client-info, apikey, x-worker-secret',
};

const ENABLE_VIDEO_PIPELINE = envFlag('ENABLE_VIDEO_PIPELINE', false);
const VIDEO_ARTIFACT_BUCKET = 'video-artifacts';

type VideoJobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

interface VideoJobRow {
  id: string;
  asset_id: string;
  status: VideoJobStatus;
  attempt: number;
  created_at?: string;
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
      .update({
        status: 'failed',
        finished_at: nowIso,
        error_code: code,
        error_message: message,
      } as never)
      .eq('id', jobId),
    supabase
      .from('video_assets')
      .update({
        status: 'failed',
        error_code: code,
        error_message: message,
        updated_at: nowIso,
      } as never)
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
    return new Response(JSON.stringify({ error: 'Server misconfigured: missing Supabase env vars' }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
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
    console.error('[video-worker] failed to read queue:', queuedError);
    return new Response(JSON.stringify({ error: 'Failed to read queue' }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  if (!queuedJobRaw) {
    return new Response(JSON.stringify({ ok: true, processed: 0, message: 'No queued jobs' }), {
      status: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const queuedJob = queuedJobRaw as VideoJobRow;
  const nowIso = new Date().toISOString();

  const { data: runningJob, error: lockError } = await supabase
    .from('video_jobs')
    .update({
      status: 'running',
      attempt: queuedJob.attempt + 1,
      started_at: nowIso,
      error_code: null,
      error_message: null,
    })
    .eq('id', queuedJob.id)
    .eq('status', 'queued')
    .select('id, asset_id, status, attempt, created_at')
    .maybeSingle();

  if (lockError || !runningJob) {
    return new Response(JSON.stringify({ ok: true, processed: 0, message: 'Job lock lost' }), {
      status: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const job = runningJob as VideoJobRow;

  try {
    const { data: asset, error: assetError } = await supabase
      .from('video_assets')
      .select('id, user_id, storage_bucket, storage_path, mime_type, status')
      .eq('id', job.asset_id)
      .maybeSingle();

    if (assetError || !asset) {
      await markJobFailed(supabase as ReturnType<typeof createClient>, job.id, job.asset_id, 'asset_not_found', 'Asset not found');
      return new Response(JSON.stringify({ ok: false, error: 'asset_not_found' }), {
        status: 404,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    await supabase
      .from('video_assets')
      .update({ status: 'processing', error_code: null, error_message: null, updated_at: nowIso })
      .eq('id', job.asset_id);

    // v1 placeholder processing: persist deterministic artifacts so router has compact references.
    await supabase.from('video_artifacts').insert([
      {
        asset_id: job.asset_id,
        kind: 'thumbnail',
        storage_bucket: VIDEO_ARTIFACT_BUCKET,
        storage_path: `${asset.user_id}/${job.asset_id}/thumbnail.jpg`,
        metadata: {
          placeholder: true,
          generated_by: 'video-worker-v1',
        },
      },
      {
        asset_id: job.asset_id,
        kind: 'summary',
        text_content: 'Video uploaded and queued for deeper analysis. Transcript extraction not enabled in this slice.',
        metadata: {
          placeholder: true,
          generated_by: 'video-worker-v1',
        },
      },
    ]);

    const doneAt = new Date().toISOString();
    await Promise.all([
      supabase
        .from('video_assets')
        .update({
          status: 'ready',
          updated_at: doneAt,
          error_code: null,
          error_message: null,
        })
        .eq('id', job.asset_id),
      supabase
        .from('video_jobs')
        .update({
          status: 'succeeded',
          finished_at: doneAt,
          error_code: null,
          error_message: null,
        })
        .eq('id', job.id),
    ]);

    return new Response(JSON.stringify({ ok: true, processed: 1, jobId: job.id, assetId: job.asset_id }), {
      status: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[video-worker] failed processing job:', job.id, message);

    await markJobFailed(
      supabase as ReturnType<typeof createClient>,
      job.id,
      job.asset_id,
      'video_processing_failed',
      message.slice(0, 500),
    );

    return new Response(JSON.stringify({ ok: false, error: 'video_processing_failed', details: message }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
});
