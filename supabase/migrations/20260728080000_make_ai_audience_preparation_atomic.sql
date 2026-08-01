-- Persist a prepared AI audience and its audit event as one idempotent
-- transition. This still authorizes no send: the job remains waiting_input.

create or replace function public.record_ai_audience_preparation(
  p_job_id uuid,
  p_salon_id uuid,
  p_summary jsonb,
  p_now timestamptz
)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_job public.ai_execution_jobs%rowtype;
  v_summary jsonb;
  v_fingerprint text;
  v_previous_fingerprint text;
begin
  if jsonb_typeof(p_summary) <> 'object'
     or p_summary ->> 'segment' <> 'lapsed_regulars_45_365_days'
     or p_summary ->> 'no_messages_sent' <> 'true'
     or coalesce(p_summary ->> 'audience_fingerprint', '') !~ '^[0-9a-f]{24}$'
     or coalesce(p_summary ->> 'candidate_count', '') !~ '^[0-9]+$'
     or coalesce(p_summary ->> 'eligible_count', '') !~ '^[0-9]+$'
     or (p_summary ->> 'candidate_count')::integer > 500
     or (p_summary ->> 'eligible_count')::integer > 500
     or (p_summary ->> 'eligible_count')::integer >
        (p_summary ->> 'candidate_count')::integer then
    return 'invalid_summary';
  end if;

  select *
    into v_job
    from public.ai_execution_jobs
   where id = p_job_id
     and salon_id = p_salon_id
     and action_type = 'bulk_message'
     and status = 'waiting_input'
   for update;

  if not found then
    return 'job_not_preparable';
  end if;

  v_fingerprint := p_summary ->> 'audience_fingerprint';
  v_previous_fingerprint :=
    v_job.result -> 'audience_preparation' ->> 'audience_fingerprint';

  -- A double click or overlapping request with the same audience is a no-op.
  -- The row lock makes this deterministic even under concurrency.
  if v_previous_fingerprint = v_fingerprint then
    return 'unchanged';
  end if;

  v_summary := p_summary || jsonb_build_object(
    'prepared_at', p_now,
    'no_messages_sent', true
  );

  update public.ai_execution_jobs
     set result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
           'blocker', 'recipient_selection_required',
           'audience_preparation', v_summary
         ),
         updated_at = p_now
   where id = v_job.id
     and status = 'waiting_input';

  if not found then
    raise exception 'audience_preparation_state_changed'
      using errcode = '40001';
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
    'execution_worker',
    'execution_audience_prepared',
    v_job.id,
    v_summary,
    p_now
  );

  return 'updated';
end;
$$;

revoke all on function public.record_ai_audience_preparation(
  uuid, uuid, jsonb, timestamptz
) from public, anon, authenticated;
grant execute on function public.record_ai_audience_preparation(
  uuid, uuid, jsonb, timestamptz
) to service_role;
