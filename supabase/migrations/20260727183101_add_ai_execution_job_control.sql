-- Atomically retry or cancel an AI execution job and record the owner action.
-- The function is service-role only. The Next.js server action authenticates
-- the owner/admin and supplies the already-resolved salon id.

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
        'previous_error', v_job.last_error,
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
      'previous_error', v_job.last_error,
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
  'Service-role-only atomic retry/cancel transition with an ai_actions_log audit row.';
