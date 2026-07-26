-- Customer Identity Layer — M6 (merge / dedupe primitive).
--
-- Collapses two client_profiles that are the same human into one. Repoints every
-- booking from the dropped profile to the kept one (by FK, and by phone for any
-- not-yet-backfilled row), folds the lifetime aggregates into the kept profile,
-- then soft-deletes the dropped one. Reversible-ish: the drop row is kept
-- (deleted_at set) so an accidental merge can be investigated.
--
-- Admin-only: SECURITY DEFINER + service_role grant; the owner-gated server
-- action (mergeClientProfiles) is the only caller.

CREATE OR REPLACE FUNCTION public.merge_client_profiles(
  p_keep_id uuid,
  p_drop_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_keep public.client_profiles%ROWTYPE;
  v_drop public.client_profiles%ROWTYPE;
  v_reassigned int := 0;
BEGIN
  IF p_keep_id IS NULL OR p_drop_id IS NULL OR p_keep_id = p_drop_id THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_args');
  END IF;

  SELECT * INTO v_keep FROM public.client_profiles WHERE id = p_keep_id;
  IF NOT FOUND OR v_keep.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'keep_not_found');
  END IF;

  SELECT * INTO v_drop FROM public.client_profiles WHERE id = p_drop_id;
  IF NOT FOUND OR v_drop.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'drop_not_found');
  END IF;

  -- Repoint bookings: linked-by-FK rows, plus any not-yet-backfilled row that
  -- still carries the dropped profile's phone.
  UPDATE public.bookings
     SET client_profile_id = p_keep_id
   WHERE client_profile_id = p_drop_id
      OR (client_profile_id IS NULL AND client_phone = v_drop.phone);
  GET DIAGNOSTICS v_reassigned = ROW_COUNT;

  -- Fold lifetime aggregates + best-known identity fields into the kept row.
  UPDATE public.client_profiles
     SET visit_count       = coalesce(v_keep.visit_count, 0) + coalesce(v_drop.visit_count, 0),
         total_spent_cents = coalesce(v_keep.total_spent_cents, 0) + coalesce(v_drop.total_spent_cents, 0),
         no_show_count     = coalesce(v_keep.no_show_count, 0) + coalesce(v_drop.no_show_count, 0),
         is_vip            = coalesce(v_keep.is_vip, false) OR coalesce(v_drop.is_vip, false),
         name              = coalesce(nullif(btrim(coalesce(v_keep.name, '')), ''), v_drop.name),
         email             = coalesce(v_keep.email, v_drop.email),
         preferred_staff_id = coalesce(v_keep.preferred_staff_id, v_drop.preferred_staff_id),
         square_customer_id = coalesce(v_keep.square_customer_id, v_drop.square_customer_id),
         last_service_date  = greatest(v_keep.last_service_date, v_drop.last_service_date),
         notes = nullif(btrim(
                   coalesce(v_keep.notes, '') ||
                   CASE WHEN coalesce(btrim(v_drop.notes), '') <> ''
                     THEN E'\n' || v_drop.notes ELSE '' END
                 ), ''),
         updated_at = now()
   WHERE id = p_keep_id;

  -- Soft-delete the dropped profile. Stamp its phone so the unique index frees
  -- up (a future booking on that number creates a fresh profile rather than
  -- colliding with the tombstone).
  UPDATE public.client_profiles
     SET deleted_at = now(),
         phone = 'merged:' || p_drop_id::text,
         updated_at = now()
   WHERE id = p_drop_id;

  RETURN jsonb_build_object('success', true, 'reassigned', v_reassigned);
EXCEPTION
  WHEN others THEN
    RETURN jsonb_build_object('success', false, 'code', 'merge_failed', 'detail', SQLERRM);
END;
$function$;

REVOKE ALL ON FUNCTION public.merge_client_profiles(uuid, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_client_profiles(uuid, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- Identity inventory for the dedupe screen: every ACTIVE client profile that
-- has at least one booking in this salon, with per-salon visit/last-visit. The
-- duplicate-candidate clustering runs in the server action over this bounded
-- list. Salon-scoped via the bookings join; SECURITY DEFINER + service_role.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.list_salon_client_identities(
  p_salon_id uuid,
  p_limit int DEFAULT 2000
)
RETURNS TABLE (
  id uuid,
  phone text,
  name text,
  email text,
  is_vip boolean,
  visit_count int,
  last_visit_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
STABLE
AS $function$
  SELECT
    cp.id,
    cp.phone,
    cp.name,
    cp.email,
    coalesce(cp.is_vip, false) AS is_vip,
    count(b.*) FILTER (WHERE b.status <> 'cancelled')::int AS visit_count,
    max(b.start_time_utc) AS last_visit_at
  FROM public.client_profiles cp
  JOIN public.bookings b
    ON b.client_phone = cp.phone
   AND b.salon_id = p_salon_id
  WHERE cp.deleted_at IS NULL
  GROUP BY cp.id, cp.phone, cp.name, cp.email, cp.is_vip
  ORDER BY max(b.start_time_utc) DESC NULLS LAST
  LIMIT greatest(1, least(coalesce(p_limit, 2000), 5000));
$function$;

REVOKE ALL ON FUNCTION public.list_salon_client_identities(uuid, int) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_salon_client_identities(uuid, int) TO service_role;
