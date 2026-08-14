\set ON_ERROR_STOP on

-- Executed only against Migration History Rehearsal's blank throwaway
-- Supabase. Every fixture and test helper is transaction-scoped and rolled
-- back, including deliberate audit-failure triggers.
begin;

insert into auth.users (
  id,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at
)
values
  (
    '91000000-0000-0000-0000-000000000001',
    'archive-owner@nailiq.invalid',
    '',
    now(),
    '{"provider":"email","providers":["email"]}',
    '{}',
    now()
  ),
  (
    '91000000-0000-0000-0000-000000000002',
    'privacy-ops@nailiq.invalid',
    '',
    now(),
    '{"provider":"email","providers":["email"]}',
    '{}',
    now()
  ),
  (
    '91000000-0000-0000-0000-000000000003',
    'archive-outsider@nailiq.invalid',
    '',
    now(),
    '{"provider":"email","providers":["email"]}',
    '{}',
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
values
  (
    '91000000-0000-0000-0000-000000000001',
    'founder'
  ),
  (
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
  price_cents,
  staff_request_note,
  client_locale,
  noshow_card_id,
  noshow_customer_id,
  noshow_card_last4,
  noshow_card_brand,
  noshow_consent_meta,
  sms_consent_meta,
  deposit_link_url,
  noshow_fee_link_url,
  stripe_payment_intent_id,
  square_payment_link_id,
  square_deposit_order_id,
  square_payment_id,
  noshow_payment_id,
  noshow_fee_order_id
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
    4500,
    null, null, null, null, null, null, null, null,
    null, null, null, null, null, null, null, null
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
    4500,
    null, null, null, null, null, null, null, null,
    null, null, null, null, null, null, null, null
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
    6700,
    'ask for Alice',
    'en',
    'card-private-token',
    'customer-private-token',
    '4242',
    'VISA',
    '{"ip":"192.0.2.1"}'::jsonb,
    '{"ip":"192.0.2.1"}'::jsonb,
    'https://example.invalid/private-deposit-link',
    'https://example.invalid/private-fee-link',
    'pi_private',
    'plink_private',
    'deposit-order-private',
    'deposit-payment-private',
    'noshow-payment-private',
    'noshow-order-private'
  );

-- A separately retained recovery child makes the privacy scope assertion
-- observable: redacting the source must report (but must not silently mutate)
-- the related workflow record.
insert into public.bookings (
  id, salon_id, service_id, staff_id, client_name, client_phone,
  start_time_utc, end_time_utc, status, source, price_cents,
  recovered_from_booking_id, recovery_kind, recovered_by_user_id,
  recovery_request_fingerprint, idempotency_key
) values (
  '95000000-0000-0000-0000-000000000004',
  '92000000-0000-0000-0000-000000000001',
  '93000000-0000-0000-0000-000000000001',
  '94000000-0000-0000-0000-000000000001',
  'Related Recovery Child',
  '+16045550915',
  date_trunc('day', clock_timestamp()) + interval '10 days 12 hours',
  date_trunc('day', clock_timestamp()) + interval '10 days 12 hours 30 minutes',
  'confirmed',
  'appointment',
  6700,
  '95000000-0000-0000-0000-000000000003',
  'cancelled_rebook',
  '91000000-0000-0000-0000-000000000001',
  repeat('f', 64),
  '96000000-0000-0000-0000-000000000003'
);

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
      repeat('a', 64),
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
      null,
      '{}'::uuid[],
      'en',
      false,
      null,
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
      repeat('b', 64),
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
    repeat('a', 64),
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
    null,
    '{}'::uuid[],
    'en',
    false,
    null,
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
    repeat('b', 64),
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

  -- A committed exact retry is canonical even if mutable prerequisites have
  -- since changed.  No new child or side effect is created.
  update public.salons
  set feature_flags = coalesce(feature_flags, '{}'::jsonb)
    || '{"archived_booking_recovery_enabled":false}'::jsonb
  where id = '92000000-0000-0000-0000-000000000001';
  update public.services set deleted_at = clock_timestamp()
  where id = '93000000-0000-0000-0000-000000000001';

  v_retry := public.create_recovered_walkin(
    '95000000-0000-0000-0000-000000000002',
    '91000000-0000-0000-0000-000000000001',
    '96000000-0000-0000-0000-000000000002',
    repeat('b', 64),
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
    '96000000-0000-0000-0000-000000000002',
    repeat('c', 64),
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
  if v_duplicate ->> 'code' <> 'idempotency_mismatch' then
    raise exception 'changed payload reused the request id: %', v_duplicate;
  end if;

  v_duplicate := public.create_recovered_walkin(
    '95000000-0000-0000-0000-000000000002',
    '91000000-0000-0000-0000-000000000001',
    '96000000-0000-0000-0000-000000000099',
    repeat('d', 64),
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
    raise exception 'different recovery request was not rejected: %', v_duplicate;
  end if;

  v_cross_tenant := public.create_recovered_walkin(
    '95000000-0000-0000-0000-000000000002',
    '91000000-0000-0000-0000-000000000001',
    '96000000-0000-0000-0000-000000000098',
    repeat('e', 64),
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
declare
  v_fee_result jsonb;
begin
  begin
    update public.bookings
    set client_name = 'Direct Rewrite'
    where id = '95000000-0000-0000-0000-000000000003';
    raise exception 'direct service-role terminal rewrite unexpectedly succeeded';
  exception
    when check_violation then null;
  end;

  begin
    update public.bookings
    set noshow_charge_status = 'waived'
    where id = '95000000-0000-0000-0000-000000000002';
    raise exception 'direct service-role fee mutation unexpectedly succeeded';
  exception
    when check_violation then null;
  end;

  v_fee_result := public.record_terminal_booking_fee_mutation(
    '95000000-0000-0000-0000-000000000002',
    '92000000-0000-0000-0000-000000000001',
    'waive',
    '98000000-0000-0000-0000-000000000001',
    '91000000-0000-0000-0000-000000000001',
    'owner'
  );
  if coalesce(v_fee_result ->> 'success', 'false') <> 'true'
     or v_fee_result ->> 'charge_status' <> 'waived' then
    raise exception 'audited fee waiver failed: %', v_fee_result;
  end if;
  if not exists (
    select 1 from public.booking_events
    where booking_id = '95000000-0000-0000-0000-000000000002'
      and event_type = 'terminal_booking_fee_mutation_recorded'
      and actor_user_id = '91000000-0000-0000-0000-000000000001'
      and actor_role = 'owner'
      and payload ->> 'requestId' = '98000000-0000-0000-0000-000000000001'
      and payload ->> 'requestFingerprint' ~ '^[0-9a-f]{64}$'
  ) then
    raise exception 'audited fee waiver event missing';
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
  v_before jsonb;
  v_after jsonb;
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

  select to_jsonb(b)
    into strict v_before
    from public.bookings b
   where b.id = '95000000-0000-0000-0000-000000000003';

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
    when others then
      if sqlstate <> 'P9102' then raise; end if;
  end;

  select to_jsonb(b)
    into strict v_after
    from public.bookings b
   where b.id = '95000000-0000-0000-0000-000000000003';

  if v_after is distinct from v_before then
    raise exception 'booking row changed despite failed privacy audit insert; before=%, after=%',
      v_before,
      v_after;
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
      and stripe_payment_intent_id is null
      and square_payment_link_id is null
      and square_deposit_order_id is null
      and square_payment_id is null
      and noshow_payment_id is null
      and noshow_fee_order_id is null
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
      and after_jsonb ->> 'scope' = 'single_terminal_booking'
      and after_jsonb ? 'relatedRecordsRequireSeparateWorkflow'
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
  if coalesce(
       (v_retry ->> 'related_records_require_separate_workflow')::boolean,
       false
     ) is distinct from true then
    raise exception 'privacy replay did not return the canonical scope result: %',
      v_retry;
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

  v_mismatch := public.redact_terminal_booking_for_privacy(
    '95000000-0000-0000-0000-000000000003',
    '92000000-0000-0000-0000-000000000001',
    '91000000-0000-0000-0000-000000000001',
    '97000000-0000-0000-0000-000000000001',
    'verified_erasure_request'
  );
  if v_mismatch ->> 'code' <> 'idempotency_mismatch' then
    raise exception 'privacy actor changed across an exact request retry: %',
      v_mismatch;
  end if;

  v_mismatch := public.redact_terminal_booking_for_privacy(
    '95000000-0000-0000-0000-000000000003',
    '92000000-0000-0000-0000-000000000002',
    '91000000-0000-0000-0000-000000000002',
    '97000000-0000-0000-0000-000000000001',
    'verified_erasure_request'
  );
  if v_mismatch ->> 'code' <> 'invalid_terminal_booking' then
    raise exception 'privacy replay crossed the salon boundary: %', v_mismatch;
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
    'public.create_recovered_walkin(uuid,uuid,uuid,text,uuid,uuid,text,text,text,boolean,text,text,jsonb,integer)',
    'EXECUTE'
  ) or has_function_privilege(
    'authenticated',
    'public.create_recovered_walkin(uuid,uuid,uuid,text,uuid,uuid,text,text,text,boolean,text,text,jsonb,integer)',
    'EXECUTE'
  ) or not has_function_privilege(
    'service_role',
    'public.create_recovered_walkin(uuid,uuid,uuid,text,uuid,uuid,text,text,text,boolean,text,text,jsonb,integer)',
    'EXECUTE'
  ) then
    raise exception 'recovered walk-in RPC role boundary mismatch';
  end if;

  if has_function_privilege(
    'service_role',
    'public.create_recovered_walkin(uuid,uuid,uuid,uuid,uuid,text,text,text,boolean,text,text,jsonb,integer)',
    'EXECUTE'
  ) then
    raise exception 'legacy partial-intent recovered walk-in RPC remains executable';
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
     or v_terminal_guard not like '%v_privileged_owner_session%'
     or v_terminal_guard not like '%v_request_role = ''''%' then
    raise exception 'privacy trigger exception lacks privileged caller guard';
  end if;
end
$grant_and_scope_proof$;

rollback;
