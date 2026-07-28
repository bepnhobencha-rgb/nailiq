\set ON_ERROR_STOP on

begin;

do $$
declare
  v_run_id uuid := gen_random_uuid();
  v_result boolean;
  v_invalid_rejected boolean := false;
begin
  if not public.ai_cron_worker_supported('reminders') then
    raise exception 'reminders worker capability is missing';
  end if;
  if public.ai_cron_worker_supported('unknown_worker') then
    raise exception 'unknown worker was accepted';
  end if;

  select public.record_ai_worker_heartbeat(
    'reminders',
    v_run_id,
    'started',
    '2026-07-28T14:20:00Z'::timestamptz,
    '{"source":"rehearsal"}'::jsonb,
    null
  ) into v_result;
  if v_result is not true then
    raise exception 'tracked cron start was not recorded';
  end if;

  if not exists (
    select 1
      from public.ai_worker_runs
     where run_id = v_run_id
       and worker_name = 'reminders'
       and status = 'running'
       and completed_at is null
  ) then
    raise exception 'append-only cron run start is missing';
  end if;

  select public.record_ai_worker_heartbeat(
    'reminders',
    v_run_id,
    'failed',
    '2026-07-28T14:20:01Z'::timestamptz,
    '{"http_status":502}'::jsonb,
    'http_502'
  ) into v_result;
  if v_result is not true then
    raise exception 'tracked cron completion was not recorded';
  end if;

  if not exists (
    select 1
      from public.ai_worker_runs
     where run_id = v_run_id
       and status = 'failed'
       and error_code = 'http_502'
       and completed_at = '2026-07-28T14:20:01Z'::timestamptz
  ) then
    raise exception 'bounded terminal run history is missing';
  end if;

  if not exists (
    select 1
      from public.ai_execution_worker_state
     where worker_name = 'reminders'
       and run_id = v_run_id
       and status = 'failed'
       and last_error = 'http_502'
  ) then
    raise exception 'fenced last-known cron state is missing';
  end if;

  begin
    perform public.record_ai_worker_heartbeat(
      'unknown_worker',
      gen_random_uuid(),
      'started',
      now(),
      '{}'::jsonb,
      null
    );
  exception
    when sqlstate '22023' then
      v_invalid_rejected := true;
  end;
  if not v_invalid_rejected then
    raise exception 'unknown worker writer call was not rejected';
  end if;
end;
$$;

rollback;
