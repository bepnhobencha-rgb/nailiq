-- "Top người dẫn nhóm" leaderboard: the salon's biggest group organizers,
-- ranked by guests brought. Reuses bookings.is_group_organizer (set on the
-- organizer row). Name comes from the most recent organizer booking; placeholder
-- names ("Guest 3" / "Khách 3") are excluded so the board only shows real people.
-- Visit count is untouched — this is a separate, celebrated stat.
-- SECURITY DEFINER + service_role; the server action gates the salon + owner.

CREATE OR REPLACE FUNCTION public.top_salon_hosts(p_salon_id uuid, p_limit int DEFAULT 10)
RETURNS TABLE (
  phone text,
  name text,
  is_vip boolean,
  groups_organized int,
  guests_brought int
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
STABLE
AS $function$
  WITH og AS (
    SELECT
      regexp_replace(coalesce(b.client_phone, ''), '\D', '', 'g') AS phone,
      b.group_id,
      b.client_name,
      b.start_time_utc
    FROM public.bookings b
    WHERE b.salon_id = p_salon_id
      AND b.is_group_organizer = true
      AND b.group_id IS NOT NULL
      AND b.status <> 'cancelled'
      AND regexp_replace(coalesce(b.client_phone, ''), '\D', '', 'g') <> ''
  ),
  names AS (
    SELECT DISTINCT ON (phone) phone, client_name
    FROM og
    ORDER BY phone, start_time_utc DESC NULLS LAST
  ),
  sizes AS (
    SELECT DISTINCT og.phone, og.group_id,
      (SELECT count(*) FROM public.bookings x
         WHERE x.group_id = og.group_id AND x.status <> 'cancelled') AS sz
    FROM og
  ),
  agg AS (
    SELECT phone, count(*) AS groups_organized, coalesce(sum(sz - 1), 0) AS guests_brought
    FROM sizes
    GROUP BY phone
  )
  SELECT
    a.phone,
    n.client_name AS name,
    coalesce(cp.is_vip, false) AS is_vip,
    a.groups_organized::int,
    a.guests_brought::int
  FROM agg a
  JOIN names n ON n.phone = a.phone
  LEFT JOIN public.client_profiles cp ON cp.phone = a.phone AND cp.deleted_at IS NULL
  WHERE a.guests_brought > 0
    AND coalesce(btrim(n.client_name), '') <> ''
    AND coalesce(n.client_name, '') !~* '^(guest|kh[aá]ch|khach)\s*[0-9]+$'
  ORDER BY a.guests_brought DESC, a.groups_organized DESC, a.phone
  LIMIT greatest(1, least(coalesce(p_limit, 10), 50));
$function$;

REVOKE ALL ON FUNCTION public.top_salon_hosts(uuid, int) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.top_salon_hosts(uuid, int) TO service_role;
