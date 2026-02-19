-- Video pipeline foundation: schema, RLS, and storage buckets

create extension if not exists pgcrypto with schema extensions;

-- Enums
DO $$ BEGIN
  CREATE TYPE public.video_asset_status AS ENUM (
    'pending_upload',
    'uploaded',
    'processing',
    'ready',
    'failed',
    'expired'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE public.video_job_status AS ENUM (
    'queued',
    'running',
    'succeeded',
    'failed'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE public.video_artifact_kind AS ENUM (
    'thumbnail',
    'frame',
    'transcript',
    'summary'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Shared updated_at trigger
create or replace function public.set_updated_at_timestamp()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Core tables
create table if not exists public.video_assets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid null references public.conversations(id) on delete set null,
  storage_bucket text not null default 'video-uploads',
  storage_path text not null,
  mime_type text not null,
  file_size_bytes bigint not null check (file_size_bytes > 0),
  duration_ms integer null,
  width integer null,
  height integer null,
  status public.video_asset_status not null default 'pending_upload',
  checksum_sha256 text null,
  error_code text null,
  error_message text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (storage_bucket, storage_path)
);

create table if not exists public.video_jobs (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.video_assets(id) on delete cascade,
  status public.video_job_status not null default 'queued',
  attempt integer not null default 0 check (attempt >= 0),
  started_at timestamptz null,
  finished_at timestamptz null,
  error_code text null,
  error_message text null,
  created_at timestamptz not null default now()
);

create table if not exists public.video_artifacts (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.video_assets(id) on delete cascade,
  kind public.video_artifact_kind not null,
  seq integer null,
  storage_bucket text null,
  storage_path text null,
  text_content text null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists video_assets_user_created_idx
  on public.video_assets (user_id, created_at desc);

create index if not exists video_assets_user_status_idx
  on public.video_assets (user_id, status);

create index if not exists video_assets_conversation_idx
  on public.video_assets (conversation_id, created_at desc);

create index if not exists video_jobs_asset_status_idx
  on public.video_jobs (asset_id, status, created_at desc);

create index if not exists video_jobs_status_created_idx
  on public.video_jobs (status, created_at asc);

create index if not exists video_artifacts_asset_kind_seq_idx
  on public.video_artifacts (asset_id, kind, seq nulls first, created_at asc);

-- updated_at trigger for video_assets
DROP TRIGGER IF EXISTS trg_video_assets_updated_at ON public.video_assets;
CREATE TRIGGER trg_video_assets_updated_at
BEFORE UPDATE ON public.video_assets
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at_timestamp();

-- RLS
alter table public.video_assets enable row level security;
alter table public.video_jobs enable row level security;
alter table public.video_artifacts enable row level security;

drop policy if exists video_assets_select_own on public.video_assets;
create policy video_assets_select_own on public.video_assets
  for select
  using (auth.uid() = user_id);

drop policy if exists video_assets_insert_own on public.video_assets;
create policy video_assets_insert_own on public.video_assets
  for insert
  with check (auth.uid() = user_id);

drop policy if exists video_assets_update_own on public.video_assets;
create policy video_assets_update_own on public.video_assets
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists video_assets_delete_own on public.video_assets;
create policy video_assets_delete_own on public.video_assets
  for delete
  using (auth.uid() = user_id);

drop policy if exists video_jobs_select_own on public.video_jobs;
create policy video_jobs_select_own on public.video_jobs
  for select
  using (
    exists (
      select 1
      from public.video_assets va
      where va.id = video_jobs.asset_id
        and va.user_id = auth.uid()
    )
  );

drop policy if exists video_jobs_insert_own on public.video_jobs;
create policy video_jobs_insert_own on public.video_jobs
  for insert
  with check (
    exists (
      select 1
      from public.video_assets va
      where va.id = video_jobs.asset_id
        and va.user_id = auth.uid()
    )
  );

drop policy if exists video_artifacts_select_own on public.video_artifacts;
create policy video_artifacts_select_own on public.video_artifacts
  for select
  using (
    exists (
      select 1
      from public.video_assets va
      where va.id = video_artifacts.asset_id
        and va.user_id = auth.uid()
    )
  );

-- Private storage buckets used by video pipeline.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  (
    'video-uploads',
    'video-uploads',
    false,
    104857600,
    array['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska', 'video/x-msvideo']
  ),
  (
    'video-artifacts',
    'video-artifacts',
    false,
    20971520,
    array['image/jpeg', 'image/png', 'text/plain', 'application/json']
  )
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;