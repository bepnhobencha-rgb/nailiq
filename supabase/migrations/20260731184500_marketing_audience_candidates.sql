-- Channel-aware audience source for owner-approved marketing execution.
--
-- `winback_candidates` gates its segment on `client_profiles.marketing_consent_at`,
-- which is the legacy *SMS* marketing consent timestamp. Every pilot salon runs
-- `customer_channel = 'email_only'` with `sms_a2p_registered = false`, so that
-- gate removes customers who explicitly consented to marketing *email*.
--
-- Measured on production 2026-07-31: 11,351 client profiles hold 4,267 email
-- consents against 10 SMS consents, so the approved bulk_message path could
-- reach 1 lapsed regular at Hi-Lite Head Spa and 0 at Hi-Lite Studio.
--
-- This function is additive: `winback_candidates` keeps its exact behaviour for
-- the Kéo Về agent (src/shared/winback/agentWinback.ts). Only the AI execution
-- audience builder reads this one.
--
-- The gate here is deliberately a SUPERSET of what may actually be messaged.
-- Per-recipient channel consent, salon channel mode, A2P state and the 24h
-- contact dedupe are all re-checked in TypeScript by
-- `decideAudienceEligibility` (src/shared/ai/audienceEligibility.ts), which
-- narrows this list. Widening here can never widen who receives a message.

create or replace function public.marketing_audience_candidates(
  p_salon_id uuid,
  p_min_visits integer,
  p_lapse_days integer,
  p_max_days integer,
  p_limit integer
)
returns table(
  client_phone text,
  client_name text,
  client_email text,
  visits integer,
  last_visit timestamp with time zone,
  no_shows integer,
  usual_service text
)
language sql
stable
set search_path to 'public', 'pg_catalog'
as $function$
  with
  square_candidates as (
    select
      cp.phone                   as client_phone,
      cp.name                    as client_name,
      count(svh.id)::int         as visits,
      max(svh.square_created_at) as last_visit
    from square_visit_history svh
    join client_profiles cp on cp.id = svh.client_profile_id
    where svh.salon_id = p_salon_id and coalesce(cp.phone, '') <> ''
    group by cp.id, cp.phone, cp.name
  ),
  booking_candidates as (
    select
      b.client_phone,
      max(b.client_name)                                   as client_name,
      count(*) filter (where b.status <> 'cancelled')::int  as visits,
      max(b.start_time_utc)                                as last_visit
    from bookings b
    where b.salon_id = p_salon_id
      and coalesce(b.client_phone, '') <> ''
      and not exists (
        select 1 from square_visit_history svh2
        join client_profiles cp2 on cp2.id = svh2.client_profile_id
        where svh2.salon_id = p_salon_id and cp2.phone = b.client_phone
      )
    group by b.client_phone
  ),
  combined as (
    select client_phone, client_name, visits, last_visit from square_candidates
    union all
    select client_phone, client_name, visits, last_visit from booking_candidates
  ),
  noshow_stats as (
    select b.client_phone,
      count(*) filter (where b.status = 'no_show')::int as no_shows
    from bookings b
    where b.salon_id = p_salon_id and coalesce(b.client_phone, '') <> ''
    group by b.client_phone
  ),
  email_lookup as (
    select distinct on (b.client_phone) b.client_phone, b.client_email
    from bookings b
    where b.salon_id = p_salon_id and coalesce(b.client_email, '') <> ''
    order by b.client_phone, b.created_at desc
  ),
  usual_svc_booking as (
    select b.client_phone,
      mode() within group (order by s.name) as usual_service
    from bookings b
    join services s on s.id = b.service_id
    where b.salon_id = p_salon_id and b.status not in ('cancelled', 'no_show')
    group by b.client_phone
  ),
  usual_svc_square as (
    select cp.phone as client_phone,
      mode() within group (order by svc_name) as usual_service
    from square_visit_history svh
    join client_profiles cp on cp.id = svh.client_profile_id,
    lateral unnest(svh.service_names) as svc_name
    where svh.salon_id = p_salon_id
      and svc_name not ilike '%fee%'
      and svc_name not ilike '%product%'
      and svc_name not ilike '%tip%'
      and svc_name not ilike '%tax%'
      and svc_name not ilike '%discount%'
      and svc_name not ilike '%gift%'
      and svc_name not ilike '%card%'
    group by cp.phone
  )
  select
    c.client_phone,
    c.client_name,
    el.client_email,
    c.visits,
    c.last_visit,
    coalesce(ns.no_shows, 0)                       as no_shows,
    coalesce(usb.usual_service, uss.usual_service) as usual_service
  from combined c
  left join noshow_stats ns       on ns.client_phone  = c.client_phone
  left join email_lookup el       on el.client_phone  = c.client_phone
  left join usual_svc_booking usb on usb.client_phone = c.client_phone
  left join usual_svc_square  uss on uss.client_phone = c.client_phone
  where c.visits >= p_min_visits
    and c.last_visit < now() - make_interval(days => p_lapse_days)
    and c.last_visit > now() - make_interval(days => p_max_days)
    and not exists (
      select 1 from bookings f
      where f.salon_id = p_salon_id
        and f.client_phone = c.client_phone
        and f.status in ('confirmed', 'pending')
        and f.start_time_utc > now()
    )
    and (
      -- Legacy consent timestamps: either channel counts here.
      exists (
        select 1 from client_profiles cp3
        where cp3.phone = c.client_phone
          and (
            cp3.marketing_consent_at is not null
            or cp3.marketing_email_consent_at is not null
          )
      )
      -- Structured per-salon preference is the newer source of truth and can
      -- grant consent for a customer who has no legacy timestamp at all.
      or exists (
        select 1
        from client_profiles cp4
        join customer_preferences pref
          on pref.client_profile_id = cp4.id
         and pref.salon_id = p_salon_id
        where cp4.phone = c.client_phone
          and (
            pref.consent_marketing_sms is true
            or pref.consent_marketing_email is true
          )
      )
    )
  order by c.visits desc, c.last_visit desc
  limit p_limit;
$function$;

comment on function public.marketing_audience_candidates(uuid, integer, integer, integer, integer) is
  'Channel-aware lapsed-regular segment for AI execution audiences. Consent is re-checked per recipient in decideAudienceEligibility; this gate is intentionally a superset.';

-- Server-side only: the AI execution audience builder runs under the service
-- role. No browser-reachable role gets a customer segment.
revoke all on function public.marketing_audience_candidates(uuid, integer, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.marketing_audience_candidates(uuid, integer, integer, integer, integer)
  to service_role;
