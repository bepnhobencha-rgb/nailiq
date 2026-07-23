-- AI "Due to Rebook" — proactively nudge on-rhythm regulars who are coming due
-- for their next visit but haven't booked yet (distinct from win-back, which
-- only fires once a customer is already 45+ days lapsed). Reuses the
-- winback_suggestions table with a `kind` discriminator.
alter table winback_suggestions
  add column if not exists kind text not null default 'lapsed';  -- 'lapsed' | 'due'

-- Salon-scoped finder: customers whose median visit cadence says they're due
-- (predicted next visit within the look-ahead window, or modestly overdue) yet
-- have no upcoming booking. Cadence = median gap between distinct PAST visit
-- days (mirrors src/shared/booking/returnRhythm.ts: ≥3 visits, gaps 1..183).
create or replace function rebook_due_candidates(
  p_salon_id uuid,
  p_min_visits int,
  p_lookahead_days int,
  p_overdue_days int,
  p_limit int
) returns table (
  client_phone text,
  client_name text,
  client_email text,
  visits int,
  last_visit date,
  cadence_days int,
  predicted_next date,
  usual_service text
) language sql stable as $$
  with visit_days as (
    select b.client_phone, (b.start_time_utc at time zone 'America/Los_Angeles')::date as vday
    from bookings b
    where b.salon_id = p_salon_id
      and coalesce(b.client_phone, '') <> ''
      and b.start_time_utc < now()
      and b.status not in ('cancelled', 'pending')
    group by b.client_phone, (b.start_time_utc at time zone 'America/Los_Angeles')::date
  ),
  gaps as (
    select client_phone, vday,
      (vday - lag(vday) over (partition by client_phone order by vday)) as gap
    from visit_days
  ),
  agg as (
    select client_phone,
      count(*) as ndays,
      max(vday) as last_visit,
      percentile_cont(0.5) within group (order by gap) filter (where gap between 1 and 183) as cadence
    from gaps
    group by client_phone
  )
  select a.client_phone,
    (select max(b.client_name) from bookings b where b.salon_id = p_salon_id and b.client_phone = a.client_phone) as client_name,
    (select max(b.client_email) from bookings b where b.salon_id = p_salon_id and b.client_phone = a.client_phone and coalesce(b.client_email,'') <> '') as client_email,
    a.ndays::int as visits,
    a.last_visit,
    round(a.cadence)::int as cadence_days,
    (a.last_visit + round(a.cadence)::int) as predicted_next,
    (select mode() within group (order by s.name)
       from bookings b2 join services s on s.id = b2.service_id
       where b2.salon_id = p_salon_id and b2.client_phone = a.client_phone) as usual_service
  from agg a
  where a.ndays >= p_min_visits
    and a.cadence is not null
    and (a.last_visit + round(a.cadence)::int) <= current_date + p_lookahead_days
    and (a.last_visit + round(a.cadence)::int) >= current_date - p_overdue_days
    and not exists (
      select 1 from bookings f
      where f.salon_id = p_salon_id and f.client_phone = a.client_phone
        and f.status in ('confirmed', 'pending') and f.start_time_utc > now()
    )
  order by (a.last_visit + round(a.cadence)::int) asc
  limit p_limit;
$$;
