-- Fix the capacity-rescue v2 wrapper for sequence/group requests. PostgreSQL
-- records have no tuple descriptor until assigned; referencing an unassigned
-- record inside CASE can still raise before CASE short-circuits. Initialize the
-- privacy-safe capacity counters once so non-individual requests remain valid.
--
-- Rollback: reapply the function body from
-- 20260905204123_enforce_atomic_individual_waitlist_capacity.sql.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION public.create_public_capacity_rescue_request_v2(
  p_salon_id uuid,
  p_request_id uuid,
  p_request_kind text,
  p_primary_service_id uuid,
  p_staff_id uuid,
  p_booking_date date,
  p_preferred_slot_label text,
  p_party_size integer,
  p_client_name text,
  p_client_phone text,
  p_client_email text,
  p_client_locale text,
  p_intent_json jsonb,
  p_app_version text DEFAULT NULL
)
RETURNS TABLE(
  id uuid,
  status text,
  created_new boolean,
  guard_outcome text,
  slot_label text,
  eligible_staff_count integer,
  eligible_resource_count integer,
  free_staff_count integer,
  free_resource_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_role text := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_kind text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_request_kind, '')));
  v_capacity record;
  v_result record;
BEGIN
  IF v_role <> 'service_role' THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  -- Give the record a stable tuple descriptor for sequence/group branches.
  SELECT
    NULL::text AS outcome,
    NULL::text AS slot_label,
    NULL::integer AS eligible_staff_count,
    NULL::integer AS eligible_resource_count,
    NULL::integer AS free_staff_count,
    NULL::integer AS free_resource_count
  INTO v_capacity;

  IF EXISTS (
    SELECT 1 FROM public.booking_waitlist_entries AS existing
    WHERE existing.salon_id = p_salon_id
      AND existing.request_id = p_request_id
  ) THEN
    SELECT * INTO v_result
    FROM public.create_public_capacity_rescue_request(
      p_salon_id, p_request_id, p_request_kind, p_primary_service_id,
      p_staff_id, p_booking_date, p_preferred_slot_label, p_party_size,
      p_client_name, p_client_phone, p_client_email, p_client_locale,
      p_intent_json
    );

    INSERT INTO public.capacity_rescue_decision_events (
      salon_id, request_id, waitlist_entry_id, decision_source, request_kind,
      service_id, staff_id, booking_date, preferred_slot_label, outcome,
      reason_code, app_version
    ) VALUES (
      p_salon_id, p_request_id, v_result.id, 'database_guard', v_kind,
      p_primary_service_id, p_staff_id, p_booking_date,
      nullif(pg_catalog.btrim(coalesce(p_preferred_slot_label, '')), ''),
      'idempotent', 'request_id_retry',
      nullif(pg_catalog.btrim(coalesce(p_app_version, '')), '')
    );

    RETURN QUERY SELECT
      v_result.id, v_result.status, false,
      CASE WHEN v_kind = 'individual' THEN 'slot_unavailable' ELSE 'capacity_not_applicable' END,
      NULL::text, NULL::integer, NULL::integer, NULL::integer, NULL::integer;
    RETURN;
  END IF;

  IF v_kind = 'individual' THEN
    SELECT * INTO v_capacity
    FROM public.evaluate_individual_waitlist_capacity(
      p_salon_id,
      p_primary_service_id,
      p_staff_id,
      p_booking_date,
      p_preferred_slot_label
    );

    IF v_capacity.outcome <> 'slot_unavailable' THEN
      INSERT INTO public.capacity_rescue_decision_events (
        salon_id, request_id, decision_source, request_kind, service_id,
        staff_id, booking_date, preferred_slot_label, outcome, reason_code,
        eligible_staff_count, eligible_resource_count,
        free_staff_count, free_resource_count, app_version
      ) VALUES (
        p_salon_id, p_request_id, 'database_guard', v_kind,
        p_primary_service_id, p_staff_id, p_booking_date,
        nullif(pg_catalog.btrim(coalesce(p_preferred_slot_label, '')), ''),
        v_capacity.outcome, v_capacity.outcome,
        v_capacity.eligible_staff_count, v_capacity.eligible_resource_count,
        v_capacity.free_staff_count, v_capacity.free_resource_count,
        nullif(pg_catalog.btrim(coalesce(p_app_version, '')), '')
      );

      RETURN QUERY SELECT
        NULL::uuid, NULL::text, false, v_capacity.outcome,
        v_capacity.slot_label, v_capacity.eligible_staff_count,
        v_capacity.eligible_resource_count, v_capacity.free_staff_count,
        v_capacity.free_resource_count;
      RETURN;
    END IF;
  END IF;

  SELECT * INTO v_result
  FROM public.create_public_capacity_rescue_request(
    p_salon_id, p_request_id, p_request_kind, p_primary_service_id,
    p_staff_id, p_booking_date, p_preferred_slot_label, p_party_size,
    p_client_name, p_client_phone, p_client_email, p_client_locale,
    p_intent_json
  );

  INSERT INTO public.capacity_rescue_decision_events (
    salon_id, request_id, waitlist_entry_id, decision_source, request_kind,
    service_id, staff_id, booking_date, preferred_slot_label, outcome,
    reason_code, eligible_staff_count, eligible_resource_count,
    free_staff_count, free_resource_count, app_version
  ) VALUES (
    p_salon_id, p_request_id, v_result.id, 'database_guard', v_kind,
    p_primary_service_id, p_staff_id, p_booking_date,
    nullif(pg_catalog.btrim(coalesce(p_preferred_slot_label, '')), ''),
    CASE WHEN v_result.created_new THEN 'created' ELSE 'idempotent' END,
    CASE WHEN v_kind = 'individual' THEN 'slot_unavailable' ELSE 'capacity_not_applicable' END,
    CASE WHEN v_kind = 'individual' THEN v_capacity.eligible_staff_count ELSE NULL END,
    CASE WHEN v_kind = 'individual' THEN v_capacity.eligible_resource_count ELSE NULL END,
    CASE WHEN v_kind = 'individual' THEN v_capacity.free_staff_count ELSE NULL END,
    CASE WHEN v_kind = 'individual' THEN v_capacity.free_resource_count ELSE NULL END,
    nullif(pg_catalog.btrim(coalesce(p_app_version, '')), '')
  );

  RETURN QUERY SELECT
    v_result.id, v_result.status, v_result.created_new,
    CASE WHEN v_kind = 'individual' THEN 'slot_unavailable' ELSE 'capacity_not_applicable' END,
    NULL::text,
    CASE WHEN v_kind = 'individual' THEN v_capacity.eligible_staff_count ELSE NULL END,
    CASE WHEN v_kind = 'individual' THEN v_capacity.eligible_resource_count ELSE NULL END,
    CASE WHEN v_kind = 'individual' THEN v_capacity.free_staff_count ELSE NULL END,
    CASE WHEN v_kind = 'individual' THEN v_capacity.free_resource_count ELSE NULL END;
END;
$function$;

REVOKE ALL ON FUNCTION public.create_public_capacity_rescue_request_v2(
  uuid, uuid, text, uuid, uuid, date, text, integer,
  text, text, text, text, jsonb, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_public_capacity_rescue_request_v2(
  uuid, uuid, text, uuid, uuid, date, text, integer,
  text, text, text, text, jsonb, text
) TO service_role;

COMMENT ON FUNCTION public.create_public_capacity_rescue_request_v2(
  uuid, uuid, text, uuid, uuid, date, text, integer,
  text, text, text, text, jsonb, text
) IS 'Atomic service-role capacity rescue boundary with initialized non-individual capacity trace.';

COMMIT;
