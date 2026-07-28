-- Make the first allowlisted execution effect real and atomic: an approved
-- operational note is written exactly once and the leased job succeeds in the
-- same transaction.

create unique index ai_actions_log_execution_effect_once_idx
  on public.ai_actions_log (agent, action_type, target_id)
  where agent = 'ai_execution'
    and action_type = 'approved_operational_note'
    and target_id is not null;

create or replace function public.execute_ai_operational_note(
  p_job_id uuid,
  p_lease_token uuid,
  p_now timestamptz
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_job public.ai_execution_jobs%rowtype;
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
    return false;
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

  return true;
end;
$$;

revoke all on function public.execute_ai_operational_note(
  uuid, uuid, timestamptz
) from public, anon, authenticated;
grant execute on function public.execute_ai_operational_note(
  uuid, uuid, timestamptz
) to service_role;
