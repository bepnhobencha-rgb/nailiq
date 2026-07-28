-- Deterministic, atomic signals turn hard worker/agent failures into durable
-- operational exceptions and close them only after a later successful run.
-- No raw provider error is accepted or stored by these interfaces.

alter table public.watchdog_alerts
  add column if not exists source_type text,
  add column if not exists source_ref text,
  add column if not exists occurrence_count integer,
  add column if not exists first_seen_at timestamptz,
  add column if not exists last_seen_at timestamptz;

update public.watchdog_alerts
   set source_type = coalesce(source_type, 'legacy_watchdog'),
       source_ref = coalesce(source_ref, kind),
       occurrence_count = coalesce(occurrence_count, 1),
       first_seen_at = coalesce(first_seen_at, created_at),
       last_seen_at = coalesce(last_seen_at, updated_at, created_at)
 where source_type is null
    or source_ref is null
    or occurrence_count is null
    or first_seen_at is null
    or last_seen_at is null;

alter table public.watchdog_alerts
  alter column source_type set default 'legacy_watchdog',
  alter column source_type set not null,
  alter column source_ref set default 'unknown',
  alter column source_ref set not null,
  alter column occurrence_count set default 1,
  alter column occurrence_count set not null,
  alter column first_seen_at set default now(),
  alter column first_seen_at set not null,
  alter column last_seen_at set default now(),
  alter column last_seen_at set not null;

alter table public.watchdog_alerts
  add constraint watchdog_alerts_source_type_length_check
    check (char_length(source_type) between 1 and 50),
  add constraint watchdog_alerts_source_ref_length_check
    check (char_length(source_ref) between 1 and 200),
  add constraint watchdog_alerts_occurrence_count_check
    check (occurrence_count between 1 and 1000000),
  add constraint watchdog_alerts_seen_order_check
    check (last_seen_at >= first_seen_at);

create index watchdog_alerts_active_dedupe_idx
  on public.watchdog_alerts (salon_id, dedupe_key, updated_at desc)
  where status in ('open', 'acknowledged')
    and dedupe_key is not null;

create or replace function public.record_ai_operational_exception_signal(
  p_salon_id uuid,
  p_dedupe_key text,
  p_source_type text,
  p_source_ref text,
  p_kind text,
  p_severity text,
  p_title text,
  p_body text,
  p_signal text,
  p_evidence jsonb default '{}'::jsonb,
  p_now timestamptz default statement_timestamp()
)
returns table (
  outcome text,
  alert_id uuid,
  alert_status text
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_alert public.watchdog_alerts%rowtype;
  v_evidence jsonb := coalesce(p_evidence, '{}'::jsonb);
begin
  if p_signal not in ('firing', 'recovered') then
    raise exception 'invalid_operational_exception_signal'
      using errcode = '22023';
  end if;
  if p_severity not in ('info', 'warning', 'critical') then
    raise exception 'invalid_operational_exception_severity'
      using errcode = '22023';
  end if;
  if nullif(btrim(p_dedupe_key), '') is null
     or char_length(p_dedupe_key) > 200
     or nullif(btrim(p_source_type), '') is null
     or char_length(p_source_type) > 50
     or nullif(btrim(p_source_ref), '') is null
     or char_length(p_source_ref) > 200
     or nullif(btrim(p_kind), '') is null
     or char_length(p_kind) > 100
     or nullif(btrim(p_title), '') is null
     or char_length(p_title) > 120
     or (p_body is not null and char_length(p_body) > 400)
     or jsonb_typeof(v_evidence) <> 'object' then
    raise exception 'invalid_operational_exception_payload'
      using errcode = '22023';
  end if;

  -- Serialize signals for the same salon/key without requiring a risky unique
  -- index over legacy rows that may already contain duplicate dedupe keys.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_salon_id::text || ':' || btrim(p_dedupe_key),
      0
    )
  );

  select *
    into v_alert
    from public.watchdog_alerts
   where salon_id = p_salon_id
     and dedupe_key = btrim(p_dedupe_key)
     and status in ('open', 'acknowledged')
   order by updated_at desc, created_at desc
   limit 1
   for update;

  if p_signal = 'recovered' then
    if not found then
      return query select 'unchanged'::text, null::uuid, 'resolved'::text;
      return;
    end if;

    update public.watchdog_alerts
       set status = 'resolved',
           resolved_at = p_now,
           resolved_by = null,
           resolution_note = 'Recovered automatically after a successful run.',
           last_seen_at = greatest(last_seen_at, p_now),
           updated_at = greatest(updated_at, p_now)
     where id = v_alert.id;

    insert into public.ai_actions_log (
      salon_id, agent, action_type, target_id, payload, created_at
    ) values (
      p_salon_id,
      'watchdog',
      'operational_exception_auto_resolved',
      v_alert.id,
      jsonb_build_object(
        'source_type', p_source_type,
        'source_ref', p_source_ref,
        'previous_status', v_alert.status,
        'new_status', 'resolved'
      ),
      p_now
    );

    return query select 'resolved'::text, v_alert.id, 'resolved'::text;
    return;
  end if;

  if found then
    update public.watchdog_alerts
       set severity = p_severity,
           title = btrim(p_title),
           body = nullif(btrim(p_body), ''),
           snapshot = v_evidence,
           source_type = btrim(p_source_type),
           source_ref = btrim(p_source_ref),
           occurrence_count = least(occurrence_count + 1, 1000000),
           last_seen_at = greatest(last_seen_at, p_now),
           updated_at = greatest(updated_at, p_now)
     where id = v_alert.id;

    return query select 'repeated'::text, v_alert.id, v_alert.status;
    return;
  end if;

  insert into public.watchdog_alerts (
    salon_id,
    kind,
    severity,
    title,
    body,
    dedupe_key,
    snapshot,
    status,
    source_type,
    source_ref,
    occurrence_count,
    first_seen_at,
    last_seen_at,
    created_at,
    updated_at
  ) values (
    p_salon_id,
    btrim(p_kind),
    p_severity,
    btrim(p_title),
    nullif(btrim(p_body), ''),
    btrim(p_dedupe_key),
    v_evidence,
    'open',
    btrim(p_source_type),
    btrim(p_source_ref),
    1,
    p_now,
    p_now,
    p_now,
    p_now
  )
  returning * into v_alert;

  insert into public.ai_actions_log (
    salon_id, agent, action_type, target_id, payload, created_at
  ) values (
    p_salon_id,
    'watchdog',
    'operational_exception_auto_opened',
    v_alert.id,
    jsonb_build_object(
      'source_type', p_source_type,
      'source_ref', p_source_ref,
      'severity', p_severity,
      'new_status', 'open'
    ),
    p_now
  );

  return query select 'opened'::text, v_alert.id, 'open'::text;
end;
$$;

create or replace function public.sync_ai_manager_operational_exceptions(
  p_salon_id uuid,
  p_signals jsonb,
  p_now timestamptz default statement_timestamp()
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_item jsonb;
  v_agent text;
  v_status text;
  v_result record;
  v_opened integer := 0;
  v_repeated integer := 0;
  v_resolved integer := 0;
begin
  if jsonb_typeof(p_signals) <> 'array'
     or jsonb_array_length(p_signals) > 50 then
    raise exception 'invalid_ai_manager_exception_signals'
      using errcode = '22023';
  end if;

  for v_item in select value from jsonb_array_elements(p_signals)
  loop
    v_agent := v_item ->> 'agent';
    v_status := v_item ->> 'status';
    if v_agent is null
       or v_agent !~ '^[a-z][a-z0-9_]{0,49}$'
       or v_status not in ('ok', 'failed') then
      raise exception 'invalid_ai_manager_exception_signal_item'
        using errcode = '22023';
    end if;

    select *
      into v_result
      from public.record_ai_operational_exception_signal(
        p_salon_id,
        'manager_agent:' || v_agent,
        'ai_manager',
        v_agent,
        'manager_agent_failure',
        'warning',
        'AI Manager agent needs attention: ' || replace(v_agent, '_', ' '),
        'The latest scheduled run failed. NailIQ will keep the issue visible until a later run succeeds.',
        case when v_status = 'failed' then 'firing' else 'recovered' end,
        jsonb_build_object(
          'agent', v_agent,
          'status', v_status,
          'raw_error_stored', false
        ),
        p_now
      );

    if v_result.outcome = 'opened' then v_opened := v_opened + 1;
    elsif v_result.outcome = 'repeated' then v_repeated := v_repeated + 1;
    elsif v_result.outcome = 'resolved' then v_resolved := v_resolved + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'opened', v_opened,
    'repeated', v_repeated,
    'resolved', v_resolved,
    'processed', jsonb_array_length(p_signals)
  );
end;
$$;

revoke all on function public.record_ai_operational_exception_signal(
  uuid, text, text, text, text, text, text, text, text, jsonb, timestamptz
) from public, anon, authenticated;
grant execute on function public.record_ai_operational_exception_signal(
  uuid, text, text, text, text, text, text, text, text, jsonb, timestamptz
) to service_role;

revoke all on function public.sync_ai_manager_operational_exceptions(
  uuid, jsonb, timestamptz
) from public, anon, authenticated;
grant execute on function public.sync_ai_manager_operational_exceptions(
  uuid, jsonb, timestamptz
) to service_role;

comment on function public.record_ai_operational_exception_signal(
  uuid, text, text, text, text, text, text, text, text, jsonb, timestamptz
) is 'Atomically opens, repeats, or auto-resolves one PII-free operational exception signal. Service role only.';

comment on function public.sync_ai_manager_operational_exceptions(
  uuid, jsonb, timestamptz
) is 'Synchronizes bounded per-agent AI Manager success/failure signals into the operational exception lifecycle. Service role only.';

create or replace function public.sync_ai_execution_job_exception()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
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
      coalesce(new.updated_at, statement_timestamp())
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
      coalesce(new.updated_at, statement_timestamp())
    );
  end if;
  return new;
end;
$$;

drop trigger if exists sync_ai_execution_job_exception_trigger
  on public.ai_execution_jobs;
create trigger sync_ai_execution_job_exception_trigger
  after update of status, attempt_count
  on public.ai_execution_jobs
  for each row
  execute function public.sync_ai_execution_job_exception();

revoke all on function public.sync_ai_execution_job_exception()
  from public, anon, authenticated;

comment on function public.sync_ai_execution_job_exception()
  is 'Synchronizes exhausted and recovered AI execution jobs into the operational exception inbox in the same transaction.';
