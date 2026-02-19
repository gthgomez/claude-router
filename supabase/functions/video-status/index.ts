import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-client-info, apikey',
};

const ENABLE_VIDEO_PIPELINE = envFlag('ENABLE_VIDEO_PIPELINE', false);

type VideoAssetStatus = 'pending_upload' | 'uploaded' | 'processing' | 'ready' | 'failed' | 'expired';

function envFlag(name: string, defaultValue: boolean): boolean {
  const raw = Deno.env.get(name);
  if (!raw) return defaultValue;
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7).trim();
  return token || null;
}

function progressFromStatus(status: VideoAssetStatus): number {
  switch (status) {
    case 'pending_upload':
      return 10;
    case 'uploaded':
      return 30;
    case 'processing':
      return 65;
    case 'ready':
      return 100;
    case 'failed':
    case 'expired':
      return 100;
    default:
      return 0;
  }
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

  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
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

  const token = extractBearerToken(req.headers.get('Authorization'));
  if (!token) {
    return new Response(JSON.stringify({ error: 'Unauthorized: Missing or invalid Authorization header' }), {
      status: 401,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const assetId = new URL(req.url).searchParams.get('assetId');
  if (!assetId) {
    return new Response(JSON.stringify({ error: 'Bad Request: Missing assetId' }), {
      status: 400,
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

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser(token);

  if (userError || !user) {
    return new Response(JSON.stringify({ error: 'Unauthorized: Invalid or expired token' }), {
      status: 401,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const { data: asset, error: assetError } = await supabase
    .from('video_assets')
    .select(
      'id, user_id, status, duration_ms, error_code, error_message, width, height, created_at, updated_at',
    )
    .eq('id', assetId)
    .maybeSingle();

  if (assetError || !asset || asset.user_id !== user.id) {
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const { data: latestJob } = await supabase
    .from('video_jobs')
    .select('id, status, attempt, started_at, finished_at, error_code, error_message, created_at')
    .eq('asset_id', assetId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const { count: artifactCount } = await supabase
    .from('video_artifacts')
    .select('id', { count: 'exact', head: true })
    .eq('asset_id', assetId);

  const status = asset.status as VideoAssetStatus;
  const isFailed = status === 'failed' || status === 'expired';

  return new Response(JSON.stringify({
    assetId,
    status,
    progress: progressFromStatus(status),
    durationMs: asset.duration_ms || null,
    width: asset.width || null,
    height: asset.height || null,
    error: isFailed
      ? {
        code: asset.error_code || latestJob?.error_code || 'video_processing_failed',
        message: asset.error_message || latestJob?.error_message || 'Video processing failed',
      }
      : null,
    artifactsReady: status === 'ready' && (artifactCount || 0) > 0,
    latestJob: latestJob || null,
    updatedAt: asset.updated_at,
  }), {
    status: 200,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
});