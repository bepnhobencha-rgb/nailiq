-- Host detail: the groups a person organized + who they brought, for the
-- "Top người dẫn nhóm" drawer (answers: dẫn ai · khi nào · dịch vụ gì).
-- One row per organized group, newest first; attendees = the co-guests (the
-- non-organizer members). SECURITY DEFINER + service_role; the server action
-- gates salon + role.

CREATE OR REPLACE FUNCTION public.get_host_groups(p_salon_id uuid, p_phone text, p_limit int DEFAULT 20)
RETURNS TABLE (
  group_id uuid,
  started_at timestamptz,
  status text,
  service text,
  size int,
  attendees text[]
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
STABLE
AS $function$
  WITH ph AS (
    SELECT regexp_replace(coalesce(public.canonical_phone(p_phone), ''), '\D', '', 'g') AS d
  ),
  og AS (
    SELECT b.group_id, b.start_time_utc, b.status, b.service_id
    FROM public.bookings b
    WHERE b.salon_id = p_salon_id
      AND b.is_group_organizer = true
      AND b.group_id IS NOT NULL
      AND b.status <> 'cancelled'
      AND (SELECT d FROM ph) <> ''
      AND regexp_replace(coalesce(b.client_phone, ''), '\D', '', 'g') = (SELECT d FROM ph)
  )
  SELECT
    og.group_id,
    og.start_time_utc AS started_at,
    og.status,
    (SELECT s.name FROM public.services s WHERE s.id = og.service_id) AS service,
    (SELECT count(*) FROM public.bookings m
       WHERE m.group_id = og.group_id AND m.status <> 'cancelled')::int AS size,
    (SELECT array_agg(DISTINCT btrim(m.client_name))
       FROM public.bookings m
      WHERE m.group_id = og.group_id
        AND m.status <> 'cancelled'
        AND m.is_group_organizer IS NOT TRUE
        AND btrim(coalesce(m.client_name, '')) <> ''
        AND m.client_name !~* '^(guest|kh[aá]ch|khach)\s*[0-9]+$') AS attendees
  FROM og
  ORDER BY og.start_time_utc DESC
  LIMIT greatest(1, least(coalesce(p_limit, 20), 50));
$function$;

REVOKE ALL ON FUNCTION public.get_host_groups(uuid, text, int) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_host_groups(uuid, text, int) TO service_role;
