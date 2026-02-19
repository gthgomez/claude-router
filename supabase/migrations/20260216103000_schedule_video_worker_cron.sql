-- Schedule video-worker every minute using pg_cron + pg_net
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM cron.job
    WHERE jobname = 'video_worker_every_minute'
  ) THEN
    PERFORM cron.unschedule('video_worker_every_minute');
  END IF;
END $$;

select cron.schedule(
  'video_worker_every_minute',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://sqjfbqjogylkfwzsyprd.supabase.co/functions/v1/video-worker',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);