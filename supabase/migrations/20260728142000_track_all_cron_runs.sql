-- Extend the existing fenced scheduler heartbeat and append-only run history
-- from the two AI workers to every Vercel cron entry point.

alter table public.ai_execution_worker_state
  drop constraint if exists ai_execution_worker_state_name_check;
alter table public.ai_execution_worker_state
  add constraint ai_execution_worker_state_name_check
  check (worker_name in (
    'ai_execution',
    'ai_manager',
    'campaign_scheduler',
    'close_stale_in_progress',
    'error_triage',
    'minh_learn',
    'nail_tryon_cleanup',
    'noshow_card_nudge',
    'noshow_charge_retry',
    'reminders',
    'send_pending_notifications',
    'spend_sync',
    'square_email_consent',
    'square_sync',
    'waitlist_advance',
    'wix_sync'
  ));

alter table public.ai_worker_runs
  drop constraint if exists ai_worker_runs_worker_name_check;
alter table public.ai_worker_runs
  add constraint ai_worker_runs_worker_name_check
  check (worker_name in (
    'ai_execution',
    'ai_manager',
    'campaign_scheduler',
    'close_stale_in_progress',
    'error_triage',
    'minh_learn',
    'nail_tryon_cleanup',
    'noshow_card_nudge',
    'noshow_charge_retry',
    'reminders',
    'send_pending_notifications',
    'spend_sync',
    'square_email_consent',
    'square_sync',
    'waitlist_advance',
    'wix_sync'
  ));

create or replace function public.ai_cron_worker_supported(
  p_worker_name text
)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $$
  select p_worker_name = any (array[
    'ai_execution',
    'ai_manager',
    'campaign_scheduler',
    'close_stale_in_progress',
    'error_triage',
    'minh_learn',
    'nail_tryon_cleanup',
    'noshow_card_nudge',
    'noshow_charge_retry',
    'reminders',
    'send_pending_notifications',
    'spend_sync',
    'square_email_consent',
    'square_sync',
    'waitlist_advance',
    'wix_sync'
  ]::text[]);
$$;

create or replace function public.record_ai_worker_heartbeat(
  p_worker_name text,
  p_run_id uuid,
  p_phase text,
  p_now timestamptz,
  p_summary jsonb default '{}'::jsonb,
  p_error text default null
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  history_updated boolean;
  current_updated boolean;
begin
  if not public.ai_cron_worker_supported(p_worker_name) then
    raise exception 'invalid worker name: %', p_worker_name using errcode = '22023';
  end if;
  if p_run_id is null then
    raise exception 'run id is required' using errcode = '22023';
  end if;
  if p_phase not in ('started', 'succeeded', 'failed') then
    raise exception 'invalid heartbeat phase: %', p_phase using errcode = '22023';
  end if;

  if p_phase = 'started' then
    insert into public.ai_worker_runs (
      run_id,
      worker_name,
      status,
      started_at,
      summary,
      updated_at
    ) values (
      p_run_id,
      p_worker_name,
      'running',
      p_now,
      coalesce(p_summary, '{}'::jsonb),
      p_now
    )
    on conflict (run_id) do nothing;

    if not found then
      return false;
    end if;

    insert into public.ai_execution_worker_state (
      worker_name,
      run_id,
      status,
      started_at,
      completed_at,
      last_error,
      summary,
      updated_at
    ) values (
      p_worker_name,
      p_run_id,
      'running',
      p_now,
      null,
      null,
      coalesce(p_summary, '{}'::jsonb),
      p_now
    )
    on conflict (worker_name) do update
      set run_id = excluded.run_id,
          status = excluded.status,
          started_at = excluded.started_at,
          completed_at = null,
          last_error = null,
          summary = excluded.summary,
          updated_at = excluded.updated_at;
    return true;
  end if;

  update public.ai_worker_runs
     set status = p_phase,
         completed_at = p_now,
         error_code = case
           when p_phase = 'failed' and p_error ~ '^[a-z0-9_:-]{1,120}$'
             then p_error
           when p_phase = 'failed' then 'worker_failed'
           else null
         end,
         summary = coalesce(p_summary, '{}'::jsonb),
         updated_at = p_now
   where run_id = p_run_id
     and worker_name = p_worker_name
     and status in ('running', p_phase);
  history_updated := found;

  update public.ai_execution_worker_state
     set status = p_phase,
         completed_at = p_now,
         succeeded_at = case
           when p_phase = 'succeeded' then p_now
           else succeeded_at
         end,
         last_error = case
           when p_phase = 'failed'
             then left(coalesce(p_error, 'worker_failed'), 1000)
           else null
         end,
         summary = coalesce(p_summary, '{}'::jsonb),
         updated_at = p_now
   where worker_name = p_worker_name
     and run_id = p_run_id;
  current_updated := found;

  return history_updated and current_updated;
end;
$$;

revoke all on function public.ai_cron_worker_supported(text)
  from public, anon, authenticated;
grant execute on function public.ai_cron_worker_supported(text)
  to service_role;

revoke all on function public.record_ai_worker_heartbeat(
  text, uuid, text, timestamptz, jsonb, text
) from public, anon, authenticated;
grant execute on function public.record_ai_worker_heartbeat(
  text, uuid, text, timestamptz, jsonb, text
) to service_role;

comment on function public.ai_cron_worker_supported(text) is
  'No-write readiness capability for the fixed NailIQ cron worker allowlist.';
comment on table public.ai_execution_worker_state is
  'Service-role-only fenced last-known state for every NailIQ scheduled HTTP worker. Historical table name is retained non-destructively.';
comment on table public.ai_worker_runs is
  'Append-only run identities and terminal outcomes for every NailIQ scheduled HTTP worker. Service role records runs; operators consume bounded aggregates.';
