-- Initial schema for Prismatix conversations/messages + token counter RPC

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.conversations (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  total_tokens bigint not null default 0,
  created_at timestamptz not null default now()
);

alter table public.conversations
  add column if not exists total_tokens bigint not null default 0;

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  token_count integer not null default 0,
  model_used text,
  image_url text,
  created_at timestamptz not null default now()
);

alter table public.messages
  add column if not exists token_count integer not null default 0,
  add column if not exists model_used text,
  add column if not exists image_url text;

create index if not exists messages_conversation_id_created_at_idx
  on public.messages (conversation_id, created_at desc);

alter table public.conversations enable row level security;
alter table public.messages enable row level security;

drop policy if exists conversations_select_own on public.conversations;
create policy conversations_select_own on public.conversations
  for select
  using (auth.uid() = user_id);

drop policy if exists conversations_insert_own on public.conversations;
create policy conversations_insert_own on public.conversations
  for insert
  with check (auth.uid() = user_id);

drop policy if exists conversations_update_own on public.conversations;
create policy conversations_update_own on public.conversations
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists conversations_delete_own on public.conversations;
create policy conversations_delete_own on public.conversations
  for delete
  using (auth.uid() = user_id);

drop policy if exists messages_select_own on public.messages;
create policy messages_select_own on public.messages
  for select
  using (
    exists (
      select 1
      from public.conversations c
      where c.id = messages.conversation_id
        and c.user_id = auth.uid()
    )
  );

drop policy if exists messages_insert_own on public.messages;
create policy messages_insert_own on public.messages
  for insert
  with check (
    exists (
      select 1
      from public.conversations c
      where c.id = conversation_id
        and c.user_id = auth.uid()
    )
  );

create or replace function public.increment_token_count(p_conversation_id uuid, p_tokens integer)
returns void
language sql
as $$
  update public.conversations
  set total_tokens = total_tokens + greatest(p_tokens, 0)
  where id = p_conversation_id;
$$;

revoke all on function public.increment_token_count(uuid, integer) from public;
grant execute on function public.increment_token_count(uuid, integer) to authenticated;
