import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-client-info, apikey',
};

interface SpendStatsRow {
  today: number | string | null;
  this_week: number | string | null;
  this_month: number | string | null;
  all_time: number | string | null;
  last_message_cost: number | string | null;
  message_count: number | string | null;
}

function parseBearerToken(authHeader: string | null): string | null {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7).trim();
  return token || null;
}

function toNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
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

  const token = parseBearerToken(req.headers.get('Authorization'));
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

  const { data, error } = await supabase.rpc('get_spend_stats', {
    p_user_id: user.id,
  });

  if (error) {
    console.error('[spend_stats] RPC failed:', error);
    return new Response(JSON.stringify({ error: 'Failed to load spend stats' }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const row = ((Array.isArray(data) ? data[0] : data) || {}) as SpendStatsRow;

  return new Response(
    JSON.stringify({
      today: toNumber(row.today),
      thisWeek: toNumber(row.this_week),
      thisMonth: toNumber(row.this_month),
      allTime: toNumber(row.all_time),
      lastMessageCost: toNumber(row.last_message_cost),
      messageCount: toNumber(row.message_count),
    }),
    {
      status: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    },
  );
});
