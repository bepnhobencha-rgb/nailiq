-- MQA-0180: claim each booking/reminder/channel occurrence before provider work.
-- A stale in-flight lease becomes outcome_unknown and is never blindly retried.

create table public.booking_reminder_delivery_claims (
  id uuid primary key default extensions.gen_random_uuid(),
  salon_id uuid not null references public.salons(id) on delete cascade,
  booking_id uuid not null references public.bookings(id) on delete cascade,
  appointment_start_utc timestamptz not null,
  reminder_type text not null,
  channel text not null,
  status text not null default 'sending',
  attempt_count integer not null default 1,
  provider_message_id text,
  last_error_code text,
  claimed_at timestamptz not null default transaction_timestamp(),
  lease_expires_at timestamptz not null default transaction_timestamp() + interval '15 minutes',
  completed_at timestamptz,
  updated_at timestamptz not null default transaction_timestamp(),
  constraint booking_reminder_delivery_claims_reminder_type_check
    check (reminder_type in ('24h', '3h')),
  constraint booking_reminder_delivery_claims_channel_check
    check (channel in ('email', 'sms')),
  constraint booking_reminder_delivery_claims_status_check
    check (status in ('sending', 'sent', 'failed', 'unknown', 'suppressed')),
  constraint booking_reminder_delivery_claims_attempt_count_check
    check (attempt_count between 1 and 3),
  constraint booking_reminder_delivery_claims_completion_check
    check (
      (status = 'sending' and completed_at is null)
      or (status <> 'sending' and completed_at is not null)
    ),
  constraint booking_reminder_delivery_claims_lease_check
    check (lease_expires_at > claimed_at),
  constraint booking_reminder_delivery_claims_sent_receipt_check
    check (
      status <> 'sent'
      or nullif(trim(coalesce(provider_message_id, '')), '') is not null
    ),
  constraint booking_reminder_delivery_claims_error_code_check
    check (
      last_error_code is null
      or (
        last_error_code = lower(trim(last_error_code))
        and last_error_code ~ '^[a-z0-9_:-]{1,160}$'
      )
    ),
  constraint booking_reminder_delivery_claims_once
    unique (booking_id, appointment_start_utc, reminder_type, channel)
);

create index booking_reminder_delivery_claims_salon_updated_idx
  on public.booking_reminder_delivery_claims (salon_id, updated_at desc);
create index booking_reminder_delivery_claims_stale_sending_idx
  on public.booking_reminder_delivery_claims (lease_expires_at, id)
  where status = 'sending';

alter table public.booking_reminder_delivery_claims enable row level security;
alter table public.booking_reminder_delivery_claims force row level security;
revoke all privileges on table public.booking_reminder_delivery_claims
  from public, anon, authenticated;
grant all privileges on table public.booking_reminder_delivery_claims
  to service_role;

create or replace function public.claim_booking_reminder_delivery(
  p_salon_id uuid,
  p_booking_id uuid,
  p_appointment_start_utc timestamptz,
  p_reminder_type text,
  p_channel text
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $claim$
declare
  v_claim public.booking_reminder_delivery_claims%rowtype;
begin
  if p_salon_id is null
     or p_booking_id is null
     or p_appointment_start_utc is null
     or p_reminder_type not in ('24h', '3h')
     or p_channel not in ('email', 'sms')
     or not exists (
       select 1
       from public.bookings b
       where b.id = p_booking_id
         and b.salon_id = p_salon_id
         and b.start_time_utc = p_appointment_start_utc
         and b.status in ('pending', 'confirmed')
     ) then
    return jsonb_build_object('success', false, 'code', 'invalid_claim');
  end if;

  insert into public.booking_reminder_delivery_claims (
    salon_id,
    booking_id,
    appointment_start_utc,
    reminder_type,
    channel
  ) values (
    p_salon_id,
    p_booking_id,
    p_appointment_start_utc,
    p_reminder_type,
    p_channel
  )
  on conflict (booking_id, appointment_start_utc, reminder_type, channel)
  do nothing
  returning * into v_claim;

  if found then
    return jsonb_build_object(
      'success', true,
      'code', 'claimed',
      'claimed', true,
      'claim_id', v_claim.id,
      'status', v_claim.status,
      'attempt_count', v_claim.attempt_count
    );
  end if;

  select c.*
  into v_claim
  from public.booking_reminder_delivery_claims c
  where c.booking_id = p_booking_id
    and c.appointment_start_utc = p_appointment_start_utc
    and c.reminder_type = p_reminder_type
    and c.channel = p_channel
  for update;

  if v_claim.status = 'sending'
     and v_claim.lease_expires_at <= transaction_timestamp() then
    update public.booking_reminder_delivery_claims c
    set status = 'unknown',
        last_error_code = coalesce(c.last_error_code, 'stale_sending_outcome_unknown'),
        completed_at = transaction_timestamp(),
        updated_at = transaction_timestamp()
    where c.id = v_claim.id
    returning * into v_claim;
  elsif v_claim.status = 'failed' and v_claim.attempt_count < 3 then
    update public.booking_reminder_delivery_claims c
    set status = 'sending',
        attempt_count = c.attempt_count + 1,
        provider_message_id = null,
        last_error_code = null,
        claimed_at = transaction_timestamp(),
        lease_expires_at = transaction_timestamp() + interval '15 minutes',
        completed_at = null,
        updated_at = transaction_timestamp()
    where c.id = v_claim.id
    returning * into v_claim;

    return jsonb_build_object(
      'success', true,
      'code', 'claimed',
      'claimed', true,
      'claim_id', v_claim.id,
      'status', v_claim.status,
      'attempt_count', v_claim.attempt_count
    );
  end if;

  return jsonb_build_object(
    'success', true,
    'code', 'duplicate_suppressed',
    'claimed', false,
    'claim_id', v_claim.id,
    'status', v_claim.status,
    'attempt_count', v_claim.attempt_count
  );
end;
$claim$;

create or replace function public.complete_booking_reminder_delivery(
  p_claim_id uuid,
  p_status text,
  p_provider_message_id text default null,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $complete$
declare
  v_claim public.booking_reminder_delivery_claims%rowtype;
  v_error_code text := lower(trim(coalesce(p_error_code, '')));
begin
  if p_claim_id is null
     or p_status not in ('sent', 'failed', 'unknown', 'suppressed')
     or (
       p_status = 'sent'
       and nullif(trim(coalesce(p_provider_message_id, '')), '') is null
     )
     or (v_error_code <> '' and v_error_code !~ '^[a-z0-9_:-]{1,160}$') then
    return jsonb_build_object('success', false, 'code', 'invalid_completion');
  end if;

  select c.*
  into v_claim
  from public.booking_reminder_delivery_claims c
  where c.id = p_claim_id
  for update;

  if not found then
    return jsonb_build_object('success', false, 'code', 'claim_not_found');
  end if;

  if v_claim.status <> 'sending' then
    return jsonb_build_object(
      'success', true,
      'code', 'already_completed',
      'status', v_claim.status
    );
  end if;

  update public.booking_reminder_delivery_claims c
  set status = p_status,
      provider_message_id = nullif(left(trim(coalesce(p_provider_message_id, '')), 200), ''),
      last_error_code = nullif(v_error_code, ''),
      completed_at = transaction_timestamp(),
      updated_at = transaction_timestamp()
  where c.id = p_claim_id;

  return jsonb_build_object(
    'success', true,
    'code', 'completed',
    'status', p_status
  );
end;
$complete$;

revoke execute on function public.claim_booking_reminder_delivery(
  uuid, uuid, timestamptz, text, text
) from public, anon, authenticated;
grant execute on function public.claim_booking_reminder_delivery(
  uuid, uuid, timestamptz, text, text
) to service_role;
revoke execute on function public.complete_booking_reminder_delivery(
  uuid, text, text, text
) from public, anon, authenticated;
grant execute on function public.complete_booking_reminder_delivery(
  uuid, text, text, text
) to service_role;
