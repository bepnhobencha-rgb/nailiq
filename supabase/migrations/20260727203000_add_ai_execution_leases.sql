-- Fence execution workers with explicit leases and keep every lifecycle
-- transition atomic with its audit record.

alter table public.ai_execution_jobs
  add column lease_token uuid,
  add column lease_expires_at timestamptz;

create index ai_execution_jobs_running_lease_idx
  on public.ai_execution_jobs (lease_expires_at)
  where status = 'running';

comment on column public.ai_execution_jobs.lease_token is
  'Per-attempt fencing token. A worker may finish only the attempt it claimed.';
comment on column public.ai_execution_jobs.lease_expires_at is
  'After this time another worker may recover and retry the job.';

create or replace function public.recover_stale_ai_execution_jobs(
  p_now timestamptz
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_job public.ai_execution_jobs%rowtype;
  v_recovered integer := 0;
begin
  for v_job in
    update public.ai_execution_jobs
       set status = 'failed',
           available_at = p_now,
           last_error = 'worker_lease_expired',
           finished_at = null,
           lease_token = null,
           lease_expires_at = null,
           updated_at = p_now
     where status = 'running'
       and coalesce(lease_expires_at, started_at + interval '15 minutes') < p_now
    returning *
  loop
    insert into public.ai_actions_log (
      salon_id,
      agent,
      action_type,
      target_id,
      payload
    ) values (
      v_job.salon_id,
      'ai_execution',
      'execution_failed',
      v_job.id,
      jsonb_build_object(
        'approval_request_id', v_job.approval_request_id,
        'requested_action_type', v_job.action_type,
        'error', 'worker_lease_expired',
        'exhausted', v_job.attempt_count >= v_job.max_attempts,
        'attempt_count', v_job.attempt_count
      )
    );
    v_recovered := v_recovered + 1;
  end loop;

  return v_recovered;
end;
$$;

create or replace function public.claim_ai_execution_jobs(
  p_limit integer,
  p_now timestamptz
)
returns setof public.ai_execution_jobs
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_candidate public.ai_execution_jobs%rowtype;
  v_claimed public.ai_execution_jobs%rowtype;
  v_limit integer := greatest(1, least(25, coalesce(p_limit, 10)));
begin
  for v_candidate in
    select *
      from public.ai_execution_jobs
     where status in ('queued', 'failed')
       and available_at <= p_now
       and attempt_count < max_attempts
     order by available_at asc, created_at asc
     for update skip locked
     limit v_limit
  loop
    update public.ai_execution_jobs
       set status = 'running',
           attempt_count = v_candidate.attempt_count + 1,
           started_at = p_now,
           finished_at = null,
           last_error = null,
           lease_token = gen_random_uuid(),
           lease_expires_at = p_now + interval '15 minutes',
           updated_at = p_now
     where id = v_candidate.id
    returning * into v_claimed;

    insert into public.ai_actions_log (
      salon_id,
      agent,
      action_type,
      target_id,
      payload
    ) values (
      v_claimed.salon_id,
      'ai_execution',
      'execution_running',
      v_claimed.id,
      jsonb_build_object(
        'approval_request_id', v_claimed.approval_request_id,
        'requested_action_type', v_claimed.action_type,
        'attempt_count', v_claimed.attempt_count,
        'lease_expires_at', v_claimed.lease_expires_at
      )
    );

    return next v_claimed;
  end loop;
end;
$$;

create or replace function public.finish_ai_execution_job(
  p_job_id uuid,
  p_lease_token uuid,
  p_status text,
  p_result jsonb,
  p_last_error text,
  p_available_at timestamptz,
  p_finished_at timestamptz,
  p_now timestamptz,
  p_details jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_job public.ai_execution_jobs%rowtype;
begin
  if p_status not in ('waiting_input', 'succeeded', 'failed', 'canceled') then
    raise exception 'invalid execution finish status: %', p_status
      using errcode = '22023';
  end if;

  update public.ai_execution_jobs
     set status = p_status,
         result = p_result,
         last_error = p_last_error,
         available_at = coalesce(p_available_at, available_at),
         finished_at = p_finished_at,
         lease_token = null,
         lease_expires_at = null,
         updated_at = p_now
   where id = p_job_id
     and status = 'running'
     and lease_token = p_lease_token
  returning * into v_job;

  if not found then
    return false;
  end if;

  insert into public.ai_actions_log (
    salon_id,
    agent,
    action_type,
    target_id,
    payload
  ) values (
    v_job.salon_id,
    'ai_execution',
    'execution_' || p_status,
    v_job.id,
    jsonb_build_object(
      'approval_request_id', v_job.approval_request_id,
      'requested_action_type', v_job.action_type
    ) || coalesce(p_details, '{}'::jsonb)
  );

  return true;
end;
$$;

revoke all on function public.recover_stale_ai_execution_jobs(timestamptz)
  from public, anon, authenticated;
grant execute on function public.recover_stale_ai_execution_jobs(timestamptz)
  to service_role;

revoke all on function public.claim_ai_execution_jobs(integer, timestamptz)
  from public, anon, authenticated;
grant execute on function public.claim_ai_execution_jobs(integer, timestamptz)
  to service_role;

revoke all on function public.finish_ai_execution_job(
  uuid, uuid, text, jsonb, text, timestamptz, timestamptz, timestamptz, jsonb
) from public, anon, authenticated;
grant execute on function public.finish_ai_execution_job(
  uuid, uuid, text, jsonb, text, timestamptz, timestamptz, timestamptz, jsonb
) to service_role;
