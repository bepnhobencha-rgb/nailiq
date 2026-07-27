-- Persist an owner decision, create its execution job, and write the audit row
-- in one transaction. This closes the split-brain state where an approval can
-- be marked approved while queue insertion fails.

create or replace function public.decide_ai_approval_request(
  p_token text,
  p_decision text
)
returns table (
  outcome text,
  approval_id uuid,
  salon_id uuid,
  action_type text,
  decision_status text,
  execution_job_id uuid,
  execution_status text,
  decided_at timestamptz
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_request public.approval_requests%rowtype;
  v_job public.ai_execution_jobs%rowtype;
  v_now timestamptz := statement_timestamp();
  v_initial_status text;
begin
  if p_decision not in ('approved', 'declined') then
    return query
      select 'invalid_decision'::text, null::uuid, null::uuid, null::text,
             null::text, null::uuid, null::text, null::timestamptz;
    return;
  end if;

  select *
    into v_request
    from public.approval_requests ar
   where (
     p_decision = 'approved'
     and ar.approve_token = p_token
   ) or (
     p_decision = 'declined'
     and ar.decline_token = p_token
   )
   for update;

  if not found then
    return query
      select 'not_found'::text, null::uuid, null::uuid, null::text,
             null::text, null::uuid, null::text, null::timestamptz;
    return;
  end if;

  if v_request.status = 'pending' and v_request.expires_at < v_now then
    update public.approval_requests
       set status = 'expired'
     where id = v_request.id;

    return query
      select 'expired'::text, v_request.id, v_request.salon_id,
             v_request.action_type, 'expired'::text, null::uuid, null::text,
             null::timestamptz;
    return;
  end if;

  if v_request.status = 'pending' then
    update public.approval_requests
       set status = p_decision,
           decided_at = v_now
     where id = v_request.id;

    if p_decision = 'declined' then
      insert into public.ai_actions_log (
        salon_id,
        agent,
        action_type,
        target_id,
        payload
      ) values (
        v_request.salon_id,
        'ai_approval',
        'approval_declined',
        v_request.id,
        jsonb_build_object(
          'approval_request_id', v_request.id,
          'requested_action_type', v_request.action_type
        )
      );

      return query
        select 'declined'::text, v_request.id, v_request.salon_id,
               v_request.action_type, 'declined'::text, null::uuid, null::text,
               v_now;
      return;
    end if;

    v_initial_status := case
      when v_request.payload ->> 'recipient_selection_required' = 'true'
        then 'waiting_input'
      else 'queued'
    end;

    insert into public.ai_execution_jobs (
      salon_id,
      approval_request_id,
      action_type,
      payload,
      status,
      idempotency_key,
      result,
      updated_at
    ) values (
      v_request.salon_id,
      v_request.id,
      v_request.action_type,
      v_request.payload,
      v_initial_status,
      'approval:' || v_request.id::text,
      case
        when v_initial_status = 'waiting_input'
          then jsonb_build_object('blocker', 'recipient_selection_required')
        else null
      end,
      v_now
    )
    returning * into v_job;

    insert into public.ai_actions_log (
      salon_id,
      agent,
      action_type,
      target_id,
      payload
    ) values (
      v_request.salon_id,
      'ai_approval',
      'approval_approved_queued',
      v_request.id,
      jsonb_build_object(
        'approval_request_id', v_request.id,
        'execution_job_id', v_job.id,
        'execution_status', v_job.status,
        'requested_action_type', v_request.action_type
      )
    );

    return query
      select 'approved_queued'::text, v_request.id, v_request.salon_id,
             v_request.action_type, 'approved'::text, v_job.id, v_job.status,
             v_now;
    return;
  end if;

  -- A previously approved row may predate this atomic function. Reconcile a
  -- missing job idempotently when its approve link is revisited.
  if v_request.status = 'approved' and p_decision = 'approved' then
    select *
      into v_job
      from public.ai_execution_jobs
     where approval_request_id = v_request.id;

    if not found then
      v_initial_status := case
        when v_request.payload ->> 'recipient_selection_required' = 'true'
          then 'waiting_input'
        else 'queued'
      end;

      insert into public.ai_execution_jobs (
        salon_id,
        approval_request_id,
        action_type,
        payload,
        status,
        idempotency_key,
        result,
        updated_at
      ) values (
        v_request.salon_id,
        v_request.id,
        v_request.action_type,
        v_request.payload,
        v_initial_status,
        'approval:' || v_request.id::text,
        case
          when v_initial_status = 'waiting_input'
            then jsonb_build_object('blocker', 'recipient_selection_required')
          else null
        end,
        v_now
      )
      on conflict (approval_request_id) do nothing
      returning * into v_job;

      if v_job.id is null then
        select *
          into v_job
          from public.ai_execution_jobs
         where approval_request_id = v_request.id;
      else
        insert into public.ai_actions_log (
          salon_id,
          agent,
          action_type,
          target_id,
          payload
        ) values (
          v_request.salon_id,
          'ai_approval',
          'approval_execution_recovered',
          v_request.id,
          jsonb_build_object(
            'approval_request_id', v_request.id,
            'execution_job_id', v_job.id,
            'execution_status', v_job.status,
            'requested_action_type', v_request.action_type
          )
        );

        return query
          select 'approved_recovered'::text, v_request.id, v_request.salon_id,
                 v_request.action_type, 'approved'::text, v_job.id,
                 v_job.status, v_request.decided_at;
        return;
      end if;
    end if;

    return query
      select 'already_decided'::text, v_request.id, v_request.salon_id,
             v_request.action_type, v_request.status, v_job.id, v_job.status,
             v_request.decided_at;
    return;
  end if;

  return query
    select 'already_decided'::text, v_request.id, v_request.salon_id,
           v_request.action_type, v_request.status, null::uuid, null::text,
           v_request.decided_at;
end;
$$;

revoke all on function public.decide_ai_approval_request(text, text)
  from public, anon, authenticated;
grant execute on function public.decide_ai_approval_request(text, text)
  to service_role;

comment on function public.decide_ai_approval_request(text, text) is
  'Service-role-only atomic approval decision, execution enqueue, and audit transition.';
