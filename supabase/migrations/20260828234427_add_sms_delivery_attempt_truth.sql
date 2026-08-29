-- Phase D: one durable provider-boundary ledger for every application SMS.
-- Domain outboxes remain authoritative for business idempotency. This ledger
-- records each actual dispatcher attempt before Twilio can be called and binds
-- its signed delivery callback directly to that attempt.

create table if not exists public.sms_delivery_attempts (
  id uuid primary key default gen_random_uuid(),
  salon_id uuid not null references public.salons(id) on delete cascade,
  booking_id uuid references public.bookings(id) on delete set null,
  notification_type text not null default 'sms_dispatch',
  recipient_fingerprint text not null,
  body_fingerprint text not null,
  status text not null default 'sending',
  attempt_token uuid,
  provider_message_sid text,
  error_code text,
  suppression_reason text,
  started_at timestamptz not null default clock_timestamp(),
  provider_accepted_at timestamptz,
  delivered_at timestamptz,
  failed_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  constraint sms_delivery_attempts_notification_type_check check (
    notification_type ~ '^[a-z][a-z0-9_]{0,79}$'
  ),
  constraint sms_delivery_attempts_recipient_fingerprint_check check (
    recipient_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  constraint sms_delivery_attempts_body_fingerprint_check check (
    body_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  constraint sms_delivery_attempts_status_check check (
    status in (
      'sending', 'accepted', 'delivered', 'undelivered', 'failed',
      'suppressed', 'unknown'
    )
  ),
  constraint sms_delivery_attempts_provider_sid_check check (
    provider_message_sid is null
    or provider_message_sid ~ '^(SM|MM)[0-9A-Fa-f]{32}$'
  ),
  constraint sms_delivery_attempts_state_check check (
    (status = 'sending' and attempt_token is not null and completed_at is null)
    or
    (status <> 'sending' and attempt_token is null and completed_at is not null)
  ),
  constraint sms_delivery_attempts_acceptance_receipt_check check (
    status not in ('accepted', 'delivered', 'undelivered')
    or provider_message_sid is not null
  ),
  constraint sms_delivery_attempts_suppression_check check (
    (status = 'suppressed' and suppression_reason is not null)
    or (status <> 'suppressed' and suppression_reason is null)
  )
);

create unique index if not exists sms_delivery_attempts_provider_sid_once
  on public.sms_delivery_attempts(provider_message_sid)
  where provider_message_sid is not null;

create index if not exists sms_delivery_attempts_salon_started_idx
  on public.sms_delivery_attempts(salon_id, started_at desc);

create index if not exists sms_delivery_attempts_unresolved_idx
  on public.sms_delivery_attempts(started_at)
  where status in ('sending', 'accepted', 'unknown');

alter table public.sms_delivery_attempts enable row level security;

revoke all on table public.sms_delivery_attempts from public, anon, authenticated;
grant select, insert, update on table public.sms_delivery_attempts to service_role;

create or replace function public.claim_sms_delivery_attempt(
  p_salon_id uuid,
  p_booking_id uuid,
  p_notification_type text,
  p_recipient_fingerprint text,
  p_body_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $claim$
declare
  v_id uuid := gen_random_uuid();
  v_token uuid := gen_random_uuid();
begin
  if p_salon_id is null
     or p_notification_type is null
     or p_notification_type !~ '^[a-z][a-z0-9_]{0,79}$'
     or p_recipient_fingerprint is null
     or p_recipient_fingerprint !~ '^[0-9a-f]{64}$'
     or p_body_fingerprint is null
     or p_body_fingerprint !~ '^[0-9a-f]{64}$'
     or (p_booking_id is not null and not exists (
       select 1 from public.bookings b
       where b.id = p_booking_id and b.salon_id = p_salon_id
     ))
     or not exists (select 1 from public.salons s where s.id = p_salon_id)
  then
    return jsonb_build_object('success', false, 'code', 'invalid_attempt');
  end if;

  insert into public.sms_delivery_attempts (
    id, salon_id, booking_id, notification_type,
    recipient_fingerprint, body_fingerprint, status, attempt_token
  ) values (
    v_id, p_salon_id, p_booking_id, p_notification_type,
    p_recipient_fingerprint, p_body_fingerprint, 'sending', v_token
  );

  return jsonb_build_object(
    'success', true,
    'code', 'claimed',
    'attempt_id', v_id,
    'attempt_token', v_token
  );
exception when others then
  return jsonb_build_object('success', false, 'code', 'claim_unavailable');
end;
$claim$;

create or replace function public.complete_sms_delivery_attempt(
  p_attempt_id uuid,
  p_attempt_token uuid,
  p_status text,
  p_provider_message_sid text default null,
  p_error_code text default null,
  p_suppression_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $complete$
declare
  v_row public.sms_delivery_attempts%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if p_attempt_id is null
     or p_attempt_token is null
     or p_status not in ('accepted', 'failed', 'suppressed', 'unknown')
     or (p_status = 'accepted' and (
       p_provider_message_sid is null
       or p_provider_message_sid !~ '^(SM|MM)[0-9A-Fa-f]{32}$'
     ))
     or (p_status <> 'accepted' and p_provider_message_sid is not null)
     or (p_status = 'suppressed') is distinct from (p_suppression_reason is not null)
     or length(coalesce(p_error_code, '')) > 160
     or length(coalesce(p_suppression_reason, '')) > 160
  then
    return jsonb_build_object('success', false, 'code', 'invalid_completion');
  end if;

  select a.* into v_row
  from public.sms_delivery_attempts a
  where a.id = p_attempt_id
  for update;

  if not found then
    return jsonb_build_object('success', false, 'code', 'attempt_not_found');
  end if;

  -- A signed terminal callback may arrive before the provider response is
  -- persisted. Never overwrite that stronger evidence.
  if v_row.status in ('delivered', 'undelivered', 'failed')
     and v_row.provider_message_sid is not null
  then
    return jsonb_build_object(
      'success', true,
      'code', 'callback_terminal',
      'status', v_row.status
    );
  end if;

  if v_row.status <> 'sending' then
    if v_row.status = p_status
       and v_row.provider_message_sid is not distinct from p_provider_message_sid
       and v_row.error_code is not distinct from p_error_code
       and v_row.suppression_reason is not distinct from p_suppression_reason
    then
      return jsonb_build_object('success', true, 'code', 'already_completed', 'status', v_row.status);
    end if;
    return jsonb_build_object('success', false, 'code', 'completion_conflict');
  end if;

  if v_row.attempt_token is distinct from p_attempt_token then
    return jsonb_build_object('success', false, 'code', 'lease_lost');
  end if;

  update public.sms_delivery_attempts
  set status = p_status,
      attempt_token = null,
      provider_message_sid = p_provider_message_sid,
      error_code = p_error_code,
      suppression_reason = p_suppression_reason,
      provider_accepted_at = case when p_status = 'accepted' then v_now end,
      failed_at = case when p_status = 'failed' then v_now end,
      completed_at = v_now,
      updated_at = v_now
  where id = p_attempt_id;

  return jsonb_build_object('success', true, 'code', 'completed', 'status', p_status);
exception when unique_violation then
  return jsonb_build_object('success', false, 'code', 'provider_receipt_conflict');
when others then
  return jsonb_build_object('success', false, 'code', 'completion_unavailable');
end;
$complete$;

create or replace function public.record_sms_delivery_attempt_receipt(
  p_attempt_id uuid,
  p_message_sid text,
  p_status text,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $receipt$
declare
  v_row public.sms_delivery_attempts%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if p_attempt_id is null
     or p_message_sid is null
     or p_message_sid !~ '^(SM|MM)[0-9A-Fa-f]{32}$'
     or p_status not in ('delivered', 'undelivered', 'failed')
     or (p_status = 'delivered' and p_error_code is not null)
     or length(coalesce(p_error_code, '')) > 160
  then
    return jsonb_build_object('success', false, 'code', 'invalid_receipt');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_message_sid, 1040197)
  );

  select a.* into v_row
  from public.sms_delivery_attempts a
  where a.id = p_attempt_id
  for update;

  if not found then
    return jsonb_build_object('success', false, 'code', 'attempt_not_found');
  end if;
  if v_row.provider_message_sid is not null
     and v_row.provider_message_sid <> p_message_sid
  then
    return jsonb_build_object('success', false, 'code', 'correlation_conflict');
  end if;
  if v_row.status in ('delivered', 'undelivered', 'failed') then
    if v_row.status = p_status
       and v_row.provider_message_sid = p_message_sid
       and v_row.error_code is not distinct from p_error_code
    then
      return jsonb_build_object('success', true, 'code', 'exact_replay', 'status', v_row.status);
    end if;
    return jsonb_build_object('success', false, 'code', 'terminal_conflict');
  end if;
  -- `unknown` deliberately remains reconcilable: a transport exception may
  -- occur after Twilio accepted the request, and the later signed callback is
  -- stronger evidence. Only a proven no-send suppression is incompatible.
  if v_row.status = 'suppressed' then
    return jsonb_build_object('success', false, 'code', 'state_conflict');
  end if;

  update public.sms_delivery_attempts
  set status = p_status,
      attempt_token = null,
      provider_message_sid = p_message_sid,
      error_code = p_error_code,
      provider_accepted_at = coalesce(provider_accepted_at, v_now),
      delivered_at = case when p_status = 'delivered' then v_now end,
      failed_at = case when p_status in ('undelivered', 'failed') then v_now end,
      completed_at = v_now,
      updated_at = v_now
  where id = p_attempt_id;

  return jsonb_build_object('success', true, 'code', 'applied', 'status', p_status);
exception when unique_violation then
  return jsonb_build_object('success', false, 'code', 'provider_receipt_conflict');
when others then
  return jsonb_build_object('success', false, 'code', 'receipt_unavailable');
end;
$receipt$;

revoke execute on function public.claim_sms_delivery_attempt(uuid, uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.claim_sms_delivery_attempt(uuid, uuid, text, text, text)
  to service_role;

revoke execute on function public.complete_sms_delivery_attempt(uuid, uuid, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.complete_sms_delivery_attempt(uuid, uuid, text, text, text, text)
  to service_role;

revoke execute on function public.record_sms_delivery_attempt_receipt(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.record_sms_delivery_attempt_receipt(uuid, text, text, text)
  to service_role;
