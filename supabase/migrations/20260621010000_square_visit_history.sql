-- square_visit_history: one row per completed Square payment.
-- Gives AI agents per-visit data (date, amount, services) instead of only the
-- aggregated totals in salon_client_spend. Foundation for:
--   • Win-back / Rebook: "Time for your Hi-Lite Royal?" personalisation
--   • Watchdog / Daily Reporter: real daily revenue trend
--   • VIP Care: milestone counting (10th / 25th visit)
--   • Chiến Lược Gia: service popularity trends

-- 1. Main table ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS square_visit_history (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id            uuid        NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  client_profile_id   uuid        REFERENCES client_profiles(id) ON DELETE SET NULL,
  square_customer_id  text        NOT NULL,
  square_payment_id   text        NOT NULL,
  square_created_at   timestamptz NOT NULL,
  visit_date          date        NOT NULL,
  amount_cents        integer     NOT NULL DEFAULT 0,
  order_id            text,
  service_names       text[],
  synced_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT square_visit_history_salon_payment_uniq
    UNIQUE (salon_id, square_payment_id)
);

CREATE INDEX IF NOT EXISTS idx_sqvh_salon_profile_date
  ON square_visit_history (salon_id, client_profile_id, square_created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sqvh_salon_date
  ON square_visit_history (salon_id, square_created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sqvh_salon_customer
  ON square_visit_history (salon_id, square_customer_id);
CREATE INDEX IF NOT EXISTS idx_sqvh_visit_date
  ON square_visit_history (salon_id, visit_date DESC);

ALTER TABLE square_visit_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_only" ON square_visit_history
  FOR ALL USING (auth.role() = 'service_role');

-- 2. winback_candidates v3: Square visit history as primary source.
-- Hi-Lite: 97% of customers only exist in Square (POS payments), not NailIQ
-- bookings. Old RPC missed them entirely. Now Square is primary; bookings is
-- fallback for salons without Square integration.
DROP FUNCTION IF EXISTS public.winback_candidates(uuid,integer,integer,integer,integer);

CREATE FUNCTION public.winback_candidates(
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
  -- Prefer clean NailIQ service names (consistent casing); fall back to Square
  -- order line items filtering out known non-service items (fees, products, etc.)
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
  ORDER BY c.visits DESC, c.last_visit DESC
  LIMIT p_limit;
$function$;
