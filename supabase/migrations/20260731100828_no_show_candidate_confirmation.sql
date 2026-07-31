-- A late confirmed booking is only a review candidate. Per the booking state
-- machine, a human desk role must explicitly acknowledge confirmed -> no_show.
alter table public.bookings
  add column if not exists no_show_candidate_at timestamptz;

comment on column public.bookings.no_show_candidate_at is
  'When the auto-no-show threshold first identified this still-confirmed booking for human review. This flag never changes booking.status or client no-show history.';

create index if not exists bookings_no_show_candidate_review_idx
  on public.bookings (salon_id, no_show_candidate_at)
  where status = 'confirmed' and no_show_candidate_at is not null;

create or replace function public.auto_mark_no_shows()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer := 0;
begin
  with flagged as (
    update public.bookings b
       set no_show_candidate_at = now()
      from public.salons s
     where b.salon_id = s.id
       and s.auto_no_show_minutes is not null
       and s.auto_no_show_minutes > 0
       and b.status = 'confirmed'
       and b.no_show_candidate_at is null
       and b.start_time_utc < now() - make_interval(mins => s.auto_no_show_minutes)
    returning 1
  )
  select count(*)::integer into v_count from flagged;

  return v_count;
end;
$$;

comment on function public.auto_mark_no_shows() is
  'Idempotently flags overdue confirmed bookings for human no-show review. Never changes booking status, charges a fee, or increments client no-show history.';

revoke all on function public.auto_mark_no_shows() from public;
grant execute on function public.auto_mark_no_shows() to service_role;
