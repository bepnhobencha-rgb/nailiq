-- Make the owner-facing "cancel to close the incident" promise transactional
-- and remove raw provider errors from execution-control audit payloads.

create or replace function public.control_ai_execution_job(
  p_salon_id uuid,
  p_job_id uuid,
  p_operation text,
  p_actor_user_id uuid default null
)
returns table (
  outcome text,
  job_status text
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_job public.ai_execution_jobs%rowtype;
  v_now timestamptz := statement_timestamp();
begin
  if p_operation not in ('retry', 'cancel') then
    return query select 'invalid_operation'::text, null::text;
    return;
  end if;

  select *
    into v_job
    from public.ai_execution_jobs
   where id = p_job_id
     and salon_id = p_salon_id
   for update;

  if not found then
    return query select 'not_found'::text, null::text;
    return;
  end if;

  if p_operation = 'retry' then
    if v_job.status <> 'failed' or v_job.attempt_count >= v_job.max_attempts then
      return query select 'invalid_state'::text, v_job.status;
      return;
    end if;

    update public.ai_execution_jobs
       set status = 'queued',
           available_at = v_now,
           started_at = null,
           finished_at = null,
           last_error = null,
           updated_at = v_now
     where id = v_job.id;

    insert into public.ai_actions_log (
      salon_id,
      agent,
      action_type,
      target_id,
      payload
    ) values (
      v_job.salon_id,
      'ai_execution',
      'execution_retry_requested',
      v_job.id,
      jsonb_build_object(
        'approval_request_id', v_job.approval_request_id,
        'requested_action_type', v_job.action_type,
        'actor_user_id', p_actor_user_id,
        'previous_status', v_job.status,
        'previous_error_present', v_job.last_error is not null,
        'attempt_count', v_job.attempt_count,
        'max_attempts', v_job.max_attempts
      )
    );

    return query select 'updated'::text, 'queued'::text;
    return;
  end if;

  if v_job.status not in ('queued', 'waiting_input', 'failed') then
    return query select 'invalid_state'::text, v_job.status;
    return;
  end if;

  update public.ai_execution_jobs
     set status = 'canceled',
         finished_at = v_now,
         last_error = null,
         result = coalesce(v_job.result, '{}'::jsonb) || jsonb_build_object(
           'canceled_by', 'owner',
           'canceled_at', v_now
         ),
         updated_at = v_now
   where id = v_job.id;

  insert into public.ai_actions_log (
    salon_id,
    agent,
    action_type,
    target_id,
    payload
  ) values (
    v_job.salon_id,
    'ai_execution',
    'execution_canceled',
    v_job.id,
    jsonb_build_object(
      'approval_request_id', v_job.approval_request_id,
      'requested_action_type', v_job.action_type,
      'actor_user_id', p_actor_user_id,
      'previous_status', v_job.status,
      'previous_error_present', v_job.last_error is not null,
      'attempt_count', v_job.attempt_count
    )
  );

  return query select 'updated'::text, 'canceled'::text;
end;
$$;

revoke all on function public.control_ai_execution_job(uuid, uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.control_ai_execution_job(uuid, uuid, text, uuid)
  to service_role;

comment on function public.control_ai_execution_job(uuid, uuid, text, uuid) is
  'Service-role-only atomic retry/cancel transition with a PII-free ai_actions_log audit row.';

create or replace function public.sync_ai_execution_job_exception()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_alert_id uuid;
  v_now timestamptz := coalesce(new.updated_at, statement_timestamp());
begin
  if new.status = 'failed'
     and new.attempt_count >= new.max_attempts
     and (
       old.status is distinct from new.status
       or old.attempt_count is distinct from new.attempt_count
     ) then
    perform public.record_ai_operational_exception_signal(
      new.salon_id,
      'execution_job:' || new.id::text,
      'ai_execution',
      new.id::text,
      'execution_job_exhausted',
      'critical',
      'AI execution job exhausted its retry limit',
      'An approved internal action could not complete within its bounded retry limit and needs review.',
      'firing',
      jsonb_build_object(
        'execution_job_id', new.id,
        'action_type', new.action_type,
        'attempt_count', new.attempt_count,
        'max_attempts', new.max_attempts,
        'raw_error_stored', false
      ),
      v_now
    );
  elsif new.status = 'succeeded'
        and old.status is distinct from 'succeeded' then
    perform public.record_ai_operational_exception_signal(
      new.salon_id,
      'execution_job:' || new.id::text,
      'ai_execution',
      new.id::text,
      'execution_job_exhausted',
      'critical',
      'AI execution job exhausted its retry limit',
      'A later retry completed successfully.',
      'recovered',
      jsonb_build_object(
        'execution_job_id', new.id,
        'action_type', new.action_type,
        'status', 'succeeded',
        'raw_error_stored', false
      ),
      v_now
    );
  elsif new.status = 'canceled'
        and old.status is distinct from 'canceled' then
    update public.watchdog_alerts
       set status = 'resolved',
           resolved_at = v_now,
           resolved_by = null,
           resolution_note = 'Closed automatically after the owner canceled the execution job.',
           last_seen_at = greatest(last_seen_at, v_now),
           updated_at = greatest(updated_at, v_now)
     where salon_id = new.salon_id
       and dedupe_key = 'execution_job:' || new.id::text
       and status in ('open', 'acknowledged')
    returning id into v_alert_id;

    if v_alert_id is not null then
      insert into public.ai_actions_log (
        salon_id, agent, action_type, target_id, payload, created_at
      ) values (
        new.salon_id,
        'watchdog',
        'operational_exception_auto_resolved',
        v_alert_id,
        jsonb_build_object(
          'source_type', 'ai_execution',
          'source_ref', new.id::text,
          'resolution_reason', 'owner_canceled_execution',
          'new_status', 'resolved'
        ),
        v_now
      );
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.sync_ai_execution_job_exception()
  from public, anon, authenticated;

comment on function public.sync_ai_execution_job_exception()
  is 'Synchronizes exhausted, recovered, and owner-canceled AI execution jobs into the operational exception inbox in the same transaction.';
