
-- Migration: Add metadata to video_assets for Gemini File API

alter table public.video_assets 
add column if not exists metadata jsonb not null default '{}'::jsonb;
