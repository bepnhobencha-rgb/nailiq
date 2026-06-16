-- AI Win-back — find lapsed regulars + draft a warm "we miss you" message for
-- the owner to review/send. Same spine as the other agents: gather (DB) → AI
-- drafts → guard → log. The AI only SUGGESTS; sending stays owner-decided.
create table if not exists winback_suggestions (
  id uuid primary key default gen_random_uuid(),
  salon_id uuid,
  client_phone text,
  client_name text,
  client_email text,
  last_visit timestamptz,
  visit_count int,
  lang text,
  channel text,                   -- sms | email (best available)
  message text,
  status text not null default 'suggested',  -- suggested | sent | dismissed
  sent_at timestamptz,
  dismissed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists winback_suggestions_salon_created_idx
  on winback_suggestions (salon_id, created_at desc);
create index if not exists winback_suggestions_salon_phone_idx
  on winback_suggestions (salon_id, client_phone);
alter table winback_suggestions enable row level security;

-- Salon-scoped lapsed-regular finder. client_profiles is GLOBAL (no salon_id),
-- so per-salon history must come from bookings — aggregated here in the DB.
create or replace function winback_candidates(
  p_salon_id uuid,
  p_min_visits int,
  p_lapse_days int,
  p_max_days int,
  p_limit int
) returns table (
  client_phone text,
  client_name text,
  client_email text,
  visits int,
  last_visit timestamptz,
  no_shows int
) language sql stable as $$
  with agg as (
    select b.client_phone,
      max(b.client_name) as client_name,
      max(b.client_email) filter (where coalesce(b.client_email, '') <> '') as client_email,
      count(*) filter (where b.status <> 'cancelled')::int as visits,
      count(*) filter (where b.status = 'no_show')::int as no_shows,
      max(b.start_time_utc) as last_visit
    from bookings b
    where b.salon_id = p_salon_id and coalesce(b.client_phone, '') <> ''
    group by b.client_phone
  )
  select client_phone, client_name, client_email, visits, last_visit, no_shows
  from agg
  where visits >= p_min_visits
    and last_visit < now() - make_interval(days => p_lapse_days)
    and last_visit > now() - make_interval(days => p_max_days)
  order by visits desc, last_visit desc
  limit p_limit;
$$;
