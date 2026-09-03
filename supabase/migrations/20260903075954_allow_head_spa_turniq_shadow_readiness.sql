-- Controlled SHADOW readiness must follow the salon's explicitly allowlisted
-- operating model. Head-spa salons use the same staff/service/resource turn
-- contracts as nail salons, and add-ons ride on a primary service rather than
-- requiring a standalone staff capability row.
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

  v_old := $old_active_services$  SELECT pg_catalog.count(*)::integer INTO v_active_service_count
  FROM public.services AS sv
  WHERE sv.salon_id = p_salon_id AND sv.deleted_at IS NULL;$old_active_services$;
  v_new := $new_active_services$  SELECT pg_catalog.count(*)::integer INTO v_active_service_count
  FROM public.services AS sv
  WHERE sv.salon_id = p_salon_id AND sv.deleted_at IS NULL
    AND sv.is_addon IS NOT TRUE;$new_active_services$;
  IF pg_catalog.strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'TurnIQ active primary service readiness definition drifted';
  END IF;
  v_definition := pg_catalog.replace(v_definition, v_old, v_new);

  v_old := $old_staff_coverage$      WHERE ss.staff_id = st.id AND sv.salon_id = p_salon_id
        AND sv.deleted_at IS NULL
    );$old_staff_coverage$;
  v_new := $new_staff_coverage$      WHERE ss.staff_id = st.id AND sv.salon_id = p_salon_id
        AND sv.deleted_at IS NULL AND sv.is_addon IS NOT TRUE
    );$new_staff_coverage$;
  IF pg_catalog.strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'TurnIQ staff primary service coverage definition drifted';
  END IF;
  v_definition := pg_catalog.replace(v_definition, v_old, v_new);

  v_old := $old_service_coverage$  FROM public.services AS sv
  WHERE sv.salon_id = p_salon_id AND sv.deleted_at IS NULL
    AND NOT EXISTS ($old_service_coverage$;
  v_new := $new_service_coverage$  FROM public.services AS sv
  WHERE sv.salon_id = p_salon_id AND sv.deleted_at IS NULL
    AND sv.is_addon IS NOT TRUE
    AND NOT EXISTS ($new_service_coverage$;
  IF pg_catalog.strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'TurnIQ uncovered primary service readiness definition drifted';
  END IF;
  v_definition := pg_catalog.replace(v_definition, v_old, v_new);

  v_old := $old_vertical$       OR v_salon.vertical <> 'nail_salon'$old_vertical$;
  v_new := $new_vertical$       OR v_salon.vertical NOT IN ('nail_salon', 'head_spa')$new_vertical$;
  IF pg_catalog.strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'TurnIQ supported vertical readiness definition drifted';
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
) IS 'Service-role-only controlled TurnIQ SHADOW activation/rollback for explicitly allowlisted nail-salon or head-spa tenants. Readiness requires primary-service capability coverage; add-ons inherit the primary service assignment. Activation fails closed and rollback remains available after allowlist expiry/revocation.';

COMMIT;

-- Rollback: replace the function with the definition recorded immediately
-- before this migration. Do not disable an active pilot by editing schema;
-- first invoke ROLLBACK_TURNIQ_SHADOW_PILOT and preserve its receipt.
