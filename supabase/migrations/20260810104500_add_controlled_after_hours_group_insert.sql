-- Private, management-only transaction boundary for a desk-created group that
-- extends beyond normal closing time. Public/Voice/SMS keep using
-- insert_group_bookings(), whose opening-hours guard remains unchanged.

CREATE OR REPLACE FUNCTION public.insert_controlled_after_hours_group_bookings(
  p_bookings jsonb,
  p_actor_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_result jsonb;
  v_salon_id uuid;
  v_row jsonb;
  v_row_salon_id uuid;
  v_staff_id uuid;
  v_after_hours integer;
  v_has_after_hours boolean := false;
BEGIN
  IF jsonb_typeof(p_bookings) <> 'array'
     OR jsonb_array_length(p_bookings) < 2
     OR jsonb_array_length(p_bookings) > 20
     OR p_actor_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_group_size');
  END IF;

  FOR v_row IN SELECT value FROM jsonb_array_elements(p_bookings)
  LOOP
    BEGIN
      v_row_salon_id := (v_row->>'salon_id')::uuid;
      v_staff_id := (v_row->>'staff_id')::uuid;
      v_after_hours := CASE
        WHEN v_row->>'after_hours_minutes' IS NULL THEN NULL
        ELSE (v_row->>'after_hours_minutes')::integer
      END;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_booking_data');
    END;

    IF v_salon_id IS NULL THEN v_salon_id := v_row_salon_id; END IF;
    IF v_row_salon_id IS NULL OR v_row_salon_id <> v_salon_id THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_salon');
    END IF;
    IF v_staff_id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_staff');
    END IF;
    IF v_after_hours IS NOT NULL THEN
      IF v_after_hours < 1 OR v_after_hours > 120 THEN
        RETURN jsonb_build_object('success', false, 'code', 'outside_hours');
      END IF;
      v_has_after_hours := true;
    END IF;
  END LOOP;

  IF NOT v_has_after_hours THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_after_hours_override');
  END IF;

  -- Database-level authorization is independent from the server action. A
  -- leaked request payload cannot manufacture a management exception.
  IF NOT EXISTS (
    SELECT 1
    FROM public.salon_members sm
    WHERE sm.salon_id = v_salon_id
      AND sm.user_id = p_actor_user_id
      AND sm.role IN ('owner', 'admin')
  ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;

  -- Every party member must name a real active provider. "Any available" is
  -- deliberately unsupported for labor-hours exceptions.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_bookings) entry
    LEFT JOIN public.staff st
      ON st.id = (entry->>'staff_id')::uuid
     AND st.salon_id = v_salon_id
     AND st.status = 'active'
     AND st.deleted_at IS NULL
    WHERE st.id IS NULL
  ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_staff');
  END IF;

  -- The existing private implementation owns the atomic group insert,
  -- idempotency key, identity resolution and GiST overlap protection.
  v_result := public.insert_group_bookings_unlimited(p_bookings);
  IF coalesce((v_result->>'success')::boolean, false) IS NOT TRUE THEN
    RETURN v_result;
  END IF;

  WITH booking_ids AS (
    SELECT (value #>> '{}')::uuid AS booking_id, ordinality
    FROM jsonb_array_elements(v_result->'booking_ids') WITH ORDINALITY
  ), payload_rows AS (
    SELECT value AS payload, ordinality
    FROM jsonb_array_elements(p_bookings) WITH ORDINALITY
  )
  UPDATE public.bookings b
  SET after_hours_minutes = (p.payload->>'after_hours_minutes')::smallint,
      after_hours_approved_by = p_actor_user_id,
      after_hours_staff_consent = true
  FROM booking_ids i
  JOIN payload_rows p USING (ordinality)
  WHERE b.id = i.booking_id
    AND p.payload->>'after_hours_minutes' IS NOT NULL;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.insert_controlled_after_hours_group_bookings(jsonb, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.insert_controlled_after_hours_group_bookings(jsonb, uuid)
  TO service_role;

COMMENT ON FUNCTION public.insert_controlled_after_hours_group_bookings(jsonb, uuid) IS
  'Private Owner/Admin-only atomic group insert for explicitly staff-approved appointments ending at most 120 minutes after close.';
