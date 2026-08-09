-- One durable review per production deployment. This table is intentionally
-- service-role only: release metadata and operator decisions must not be
-- reachable from salon or anonymous Data API sessions.
create table if not exists public.platform_release_reviews (
  id uuid primary key default gen_random_uuid(),
  deployment_id text not null unique,
  change_summary text not null,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'declined')),
  recipient_email text not null,
  email_attempt_count integer not null default 0
    check (email_attempt_count between 0 and 3),
  email_claimed_at timestamptz,
  email_sent_at timestamptz,
  email_provider_id text,
  email_last_error text,
  decision_by uuid references auth.users(id) on delete restrict,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint platform_release_reviews_decision_check check (
    (status = 'pending' and decision_by is null and decided_at is null)
    or
    (status in ('approved', 'declined') and decision_by is not null and decided_at is not null)
  )
);

create index if not exists platform_release_reviews_pending_idx
  on public.platform_release_reviews (created_at desc)
  where status = 'pending';

create index if not exists platform_release_reviews_decision_by_idx
  on public.platform_release_reviews (decision_by)
  where decision_by is not null;

alter table public.platform_release_reviews enable row level security;

revoke all on table public.platform_release_reviews from anon, authenticated;
grant all on table public.platform_release_reviews to service_role;

create trigger set_platform_release_reviews_updated_at
before update on public.platform_release_reviews
for each row execute function public.set_updated_at();

comment on table public.platform_release_reviews is
  'Durable, service-only release communication review queue. Opening an email link never records a decision.';
comment on column public.platform_release_reviews.deployment_id is
  'Vercel Git commit SHA when available; unique to prevent duplicate review emails.';
comment on column public.platform_release_reviews.email_claimed_at is
  'Short delivery lease. A stale lease may be retried, with a hard three-attempt bound.';

-- Keep the new scheduled sender inside the same fenced heartbeat and history
-- contract as every other production cron route.
alter table public.ai_execution_worker_state
  drop constraint if exists ai_execution_worker_state_name_check;
alter table public.ai_execution_worker_state
  add constraint ai_execution_worker_state_name_check
  check (worker_name in (
    'ai_execution', 'ai_manager', 'campaign_scheduler',
    'close_stale_in_progress', 'error_triage', 'minh_learn',
    'nail_tryon_cleanup', 'noshow_card_nudge', 'noshow_charge_retry',
    'release_review', 'reminders', 'send_pending_notifications', 'spend_sync',
    'square_email_consent', 'square_sync', 'waitlist_advance', 'wix_sync'
  ));

alter table public.ai_worker_runs
  drop constraint if exists ai_worker_runs_worker_name_check;
alter table public.ai_worker_runs
  add constraint ai_worker_runs_worker_name_check
  check (worker_name in (
    'ai_execution', 'ai_manager', 'campaign_scheduler',
    'close_stale_in_progress', 'error_triage', 'minh_learn',
    'nail_tryon_cleanup', 'noshow_card_nudge', 'noshow_charge_retry',
    'release_review', 'reminders', 'send_pending_notifications', 'spend_sync',
    'square_email_consent', 'square_sync', 'waitlist_advance', 'wix_sync'
  ));

create or replace function public.ai_cron_worker_supported(p_worker_name text)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $$
  select p_worker_name = any (array[
    'ai_execution', 'ai_manager', 'campaign_scheduler',
    'close_stale_in_progress', 'error_triage', 'minh_learn',
    'nail_tryon_cleanup', 'noshow_card_nudge', 'noshow_charge_retry',
    'release_review', 'reminders', 'send_pending_notifications', 'spend_sync',
    'square_email_consent', 'square_sync', 'waitlist_advance', 'wix_sync'
  ]::text[]);
$$;

revoke all on function public.ai_cron_worker_supported(text)
  from public, anon, authenticated;
grant execute on function public.ai_cron_worker_supported(text)
  to service_role;
