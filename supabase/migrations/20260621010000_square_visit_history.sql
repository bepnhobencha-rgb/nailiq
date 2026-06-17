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
  visit_date          date        NOT NULL,    -- square_created_at cast to date (LA tz)
  amount_cents        integer     NOT NULL DEFAULT 0,
  order_id            text,
  service_names       text[],                  -- from Square order line items
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

-- 2. Update winback_candidates RPC to return usual_service -------------------
-- Previously the RPC only returned visits/last_visit/no_shows with no service
-- context, so the AI drafted generic "We miss you" messages. Adding usual_service
-- (MODE aggregate from bookings → services) lets the agent write
-- "Time for your Hi-Lite Royal?" instead.
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
  WITH agg AS (
    SELECT
      b.client_phone,
      max(b.client_name)  AS client_name,
      max(b.client_email) FILTER (WHERE coalesce(b.client_email, '') <> '') AS client_email,
      count(*) FILTER (WHERE b.status <> 'cancelled')::int AS visits,
      count(*) FILTER (WHERE b.status = 'no_show')::int    AS no_shows,
      max(b.start_time_utc) AS last_visit
    FROM bookings b
    WHERE b.salon_id = p_salon_id
      AND coalesce(b.client_phone, '') <> ''
    GROUP BY b.client_phone
  )
  SELECT
    a.client_phone,
    a.client_name,
    a.client_email,
    a.visits,
    a.last_visit,
    a.no_shows,
    (
      SELECT mode() WITHIN GROUP (ORDER BY s.name)
      FROM bookings b2
      JOIN services s ON s.id = b2.service_id
      WHERE b2.salon_id  = p_salon_id
        AND b2.client_phone = a.client_phone
        AND b2.status NOT IN ('cancelled', 'no_show')
    ) AS usual_service
  FROM agg a
  WHERE a.visits >= p_min_visits
    AND a.last_visit < now() - make_interval(days => p_lapse_days)
    AND a.last_visit > now() - make_interval(days => p_max_days)
  ORDER BY a.visits DESC, a.last_visit DESC
  LIMIT p_limit;
$function$;
