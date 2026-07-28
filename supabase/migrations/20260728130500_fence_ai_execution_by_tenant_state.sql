-- Keep durable AI execution subordinate to the salon control plane.
-- Jobs for archived, superadmin-locked, canceled, or unknown tenants are
-- canceled with an audit record instead of being executed or left pending.

create or replace function public.ai_tenant_allows_autonomous_execution(
  p_salon_id uuid
)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce((
    select s.archived_at is null
       and s.superadmin_locked_at is null
       and s.subscription_status in ('active', 'trialing', 'past_due')
      from public.salons s
     where s.id = p_salon_id
  ), false);
$$;

create or replace function public.cancel_ineligible_ai_execution_jobs(
  p_now timestamptz
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_job public.ai_execution_jobs%rowtype;
  v_canceled integer := 0;
begin
  for v_job in
    update public.ai_execution_jobs j
       set status = 'canceled',
           last_error = 'tenant_not_operational',
           finished_at = p_now,
           lease_token = null,
           lease_expires_at = null,
           updated_at = p_now
     where j.status in ('queued', 'failed', 'waiting_input')
       and not public.ai_tenant_allows_autonomous_execution(j.salon_id)
    returning j.*
  loop
    insert into public.ai_actions_log (
      salon_id,
      agent,
      action_type,
      target_id,
      payload,
      created_at
    ) values (
      v_job.salon_id,
      'ai_execution',
      'execution_canceled',
      v_job.id,
      jsonb_build_object(
        'approval_request_id', v_job.approval_request_id,
        'requested_action_type', v_job.action_type,
        'reason', 'tenant_not_operational'
      ),
      p_now
    );
    v_canceled := v_canceled + 1;
  end loop;

  return v_canceled;
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
    select j.*
      from public.ai_execution_jobs j
     where j.status in ('queued', 'failed')
       and j.available_at <= p_now
       and j.attempt_count < j.max_attempts
       and public.ai_tenant_allows_autonomous_execution(j.salon_id)
     order by j.available_at asc, j.created_at asc
     for update of j skip locked
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

create function public.execute_ai_operational_note_v2(
  p_job_id uuid,
  p_lease_token uuid,
  p_now timestamptz
)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_job public.ai_execution_jobs%rowtype;
  v_tenant_operational boolean;
  v_note text;
  v_result jsonb;
begin
  select *
    into v_job
    from public.ai_execution_jobs
   where id = p_job_id
     and status = 'running'
     and lease_token = p_lease_token
     and action_type = 'record_operational_note'
   for update;

  if not found then
    return 'stale';
  end if;

  select s.archived_at is null
     and s.superadmin_locked_at is null
     and s.subscription_status in ('active', 'trialing', 'past_due')
    into v_tenant_operational
    from public.salons s
   where s.id = v_job.salon_id
   for share;

  if not coalesce(v_tenant_operational, false) then
    update public.ai_execution_jobs
       set status = 'canceled',
           last_error = 'tenant_not_operational',
           finished_at = p_now,
           lease_token = null,
           lease_expires_at = null,
           updated_at = p_now
     where id = v_job.id
       and status = 'running'
       and lease_token = p_lease_token;

    if not found then
      return 'stale';
    end if;

    insert into public.ai_actions_log (
      salon_id,
      agent,
      action_type,
      target_id,
      payload,
      created_at
    ) values (
      v_job.salon_id,
      'ai_execution',
      'execution_canceled',
      v_job.id,
      jsonb_build_object(
        'approval_request_id', v_job.approval_request_id,
        'requested_action_type', v_job.action_type,
        'reason', 'tenant_not_operational'
      ),
      p_now
    );

    return 'canceled';
  end if;

  v_note := nullif(btrim(v_job.payload->>'note'), '');
  if v_note is null or length(v_note) > 1000 then
    raise exception 'invalid_operational_note' using errcode = '22023';
  end if;

  v_result := jsonb_build_object(
    'effect', 'internal_audit',
    'audit_action_type', 'approved_operational_note',
    'execution_job_id', v_job.id,
    'approval_request_id', v_job.approval_request_id,
    'note', v_note
  );

  insert into public.ai_actions_log (
    salon_id,
    agent,
    action_type,
    target_id,
    payload,
    created_at
  ) values (
    v_job.salon_id,
    'ai_execution',
    'approved_operational_note',
    v_job.id,
    jsonb_build_object(
      'execution_job_id', v_job.id,
      'approval_request_id', v_job.approval_request_id,
      'note', v_note
    ),
    p_now
  )
  on conflict (agent, action_type, target_id)
    where agent = 'ai_execution'
      and action_type = 'approved_operational_note'
      and target_id is not null
    do nothing;

  update public.ai_execution_jobs
     set status = 'succeeded',
         result = v_result,
         last_error = null,
         finished_at = p_now,
         lease_token = null,
         lease_expires_at = null,
         updated_at = p_now
   where id = v_job.id
     and status = 'running'
     and lease_token = p_lease_token;

  if not found then
    raise exception 'stale_execution_lease' using errcode = '40001';
  end if;

  insert into public.ai_actions_log (
    salon_id,
    agent,
    action_type,
    target_id,
    payload,
    created_at
  ) values (
    v_job.salon_id,
    'ai_execution',
    'execution_succeeded',
    v_job.id,
    jsonb_build_object(
      'approval_request_id', v_job.approval_request_id,
      'requested_action_type', v_job.action_type,
      'effect', 'internal_audit',
      'audit_action_type', 'approved_operational_note',
      'execution_job_id', v_job.id
    ),
    p_now
  );

  return 'succeeded';
end;
$$;

revoke all on function public.ai_tenant_allows_autonomous_execution(uuid)
  from public, anon, authenticated;
grant execute on function public.ai_tenant_allows_autonomous_execution(uuid)
  to service_role;

revoke all on function public.cancel_ineligible_ai_execution_jobs(timestamptz)
  from public, anon, authenticated;
grant execute on function public.cancel_ineligible_ai_execution_jobs(timestamptz)
  to service_role;

revoke all on function public.execute_ai_operational_note(
  uuid, uuid, timestamptz
) from service_role;

revoke all on function public.execute_ai_operational_note_v2(
  uuid, uuid, timestamptz
) from public, anon, authenticated;
grant execute on function public.execute_ai_operational_note_v2(
  uuid, uuid, timestamptz
) to service_role;
