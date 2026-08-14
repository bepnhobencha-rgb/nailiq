\set ON_ERROR_STOP on

-- Throwaway/rehearsal database only.  The script uses synthetic fixtures,
-- performs no provider calls, and rolls every row/function/trigger back.
begin;

insert into auth.users (
  id, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at
) values
  ('a1000000-0000-0000-0000-000000000001', 'terminal-owner@nailiq.invalid', '', now(), '{}', '{}', now()),
  ('a1000000-0000-0000-0000-000000000002', 'terminal-reception@nailiq.invalid', '', now(), '{}', '{}', now()),
  ('a1000000-0000-0000-0000-000000000003', 'terminal-tech@nailiq.invalid', '', now(), '{}', '{}', now()),
  ('a1000000-0000-0000-0000-000000000004', 'terminal-outsider@nailiq.invalid', '', now(), '{}', '{}', now());

insert into public.salons (
  id, slug, name, phone, timezone, opening_hours, feature_flags
) values
  (
    'a2000000-0000-0000-0000-000000000001',
    'terminal-boundary-test',
    'Terminal Boundary Test',
    '+16045550101',
    'UTC',
    '{
      "mon":{"open":"00:00","close":"23:59","closed":false},
      "tue":{"open":"00:00","close":"23:59","closed":false},
      "wed":{"open":"00:00","close":"23:59","closed":false},
      "thu":{"open":"00:00","close":"23:59","closed":false},
      "fri":{"open":"00:00","close":"23:59","closed":false},
      "sat":{"open":"00:00","close":"23:59","closed":false},
      "sun":{"open":"00:00","close":"23:59","closed":false}
    }'::jsonb,
    '{"archived_booking_recovery_enabled":true}'::jsonb
  ),
  (
    'a2000000-0000-0000-0000-000000000002',
    'terminal-other-tenant-test',
    'Terminal Other Tenant Test',
    '+16045550102',
    'UTC',
    '{}'::jsonb,
    '{"archived_booking_recovery_enabled":true}'::jsonb
  );

insert into public.salon_members (salon_id, user_id, role) values
  ('a2000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'owner'),
  ('a2000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000002', 'receptionist'),
  ('a2000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000003', 'nail_tech');

insert into public.services (
  id, salon_id, name, price_cents, duration_minutes, buffer_minutes
) values (
  'a3000000-0000-0000-0000-000000000001',
  'a2000000-0000-0000-0000-000000000001',
  'Terminal Test Service', 5000, 30, 0
);

insert into public.staff (id, salon_id, name, status) values (
  'a4000000-0000-0000-0000-000000000001',
  'a2000000-0000-0000-0000-000000000001',
  'Terminal Test Staff', 'active'
);

insert into public.bookings (
  id, salon_id, service_id, staff_id, client_name, client_phone,
  start_time_utc, end_time_utc, status, source, price_cents
) values
  ('a5000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000001', 'Owner Active', '+16045550111', now() + interval '1 day', now() + interval '1 day 30 minutes', 'pending', 'appointment', 5000),
  ('a5000000-0000-0000-0000-000000000002', 'a2000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000001', 'Owner Transition', '+16045550112', now() + interval '2 days', now() + interval '2 days 30 minutes', 'confirmed', 'appointment', 5000),
  ('a5000000-0000-0000-0000-000000000003', 'a2000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000001', 'Terminal Existing', '+16045550113', now() - interval '2 days', now() - interval '2 days' + interval '30 minutes', 'cancelled', 'appointment', 5000),
  ('a5000000-0000-0000-0000-000000000004', 'a2000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000001', 'Fee Waive', '+16045550114', now() - interval '3 days', now() - interval '3 days' + interval '30 minutes', 'no_show', 'appointment', 5000),
  ('a5000000-0000-0000-0000-000000000005', 'a2000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000001', 'Transition Rollback', '+16045550115', now() + interval '4 days', now() + interval '4 days 30 minutes', 'confirmed', 'appointment', 5000),
  ('a5000000-0000-0000-0000-000000000006', 'a2000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000001', 'Fee Rollback', '+16045550116', now() - interval '4 days', now() - interval '4 days' + interval '30 minutes', 'no_show', 'appointment', 5000),
  ('a5000000-0000-0000-0000-000000000007', 'a2000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000001', 'Recovery Source', '+16045550117', now() - interval '5 days', now() - interval '5 days' + interval '30 minutes', 'no_show', 'appointment', 5000),
  ('a5000000-0000-0000-0000-000000000008', 'a2000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000001', 'Retention Row', '+16045550118', now() - interval '6 days', now() - interval '6 days' + interval '30 minutes', 'cancelled', 'appointment', 5000),
  ('a5000000-0000-0000-0000-000000000009', 'a2000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000001', 'Reception Transition', '+16045550119', now() + interval '5 days', now() + interval '5 days 30 minutes', 'pending', 'appointment', 5000),
  ('a5000000-0000-0000-0000-000000000012', 'a2000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000001', 'Tenant Scoped System Cancel', '+16045550122', now() + interval '6 days', now() + interval '6 days 30 minutes', 'confirmed', 'appointment', 5000),
  ('a5000000-0000-0000-0000-000000000013', 'a2000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000001', 'System Cancel Rollback', '+16045550123', now() + interval '7 days', now() + interval '7 days 30 minutes', 'confirmed', 'appointment', 5000),
  ('a5000000-0000-0000-0000-000000000014', 'a2000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000001', 'Automatic No Show Rollback', '+16045550124', now() - interval '3 hours', now() - interval '150 minutes', 'confirmed', 'appointment', 5000),
  ('a5000000-0000-0000-0000-000000000015', 'a2000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000001', 'Square Cancel', '+16045550125', now() + interval '8 days', now() + interval '8 days 30 minutes', 'confirmed', 'appointment', 5000),
  ('a5000000-0000-0000-0000-000000000016', 'a2000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000001', 'Square No Show', '+16045550126', now() + interval '9 days', now() + interval '9 days 30 minutes', 'confirmed', 'appointment', 5000),
  ('a5000000-0000-0000-0000-000000000017', 'a2000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000001', 'Square Audit Rollback', '+16045550127', now() + interval '10 days', now() + interval '10 days 30 minutes', 'confirmed', 'appointment', 5000);

update public.bookings set square_booking_id = case id
  when 'a5000000-0000-0000-0000-000000000015'::uuid then 'square-cancel-test'
  when 'a5000000-0000-0000-0000-000000000016'::uuid then 'square-no-show-test'
  when 'a5000000-0000-0000-0000-000000000017'::uuid then 'square-rollback-test'
end,
no_show_candidate_at = case
  when id = 'a5000000-0000-0000-0000-000000000016'::uuid then now()
  else no_show_candidate_at
end
where id in (
  'a5000000-0000-0000-0000-000000000015',
  'a5000000-0000-0000-0000-000000000016',
  'a5000000-0000-0000-0000-000000000017'
);

update public.salons set auto_no_show_minutes = 30
 where id = 'a2000000-0000-0000-0000-000000000001';

-- Exercise the real PostgREST application roles.  The trigger's maintenance
-- exemption must not survive SET ROLE even when CI owns the connection as
-- postgres; this is portable to hosted/local Supabase roles which cannot SET
-- SESSION AUTHORIZATION.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"a1000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);
select set_config(
  'request.jwt.claim.sub',
  'a1000000-0000-0000-0000-000000000001',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);

do $authenticated_boundary$
begin
  begin
    insert into public.bookings (
      id, salon_id, service_id, staff_id, client_name, client_phone,
      start_time_utc, end_time_utc, status, source, price_cents
    ) values (
      'a5000000-0000-0000-0000-000000000010',
      'a2000000-0000-0000-0000-000000000001',
      'a3000000-0000-0000-0000-000000000001',
      'a4000000-0000-0000-0000-000000000001',
      'Forged Terminal', '+16045550120', now(), now() + interval '30 minutes',
      'cancelled', 'appointment', 5000
    );
    raise exception 'authenticated direct terminal insert unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;

  begin
    update public.bookings set status = 'cancelled'
     where id = 'a5000000-0000-0000-0000-000000000001';
    raise exception 'authenticated direct terminal transition unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;

  begin
    update public.bookings
       set status = 'cancelled', client_name = 'Forged Rewrite'
     where id = 'a5000000-0000-0000-0000-000000000001';
    raise exception 'authenticated multi-column terminal transition unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;

  begin
    update public.bookings set client_name = 'Terminal Rewrite'
     where id = 'a5000000-0000-0000-0000-000000000003';
    raise exception 'authenticated terminal rewrite unexpectedly succeeded';
  exception when check_violation then null;
  end;

  -- A caller-set custom GUC is not an authorization capability.  The final
  -- terminal boundary independently requires service_role even when the
  -- booking-scoped privacy marker matches.
  perform set_config(
    'nailiq.privacy_redaction_booking_id',
    'a5000000-0000-0000-0000-000000000003',
    true
  );
  begin
    update public.bookings set client_name = 'Forged Privacy Rewrite'
     where id = 'a5000000-0000-0000-0000-000000000003';
    raise exception 'authenticated privacy GUC bypass unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
  perform set_config('nailiq.privacy_redaction_booking_id', '', true);

  delete from public.bookings
   where id = 'a5000000-0000-0000-0000-000000000003';
  if not exists (
    select 1 from public.bookings
     where id = 'a5000000-0000-0000-0000-000000000003'
  ) then
    raise exception 'authenticated hard delete removed terminal history';
  end if;

  begin
    perform public.transition_booking_to_terminal(
      'a5000000-0000-0000-0000-000000000002',
      'a2000000-0000-0000-0000-000000000001',
      'a1000000-0000-0000-0000-000000000001',
      'owner',
      'desk_cancel'
    );
    raise exception 'authenticated role executed service-only transition RPC';
  exception when insufficient_privilege then null;
  end;

  begin
    perform public.transition_square_booking_to_terminal(
      'a5000000-0000-0000-0000-000000000015',
      'a2000000-0000-0000-0000-000000000001',
      'square-cancel-test',
      'cancelled'
    );
    raise exception 'authenticated role executed Square terminal transition RPC';
  exception when insufficient_privilege then null;
  end;
end
$authenticated_boundary$;

reset role;
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);

do $service_transition_boundary$
declare
  v_result jsonb;
  v_cancel record;
begin
  begin
    insert into public.bookings (
      id, salon_id, service_id, staff_id, client_name, client_phone,
      start_time_utc, end_time_utc, status, source, price_cents
    ) values (
      'a5000000-0000-0000-0000-000000000011',
      'a2000000-0000-0000-0000-000000000001',
      'a3000000-0000-0000-0000-000000000001',
      'a4000000-0000-0000-0000-000000000001',
      'Service Forged Terminal', '+16045550121', now(), now() + interval '30 minutes',
      'no_show', 'appointment', 5000
    );
    raise exception 'service role direct terminal insert unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;

  begin
    update public.bookings set status = 'cancelled'
     where id = 'a5000000-0000-0000-0000-000000000002';
    raise exception 'service role direct terminal transition unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;

  begin
    perform public.transition_booking_to_terminal(
      'a5000000-0000-0000-0000-000000000002',
      'a2000000-0000-0000-0000-000000000002',
      'a1000000-0000-0000-0000-000000000001',
      'owner',
      'desk_cancel'
    );
    raise exception 'cross-tenant transition unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;

  v_result := public.transition_booking_to_terminal(
    'a5000000-0000-0000-0000-000000000002',
    'a2000000-0000-0000-0000-000000000001',
    'a1000000-0000-0000-0000-000000000001',
    'owner',
    null
  );
  if v_result ->> 'code' <> 'invalid_request' then
    raise exception 'NULL transition reason was not rejected: %', v_result;
  end if;

  begin
    perform public.transition_booking_to_terminal(
      'a5000000-0000-0000-0000-000000000002',
      'a2000000-0000-0000-0000-000000000001',
      'a1000000-0000-0000-0000-000000000003',
      'nail_tech',
      'desk_cancel'
    );
    raise exception 'nail tech terminal transition unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;

  begin
    perform public.transition_booking_to_terminal(
      'a5000000-0000-0000-0000-000000000002',
      'a2000000-0000-0000-0000-000000000001',
      'a1000000-0000-0000-0000-000000000002',
      'owner',
      'desk_cancel'
    );
    raise exception 'spoofed receptionist role unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;

  v_result := public.transition_booking_to_terminal(
    'a5000000-0000-0000-0000-000000000002',
    'a2000000-0000-0000-0000-000000000001',
    'a1000000-0000-0000-0000-000000000001',
    'owner',
    'desk_cancel'
  );
  if coalesce(v_result ->> 'success', 'false') <> 'true' then
    raise exception 'authorized owner transition failed: %', v_result;
  end if;
  if not exists (
    select 1 from public.booking_events
     where booking_id = 'a5000000-0000-0000-0000-000000000002'
       and event_type = 'terminal_booking_transition_authorized'
       and actor_user_id = 'a1000000-0000-0000-0000-000000000001'
       and actor_role = 'owner'
       and payload ->> 'reason' = 'desk_cancel'
  ) then
    raise exception 'authorized transition committed without same-transaction audit';
  end if;

  v_result := public.transition_booking_to_terminal(
    'a5000000-0000-0000-0000-000000000009',
    'a2000000-0000-0000-0000-000000000001',
    'a1000000-0000-0000-0000-000000000002',
    'receptionist',
    'desk_cancel'
  );
  if coalesce(v_result ->> 'success', 'false') <> 'true' then
    raise exception 'authorized receptionist transition failed: %', v_result;
  end if;

  select * into v_cancel from public.cancel_booking_by_id(
    'a5000000-0000-0000-0000-000000000012',
    'a2000000-0000-0000-0000-000000000002'
  );
  if v_cancel.ok is distinct from false
     or v_cancel.code is distinct from 'booking_not_cancellable' then
    raise exception 'cross-tenant system cancellation did not fail closed: %',
      row_to_json(v_cancel);
  end if;
  if not exists (
    select 1 from public.bookings
     where id = 'a5000000-0000-0000-0000-000000000012'
       and status = 'confirmed'
  ) then
    raise exception 'cross-tenant system cancellation changed the booking';
  end if;

  select * into v_cancel from public.cancel_booking_by_id(
    'a5000000-0000-0000-0000-000000000012', null
  );
  if v_cancel.ok is distinct from false
     or v_cancel.code is distinct from 'invalid_request' then
    raise exception 'NULL system cancellation tenant was not rejected: %',
      row_to_json(v_cancel);
  end if;

  select * into v_cancel from public.cancel_booking_by_id(
    'a5000000-0000-0000-0000-000000000012',
    'a2000000-0000-0000-0000-000000000001'
  );
  if v_cancel.ok is distinct from true then
    raise exception 'tenant-scoped system cancellation failed: %',
      row_to_json(v_cancel);
  end if;
  if not exists (
    select 1 from public.booking_events
     where booking_id = 'a5000000-0000-0000-0000-000000000012'
       and salon_id = 'a2000000-0000-0000-0000-000000000001'
       and event_type = 'terminal_booking_transition_authorized'
       and actor_role = 'system'
  ) then
    raise exception 'tenant-scoped system cancellation lacks atomic audit';
  end if;

  v_result := public.transition_square_booking_to_terminal(
    'a5000000-0000-0000-0000-000000000015',
    'a2000000-0000-0000-0000-000000000002',
    'square-cancel-test',
    'cancelled'
  );
  if v_result ->> 'code' <> 'invalid_state' then
    raise exception 'cross-tenant Square transition did not fail closed: %', v_result;
  end if;

  v_result := public.transition_square_booking_to_terminal(
    'a5000000-0000-0000-0000-000000000015',
    'a2000000-0000-0000-0000-000000000001',
    'wrong-square-id',
    'cancelled'
  );
  if v_result ->> 'code' <> 'invalid_state' then
    raise exception 'wrong external Square id did not fail closed: %', v_result;
  end if;

  v_result := public.transition_square_booking_to_terminal(
    'a5000000-0000-0000-0000-000000000015',
    'a2000000-0000-0000-0000-000000000001',
    'square-cancel-test',
    'cancelled'
  );
  if coalesce(v_result ->> 'success', 'false') <> 'true' or not exists (
    select 1 from public.bookings
     where id = 'a5000000-0000-0000-0000-000000000015'
       and status = 'cancelled'
  ) or not exists (
    select 1 from public.booking_events
     where booking_id = 'a5000000-0000-0000-0000-000000000015'
       and salon_id = 'a2000000-0000-0000-0000-000000000001'
       and event_type = 'terminal_booking_transition_authorized'
       and actor_role = 'system'
       and payload ->> 'reason' = 'square_sync_cancel'
  ) then
    raise exception 'audited Square cancellation failed: %', v_result;
  end if;

  v_result := public.transition_square_booking_to_terminal(
    'a5000000-0000-0000-0000-000000000016',
    'a2000000-0000-0000-0000-000000000001',
    'square-no-show-test',
    'no_show'
  );
  if coalesce(v_result ->> 'success', 'false') <> 'true' or not exists (
    select 1 from public.bookings
     where id = 'a5000000-0000-0000-0000-000000000016'
       and status = 'no_show'
       and no_show_candidate_at is null
  ) or not exists (
    select 1 from public.booking_events
     where booking_id = 'a5000000-0000-0000-0000-000000000016'
       and payload ->> 'reason' = 'square_sync_no_show'
  ) then
    raise exception 'audited Square no-show failed: %', v_result;
  end if;

  begin
    delete from public.bookings
     where id = 'a5000000-0000-0000-0000-000000000003';
    raise exception 'service role terminal hard delete unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
end
$service_transition_boundary$;

reset role;

create function public.test_reject_terminal_transition_audit()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.event_type = 'terminal_booking_transition_authorized' then
    raise exception 'forced_terminal_transition_audit_failure' using errcode = 'P9201';
  end if;
  return new;
end;
$$;
create trigger test_reject_terminal_transition_audit_trigger
before insert on public.booking_events
for each row execute function public.test_reject_terminal_transition_audit();

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);

do $transition_audit_rollback$
declare
  v_cancel record;
  v_flagged integer;
begin
  begin
    perform public.transition_booking_to_terminal(
      'a5000000-0000-0000-0000-000000000005',
      'a2000000-0000-0000-0000-000000000001',
      'a1000000-0000-0000-0000-000000000001',
      'owner',
      'desk_cancel'
    );
    raise exception 'terminal transition bypassed forced audit failure';
  exception when others then
    if sqlstate <> 'P9201' then raise; end if;
  end;
  if not exists (
    select 1 from public.bookings
     where id = 'a5000000-0000-0000-0000-000000000005'
       and status = 'confirmed'
  ) then
    raise exception 'terminal transition survived failed audit insert';
  end if;

  begin
    select * into v_cancel from public.cancel_booking_by_id(
      'a5000000-0000-0000-0000-000000000013',
      'a2000000-0000-0000-0000-000000000001'
    );
    raise exception 'system terminal transition bypassed forced audit failure: %',
      row_to_json(v_cancel);
  exception when others then
    if sqlstate <> 'P9201' then raise; end if;
  end;
  if not exists (
    select 1 from public.bookings
     where id = 'a5000000-0000-0000-0000-000000000013'
       and status = 'confirmed'
  ) then
    raise exception 'system terminal transition survived failed audit insert';
  end if;

  begin
    perform public.transition_square_booking_to_terminal(
      'a5000000-0000-0000-0000-000000000017',
      'a2000000-0000-0000-0000-000000000001',
      'square-rollback-test',
      'cancelled'
    );
    raise exception 'Square transition bypassed forced audit failure';
  exception when others then
    if sqlstate <> 'P9201' then raise; end if;
  end;
  if not exists (
    select 1 from public.bookings
     where id = 'a5000000-0000-0000-0000-000000000017'
       and status = 'confirmed'
  ) then
    raise exception 'Square terminal transition survived failed audit insert';
  end if;

  v_flagged := public.auto_mark_no_shows();
  if v_flagged < 1 then
    raise exception 'automatic no-show review did not flag the overdue fixture';
  end if;
  if not exists (
    select 1 from public.bookings
     where id = 'a5000000-0000-0000-0000-000000000014'
       and status = 'confirmed'
       and no_show_candidate_at is not null
  ) then
    raise exception 'automatic no-show review changed terminal state or missed candidate flag';
  end if;
end
$transition_audit_rollback$;

reset role;
drop trigger test_reject_terminal_transition_audit_trigger on public.booking_events;
drop function public.test_reject_terminal_transition_audit();

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);

do $fee_boundary$
declare
  v_result jsonb;
begin
  begin
    update public.bookings set noshow_charge_status = 'waived'
     where id = 'a5000000-0000-0000-0000-000000000004';
    raise exception 'service role direct terminal fee mutation unexpectedly succeeded';
  exception when check_violation then null;
  end;

  v_result := public.record_terminal_booking_fee_mutation(
    'a5000000-0000-0000-0000-000000000004',
    'a2000000-0000-0000-0000-000000000001',
    null,
    'a8000000-0000-0000-0000-000000000001',
    'a1000000-0000-0000-0000-000000000001',
    'owner'
  );
  if v_result ->> 'code' <> 'invalid_request' then
    raise exception 'NULL fee operation was not rejected: %', v_result;
  end if;

  v_result := public.record_terminal_booking_fee_mutation(
    'a5000000-0000-0000-0000-000000000004',
    'a2000000-0000-0000-0000-000000000001',
    'waive',
    'a8000000-0000-0000-0000-000000000001',
    'a1000000-0000-0000-0000-000000000001',
    'owner'
  );
  if coalesce(v_result ->> 'success', 'false') <> 'true'
     or v_result ->> 'charge_status' <> 'waived' then
    raise exception 'authorized fee waiver failed: %', v_result;
  end if;

  v_result := public.record_terminal_booking_fee_mutation(
    'a5000000-0000-0000-0000-000000000004',
    'a2000000-0000-0000-0000-000000000001',
    'waive',
    'a8000000-0000-0000-0000-000000000001',
    'a1000000-0000-0000-0000-000000000001',
    'owner'
  );
  if coalesce(v_result ->> 'success', 'false') <> 'true'
     or coalesce(v_result ->> 'replayed', 'false') <> 'true' then
    raise exception 'exact fee retry was not canonical: %', v_result;
  end if;

  v_result := public.record_terminal_booking_fee_mutation(
    'a5000000-0000-0000-0000-000000000004',
    'a2000000-0000-0000-0000-000000000001',
    'card_removed',
    'a8000000-0000-0000-0000-000000000001',
    'a1000000-0000-0000-0000-000000000001',
    'owner'
  );
  if v_result ->> 'code' <> 'idempotency_mismatch' then
    raise exception 'changed fee payload reused request id: %', v_result;
  end if;

  v_result := public.record_terminal_booking_fee_mutation(
    'a5000000-0000-0000-0000-000000000004',
    'a2000000-0000-0000-0000-000000000002',
    'waive',
    'a8000000-0000-0000-0000-000000000002',
    'a1000000-0000-0000-0000-000000000001',
    'owner'
  );
  if v_result ->> 'code' <> 'invalid_terminal_booking' then
    raise exception 'cross-tenant fee mutation did not fail closed: %', v_result;
  end if;

  begin
    perform public.record_terminal_booking_fee_mutation(
      'a5000000-0000-0000-0000-000000000006',
      'a2000000-0000-0000-0000-000000000001',
      'waive',
      'a8000000-0000-0000-0000-000000000003',
      'a1000000-0000-0000-0000-000000000003',
      'nail_tech'
    );
    raise exception 'nail tech fee mutation unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
end
$fee_boundary$;

reset role;

create function public.test_reject_terminal_fee_audit()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.event_type = 'terminal_booking_fee_mutation_recorded' then
    raise exception 'forced_terminal_fee_audit_failure' using errcode = 'P9202';
  end if;
  return new;
end;
$$;
create trigger test_reject_terminal_fee_audit_trigger
before insert on public.booking_events
for each row execute function public.test_reject_terminal_fee_audit();

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);

do $fee_audit_rollback$
begin
  begin
    perform public.record_terminal_booking_fee_mutation(
      'a5000000-0000-0000-0000-000000000006',
      'a2000000-0000-0000-0000-000000000001',
      'waive',
      'a8000000-0000-0000-0000-000000000004',
      'a1000000-0000-0000-0000-000000000001',
      'owner'
    );
    raise exception 'fee mutation bypassed forced audit failure';
  exception when others then
    if sqlstate <> 'P9202' then raise; end if;
  end;
  if not exists (
    select 1 from public.bookings
     where id = 'a5000000-0000-0000-0000-000000000006'
       and noshow_charge_status is distinct from 'waived'
  ) then
    raise exception 'fee mutation survived failed audit insert';
  end if;
end
$fee_audit_rollback$;

reset role;
drop trigger test_reject_terminal_fee_audit_trigger on public.booking_events;
drop function public.test_reject_terminal_fee_audit();

-- Create a canonical recovery child so the source hard-delete FK can be proven.
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
do $recovery_child_for_delete$
declare
  v_result jsonb;
begin
  v_result := public.create_recovered_walkin(
    'a5000000-0000-0000-0000-000000000007',
    'a1000000-0000-0000-0000-000000000001',
    'a9000000-0000-0000-0000-000000000001',
    repeat('f', 64),
    'a2000000-0000-0000-0000-000000000001',
    'a3000000-0000-0000-0000-000000000001',
    'Recovery Child', '+16045550127', null, false,
    'walk_in', 'medium', '[]'::jsonb, 1
  );
  if coalesce(v_result ->> 'success', 'false') <> 'true' then
    raise exception 'recovery child setup failed: %', v_result;
  end if;
end
$recovery_child_for_delete$;

reset role;

do $postgres_retention_boundary$
begin
  begin
    delete from public.bookings
     where id = 'a5000000-0000-0000-0000-000000000007';
    raise exception 'recovery source hard delete unexpectedly succeeded';
  exception when foreign_key_violation then null;
  end;
  if not exists (
    select 1 from public.bookings
     where id = 'a5000000-0000-0000-0000-000000000007'
  ) then
    raise exception 'recovery source disappeared after restricted hard delete';
  end if;

  delete from public.bookings
   where id = 'a5000000-0000-0000-0000-000000000008';
  if found and exists (
    select 1 from public.bookings
     where id = 'a5000000-0000-0000-0000-000000000008'
  ) then
    raise exception 'postgres retention delete reported success but row remains';
  end if;
end
$postgres_retention_boundary$;

do $definition_and_acl_boundary$
declare
  v_trigger_def text := pg_get_functiondef(
    'public.enforce_terminal_booking_write_boundary()'::regprocedure
  );
  v_transition_def text := pg_get_functiondef(
    'public.transition_booking_to_terminal(uuid,uuid,uuid,text,text)'::regprocedure
  );
  v_fee_def text := pg_get_functiondef(
    'public.record_terminal_booking_fee_mutation(uuid,uuid,text,uuid,uuid,text,text,integer,text,text,text)'::regprocedure
  );
  v_system_cancel_def text := pg_get_functiondef(
    'public.cancel_booking_by_id(uuid,uuid)'::regprocedure
  );
  v_square_transition_def text := pg_get_functiondef(
    'public.transition_square_booking_to_terminal(uuid,uuid,text,text)'::regprocedure
  );
begin
  if v_trigger_def not like '%SECURITY DEFINER%'
     or v_trigger_def not like '%SET search_path TO ''''%' then
    raise exception 'terminal trigger function lacks definer/search_path hardening';
  end if;
  if v_transition_def like '%SECURITY DEFINER%'
     or v_transition_def not like '%SET search_path TO ''''%' then
    raise exception 'transition RPC is not invoker/search_path hardened';
  end if;
  if v_fee_def like '%SECURITY DEFINER%'
     or v_fee_def not like '%SET search_path TO ''''%' then
    raise exception 'fee RPC is not invoker/search_path hardened';
  end if;
  if v_system_cancel_def not like '%SECURITY DEFINER%'
     or v_system_cancel_def not like '%SET search_path TO ''''%' then
    raise exception 'system cancellation RPC lacks definer/search_path hardening';
  end if;
  if v_square_transition_def like '%SECURITY DEFINER%'
     or v_square_transition_def not like '%SET search_path TO ''''%' then
    raise exception 'Square transition RPC is not invoker/search_path hardened';
  end if;

  if has_function_privilege(
    'anon',
    'public.transition_booking_to_terminal(uuid,uuid,uuid,text,text)',
    'EXECUTE'
  ) or has_function_privilege(
    'authenticated',
    'public.transition_booking_to_terminal(uuid,uuid,uuid,text,text)',
    'EXECUTE'
  ) or not has_function_privilege(
    'service_role',
    'public.transition_booking_to_terminal(uuid,uuid,uuid,text,text)',
    'EXECUTE'
  ) then
    raise exception 'terminal transition RPC ACL mismatch';
  end if;

  if has_function_privilege(
    'anon',
    'public.record_terminal_booking_fee_mutation(uuid,uuid,text,uuid,uuid,text,text,integer,text,text,text)',
    'EXECUTE'
  ) or has_function_privilege(
    'authenticated',
    'public.record_terminal_booking_fee_mutation(uuid,uuid,text,uuid,uuid,text,text,integer,text,text,text)',
    'EXECUTE'
  ) or not has_function_privilege(
    'service_role',
    'public.record_terminal_booking_fee_mutation(uuid,uuid,text,uuid,uuid,text,text,integer,text,text,text)',
    'EXECUTE'
  ) then
    raise exception 'terminal fee RPC ACL mismatch';
  end if;

  if has_function_privilege(
    'service_role', 'public.cancel_booking_by_id(uuid)', 'EXECUTE'
  ) or has_function_privilege(
    'anon', 'public.cancel_booking_by_id(uuid,uuid)', 'EXECUTE'
  ) or has_function_privilege(
    'authenticated', 'public.cancel_booking_by_id(uuid,uuid)', 'EXECUTE'
  ) or not has_function_privilege(
    'service_role', 'public.cancel_booking_by_id(uuid,uuid)', 'EXECUTE'
  ) then
    raise exception 'tenant-scoped system cancellation RPC ACL mismatch';
  end if;

  if has_function_privilege(
    'anon',
    'public.transition_square_booking_to_terminal(uuid,uuid,text,text)',
    'EXECUTE'
  ) or has_function_privilege(
    'authenticated',
    'public.transition_square_booking_to_terminal(uuid,uuid,text,text)',
    'EXECUTE'
  ) or not has_function_privilege(
    'service_role',
    'public.transition_square_booking_to_terminal(uuid,uuid,text,text)',
    'EXECUTE'
  ) then
    raise exception 'Square transition RPC ACL mismatch';
  end if;

  if not exists (
    select 1 from pg_trigger t
     where t.tgrelid = 'public.bookings'::regclass
       and t.tgname = 'enforce_terminal_booking_write_boundary_trigger'
       and (t.tgtype::integer & 4) = 4
       and (t.tgtype::integer & 8) = 8
       and (t.tgtype::integer & 16) = 16
  ) then
    raise exception 'terminal boundary trigger does not cover INSERT/UPDATE/DELETE';
  end if;
end
$definition_and_acl_boundary$;

rollback;
