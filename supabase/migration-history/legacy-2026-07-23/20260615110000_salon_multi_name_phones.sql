-- "Một số — nhiều tên": phones in this salon whose non-cancelled bookings carry
-- 2+ distinct real names (family / shared line / legacy group pollution / typos).
-- Phone is the identity (one row per phone); this surfaces those phones so the
-- owner can pick ONE canonical display name. Placeholder names ("Guest N" /
-- "Khách N") are excluded so the variants list is meaningful.
-- SECURITY DEFINER + service_role; the server action gates the salon + owner.

CREATE OR REPLACE FUNCTION public.salon_multi_name_phones(p_salon_id uuid, p_limit int DEFAULT 25)
RETURNS TABLE (
  phone text,
  profile_name text,
  is_vip boolean,
  distinct_names int,
  total_visits int,
  variants jsonb
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
STABLE
AS $function$
  WITH rows AS (
    SELECT
      regexp_replace(coalesce(b.client_phone, ''), '\D', '', 'g') AS phone,
      btrim(b.client_name) AS nm
    FROM public.bookings b
    WHERE b.salon_id = p_salon_id
      AND b.status <> 'cancelled'
      AND regexp_replace(coalesce(b.client_phone, ''), '\D', '', 'g') <> ''
      AND btrim(coalesce(b.client_name, '')) <> ''
      AND b.client_name !~* '^(guest|kh[aá]ch|khach)\s*[0-9]+$'
  ),
  byname AS (
    SELECT phone, nm, count(*) AS c FROM rows GROUP BY phone, nm
  ),
  agg AS (
    SELECT
      phone,
      count(*) AS distinct_names,
      sum(c) AS total,
      jsonb_agg(jsonb_build_object('name', nm, 'count', c) ORDER BY c DESC, nm) AS variants
    FROM byname
    GROUP BY phone
    HAVING count(*) >= 2
  )
  SELECT
    a.phone,
    cp.name AS profile_name,
    coalesce(cp.is_vip, false) AS is_vip,
    a.distinct_names::int,
    a.total::int,
    a.variants
  FROM agg a
  LEFT JOIN public.client_profiles cp ON cp.phone = a.phone AND cp.deleted_at IS NULL
  ORDER BY a.distinct_names DESC, a.total DESC, a.phone
  LIMIT greatest(1, least(coalesce(p_limit, 25), 100));
$function$;

REVOKE ALL ON FUNCTION public.salon_multi_name_phones(uuid, int) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.salon_multi_name_phones(uuid, int) TO service_role;
