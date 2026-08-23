-- Keep the database heartbeat fence aligned with the two payment cron routes
-- already represented by the application-level CronWorkerName union. This is
-- an allowlist expansion only: existing worker names and privileges remain.
--
-- Build and validate each strict-superset check before retiring its predecessor.
-- NOT VALID separates the table scan from initial constraint installation;
-- the expanded check still protects every new or changed row before validation.

alter table public.ai_execution_worker_state
  add constraint ai_execution_worker_state_name_check_expanded
  check (worker_name in (
    'ai_execution', 'ai_manager', 'campaign_scheduler',
    'close_stale_in_progress', 'deposit_compensation', 'error_triage',
    'minh_learn', 'nail_tryon_cleanup', 'noshow_card_nudge',
    'noshow_charge_retry', 'payment_reconciliation', 'release_review',
    'reminders', 'send_pending_notifications', 'spend_sync',
    'square_email_consent', 'square_sync', 'tenant_payment_pause',
    'waitlist_advance', 'wix_sync'
  )) not valid;
alter table public.ai_execution_worker_state
  validate constraint ai_execution_worker_state_name_check_expanded;
alter table public.ai_execution_worker_state
  drop constraint if exists ai_execution_worker_state_name_check;
alter table public.ai_execution_worker_state
  rename constraint ai_execution_worker_state_name_check_expanded
  to ai_execution_worker_state_name_check;

alter table public.ai_worker_runs
  add constraint ai_worker_runs_worker_name_check_expanded
  check (worker_name in (
    'ai_execution', 'ai_manager', 'campaign_scheduler',
    'close_stale_in_progress', 'deposit_compensation', 'error_triage',
    'minh_learn', 'nail_tryon_cleanup', 'noshow_card_nudge',
    'noshow_charge_retry', 'payment_reconciliation', 'release_review',
    'reminders', 'send_pending_notifications', 'spend_sync',
    'square_email_consent', 'square_sync', 'tenant_payment_pause',
    'waitlist_advance', 'wix_sync'
  )) not valid;
alter table public.ai_worker_runs
  validate constraint ai_worker_runs_worker_name_check_expanded;
alter table public.ai_worker_runs
  drop constraint if exists ai_worker_runs_worker_name_check;
alter table public.ai_worker_runs
  rename constraint ai_worker_runs_worker_name_check_expanded
  to ai_worker_runs_worker_name_check;

create or replace function public.ai_cron_worker_supported(p_worker_name text)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $$
  select p_worker_name = any (array[
    'ai_execution', 'ai_manager', 'campaign_scheduler',
    'close_stale_in_progress', 'deposit_compensation', 'error_triage',
    'minh_learn', 'nail_tryon_cleanup', 'noshow_card_nudge',
    'noshow_charge_retry', 'payment_reconciliation', 'release_review',
    'reminders', 'send_pending_notifications', 'spend_sync',
    'square_email_consent', 'square_sync', 'tenant_payment_pause',
    'waitlist_advance', 'wix_sync'
  ]::text[]);
$$;

revoke all on function public.ai_cron_worker_supported(text)
  from public, anon, authenticated;
grant execute on function public.ai_cron_worker_supported(text)
  to service_role;

comment on function public.ai_cron_worker_supported(text) is
  'No-write readiness capability for the fixed NailIQ cron worker allowlist.';
