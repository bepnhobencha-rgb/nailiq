-- Customer Identity Layer — M4 (front-desk client search).
--
-- Typeahead source for the receptionist booking form: find an EXISTING client
-- of THIS salon by name or phone, so the receptionist picks the known profile
-- instead of retyping (and minting a near-duplicate identity).
--
-- Salon-scoped by an inner join to this salon's bookings — a receptionist only
-- ever sees their own salon's customers, even though client_profiles is global.
-- SECURITY DEFINER + service_role-only grant; the calling server action verifies
-- salon membership before passing p_salon_id (same guard as lookupClientByPhone).

CREATE OR REPLACE FUNCTION public.search_salon_clients(
  p_salon_id uuid,
  p_query text,
  p_limit int DEFAULT 8
)
RETURNS TABLE (
  phone text,
  name text,
  is_vip boolean,
  visit_count int,
  last_visit_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
STABLE
AS $function$
  WITH q AS (
    SELECT nullif(btrim(p_query), '') AS raw
  ),
  d AS (
    SELECT regexp_replace(coalesce((SELECT raw FROM q), ''), '\D', '', 'g') AS digits
  )
  SELECT
    cp.phone,
    cp.name,
    coalesce(cp.is_vip, false) AS is_vip,
    count(b.*) FILTER (WHERE b.status <> 'cancelled')::int AS visit_count,
    max(b.start_time_utc) AS last_visit_at
  FROM public.client_profiles cp
  JOIN public.bookings b
    ON b.client_phone = cp.phone
   AND b.salon_id = p_salon_id
  WHERE cp.deleted_at IS NULL
    AND (SELECT raw FROM q) IS NOT NULL
    AND (
      ( (SELECT digits FROM d) <> '' AND cp.phone LIKE '%' || (SELECT digits FROM d) || '%' )
      OR ( cp.name ILIKE '%' || (SELECT raw FROM q) || '%' )
    )
  GROUP BY cp.phone, cp.name, cp.is_vip
  ORDER BY max(b.start_time_utc) DESC NULLS LAST
  LIMIT greatest(1, least(coalesce(p_limit, 8), 20));
$function$;

REVOKE ALL ON FUNCTION public.search_salon_clients(uuid, text, int) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_salon_clients(uuid, text, int) TO service_role;
