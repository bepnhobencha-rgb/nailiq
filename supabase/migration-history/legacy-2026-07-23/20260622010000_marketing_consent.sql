-- Marketing consent: explicit opt-in column on client_profiles.
-- Customers who tick the marketing checkbox at booking gate get
-- marketing_consent_at stamped with the time they consented.
-- NULL = no consent (default) — Minh agents skip these customers.
ALTER TABLE public.client_profiles
  ADD COLUMN IF NOT EXISTS marketing_consent_at timestamptz;

-- Update winback_candidates to honour marketing consent.
-- Only returns customers who have explicitly opted in to marketing.
CREATE OR REPLACE FUNCTION public.winback_candidates(
  p_salon_id    uuid,
  p_min_visits  integer,
  p_lapse_days  integer,
  p_max_days    integer,
  p_limit       integer
) RETURNS TABLE(
  client_phone   text,
  client_name    text,
  client_email   text,
  visits         integer,
  last_visit     timestamp with time zone,
  no_shows       integer,
  usual_service  text
) LANGUAGE sql STABLE AS $function$
  WITH
  square_candidates AS (
    SELECT
      cp.phone                       AS client_phone,
      cp.name                        AS client_name,
      COUNT(svh.id)::int             AS visits,
      MAX(svh.square_created_at)     AS last_visit
    FROM square_visit_history svh
    JOIN client_profiles cp ON cp.id = svh.client_profile_id
    WHERE svh.salon_id = p_salon_id AND coalesce(cp.phone, '') <> ''
    GROUP BY cp.id, cp.phone, cp.name
  ),
  booking_candidates AS (
    SELECT
      b.client_phone,
      max(b.client_name)                                   AS client_name,
      count(*) FILTER (WHERE b.status <> 'cancelled')::int AS visits,
      max(b.start_time_utc)                                AS last_visit
    FROM bookings b
    WHERE b.salon_id = p_salon_id
      AND coalesce(b.client_phone, '') <> ''
      AND NOT EXISTS (
        SELECT 1 FROM square_visit_history svh2
        JOIN client_profiles cp2 ON cp2.id = svh2.client_profile_id
        WHERE svh2.salon_id = p_salon_id AND cp2.phone = b.client_phone
      )
    GROUP BY b.client_phone
  ),
  combined AS (
    SELECT client_phone, client_name, visits, last_visit FROM square_candidates
    UNION ALL
    SELECT client_phone, client_name, visits, last_visit FROM booking_candidates
  ),
  noshow_stats AS (
    SELECT b.client_phone,
      count(*) FILTER (WHERE b.status = 'no_show')::int AS no_shows
    FROM bookings b
    WHERE b.salon_id = p_salon_id AND coalesce(b.client_phone, '') <> ''
    GROUP BY b.client_phone
  ),
  email_lookup AS (
    SELECT DISTINCT ON (b.client_phone) b.client_phone, b.client_email
    FROM bookings b
    WHERE b.salon_id = p_salon_id AND coalesce(b.client_email, '') <> ''
    ORDER BY b.client_phone, b.created_at DESC
  ),
  usual_svc_booking AS (
    SELECT b.client_phone,
      mode() WITHIN GROUP (ORDER BY s.name) AS usual_service
    FROM bookings b
    JOIN services s ON s.id = b.service_id
    WHERE b.salon_id = p_salon_id AND b.status NOT IN ('cancelled', 'no_show')
    GROUP BY b.client_phone
  ),
  usual_svc_square AS (
    SELECT cp.phone AS client_phone,
      mode() WITHIN GROUP (ORDER BY svc_name) AS usual_service
    FROM square_visit_history svh
    JOIN client_profiles cp ON cp.id = svh.client_profile_id,
    LATERAL unnest(svh.service_names) AS svc_name
    WHERE svh.salon_id = p_salon_id
      AND svc_name NOT ILIKE '%fee%'
      AND svc_name NOT ILIKE '%product%'
      AND svc_name NOT ILIKE '%tip%'
      AND svc_name NOT ILIKE '%tax%'
      AND svc_name NOT ILIKE '%discount%'
      AND svc_name NOT ILIKE '%gift%'
      AND svc_name NOT ILIKE '%card%'
    GROUP BY cp.phone
  )
  SELECT
    c.client_phone,
    c.client_name,
    el.client_email,
    c.visits,
    c.last_visit,
    coalesce(ns.no_shows, 0)                        AS no_shows,
    coalesce(usb.usual_service, uss.usual_service)  AS usual_service
  FROM combined c
  LEFT JOIN noshow_stats ns       ON ns.client_phone  = c.client_phone
  LEFT JOIN email_lookup el       ON el.client_phone  = c.client_phone
  LEFT JOIN usual_svc_booking usb ON usb.client_phone = c.client_phone
  LEFT JOIN usual_svc_square  uss ON uss.client_phone = c.client_phone
  WHERE c.visits >= p_min_visits
    AND c.last_visit < now() - make_interval(days => p_lapse_days)
    AND c.last_visit > now() - make_interval(days => p_max_days)
    AND NOT EXISTS (
      SELECT 1 FROM bookings f
      WHERE f.salon_id = p_salon_id
        AND f.client_phone = c.client_phone
        AND f.status IN ('confirmed', 'pending')
        AND f.start_time_utc > now()
    )
    AND EXISTS (
      SELECT 1 FROM client_profiles cp3
      WHERE cp3.phone = c.client_phone
        AND cp3.marketing_consent_at IS NOT NULL
    )
  ORDER BY c.visits DESC, c.last_visit DESC
  LIMIT p_limit;
$function$;

-- Update rebook_due_candidates to honour marketing consent.
CREATE OR REPLACE FUNCTION public.rebook_due_candidates(
  p_salon_id uuid,
  p_min_visits int,
  p_lookahead_days int,
  p_overdue_days int,
  p_limit int
) RETURNS TABLE (
  client_phone text,
  client_name text,
  client_email text,
  visits int,
  last_visit date,
  cadence_days int,
  predicted_next date,
  usual_service text
) LANGUAGE sql STABLE AS $$
  WITH visit_days AS (
    SELECT b.client_phone, (b.start_time_utc AT TIME ZONE 'America/Los_Angeles')::date AS vday
    FROM bookings b
    WHERE b.salon_id = p_salon_id
      AND coalesce(b.client_phone, '') <> ''
      AND b.start_time_utc < now()
      AND b.status NOT IN ('cancelled', 'pending')
    GROUP BY b.client_phone, (b.start_time_utc AT TIME ZONE 'America/Los_Angeles')::date
  ),
  gaps AS (
    SELECT client_phone, vday,
      (vday - lag(vday) OVER (PARTITION BY client_phone ORDER BY vday)) AS gap
    FROM visit_days
  ),
  agg AS (
    SELECT client_phone,
      count(*) AS ndays,
      max(vday) AS last_visit,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY gap) FILTER (WHERE gap BETWEEN 1 AND 183) AS cadence
    FROM gaps
    GROUP BY client_phone
  )
  SELECT a.client_phone,
    (SELECT max(b.client_name) FROM bookings b WHERE b.salon_id = p_salon_id AND b.client_phone = a.client_phone) AS client_name,
    (SELECT max(b.client_email) FROM bookings b WHERE b.salon_id = p_salon_id AND b.client_phone = a.client_phone AND coalesce(b.client_email,'') <> '') AS client_email,
    a.ndays::int AS visits,
    a.last_visit,
    round(a.cadence)::int AS cadence_days,
    (a.last_visit + round(a.cadence)::int) AS predicted_next,
    (SELECT mode() WITHIN GROUP (ORDER BY s.name)
       FROM bookings b2 JOIN services s ON s.id = b2.service_id
       WHERE b2.salon_id = p_salon_id AND b2.client_phone = a.client_phone) AS usual_service
  FROM agg a
  WHERE a.ndays >= p_min_visits
    AND a.cadence IS NOT NULL
    AND (a.last_visit + round(a.cadence)::int) <= current_date + p_lookahead_days
    AND (a.last_visit + round(a.cadence)::int) >= current_date - p_overdue_days
    AND NOT EXISTS (
      SELECT 1 FROM bookings f
      WHERE f.salon_id = p_salon_id AND f.client_phone = a.client_phone
        AND f.status IN ('confirmed', 'pending') AND f.start_time_utc > now()
    )
    AND EXISTS (
      SELECT 1 FROM client_profiles cp
      WHERE cp.phone = a.client_phone
        AND cp.marketing_consent_at IS NOT NULL
    )
  ORDER BY (a.last_visit + round(a.cadence)::int) ASC
  LIMIT p_limit;
$$;
