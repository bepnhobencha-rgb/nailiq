-- Customer Identity Layer — M4 fix: avoid a name collision.
--
-- An unrelated, richer search_salon_clients(uuid,text,int,int) already exists on
-- prod (drift from a parallel branch: returns client_profile_id/notes/spend/
-- pagination, joins salon_clients). The 3-arg search_salon_clients this feature
-- added in 20260614120000 collides by name, so we drop it and rename ours to
-- search_salon_client_typeahead. Idempotent: DROP IF EXISTS is a no-op on a DB
-- that never got the 3-arg version.
DROP FUNCTION IF EXISTS public.search_salon_clients(uuid, text, int);

CREATE OR REPLACE FUNCTION public.search_salon_client_typeahead(
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

REVOKE ALL ON FUNCTION public.search_salon_client_typeahead(uuid, text, int) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_salon_client_typeahead(uuid, text, int) TO service_role;
