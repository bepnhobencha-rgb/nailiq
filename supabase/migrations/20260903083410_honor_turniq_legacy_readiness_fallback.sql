-- TurnIQ SHADOW readiness must honor the same explicit compatibility modes as
-- the live booking engine. A legacy_all salon intentionally has no
-- staff_services rows, and a salon with no active staff_shifts intentionally
-- falls back to salon opening hours. Treating either state as missing data
-- blocks a safe shadow pilot even though live booking already accepts it.
--
-- This migration does not create an allowlist entry, enable a feature flag,
-- change a rollout stage, or touch bookings/providers/notifications.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $patch$
DECLARE
  v_definition text;
  v_old text;
  v_new text;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(
    'public.configure_turniq_controlled_shadow_pilot_v1(uuid,text,uuid,uuid,text,text,text,text)'::regprocedure
  ) INTO v_definition;

  v_old := $old_salon_projection$    s.id, s.slug, s.timezone, s.vertical, s.subscription_status,
    s.archived_at, s.resources_enabled, s.feature_flags$old_salon_projection$;
  v_new := $new_salon_projection$    s.id, s.slug, s.timezone, s.vertical, s.subscription_status,
    s.archived_at, s.resources_enabled, s.feature_flags,
    s.staff_capability_mode$new_salon_projection$;
  IF pg_catalog.strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'TurnIQ salon readiness projection drifted';
  END IF;
  v_definition := pg_catalog.replace(v_definition, v_old, v_new);

  v_old := $old_unqualified$    AND NOT EXISTS (
      SELECT 1 FROM public.staff_services AS ss
      JOIN public.services AS sv ON sv.id = ss.service_id
      WHERE ss.staff_id = st.id AND sv.salon_id = p_salon_id
        AND sv.deleted_at IS NULL AND sv.is_addon IS NOT TRUE
    );$old_unqualified$;
  v_new := $new_unqualified$    AND v_salon.staff_capability_mode = 'whitelist'
    AND NOT EXISTS (
      SELECT 1 FROM public.staff_services AS ss
      JOIN public.services AS sv ON sv.id = ss.service_id
      WHERE ss.staff_id = st.id AND sv.salon_id = p_salon_id
        AND sv.deleted_at IS NULL AND sv.is_addon IS NOT TRUE
    );$new_unqualified$;
  IF pg_catalog.strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'TurnIQ staff capability readiness definition drifted';
  END IF;
  v_definition := pg_catalog.replace(v_definition, v_old, v_new);

  v_old := $old_uncovered$    AND NOT EXISTS (
      SELECT 1 FROM public.staff_services AS ss
      JOIN public.staff AS st ON st.id = ss.staff_id
      WHERE ss.service_id = sv.id AND st.salon_id = p_salon_id
        AND st.status = 'active' AND st.deleted_at IS NULL
    );$old_uncovered$;
  v_new := $new_uncovered$    AND v_salon.staff_capability_mode = 'whitelist'
    AND NOT EXISTS (
      SELECT 1 FROM public.staff_services AS ss
      JOIN public.staff AS st ON st.id = ss.staff_id
      WHERE ss.service_id = sv.id AND st.salon_id = p_salon_id
        AND st.status = 'active' AND st.deleted_at IS NULL
    );$new_uncovered$;
  IF pg_catalog.strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'TurnIQ service capability readiness definition drifted';
  END IF;
  v_definition := pg_catalog.replace(v_definition, v_old, v_new);

  v_old := $old_unscheduled$    AND NOT EXISTS (
      SELECT 1 FROM public.staff_shifts AS sh
      WHERE sh.staff_id = st.id AND sh.salon_id = p_salon_id
        AND sh.is_active IS TRUE
    );$old_unscheduled$;
  v_new := $new_unscheduled$    AND EXISTS (
      SELECT 1 FROM public.staff_shifts AS configured
      WHERE configured.salon_id = p_salon_id
        AND configured.is_active IS TRUE
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.staff_shifts AS sh
      WHERE sh.staff_id = st.id AND sh.salon_id = p_salon_id
        AND sh.is_active IS TRUE
    );$new_unscheduled$;
  IF pg_catalog.strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'TurnIQ staff schedule readiness definition drifted';
  END IF;
  v_definition := pg_catalog.replace(v_definition, v_old, v_new);

  v_old := $old_readiness$    'active_staff_count', v_active_staff_count,
    'active_service_count', v_active_service_count,$old_readiness$;
  v_new := $new_readiness$    'active_staff_count', v_active_staff_count,
    'active_service_count', v_active_service_count,
    'staff_capability_mode', v_salon.staff_capability_mode,
    'staff_schedule_mode', CASE WHEN EXISTS (
      SELECT 1 FROM public.staff_shifts AS configured
      WHERE configured.salon_id = p_salon_id
        AND configured.is_active IS TRUE
    ) THEN 'explicit' ELSE 'salon_hours_fallback' END,$new_readiness$;
  IF pg_catalog.strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'TurnIQ readiness receipt definition drifted';
  END IF;
  v_definition := pg_catalog.replace(v_definition, v_old, v_new);

  EXECUTE v_definition;
END;
$patch$;

REVOKE ALL ON FUNCTION public.configure_turniq_controlled_shadow_pilot_v1(
  uuid, text, uuid, uuid, text, text, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.configure_turniq_controlled_shadow_pilot_v1(
  uuid, text, uuid, uuid, text, text, text, text
) TO service_role;

COMMENT ON FUNCTION public.configure_turniq_controlled_shadow_pilot_v1(
  uuid, text, uuid, uuid, text, text, text, text
) IS 'Service-role-only controlled TurnIQ SHADOW activation/rollback for explicitly allowlisted nail-salon or head-spa tenants. Readiness honors durable legacy_all capability and salon-hours schedule fallbacks; explicit capability or shift configuration remains fail-closed. Activation fails closed and rollback remains available after allowlist expiry/revocation.';

COMMIT;

-- Rollback: replace the function with the definition recorded immediately
-- before this migration. Do not disable an active pilot by editing schema;
-- first invoke ROLLBACK_TURNIQ_SHADOW_PILOT and preserve its receipt.
