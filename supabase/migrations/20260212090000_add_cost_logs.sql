-- Server-backed spend analytics for Prismatix

create table if not exists public.cost_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  conversation_id uuid references public.conversations (id) on delete set null,
  model text not null,
  provider text,
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  thinking_tokens integer not null default 0 check (thinking_tokens >= 0),
  input_cost numeric(12, 6) not null default 0 check (input_cost >= 0),
  output_cost numeric(12, 6) not null default 0 check (output_cost >= 0),
  thinking_cost numeric(12, 6) not null default 0 check (thinking_cost >= 0),
  total_cost numeric(12, 6) not null default 0 check (total_cost >= 0),
  pricing_version text,
  created_at timestamptz not null default now()
);

create index if not exists cost_logs_user_created_idx
  on public.cost_logs (user_id, created_at desc);

create index if not exists cost_logs_conversation_created_idx
  on public.cost_logs (conversation_id, created_at desc);

alter table public.cost_logs enable row level security;

drop policy if exists cost_logs_select_own on public.cost_logs;
create policy cost_logs_select_own on public.cost_logs
  for select
  using (auth.uid() = user_id);

drop policy if exists cost_logs_insert_own on public.cost_logs;
create policy cost_logs_insert_own on public.cost_logs
  for insert
  with check (auth.uid() = user_id);

create or replace function public.get_spend_stats(p_user_id uuid)
returns table(
  today numeric,
  this_week numeric,
  this_month numeric,
  all_time numeric,
  last_message_cost numeric,
  message_count bigint
)
language sql
security definer
set search_path = public
as $$
  with bounds as (
    select
      date_trunc('day', now() at time zone 'utc') as today_start,
      date_trunc('week', now() at time zone 'utc') as week_start,
      date_trunc('month', now() at time zone 'utc') as month_start
  )
  select
    coalesce(sum(c.total_cost) filter (where c.created_at >= b.today_start), 0)::numeric as today,
    coalesce(sum(c.total_cost) filter (where c.created_at >= b.week_start), 0)::numeric as this_week,
    coalesce(sum(c.total_cost) filter (where c.created_at >= b.month_start), 0)::numeric as this_month,
    coalesce(sum(c.total_cost), 0)::numeric as all_time,
    coalesce((
      select c2.total_cost
      from public.cost_logs c2
      where c2.user_id = p_user_id
      order by c2.created_at desc
      limit 1
    ), 0)::numeric as last_message_cost,
    count(c.id)::bigint as message_count
  from bounds b
  left join public.cost_logs c
    on c.user_id = p_user_id;
$$;

revoke all on function public.get_spend_stats(uuid) from public;
grant execute on function public.get_spend_stats(uuid) to authenticated;
