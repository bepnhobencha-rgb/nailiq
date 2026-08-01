\set ON_ERROR_STOP on

begin;

insert into public.salons (id, slug, name, phone)
values (
  '10000000-0000-4000-8000-000000000001',
  'source-owned-exception-rehearsal',
  'Source-owned exception rehearsal',
  '+16045550199'
);

insert into public.watchdog_alerts (
  id,
  salon_id,
  kind,
  severity,
  title,
  status,
  source_type,
  source_ref,
  occurrence_count,
  first_seen_at,
  last_seen_at,
  resolved_at,
  created_at,
  updated_at
) values
  (
    '20000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'execution_failure',
    'warning',
    'Execution still failing',
    'open',
    'ai_execution',
    '30000000-0000-4000-8000-000000000001',
    1,
    statement_timestamp(),
    statement_timestamp(),
    null,
    statement_timestamp(),
    statement_timestamp()
  ),
  (
    '20000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000001',
    'manager_failure',
    'warning',
    'Manager recovered previously',
    'resolved',
    'ai_manager',
    'winback',
    1,
    statement_timestamp(),
    statement_timestamp(),
    statement_timestamp(),
    statement_timestamp(),
    statement_timestamp()
  );

do $$
declare
  v_outcome text;
  v_status text;
begin
  select outcome, alert_status
    into v_outcome, v_status
    from public.control_watchdog_alert(
      '10000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000001',
      'resolve',
      '40000000-0000-4000-8000-000000000001',
      'Should not be accepted'
    );

  if v_outcome <> 'invalid_state' or v_status <> 'open' then
    raise exception 'source-owned resolve was not rejected: %, %',
      v_outcome, v_status;
  end if;

  select outcome, alert_status
    into v_outcome, v_status
    from public.control_watchdog_alert(
      '10000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000002',
      'reopen',
      '40000000-0000-4000-8000-000000000001',
      null
    );

  if v_outcome <> 'invalid_state' or v_status <> 'resolved' then
    raise exception 'source-owned reopen was not rejected: %, %',
      v_outcome, v_status;
  end if;

  if (
    select status
    from public.watchdog_alerts
    where id = '20000000-0000-4000-8000-000000000001'
  ) <> 'open' then
    raise exception 'source-owned resolve mutated the open row';
  end if;

  if (
    select count(*)
    from public.ai_actions_log
    where target_id in (
      '20000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000002'
    )
  ) <> 0 then
    raise exception 'rejected source-owned transition wrote an audit claim';
  end if;
end;
$$;

do $$
begin
  if has_function_privilege(
    'anon',
    'public.control_watchdog_alert(uuid,uuid,text,uuid,text)',
    'EXECUTE'
  ) then
    raise exception 'anon can execute control_watchdog_alert';
  end if;

  if has_function_privilege(
    'authenticated',
    'public.control_watchdog_alert(uuid,uuid,text,uuid,text)',
    'EXECUTE'
  ) then
    raise exception 'authenticated can execute control_watchdog_alert';
  end if;
end;
$$;

rollback;
