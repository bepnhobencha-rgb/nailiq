\set ON_ERROR_STOP on

begin;

do $$
declare
  v_now timestamptz := '2026-07-28 13:05:00+00';
  v_active_salon uuid := '10000000-0000-4000-8000-000000000001';
  v_canceled_salon uuid := '10000000-0000-4000-8000-000000000002';
  v_active_approval uuid := '20000000-0000-4000-8000-000000000001';
  v_canceled_approval uuid := '20000000-0000-4000-8000-000000000002';
  v_active_job uuid := '30000000-0000-4000-8000-000000000001';
  v_canceled_job uuid := '30000000-0000-4000-8000-000000000002';
  v_claimed public.ai_execution_jobs%rowtype;
  v_count integer;
  v_outcome text;
begin
  insert into public.salons (
    id, slug, name, phone, subscription_status
  ) values
    (v_active_salon, 'tenant-fence-active', 'Tenant Fence Active', '+15555550101', 'active'),
    (v_canceled_salon, 'tenant-fence-canceled', 'Tenant Fence Canceled', '+15555550102', 'canceled');

  insert into public.approval_requests (
    id, salon_id, action_type, summary, status, expires_at
  ) values
    (
      v_active_approval,
      v_active_salon,
      'record_operational_note',
      'Rehearse active tenant',
      'approved',
      v_now + interval '1 day'
    ),
    (
      v_canceled_approval,
      v_canceled_salon,
      'record_operational_note',
      'Rehearse canceled tenant',
      'approved',
      v_now + interval '1 day'
    );

  insert into public.ai_execution_jobs (
    id,
    salon_id,
    approval_request_id,
    action_type,
    payload,
    status,
    idempotency_key,
    available_at
  ) values
    (
      v_active_job,
      v_active_salon,
      v_active_approval,
      'record_operational_note',
      '{"note":"Active tenant rehearsal"}'::jsonb,
      'queued',
      'tenant-fence:active',
      v_now
    ),
    (
      v_canceled_job,
      v_canceled_salon,
      v_canceled_approval,
      'record_operational_note',
      '{"note":"Must never execute"}'::jsonb,
      'queued',
      'tenant-fence:canceled',
      v_now
    );

  select public.cancel_ineligible_ai_execution_jobs(v_now)
    into v_count;
  if v_count <> 1 then
    raise exception 'expected one ineligible job cancellation, got %', v_count;
  end if;

  if not exists (
    select 1
      from public.ai_execution_jobs
     where id = v_canceled_job
       and status = 'canceled'
       and last_error = 'tenant_not_operational'
  ) then
    raise exception 'ineligible queued job was not canceled truthfully';
  end if;

  if not exists (
    select 1
      from public.ai_actions_log
     where salon_id = v_canceled_salon
       and target_id = v_canceled_job
       and action_type = 'execution_canceled'
       and payload->>'reason' = 'tenant_not_operational'
  ) then
    raise exception 'ineligible queued job cancellation was not audited';
  end if;

  select *
    into v_claimed
    from public.claim_ai_execution_jobs(10, v_now);
  if not found or v_claimed.id <> v_active_job then
    raise exception 'claim did not return only the operational tenant job';
  end if;

  update public.salons
     set subscription_status = 'canceled'
   where id = v_active_salon;

  select public.execute_ai_operational_note_v2(
    v_active_job,
    v_claimed.lease_token,
    v_now + interval '1 minute'
  ) into v_outcome;
  if v_outcome <> 'canceled' then
    raise exception 'post-claim tenant transition returned %, expected canceled', v_outcome;
  end if;

  if exists (
    select 1
      from public.ai_actions_log
     where target_id = v_active_job
       and action_type = 'approved_operational_note'
  ) then
    raise exception 'effect committed after tenant became ineligible';
  end if;
end;
$$;

rollback;
