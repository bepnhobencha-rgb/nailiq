\set ON_ERROR_STOP on

-- Executed only against Migration History Rehearsal's blank throwaway
-- Supabase. Every fixture and test helper is transaction-scoped and rolled
-- back, including deliberate audit-failure triggers.
begin;

insert into auth.users (
  id,
  instance_id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
values
  (
    '91000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'archive-owner@nailiq.invalid',
    '',
    now(),
    '{"provider":"email","providers":["email"]}',
    '{}',
    now(),
    now()
  ),
  (
    '91000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'privacy-ops@nailiq.invalid',
    '',
    now(),
    '{"provider":"email","providers":["email"]}',
    '{}',
    now(),
    now()
  ),
  (
    '91000000-0000-0000-0000-000000000003',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'archive-outsider@nailiq.invalid',
    '',
    now(),
    '{"provider":"email","providers":["email"]}',
    '{}',
    now(),
    now()
  );

insert into public.salons (
  id,
  slug,
  name,
  phone,
  timezone,
  opening_hours,
  feature_flags
)
values
  (
    '92000000-0000-0000-0000-000000000001',
    'archive-atomicity-test',
    'Archive Atomicity Test',
    '+16045550910',
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
    '92000000-0000-0000-0000-000000000002',
    'archive-other-tenant-test',
    'Archive Other Tenant Test',
    '+16045550911',
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
  );

insert into public.salon_members (salon_id, user_id, role)
values (
  '92000000-0000-0000-0000-000000000001',
  '91000000-0000-0000-0000-000000000001',
  'owner'
);

insert into public.superadmins (user_id, role)
values (
  '91000000-0000-0000-0000-000000000002',
  'ops_admin'
);

insert into public.services (
  id,
  salon_id,
  name,
  price_cents,
  duration_minutes,
  buffer_minutes
)
values (
  '93000000-0000-0000-0000-000000000001',
  '92000000-0000-0000-0000-000000000001',
  'Atomic Recovery Service',
  4500,
  30,
  0
);

insert into public.staff (id, salon_id, name, status)
values (
  '94000000-0000-0000-0000-000000000001',
  '92000000-0000-0000-0000-000000000001',
  'Atomic Recovery Staff',
  'active'
);

insert into public.bookings (
  id,
  salon_id,
  service_id,
  staff_id,
  client_name,
  client_phone,
  client_email,
  client_notes,
  start_time_utc,
  end_time_utc,
  status,
  source,
  price_cents
)
values
  (
    '95000000-0000-0000-0000-000000000001',
    '92000000-0000-0000-0000-000000000001',
    '93000000-0000-0000-0000-000000000001',
    '94000000-0000-0000-0000-000000000001',
    'Cancelled Source',
    '+16045550912',
    'cancelled-source@nailiq.invalid',
    'terminal cancelled source',
    date_trunc('day', clock_timestamp()) + interval '3 days 12 hours',
    date_trunc('day', clock_timestamp()) + interval '3 days 12 hours 30 minutes',
    'cancelled',
    'appointment',
    4500
  ),
  (
    '95000000-0000-0000-0000-000000000002',
    '92000000-0000-0000-0000-000000000001',
    '93000000-0000-0000-0000-000000000001',
    '94000000-0000-0000-0000-000000000001',
    'No Show Source',
    '+16045550913',
    'no-show-source@nailiq.invalid',
    'terminal no-show source',
    clock_timestamp() - interval '2 hours',
    clock_timestamp() - interval '90 minutes',
    'no_show',
    'appointment',
    4500
  ),
  (
    '95000000-0000-0000-0000-000000000003',
    '92000000-0000-0000-0000-000000000001',
    '93000000-0000-0000-0000-000000000001',
    '94000000-0000-0000-0000-000000000001',
    'Privacy Customer',
    '+16045550914',
    'privacy-customer@nailiq.invalid',
    'privacy request notes',
    clock_timestamp() - interval '4 hours',
    clock_timestamp() - interval '3 hours 30 minutes',
    'cancelled',
    'appointment',
    6700
  );

update public.bookings
set staff_request_note = 'ask for Alice',
    client_locale = 'en',
    noshow_card_id = 'card-private-token',
    noshow_customer_id = 'customer-private-token',
    noshow_card_last4 = '4242',
    noshow_card_brand = 'VISA',
    noshow_consent_meta = '{"ip":"192.0.2.1"}'::jsonb,
    sms_consent_meta = '{"ip":"192.0.2.1"}'::jsonb,
    deposit_link_url = 'https://example.invalid/private-deposit-link',
    noshow_fee_link_url = 'https://example.invalid/private-fee-link'
where id = '95000000-0000-0000-0000-000000000003';

create function public.test_reject_booking_recovery_audit()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.event_type = 'booking_recovered' then
    raise exception 'forced_recovery_audit_failure' using errcode = 'P9101';
  end if;
  return new;
end;
$$;

create trigger test_reject_booking_recovery_audit_trigger
before insert on public.booking_events
for each row execute function public.test_reject_booking_recovery_audit();

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);

do $recovery_failure_proof$
declare
  v_result jsonb;
begin
  begin
    v_result := public.create_recovered_booking(
      '95000000-0000-0000-0000-000000000001',
      'cancelled_rebook',
      '91000000-0000-0000-0000-000000000001',
      '96000000-0000-0000-0000-000000000001',
      '92000000-0000-0000-0000-000000000001',
      '93000000-0000-0000-0000-000000000001',
      '94000000-0000-0000-0000-000000000001',
      'Recovered Appointment',
      '+16045550915',
      date_trunc('day', clock_timestamp()) + interval '1 day 12 hours',
      date_trunc('day', clock_timestamp()) + interval '1 day 12 hours 30 minutes',
      'confirmed',
      4500,
      null,
      'recovered-appointment@nailiq.invalid',
      null
    );
    raise exception 'appointment recovery unexpectedly bypassed audit failure: %',
      v_result;
  exception
    when sqlstate 'P9101' then null;
  end;

  if exists (
    select 1 from public.bookings
    where recovered_from_booking_id =
      '95000000-0000-0000-0000-000000000001'
  ) then
    raise exception 'appointment child survived failed audit insert';
  end if;

  begin
    v_result := public.create_recovered_walkin(
      '95000000-0000-0000-0000-000000000002',
      '91000000-0000-0000-0000-000000000001',
      '96000000-0000-0000-0000-000000000002',
      '92000000-0000-0000-0000-000000000001',
      '93000000-0000-0000-0000-000000000001',
      'Recovered Walk-in',
      '+16045550916',
      null,
      false,
      'walk_in',
      'medium',
      '[]'::jsonb,
      1
    );
    raise exception 'walk-in recovery unexpectedly bypassed audit failure: %',
      v_result;
  exception
    when sqlstate 'P9101' then null;
  end;

  if exists (
    select 1 from public.bookings
    where recovered_from_booking_id =
      '95000000-0000-0000-0000-000000000002'
  ) then
    raise exception 'walk-in child survived failed audit insert';
  end if;
end
$recovery_failure_proof$;

reset role;
drop trigger test_reject_booking_recovery_audit_trigger
  on public.booking_events;
drop function public.test_reject_booking_recovery_audit();

set local role service_role;

do $recovery_success_proof$
declare
  v_appointment jsonb;
  v_walkin jsonb;
  v_retry jsonb;
  v_duplicate jsonb;
  v_cross_tenant jsonb;
  v_appointment_id uuid;
  v_walkin_id uuid;
begin
  v_appointment := public.create_recovered_booking(
    '95000000-0000-0000-0000-000000000001',
    'cancelled_rebook',
    '91000000-0000-0000-0000-000000000001',
    '96000000-0000-0000-0000-000000000001',
    '92000000-0000-0000-0000-000000000001',
    '93000000-0000-0000-0000-000000000001',
    '94000000-0000-0000-0000-000000000001',
    'Recovered Appointment',
    '+16045550915',
    date_trunc('day', clock_timestamp()) + interval '1 day 12 hours',
    date_trunc('day', clock_timestamp()) + interval '1 day 12 hours 30 minutes',
    'confirmed',
    4500,
    null,
    'recovered-appointment@nailiq.invalid',
    null
  );
  if coalesce(v_appointment ->> 'success', 'false') <> 'true' then
    raise exception 'appointment recovery failed: %', v_appointment;
  end if;
  v_appointment_id := (v_appointment ->> 'booking_id')::uuid;

  v_walkin := public.create_recovered_walkin(
    '95000000-0000-0000-0000-000000000002',
    '91000000-0000-0000-0000-000000000001',
    '96000000-0000-0000-0000-000000000002',
    '92000000-0000-0000-0000-000000000001',
    '93000000-0000-0000-0000-000000000001',
    'Recovered Walk-in',
    '+16045550916',
    null,
    false,
    'walk_in',
    'medium',
    '[]'::jsonb,
    1
  );
  if coalesce(v_walkin ->> 'success', 'false') <> 'true' then
    raise exception 'walk-in recovery failed: %', v_walkin;
  end if;
  v_walkin_id := (v_walkin ->> 'booking_id')::uuid;

  if (
    select count(*) from public.booking_events
    where event_type = 'booking_recovered'
      and booking_id in (v_appointment_id, v_walkin_id)
      and actor_user_id = '91000000-0000-0000-0000-000000000001'
      and actor_role = 'owner'
  ) <> 2 then
    raise exception 'recovery actor/link audit rows were not committed';
  end if;

  v_retry := public.create_recovered_walkin(
    '95000000-0000-0000-0000-000000000002',
    '91000000-0000-0000-0000-000000000001',
    '96000000-0000-0000-0000-000000000002',
    '92000000-0000-0000-0000-000000000001',
    '93000000-0000-0000-0000-000000000001',
    'Ignored Replay Payload',
    '+16045550999',
    null,
    false,
    null,
    null,
    '[]'::jsonb,
    null
  );
  if coalesce(v_retry ->> 'success', 'false') <> 'true'
     or coalesce(v_retry ->> 'replayed', 'false') <> 'true'
     or (v_retry ->> 'booking_id')::uuid <> v_walkin_id then
    raise exception 'exact recovery retry was not idempotent: %', v_retry;
  end if;

  if (
    select count(*) from public.booking_events
    where event_type = 'booking_recovered'
      and booking_id = v_walkin_id
  ) <> 1 then
    raise exception 'exact retry duplicated the recovery audit';
  end if;

  v_duplicate := public.create_recovered_walkin(
    '95000000-0000-0000-0000-000000000002',
    '91000000-0000-0000-0000-000000000001',
    '96000000-0000-0000-0000-000000000099',
    '92000000-0000-0000-0000-000000000001',
    '93000000-0000-0000-0000-000000000001',
    'Duplicate Walk-in',
    '+16045550916',
    null,
    false,
    null,
    null,
    '[]'::jsonb,
    null
  );
  if v_duplicate ->> 'code' <> 'already_recovered' then
    raise exception 'different recovery retry was not rejected: %', v_duplicate;
  end if;

  v_cross_tenant := public.create_recovered_walkin(
    '95000000-0000-0000-0000-000000000002',
    '91000000-0000-0000-0000-000000000001',
    '96000000-0000-0000-0000-000000000098',
    '92000000-0000-0000-0000-000000000002',
    '93000000-0000-0000-0000-000000000001',
    'Cross Tenant Walk-in',
    '+16045550916',
    null,
    false,
    null,
    null,
    '[]'::jsonb,
    null
  );
  if v_cross_tenant ->> 'code' <> 'invalid_recovery_source' then
    raise exception 'cross-tenant recovery was not rejected: %', v_cross_tenant;
  end if;
end
$recovery_success_proof$;

do $terminal_update_proof$
begin
  begin
    update public.bookings
    set client_name = 'Direct Rewrite'
    where id = '95000000-0000-0000-0000-000000000003';
    raise exception 'direct service-role terminal rewrite unexpectedly succeeded';
  exception
    when check_violation then null;
  end;

  update public.bookings
  set noshow_charge_status = 'waived'
  where id = '95000000-0000-0000-0000-000000000002';
  if not found then
    raise exception 'valid no-show fee outcome update failed';
  end if;
end
$terminal_update_proof$;

reset role;

create function public.test_reject_terminal_privacy_audit()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.action = 'terminal_booking_privacy_redacted' then
    raise exception 'forced_privacy_audit_failure' using errcode = 'P9102';
  end if;
  return new;
end;
$$;

create trigger test_reject_terminal_privacy_audit_trigger
before insert on public.superadmin_audit_logs
for each row execute function public.test_reject_terminal_privacy_audit();

set local role service_role;

do $privacy_failure_proof$
declare
  v_result jsonb;
begin
  v_result := public.redact_terminal_booking_for_privacy(
    '95000000-0000-0000-0000-000000000003',
    '92000000-0000-0000-0000-000000000001',
    '91000000-0000-0000-0000-000000000002',
    '97000000-0000-0000-0000-000000000099',
    'Privacy Customer +16045550914'
  );
  if v_result ->> 'code' <> 'invalid_request' then
    raise exception 'free-form/PII privacy reason was not rejected: %',
      v_result;
  end if;

  v_result := public.redact_terminal_booking_for_privacy(
    '95000000-0000-0000-0000-000000000003',
    '92000000-0000-0000-0000-000000000001',
    '91000000-0000-0000-0000-000000000002',
    '97000000-0000-0000-0000-000000000098',
    null
  );
  if v_result ->> 'code' <> 'invalid_request' then
    raise exception 'null privacy reason code was not rejected: %', v_result;
  end if;

  begin
    v_result := public.redact_terminal_booking_for_privacy(
      '95000000-0000-0000-0000-000000000003',
      '92000000-0000-0000-0000-000000000001',
      '91000000-0000-0000-0000-000000000002',
      '97000000-0000-0000-0000-000000000001',
      'verified_erasure_request'
    );
    raise exception 'privacy redaction unexpectedly bypassed audit failure: %',
      v_result;
  exception
    when sqlstate 'P9102' then null;
  end;

  if not exists (
    select 1 from public.bookings
    where id = '95000000-0000-0000-0000-000000000003'
      and client_name = 'Privacy Customer'
      and client_phone = '+16045550914'
      and status = 'cancelled'
      and price_cents = 6700
  ) then
    raise exception 'privacy fields changed despite failed audit insert';
  end if;
end
$privacy_failure_proof$;

reset role;
drop trigger test_reject_terminal_privacy_audit_trigger
  on public.superadmin_audit_logs;
drop function public.test_reject_terminal_privacy_audit();

set local role service_role;

do $privacy_success_proof$
declare
  v_result jsonb;
  v_retry jsonb;
  v_mismatch jsonb;
begin
  v_result := public.redact_terminal_booking_for_privacy(
    '95000000-0000-0000-0000-000000000003',
    '92000000-0000-0000-0000-000000000001',
    '91000000-0000-0000-0000-000000000002',
    '97000000-0000-0000-0000-000000000001',
    'verified_erasure_request'
  );
  if coalesce(v_result ->> 'success', 'false') <> 'true'
     or coalesce(v_result ->> 'replayed', 'true') <> 'false' then
    raise exception 'privacy redaction failed: %', v_result;
  end if;

  if not exists (
    select 1 from public.bookings
    where id = '95000000-0000-0000-0000-000000000003'
      and client_name = '[removed]'
      and client_phone is null
      and client_email is null
      and client_notes is null
      and noshow_card_id is null
      and deposit_link_url is null
      and status = 'cancelled'
      and salon_id = '92000000-0000-0000-0000-000000000001'
      and service_id = '93000000-0000-0000-0000-000000000001'
      and staff_id = '94000000-0000-0000-0000-000000000001'
      and price_cents = 6700
  ) then
    raise exception 'privacy redaction changed terminal facts or retained PII';
  end if;

  if not exists (
    select 1 from public.superadmin_audit_logs
    where action = 'terminal_booking_privacy_redacted'
      and target_kind = 'booking'
      and target_id = '95000000-0000-0000-0000-000000000003'
      and actor_user_id = '91000000-0000-0000-0000-000000000002'
      and actor_role = 'ops_admin'
      and reason = 'verified_erasure_request'
      and after_jsonb ->> 'requestId' =
        '97000000-0000-0000-0000-000000000001'
      and before_jsonb ? 'personalDataPresent'
      and before_jsonb::text not like '%Privacy Customer%'
      and before_jsonb::text not like '%16045550914%'
  ) then
    raise exception 'privacy redaction audit missing or contains direct PII';
  end if;

  v_retry := public.redact_terminal_booking_for_privacy(
    '95000000-0000-0000-0000-000000000003',
    '92000000-0000-0000-0000-000000000001',
    '91000000-0000-0000-0000-000000000002',
    '97000000-0000-0000-0000-000000000001',
    'verified_erasure_request'
  );
  if coalesce(v_retry ->> 'success', 'false') <> 'true'
     or coalesce(v_retry ->> 'replayed', 'false') <> 'true' then
    raise exception 'privacy retry was not idempotent: %', v_retry;
  end if;

  v_mismatch := public.redact_terminal_booking_for_privacy(
    '95000000-0000-0000-0000-000000000003',
    '92000000-0000-0000-0000-000000000001',
    '91000000-0000-0000-0000-000000000002',
    '97000000-0000-0000-0000-000000000001',
    'verified_legal_correction'
  );
  if v_mismatch ->> 'code' <> 'idempotency_mismatch' then
    raise exception 'privacy reason changed across an exact request retry: %',
      v_mismatch;
  end if;
end
$privacy_success_proof$;

reset role;

do $grant_and_scope_proof$
declare
  v_terminal_guard text := pg_get_functiondef(
    'public.validate_archived_booking_recovery()'::regprocedure
  );
begin
  if has_function_privilege(
    'anon',
    'public.create_recovered_walkin(uuid,uuid,uuid,uuid,uuid,text,text,text,boolean,text,text,jsonb,integer)',
    'EXECUTE'
  ) or has_function_privilege(
    'authenticated',
    'public.create_recovered_walkin(uuid,uuid,uuid,uuid,uuid,text,text,text,boolean,text,text,jsonb,integer)',
    'EXECUTE'
  ) or not has_function_privilege(
    'service_role',
    'public.create_recovered_walkin(uuid,uuid,uuid,uuid,uuid,text,text,text,boolean,text,text,jsonb,integer)',
    'EXECUTE'
  ) then
    raise exception 'recovered walk-in RPC role boundary mismatch';
  end if;

  if has_function_privilege(
    'anon',
    'public.redact_terminal_booking_for_privacy(uuid,uuid,uuid,uuid,text)',
    'EXECUTE'
  ) or has_function_privilege(
    'authenticated',
    'public.redact_terminal_booking_for_privacy(uuid,uuid,uuid,uuid,text)',
    'EXECUTE'
  ) or not has_function_privilege(
    'service_role',
    'public.redact_terminal_booking_for_privacy(uuid,uuid,uuid,uuid,text)',
    'EXECUTE'
  ) then
    raise exception 'terminal privacy redaction RPC role boundary mismatch';
  end if;

  if exists (
    select 1
    from pg_trigger t
    where t.tgrelid = 'public.bookings'::regclass
      and t.tgname = 'validate_archived_booking_recovery_trigger'
      and (t.tgtype::integer & 8) = 8
  ) then
    raise exception 'terminal trigger unexpectedly claims DELETE coverage';
  end if;

  if v_terminal_guard not like '%v_request_role = ''service_role''%'
     or v_terminal_guard not like
       '%session_user in (''postgres'', ''supabase_admin'')%' then
    raise exception 'privacy trigger exception lacks privileged caller guard';
  end if;
end
$grant_and_scope_proof$;

rollback;
