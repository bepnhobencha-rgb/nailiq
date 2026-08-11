alter table public.staff_shifts
  add column break_start_time time without time zone,
  add column break_end_time time without time zone;

alter table public.staff_shifts
  add constraint staff_shifts_break_pair_check check (
    (break_start_time is null and break_end_time is null)
    or
    (break_start_time is not null and break_end_time is not null)
  ),
  add constraint staff_shifts_break_within_shift_check check (
    break_start_time is null
    or (
      start_time::time < break_start_time
      and break_start_time < break_end_time
      and break_end_time < end_time::time
    )
  );

create or replace view public.public_staff_shifts
with (security_invoker = true)
as
select
  id,
  staff_id,
  salon_id,
  day_of_week,
  start_time,
  end_time,
  is_active,
  break_start_time,
  break_end_time
from public.staff_shifts
where is_active = true;

grant select (break_start_time, break_end_time)
  on public.staff_shifts to anon;

comment on column public.staff_shifts.break_start_time is
  'Optional recurring break start in salon-local HH:MM time; paired with break_end_time.';
comment on column public.staff_shifts.break_end_time is
  'Optional recurring break end in salon-local HH:MM time; paired with break_start_time.';

create or replace function public.reject_booking_during_staff_break()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_timezone text;
  v_local_start timestamp;
  v_local_end timestamp;
  v_day text;
begin
  if new.staff_id is null
     or new.start_time_utc is null
     or new.end_time_utc is null
     or new.deleted_at is not null
     or new.status in ('cancelled', 'waiting', 'no_show') then
    return new;
  end if;

  select coalesce(nullif(s.timezone, ''), 'America/Vancouver')
    into v_timezone
  from public.salons s
  where s.id = new.salon_id;

  v_local_start := new.start_time_utc at time zone v_timezone;
  v_local_end := new.end_time_utc at time zone v_timezone;
  v_day := lower(to_char(v_local_start, 'Dy'));

  if exists (
    select 1
    from public.staff_shifts ss
    where ss.salon_id = new.salon_id
      and ss.staff_id = new.staff_id
      and ss.day_of_week = v_day
      and ss.is_active = true
      and ss.break_start_time is not null
      and ss.break_end_time is not null
      and v_local_start::date = v_local_end::date
      and v_local_start::time < ss.break_end_time
      and v_local_end::time > ss.break_start_time
  ) then
    raise exception 'booking_overlaps_staff_break'
      using errcode = '23P01';
  end if;

  return new;
end;
$$;

drop trigger if exists reject_booking_during_staff_break on public.bookings;
create trigger reject_booking_during_staff_break
before insert or update of salon_id, staff_id, start_time_utc, end_time_utc, status, deleted_at
on public.bookings
for each row execute function public.reject_booking_during_staff_break();

revoke all on function public.reject_booking_during_staff_break() from public;
grant execute on function public.reject_booking_during_staff_break() to authenticated, service_role;

create or replace function public.reject_staff_break_over_booking()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_timezone text;
begin
  if new.break_start_time is null
     or new.break_end_time is null
     or new.is_active is not true then
    return new;
  end if;

  select coalesce(nullif(s.timezone, ''), 'America/Vancouver')
    into v_timezone
  from public.salons s
  where s.id = new.salon_id;

  if exists (
    select 1
    from public.bookings b
    where b.salon_id = new.salon_id
      and b.staff_id = new.staff_id
      and b.deleted_at is null
      and b.status not in ('cancelled', 'waiting', 'no_show')
      and b.end_time_utc > clock_timestamp()
      and lower(to_char(b.start_time_utc at time zone v_timezone, 'Dy')) = new.day_of_week
      and (b.start_time_utc at time zone v_timezone)::date =
          (b.end_time_utc at time zone v_timezone)::date
      and (b.start_time_utc at time zone v_timezone)::time < new.break_end_time
      and (b.end_time_utc at time zone v_timezone)::time > new.break_start_time
  ) then
    raise exception 'staff_break_overlaps_existing_booking'
      using errcode = '23P01';
  end if;

  return new;
end;
$$;

drop trigger if exists reject_staff_break_over_booking on public.staff_shifts;
create trigger reject_staff_break_over_booking
before insert or update of salon_id, staff_id, day_of_week, break_start_time, break_end_time, is_active
on public.staff_shifts
for each row execute function public.reject_staff_break_over_booking();

revoke all on function public.reject_staff_break_over_booking() from public;
grant execute on function public.reject_staff_break_over_booking() to authenticated, service_role;
