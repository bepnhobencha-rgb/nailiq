-- Machine-signaled operational exceptions own their recovery lifecycle.
-- Owners may acknowledge them, but only a recovered source signal may resolve
-- them. This prevents the inbox from claiming recovery while the underlying
-- execution job, manager agent, or readiness check is still failing.

create or replace function public.control_watchdog_alert(
  p_salon_id uuid,
  p_alert_id uuid,
  p_operation text,
  p_actor_user_id uuid,
  p_resolution_note text default null
)
returns table (
  outcome text,
  alert_status text
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_alert public.watchdog_alerts%rowtype;
  v_now timestamptz := statement_timestamp();
  v_note text := nullif(btrim(p_resolution_note), '');
  v_action_type text;
begin
  if p_operation not in ('acknowledge', 'resolve', 'reopen') then
    raise exception 'invalid_watchdog_alert_operation'
      using errcode = '22023';
  end if;

  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'watchdog_alert_resolution_note_too_long'
      using errcode = '22001';
  end if;

  select *
    into v_alert
    from public.watchdog_alerts
   where id = p_alert_id
     and salon_id = p_salon_id
   for update;

  if not found then
    return query select 'not_found'::text, null::text;
    return;
  end if;

  if v_alert.source_type in ('ai_execution', 'ai_manager', 'readiness')
     and p_operation in ('resolve', 'reopen') then
    return query select 'invalid_state'::text, v_alert.status;
    return;
  end if;

  if (p_operation = 'acknowledge' and v_alert.status = 'acknowledged')
     or (p_operation = 'resolve' and v_alert.status = 'resolved')
     or (p_operation = 'reopen' and v_alert.status = 'open') then
    return query select 'unchanged'::text, v_alert.status;
    return;
  end if;

  if p_operation = 'acknowledge' and v_alert.status <> 'open' then
    return query select 'invalid_state'::text, v_alert.status;
    return;
  end if;

  if p_operation = 'reopen' and v_alert.status <> 'resolved' then
    return query select 'invalid_state'::text, v_alert.status;
    return;
  end if;

  if p_operation = 'acknowledge' then
    update public.watchdog_alerts
       set status = 'acknowledged',
           acknowledged_at = v_now,
           acknowledged_by = p_actor_user_id,
           updated_at = v_now
     where id = p_alert_id;
    v_action_type := 'operational_exception_acknowledged';
  elsif p_operation = 'resolve' then
    update public.watchdog_alerts
       set status = 'resolved',
           acknowledged_at = coalesce(acknowledged_at, v_now),
           acknowledged_by = coalesce(acknowledged_by, p_actor_user_id),
           resolved_at = v_now,
           resolved_by = p_actor_user_id,
           resolution_note = v_note,
           updated_at = v_now
     where id = p_alert_id;
    v_action_type := 'operational_exception_resolved';
  else
    update public.watchdog_alerts
       set status = 'open',
           acknowledged_at = null,
           acknowledged_by = null,
           resolved_at = null,
           resolved_by = null,
           resolution_note = null,
           updated_at = v_now
     where id = p_alert_id;
    v_action_type := 'operational_exception_reopened';
  end if;

  insert into public.ai_actions_log (
    salon_id,
    agent,
    action_type,
    target_id,
    payload,
    created_at
  ) values (
    p_salon_id,
    'watchdog',
    v_action_type,
    p_alert_id,
    jsonb_build_object(
      'actor_user_id', p_actor_user_id,
      'previous_status', v_alert.status,
      'new_status', case p_operation
        when 'acknowledge' then 'acknowledged'
        when 'resolve' then 'resolved'
        else 'open'
      end,
      'has_resolution_note', v_note is not null
    ),
    v_now
  );

  return query
    select
      'updated'::text,
      case p_operation
        when 'acknowledge' then 'acknowledged'
        when 'resolve' then 'resolved'
        else 'open'
      end;
end;
$$;

revoke all on function public.control_watchdog_alert(uuid, uuid, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.control_watchdog_alert(uuid, uuid, text, uuid, text)
  to service_role;

comment on function public.control_watchdog_alert(uuid, uuid, text, uuid, text)
  is 'Atomically controls manual exception lifecycle while reserving resolve/reopen for source-owned AI and readiness signals. Service role only.';
