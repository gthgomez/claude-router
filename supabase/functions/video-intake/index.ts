import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-client-info, apikey',
};

const VIDEO_UPLOAD_BUCKET = 'video-uploads';
const ENABLE_VIDEO_PIPELINE = envFlag('ENABLE_VIDEO_PIPELINE', false);
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_ACTIVE_JOBS_PER_USER = 2;
const ALLOWED_MIME_TYPES = new Set([
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-matroska',
  'video/x-msvideo',
]);

interface InitRequestBody {
  fileName?: string;
  mimeType?: string;
  fileSizeBytes?: number;
  conversationId?: string | null;
}

interface CompleteRequestBody {
  assetId?: string;
}

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

function getPathSuffix(fileName: string, mimeType: string): string {
  const cleanedName = fileName.trim().toLowerCase();
  const dotIndex = cleanedName.lastIndexOf('.');
  if (dotIndex > 0) {
    const ext = cleanedName.slice(dotIndex);
    if (ext.length <= 8 && /^\.[a-z0-9]+$/.test(ext)) return ext;
  }

  switch (mimeType.toLowerCase()) {
    case 'video/quicktime':
      return '.mov';
    case 'video/webm':
      return '.webm';
    case 'video/x-matroska':
      return '.mkv';
    case 'video/x-msvideo':
      return '.avi';
    default:
      return '.mp4';
  }
}

function parsePath(url: string): 'init' | 'complete' | 'unknown' {
  const pathname = new URL(url).pathname.replace(/\/+$/, '');
  if (pathname.endsWith('/video-intake/init')) return 'init';
  if (pathname.endsWith('/video-intake/complete')) return 'complete';
  if (pathname.endsWith('/video-intake')) return 'init';
  return 'unknown';
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

  const operation = parsePath(req.url);

  if (operation === 'unknown') {
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  let body: InitRequestBody | CompleteRequestBody;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Bad Request: Invalid JSON' }), {
      status: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  if (operation === 'init') {
    const { fileName, mimeType, fileSizeBytes, conversationId } = body as InitRequestBody;
    let conversationIdForAsset: string | null = conversationId || null;

    if (!fileName || !mimeType || !Number.isFinite(fileSizeBytes)) {
      return new Response(JSON.stringify({ error: 'Bad Request: Missing required fields' }), {
        status: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }
    const normalizedFileSizeBytes = Number(fileSizeBytes);

    const normalizedMimeType = mimeType.trim().toLowerCase();
    if (!ALLOWED_MIME_TYPES.has(normalizedMimeType)) {
      return new Response(JSON.stringify({ error: 'video_unsupported_mime' }), {
        status: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    if (normalizedFileSizeBytes <= 0 || normalizedFileSizeBytes > MAX_UPLOAD_BYTES) {
      return new Response(JSON.stringify({ error: 'video_too_large', maxBytes: MAX_UPLOAD_BYTES }), {
        status: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    if (conversationId) {
      const { data: conversation, error: conversationError } = await supabase
        .from('conversations')
        .select('id, user_id')
        .eq('id', conversationId)
        .maybeSingle();

      if (conversationError) {
        console.error('[video-intake] conversation lookup failed:', {
          conversationId,
          userId: user.id,
          error: conversationError,
        });
        return new Response(JSON.stringify({ error: 'Failed to validate conversation ownership' }), {
          status: 500,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }

      if (conversation && conversation.user_id !== user.id) {
        return new Response(JSON.stringify({ error: 'Forbidden: Invalid conversation ownership' }), {
          status: 403,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }

      if (!conversation) {
        console.log('[video-intake] New conversation detected, allowing upload for authenticated user', {
          conversationId,
          userId: user.id,
        });
        // Avoid FK failure when conversation row is not created yet.
        conversationIdForAsset = null;
      } else {
        conversationIdForAsset = conversation.id;
      }
    }

    const { count: activeJobCount } = await supabase
      .from('video_jobs')
      .select('id, video_assets!inner(user_id)', { count: 'exact', head: true })
      .in('status', ['queued', 'running'])
      .eq('video_assets.user_id', user.id);

    if ((activeJobCount || 0) >= MAX_ACTIVE_JOBS_PER_USER) {
      return new Response(JSON.stringify({ error: 'video_quota_exceeded' }), {
        status: 429,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    const assetId = crypto.randomUUID();
    const extension = getPathSuffix(fileName, normalizedMimeType);
    const storagePath = `${user.id}/${assetId}/source${extension}`;

    const { error: insertError } = await supabase
      .from('video_assets')
      .insert({
        id: assetId,
        user_id: user.id,
        conversation_id: conversationIdForAsset,
        storage_bucket: VIDEO_UPLOAD_BUCKET,
        storage_path: storagePath,
        mime_type: normalizedMimeType,
        file_size_bytes: Math.floor(normalizedFileSizeBytes),
        status: 'pending_upload',
      });

    if (insertError) {
      console.error('[video-intake] insert asset failed:', insertError);
      return new Response(JSON.stringify({ error: 'Failed to create upload session' }), {
        status: 500,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    const { data: signed, error: signedError } = await supabase.storage
      .from(VIDEO_UPLOAD_BUCKET)
      .createSignedUploadUrl(storagePath);

    if (signedError || !signed?.signedUrl) {
      await supabase.from('video_assets').delete().eq('id', assetId);
      console.error('[video-intake] createSignedUploadUrl failed:', signedError);
      return new Response(JSON.stringify({ error: 'Failed to create signed upload URL' }), {
        status: 500,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

    return new Response(JSON.stringify({
      assetId,
      bucket: VIDEO_UPLOAD_BUCKET,
      path: storagePath,
      signedUploadUrl: signed.signedUrl,
      expiresAt,
    }), {
      status: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const { assetId } = body as CompleteRequestBody;
  if (!assetId) {
    return new Response(JSON.stringify({ error: 'Bad Request: Missing assetId' }), {
      status: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const { data: asset, error: assetError } = await supabase
    .from('video_assets')
    .select('id, user_id, storage_bucket, storage_path, status')
    .eq('id', assetId)
    .maybeSingle();

  if (assetError || !asset || asset.user_id !== user.id) {
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const pathParts = asset.storage_path.split('/');
  const objectName = pathParts[pathParts.length - 1] || '';
  const folderPath = pathParts.slice(0, -1).join('/');
  const { data: objects, error: listError } = await supabase.storage
    .from(asset.storage_bucket)
    .list(folderPath, { limit: 20, search: objectName });

  if (listError) {
    console.error('[video-intake] list storage object failed:', listError);
    return new Response(JSON.stringify({ error: 'Failed to verify uploaded object' }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const objectExists = (objects || []).some((entry) => entry.name === objectName);
  if (!objectExists) {
    return new Response(JSON.stringify({ error: 'Uploaded object not found' }), {
      status: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const { error: updateError } = await supabase
    .from('video_assets')
    .update({ status: 'uploaded', updated_at: new Date().toISOString(), error_code: null, error_message: null })
    .eq('id', assetId)
    .eq('user_id', user.id);

  if (updateError) {
    console.error('[video-intake] update asset failed:', updateError);
    return new Response(JSON.stringify({ error: 'Failed to finalize upload' }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const { error: jobInsertError } = await supabase
    .from('video_jobs')
    .insert({ asset_id: assetId, status: 'queued' });

  if (jobInsertError) {
    console.error('[video-intake] insert job failed:', jobInsertError);
    return new Response(JSON.stringify({ error: 'Failed to enqueue processing job' }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({
    ok: true,
    assetId,
    status: 'uploaded',
    jobStatus: 'queued',
  }), {
    status: 200,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
});
