-- Keep a customer-controlled reschedule from resetting an already-entered
-- late-cancellation window. These nullable snapshots are additive and inert
-- until a customer/voice reschedule occurs inside the salon's configured
-- window; staff reschedules remain discretionary and do not set the lock.

alter table public.bookings
  add column if not exists self_cancel_fee_locked_at timestamptz,
  add column if not exists self_cancel_fee_locked_cents integer,
  add column if not exists self_cancel_fee_lock_reason text;

comment on column public.bookings.self_cancel_fee_locked_at is
  'Immutable timestamp set when a customer-controlled reschedule occurs inside the late-cancellation window.';
comment on column public.bookings.self_cancel_fee_locked_cents is
  'Late-cancellation fee snapshot retained across later customer-controlled reschedules.';
comment on column public.bookings.self_cancel_fee_lock_reason is
  'Customer-controlled channel that locked the fee: customer_reschedule or voice_reschedule.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'bookings_self_cancel_fee_locked_cents_check'
      and conrelid = 'public.bookings'::regclass
  ) then
    alter table public.bookings
      add constraint bookings_self_cancel_fee_locked_cents_check
      check (self_cancel_fee_locked_cents is null or self_cancel_fee_locked_cents >= 0)
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'bookings_self_cancel_fee_lock_reason_check'
      and conrelid = 'public.bookings'::regclass
  ) then
    alter table public.bookings
      add constraint bookings_self_cancel_fee_lock_reason_check
      check (
        self_cancel_fee_lock_reason is null
        or self_cancel_fee_lock_reason in ('customer_reschedule', 'voice_reschedule')
      )
      not valid;
  end if;
end $$;

alter table public.bookings
  validate constraint bookings_self_cancel_fee_locked_cents_check;
alter table public.bookings
  validate constraint bookings_self_cancel_fee_lock_reason_check;

-- The public reschedule route calls this RPC with the service-role client.
-- Preserve the existing conflict/token/waitlist behavior and atomically set a
-- fee lock from the pre-update booking snapshot when the old appointment is
-- already inside the salon's cancellation window.
create or replace function public.reschedule_booking_as_customer(
  p_token_id uuid,
  p_new_start_utc timestamptz,
  p_new_end_utc timestamptz
)
returns table (
  ok boolean,
  code text,
  booking_id uuid,
  service_name text,
  staff_name text,
  new_start_utc timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token booking_reminder_tokens%rowtype;
  v_booking bookings%rowtype;
  v_svc text;
  v_stf text;
  v_tz text;
  v_now timestamptz := clock_timestamp();
  v_self_cancel_enabled boolean := false;
  v_window_hours integer := 24;
  v_self_cancel_percent integer;
  v_noshow_percent integer;
  v_lock_at timestamptz;
  v_lock_cents integer;
begin
  select * into v_token
  from booking_reminder_tokens
  where id = p_token_id and used_at is null and expires_at > v_now
  for update;
  if not found then
    return query select false, 'token_invalid'::text, null::uuid, null::text, null::text, null::timestamptz;
    return;
  end if;

  select * into v_booking
  from bookings
  where id = v_token.booking_id
    and status in ('pending', 'confirmed')
    and start_time_utc > v_now
  for update;
  if not found then
    return query select false, 'booking_not_reschedulable'::text, null::uuid, null::text, null::text, null::timestamptz;
    return;
  end if;

  if p_new_start_utc <= v_now or p_new_end_utc <= p_new_start_utc then
    return query select false, 'invalid_slot'::text, null::uuid, null::text, null::text, null::timestamptz;
    return;
  end if;

  if exists (
    select 1
    from bookings b
    where b.id <> v_booking.id
      and b.salon_id = v_booking.salon_id
      and b.staff_id = v_booking.staff_id
      and b.status not in ('cancelled')
      and b.start_time_utc < p_new_end_utc
      and b.end_time_utc > p_new_start_utc
  ) then
    return query select false, 'slot_conflict'::text, null::uuid, null::text, null::text, null::timestamptz;
    return;
  end if;

  select
    coalesce(s.self_cancel_fee_enabled, false),
    case
      when s.self_cancel_window_hours is not null and s.self_cancel_window_hours > 0
        then s.self_cancel_window_hours
      else 24
    end,
    s.self_cancel_fee_percent,
    s.noshow_fee_percent,
    coalesce(nullif(trim(s.timezone), ''), 'America/Los_Angeles')
  into
    v_self_cancel_enabled,
    v_window_hours,
    v_self_cancel_percent,
    v_noshow_percent,
    v_tz
  from salons s
  where s.id = v_booking.salon_id;

  v_tz := coalesce(v_tz, 'America/Los_Angeles');

  if v_booking.self_cancel_fee_locked_at is null
     and v_self_cancel_enabled
     and v_booking.start_time_utc > v_now
     and v_booking.start_time_utc < v_now + make_interval(hours => v_window_hours)
  then
    v_lock_cents := greatest(0, coalesce(v_booking.noshow_fee_cents, 0));
    if v_self_cancel_percent is not null and coalesce(v_noshow_percent, 0) > 0 then
      v_lock_cents := round(
        v_lock_cents::numeric * v_self_cancel_percent::numeric / v_noshow_percent::numeric
      )::integer;
    end if;
    if v_lock_cents > 0 then
      v_lock_at := v_now;
    end if;
  end if;

  update bookings
  set
    rescheduled_from_time_utc = start_time_utc,
    start_time_utc = p_new_start_utc,
    end_time_utc = p_new_end_utc,
    rescheduled_at = v_now,
    rescheduled_by = 'customer',
    reminder_24h_sent_at = null,
    reminder_3h_sent_at = null,
    status = 'confirmed',
    self_cancel_fee_locked_at = coalesce(self_cancel_fee_locked_at, v_lock_at),
    self_cancel_fee_locked_cents = coalesce(self_cancel_fee_locked_cents, v_lock_cents),
    self_cancel_fee_lock_reason = coalesce(
      self_cancel_fee_lock_reason,
      case when v_lock_at is not null then 'customer_reschedule' end
    )
  where id = v_booking.id;

  update booking_reminder_tokens
  set used_at = v_now, used_action = 'reschedule'
  where id = v_token.id;

  update booking_waitlist_entries
  set status = 'notified', notified_at = v_now, claim_token = gen_random_uuid()
  where id = (
    select id
    from booking_waitlist_entries
    where salon_id = v_booking.salon_id
      and service_id = v_booking.service_id
      and booking_date = (v_booking.start_time_utc at time zone v_tz)::date
      and status = 'waiting'
    order by created_at
    limit 1
    for update skip locked
  );

  select name into v_svc from services where id = v_booking.service_id;
  select name into v_stf from staff where id = v_booking.staff_id;
  return query select true, 'ok'::text, v_booking.id, v_svc, v_stf, p_new_start_utc;
end;
$$;

revoke all on function public.reschedule_booking_as_customer(uuid, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.reschedule_booking_as_customer(uuid, timestamptz, timestamptz)
  to service_role;
