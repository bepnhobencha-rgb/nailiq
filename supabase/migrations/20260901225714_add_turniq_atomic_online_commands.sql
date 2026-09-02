-- TurnIQ M3A atomic online commands.
--
-- This migration remains inert while
-- salons.feature_flags.turniq_trust_engine_enabled is absent/false. It adds
-- service-role-only RPCs and never installs a trigger on bookings, staff, or
-- resources. No provider or notification dispatch is performed here.
--
-- Rollback boundary: keep the flag OFF and stop invoking these RPCs. Preserve
-- command receipts, events, assignments, and fairness receipts as evidence.

ALTER TABLE public.turniq_shift_sessions
  ADD COLUMN state_version bigint NOT NULL DEFAULT 1
    CHECK (state_version > 0);

ALTER TABLE public.turniq_assignments
  ADD COLUMN state_version bigint NOT NULL DEFAULT 1
    CHECK (state_version > 0);

CREATE UNIQUE INDEX turniq_assignment_one_active_booking_idx
  ON public.turniq_assignments (salon_id, booking_id)
  WHERE booking_id IS NOT NULL
    AND status IN ('recommended', 'confirmed', 'in_progress');

CREATE OR REPLACE FUNCTION public.turniq_sha256_jsonb(p_value jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SECURITY INVOKER
SET search_path TO ''
AS $function$
  SELECT pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(p_value::text, 'UTF8'), 'sha256'),
    'hex'
  )
$function$;

CREATE OR REPLACE FUNCTION public.turniq_online_context(
  p_salon_id uuid,
  p_policy_version_id uuid,
  p_actor_user_id uuid,
  p_actor_role text,
  p_occurred_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO ''
AS $function$
DECLARE
  v_actual_role text;
  v_actor_staff_id uuid;
  v_policy public.turniq_policy_versions%ROWTYPE;
  v_business_date date;
BEGIN
  IF p_salon_id IS NULL OR p_policy_version_id IS NULL
     OR p_actor_user_id IS NULL OR p_occurred_at IS NULL
     OR p_actor_role NOT IN (
       'owner', 'admin', 'senior', 'receptionist', 'nail_tech'
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'invalid TurnIQ online context';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.salons s
    WHERE s.id = p_salon_id
      AND s.archived_at IS NULL
      AND coalesce(
        s.feature_flags -> 'turniq_trust_engine_enabled',
        'false'::jsonb
      ) = 'true'::jsonb
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'TurnIQ is not enabled for salon';
  END IF;

  SELECT m.role
  INTO v_actual_role
  FROM public.salon_members m
  WHERE m.salon_id = p_salon_id
    AND m.user_id = p_actor_user_id
  LIMIT 1;

  IF v_actual_role IS NULL OR v_actual_role IS DISTINCT FROM p_actor_role THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'TurnIQ actor membership mismatch';
  END IF;

  SELECT p.*
  INTO v_policy
  FROM public.turniq_policy_versions p
  WHERE p.id = p_policy_version_id
    AND p.salon_id = p_salon_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23503',
      MESSAGE = 'TurnIQ policy does not belong to salon';
  END IF;

  v_business_date :=
    (p_occurred_at AT TIME ZONE v_policy.business_timezone)::date;
  IF v_policy.effective_business_date > v_business_date THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'TurnIQ policy is not effective for business date';
  END IF;

  SELECT st.id
  INTO v_actor_staff_id
  FROM public.staff st
  WHERE st.salon_id = p_salon_id
    AND st.user_id = p_actor_user_id
    AND st.status = 'active'
    AND st.deleted_at IS NULL
  ORDER BY st.id
  LIMIT 1;

  RETURN pg_catalog.jsonb_build_object(
    'actor_role', v_actual_role,
    'actor_staff_id', v_actor_staff_id,
    'business_date', v_business_date,
    'business_timezone', v_policy.business_timezone,
    'fairness_band_cents', v_policy.fairness_band_cents
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.turniq_replay_online_command(
  p_command_id uuid,
  p_salon_id uuid,
  p_policy_version_id uuid,
  p_actor_user_id uuid,
  p_actor_role text,
  p_command_type text,
  p_request_fingerprint text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO ''
AS $function$
DECLARE
  v_receipt public.turniq_command_receipts%ROWTYPE;
BEGIN
  SELECT r.*
  INTO v_receipt
  FROM public.turniq_command_receipts r
  WHERE r.command_id = p_command_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_receipt.salon_id IS DISTINCT FROM p_salon_id
     OR v_receipt.policy_version_id IS DISTINCT FROM p_policy_version_id
     OR v_receipt.actor_user_id IS DISTINCT FROM p_actor_user_id
     OR v_receipt.actor_role IS DISTINCT FROM p_actor_role
     OR v_receipt.command_type IS DISTINCT FROM p_command_type
     OR v_receipt.request_fingerprint IS DISTINCT FROM p_request_fingerprint THEN
    RAISE EXCEPTION USING ERRCODE = '23505',
      MESSAGE = 'TurnIQ command idempotency conflict';
  END IF;

  RETURN v_receipt.result || pg_catalog.jsonb_build_object('replayed', true);
END
$function$;

CREATE OR REPLACE FUNCTION public.turniq_store_online_command(
  p_command_id uuid,
  p_salon_id uuid,
  p_policy_version_id uuid,
  p_device_id uuid,
  p_local_sequence bigint,
  p_actor_user_id uuid,
  p_actor_role text,
  p_command_type text,
  p_request_fingerprint text,
  p_result_status text,
  p_result jsonb,
  p_client_timestamp timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO ''
AS $function$
BEGIN
  INSERT INTO public.turniq_command_receipts (
    command_id, salon_id, policy_version_id, device_id, local_sequence,
    actor_user_id, actor_role, command_type, request_fingerprint,
    result_fingerprint, result_status, result, client_timestamp
  ) VALUES (
    p_command_id, p_salon_id, p_policy_version_id, p_device_id,
    p_local_sequence, p_actor_user_id, p_actor_role, p_command_type,
    p_request_fingerprint, public.turniq_sha256_jsonb(p_result),
    p_result_status, p_result, p_client_timestamp
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.apply_turniq_shift_command_v1(
  p_salon_id uuid,
  p_policy_version_id uuid,
  p_staff_id uuid,
  p_command_type text,
  p_reason text,
  p_command_id uuid,
  p_device_id uuid,
  p_local_sequence bigint,
  p_actor_user_id uuid,
  p_actor_role text,
  p_request_fingerprint text,
  p_occurred_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO ''
AS $function$
DECLARE
  v_context jsonb;
  v_replay jsonb;
  v_shift public.turniq_shift_sessions%ROWTYPE;
  v_business_date date;
  v_queue_position integer;
  v_baseline integer;
  v_next_state text;
  v_event_type text;
  v_result jsonb;
  v_event_version bigint;
  v_normalized_reason text := nullif(btrim(coalesce(p_reason, '')), '');
BEGIN
  IF p_command_id IS NULL OR p_device_id IS NULL OR p_staff_id IS NULL
     OR p_local_sequence <= 0 OR p_request_fingerprint !~ '^[0-9a-f]{64}$'
     OR p_command_type NOT IN (
       'check_in', 'check_out', 'break', 'return', 'hold', 'release_hold'
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'invalid TurnIQ shift command';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('turniq-command:' || p_command_id::text, 0)
  );
  v_replay := public.turniq_replay_online_command(
    p_command_id, p_salon_id, p_policy_version_id, p_actor_user_id,
    p_actor_role, p_command_type, p_request_fingerprint
  );
  IF v_replay IS NOT NULL THEN
    RETURN v_replay;
  END IF;

  v_context := public.turniq_online_context(
    p_salon_id, p_policy_version_id, p_actor_user_id, p_actor_role,
    p_occurred_at
  );
  v_business_date := (v_context ->> 'business_date')::date;

  IF p_actor_role = 'nail_tech'
     AND (v_context ->> 'actor_staff_id')::uuid IS DISTINCT FROM p_staff_id THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Technician may change only own TurnIQ shift';
  END IF;
  IF p_command_type IN ('hold', 'release_hold')
     AND p_actor_role NOT IN ('owner', 'admin', 'senior', 'receptionist') THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'TurnIQ safety hold requires desk role';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.staff st
    WHERE st.id = p_staff_id AND st.salon_id = p_salon_id
      AND st.status = 'active' AND st.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23503',
      MESSAGE = 'TurnIQ shift staff is unavailable';
  END IF;

  SELECT sh.*
  INTO v_shift
  FROM public.turniq_shift_sessions sh
  WHERE sh.salon_id = p_salon_id
    AND sh.staff_id = p_staff_id
    AND sh.checked_out_at IS NULL
  FOR UPDATE;

  IF p_command_type = 'check_in' THEN
    IF FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'Technician already has an open TurnIQ shift';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'turniq-shift-queue:' || p_salon_id::text || ':' || v_business_date::text,
        0
      )
    );
    SELECT coalesce(max(sh.queue_position), 0) + 1
    INTO v_queue_position
    FROM public.turniq_shift_sessions sh
    WHERE sh.salon_id = p_salon_id
      AND sh.business_date = v_business_date;

    SELECT coalesce(
      pg_catalog.percentile_disc(0.5) WITHIN GROUP (
        ORDER BY sh.fairness_baseline_cents
          + sh.service_credit_since_checkin_cents
      ),
      0
    )::integer
    INTO v_baseline
    FROM public.turniq_shift_sessions sh
    WHERE sh.salon_id = p_salon_id
      AND sh.business_date = v_business_date
      AND sh.state <> 'checked_out';

    INSERT INTO public.turniq_shift_sessions (
      salon_id, policy_version_id, staff_id, business_date, checked_in_at,
      state, queue_position, fairness_baseline_cents, state_changed_at
    ) VALUES (
      p_salon_id, p_policy_version_id, p_staff_id, v_business_date,
      p_occurred_at, 'active', v_queue_position, v_baseline, p_occurred_at
    ) RETURNING * INTO v_shift;
    v_event_type := 'shift_checked_in';
    v_event_version := 1;
  ELSE
    IF NOT FOUND OR v_shift.business_date IS DISTINCT FROM v_business_date
       OR v_shift.policy_version_id IS DISTINCT FROM p_policy_version_id
       OR p_occurred_at < v_shift.state_changed_at THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'invalid or stale TurnIQ shift state';
    END IF;

    IF p_command_type = 'break' THEN
      v_next_state := 'approved_break';
      v_event_type := 'shift_break_started';
      IF v_shift.state <> 'active' OR v_normalized_reason IS NULL
         OR length(v_normalized_reason) > 500 THEN
        RAISE EXCEPTION USING ERRCODE = '55000',
          MESSAGE = 'invalid TurnIQ break transition';
      END IF;
    ELSIF p_command_type = 'return' THEN
      v_next_state := 'active';
      v_event_type := 'shift_returned';
      IF v_shift.state <> 'approved_break' THEN
        RAISE EXCEPTION USING ERRCODE = '55000',
          MESSAGE = 'invalid TurnIQ return transition';
      END IF;
      v_normalized_reason := NULL;
    ELSIF p_command_type = 'hold' THEN
      v_next_state := 'temporary_hold';
      v_event_type := 'shift_hold_started';
      IF v_shift.state <> 'active' OR v_normalized_reason IS NULL
         OR length(v_normalized_reason) > 500 THEN
        RAISE EXCEPTION USING ERRCODE = '55000',
          MESSAGE = 'invalid TurnIQ hold transition';
      END IF;
    ELSIF p_command_type = 'release_hold' THEN
      v_next_state := 'active';
      v_event_type := 'shift_hold_released';
      IF v_shift.state <> 'temporary_hold' THEN
        RAISE EXCEPTION USING ERRCODE = '55000',
          MESSAGE = 'invalid TurnIQ hold release';
      END IF;
      v_normalized_reason := NULL;
    ELSE
      v_next_state := 'checked_out';
      v_event_type := 'shift_checked_out';
      v_normalized_reason := NULL;
    END IF;

    UPDATE public.turniq_shift_sessions sh
    SET state = v_next_state,
        checked_out_at = CASE
          WHEN v_next_state = 'checked_out' THEN p_occurred_at ELSE NULL
        END,
        hold_reason = v_normalized_reason,
        state_changed_at = p_occurred_at,
        state_version = sh.state_version + 1,
        updated_at = pg_catalog.transaction_timestamp()
    WHERE sh.id = v_shift.id
      AND sh.state_version = v_shift.state_version
    RETURNING * INTO v_shift;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '40001',
        MESSAGE = 'TurnIQ shift changed concurrently';
    END IF;
    v_event_version := v_shift.state_version;
  END IF;

  v_result := pg_catalog.jsonb_build_object(
    'ok', true,
    'command_id', p_command_id,
    'replayed', false,
    'shift_session_id', v_shift.id,
    'staff_id', v_shift.staff_id,
    'business_date', v_shift.business_date,
    'state', v_shift.state,
    'queue_position', v_shift.queue_position,
    'state_version', v_shift.state_version
  );
  PERFORM public.turniq_store_online_command(
    p_command_id, p_salon_id, p_policy_version_id, p_device_id,
    p_local_sequence, p_actor_user_id, p_actor_role, p_command_type,
    p_request_fingerprint, 'committed', v_result, p_occurred_at
  );
  INSERT INTO public.turniq_events (
    salon_id, policy_version_id, command_id, aggregate_type, aggregate_id,
    aggregate_version, event_type, actor_user_id, actor_staff_id, actor_role,
    actor_ref, reason_code, reason_detail, request_fingerprint, payload,
    occurred_at
  ) VALUES (
    p_salon_id, p_policy_version_id, p_command_id, 'shift', v_shift.id,
    v_event_version, v_event_type, p_actor_user_id,
    nullif(v_context ->> 'actor_staff_id', '')::uuid, p_actor_role,
    'user:' || p_actor_user_id::text, p_command_type, v_normalized_reason,
    p_request_fingerprint,
    pg_catalog.jsonb_build_object(
      'state', v_shift.state,
      'queue_position', v_shift.queue_position,
      'state_version', v_shift.state_version
    ),
    p_occurred_at
  );
  RETURN v_result;
END
$function$;

CREATE OR REPLACE FUNCTION public.record_turniq_recommendation_v1(
  p_salon_id uuid,
  p_policy_version_id uuid,
  p_booking_id uuid,
  p_customer_request_id uuid,
  p_recommended_staff_id uuid,
  p_resource_id uuid,
  p_requested_staff_id uuid,
  p_requested_tech_source text,
  p_request_trust_label text,
  p_requested_tech_actor_ref text,
  p_requested_tech_recorded_at timestamptz,
  p_decision_timestamp timestamptz,
  p_decision_fingerprint text,
  p_snapshot_version text,
  p_privacy_safe_explanation text,
  p_eligible_candidates jsonb,
  p_skipped_candidates jsonb,
  p_internal_decision_trace jsonb,
  p_command_id uuid,
  p_device_id uuid,
  p_local_sequence bigint,
  p_actor_user_id uuid,
  p_actor_role text,
  p_request_fingerprint text,
  p_occurred_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO ''
AS $function$
DECLARE
  v_context jsonb;
  v_replay jsonb;
  v_booking public.bookings%ROWTYPE;
  v_shift public.turniq_shift_sessions%ROWTYPE;
  v_assignment public.turniq_assignments%ROWTYPE;
  v_opportunity_credit integer;
  v_result jsonb;
BEGIN
  IF p_command_id IS NULL OR p_device_id IS NULL OR p_booking_id IS NULL
     OR p_customer_request_id IS NULL OR p_recommended_staff_id IS NULL
     OR p_local_sequence <= 0 OR p_request_fingerprint !~ '^[0-9a-f]{64}$'
     OR p_decision_fingerprint !~ '^[0-9a-f]{64}$'
     OR pg_catalog.jsonb_typeof(p_eligible_candidates) <> 'array'
     OR pg_catalog.jsonb_typeof(p_skipped_candidates) <> 'array'
     OR pg_catalog.jsonb_typeof(p_internal_decision_trace) <> 'object'
     OR coalesce(length(btrim(p_snapshot_version)), 0) NOT BETWEEN 1 AND 120
     OR coalesce(length(btrim(p_privacy_safe_explanation)), 0) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'invalid TurnIQ recommendation command';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('turniq-command:' || p_command_id::text, 0)
  );
  v_replay := public.turniq_replay_online_command(
    p_command_id, p_salon_id, p_policy_version_id, p_actor_user_id,
    p_actor_role, 'recommend', p_request_fingerprint
  );
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;

  v_context := public.turniq_online_context(
    p_salon_id, p_policy_version_id, p_actor_user_id, p_actor_role,
    p_occurred_at
  );
  IF p_actor_role NOT IN ('owner', 'admin', 'senior', 'receptionist') THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'TurnIQ recommendation recording requires desk role';
  END IF;

  SELECT b.* INTO v_booking
  FROM public.bookings b
  WHERE b.id = p_booking_id AND b.salon_id = p_salon_id
  FOR UPDATE;
  IF NOT FOUND OR v_booking.deleted_at IS NOT NULL
     OR v_booking.schedule_model <> 'single'
     OR v_booking.status NOT IN ('pending', 'confirmed', 'waiting') THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'booking is not eligible for TurnIQ recommendation';
  END IF;
  IF p_resource_id IS NOT NULL
     AND v_booking.resource_id IS NOT NULL
     AND p_resource_id IS DISTINCT FROM v_booking.resource_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'TurnIQ recommendation resource mismatch';
  END IF;

  SELECT sh.* INTO v_shift
  FROM public.turniq_shift_sessions sh
  WHERE sh.salon_id = p_salon_id
    AND sh.policy_version_id = p_policy_version_id
    AND sh.business_date = (v_context ->> 'business_date')::date
    AND sh.staff_id = p_recommended_staff_id
    AND sh.state = 'active'
    AND sh.checked_out_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'recommended technician is not active in TurnIQ';
  END IF;

  SELECT main.price_cents + coalesce(addon.price_cents, 0)
  INTO v_opportunity_credit
  FROM public.services main
  LEFT JOIN public.services addon
    ON addon.id = v_booking.addon_service_id
    AND addon.salon_id = v_booking.salon_id
    AND addon.deleted_at IS NULL
    AND addon.is_addon
  WHERE main.id = v_booking.service_id
    AND main.salon_id = v_booking.salon_id
    AND main.deleted_at IS NULL;
  IF v_opportunity_credit IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23503',
      MESSAGE = 'TurnIQ booking service catalog truth is unavailable';
  END IF;

  INSERT INTO public.turniq_assignments (
    salon_id, policy_version_id, shift_session_id, booking_id,
    customer_request_id, recommended_staff_id, requested_staff_id, service_id,
    resource_id, requested_tech_source, request_trust_label,
    requested_tech_actor_ref, requested_tech_recorded_at, decision_timestamp,
    decision_fingerprint, snapshot_version, privacy_safe_explanation,
    eligible_candidates, skipped_candidates, internal_decision_trace,
    opportunity_credit_cents
  ) VALUES (
    p_salon_id, p_policy_version_id, v_shift.id, p_booking_id,
    p_customer_request_id, p_recommended_staff_id, p_requested_staff_id,
    v_booking.service_id, coalesce(p_resource_id, v_booking.resource_id),
    p_requested_tech_source, p_request_trust_label,
    p_requested_tech_actor_ref, p_requested_tech_recorded_at,
    p_decision_timestamp, p_decision_fingerprint, btrim(p_snapshot_version),
    btrim(p_privacy_safe_explanation), p_eligible_candidates,
    p_skipped_candidates, p_internal_decision_trace, v_opportunity_credit
  ) RETURNING * INTO v_assignment;

  v_result := pg_catalog.jsonb_build_object(
    'ok', true, 'command_id', p_command_id, 'replayed', false,
    'assignment_id', v_assignment.id, 'booking_id', v_assignment.booking_id,
    'recommended_staff_id', v_assignment.recommended_staff_id,
    'status', v_assignment.status, 'state_version', v_assignment.state_version,
    'decision_fingerprint', v_assignment.decision_fingerprint
  );
  PERFORM public.turniq_store_online_command(
    p_command_id, p_salon_id, p_policy_version_id, p_device_id,
    p_local_sequence, p_actor_user_id, p_actor_role, 'recommend',
    p_request_fingerprint, 'committed', v_result, p_occurred_at
  );
  INSERT INTO public.turniq_events (
    salon_id, policy_version_id, assignment_id, command_id, aggregate_type,
    aggregate_id, aggregate_version, event_type, actor_user_id, actor_staff_id,
    actor_role, actor_ref, reason_code, decision_fingerprint,
    request_fingerprint, payload, occurred_at
  ) VALUES (
    p_salon_id, p_policy_version_id, v_assignment.id, p_command_id,
    'assignment', v_assignment.id, 1, 'assignment_recommended',
    p_actor_user_id, nullif(v_context ->> 'actor_staff_id', '')::uuid,
    p_actor_role, 'user:' || p_actor_user_id::text, 'recommend',
    p_decision_fingerprint, p_request_fingerprint,
    pg_catalog.jsonb_build_object(
      'booking_id', p_booking_id,
      'recommended_staff_id', p_recommended_staff_id,
      'status', 'recommended',
      'state_version', 1
    ),
    p_occurred_at
  );
  RETURN v_result;
END
$function$;

CREATE OR REPLACE FUNCTION public.apply_turniq_assignment_command_v1(
  p_salon_id uuid,
  p_policy_version_id uuid,
  p_assignment_id uuid,
  p_command_type text,
  p_assigned_staff_id uuid,
  p_override_reason text,
  p_command_id uuid,
  p_device_id uuid,
  p_local_sequence bigint,
  p_actor_user_id uuid,
  p_actor_role text,
  p_request_fingerprint text,
  p_occurred_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO ''
AS $function$
DECLARE
  v_context jsonb;
  v_replay jsonb;
  v_assignment public.turniq_assignments%ROWTYPE;
  v_booking public.bookings%ROWTYPE;
  v_shift public.turniq_shift_sessions%ROWTYPE;
  v_fairness_receipt_id uuid := extensions.gen_random_uuid();
  v_exception_id uuid;
  v_result jsonb;
  v_result_status text := 'committed';
  v_event_type text;
  v_event_version bigint;
  v_actor_staff_id uuid;
  v_normalized_reason text := nullif(btrim(coalesce(p_override_reason, '')), '');
  v_skipped_reason_codes jsonb := '[]'::jsonb;
  v_actual_revenue integer;
  v_actual_tax integer;
BEGIN
  IF p_command_id IS NULL OR p_device_id IS NULL OR p_assignment_id IS NULL
     OR p_local_sequence <= 0 OR p_request_fingerprint !~ '^[0-9a-f]{64}$'
     OR p_command_type NOT IN ('confirm', 'override', 'start', 'complete') THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'invalid TurnIQ assignment command';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('turniq-command:' || p_command_id::text, 0)
  );
  v_replay := public.turniq_replay_online_command(
    p_command_id, p_salon_id, p_policy_version_id, p_actor_user_id,
    p_actor_role, p_command_type, p_request_fingerprint
  );
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;

  v_context := public.turniq_online_context(
    p_salon_id, p_policy_version_id, p_actor_user_id, p_actor_role,
    p_occurred_at
  );
  v_actor_staff_id := nullif(v_context ->> 'actor_staff_id', '')::uuid;

  SELECT a.* INTO v_assignment
  FROM public.turniq_assignments a
  WHERE a.id = p_assignment_id AND a.salon_id = p_salon_id
  FOR UPDATE;
  IF NOT FOUND OR v_assignment.policy_version_id IS DISTINCT FROM p_policy_version_id THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'TurnIQ assignment is unavailable or stale';
  END IF;

  SELECT coalesce(max(e.aggregate_version), 0) + 1
  INTO v_event_version
  FROM public.turniq_events e
  WHERE e.salon_id = p_salon_id
    AND e.aggregate_type = 'assignment'
    AND e.aggregate_id = p_assignment_id;

  SELECT b.* INTO v_booking
  FROM public.bookings b
  WHERE b.id = v_assignment.booking_id AND b.salon_id = p_salon_id
  FOR UPDATE;
  IF NOT FOUND OR v_booking.deleted_at IS NOT NULL
     OR v_booking.schedule_model <> 'single' THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'TurnIQ booking is unavailable or unsupported';
  END IF;

  IF p_command_type IN ('confirm', 'override') THEN
    IF p_actor_role NOT IN ('owner', 'admin', 'senior', 'receptionist')
       OR v_assignment.status <> 'recommended'
       OR p_assigned_staff_id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '42501',
        MESSAGE = 'TurnIQ confirmation requires desk role and recommended state';
    END IF;
    IF p_command_type = 'confirm'
       AND p_assigned_staff_id IS DISTINCT FROM v_assignment.recommended_staff_id THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'TurnIQ confirmation does not match recommendation';
    END IF;
    IF p_command_type = 'override'
       AND (v_normalized_reason IS NULL OR length(v_normalized_reason) > 500) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'TurnIQ override reason is required';
    END IF;

    SELECT sh.* INTO v_shift
    FROM public.turniq_shift_sessions sh
    WHERE sh.salon_id = p_salon_id
      AND sh.policy_version_id = p_policy_version_id
      AND sh.business_date = (v_context ->> 'business_date')::date
      AND sh.staff_id = p_assigned_staff_id
      AND sh.state = 'active'
      AND sh.checked_out_at IS NULL
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'assigned technician is not active in TurnIQ';
    END IF;

    IF v_booking.status NOT IN ('pending', 'confirmed', 'waiting')
       OR (v_booking.staff_id IS NOT NULL
           AND v_booking.staff_id IS DISTINCT FROM p_assigned_staff_id) THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'booking assignment changed or is no longer confirmable';
    END IF;

    IF p_command_type = 'override'
       AND p_assigned_staff_id IS DISTINCT FROM v_assignment.recommended_staff_id
       AND v_actor_staff_id IS NOT NULL
       AND v_actor_staff_id = p_assigned_staff_id
       AND p_actor_role NOT IN ('owner', 'admin') THEN
      v_exception_id := extensions.gen_random_uuid();
      INSERT INTO public.turniq_exceptions (
        id, salon_id, policy_version_id, assignment_id, exception_type,
        privacy_safe_summary, recommended_action, detail
      ) VALUES (
        v_exception_id, p_salon_id, p_policy_version_id, p_assignment_id,
        'self_assignment_override',
        'A self-assignment override needs owner or admin confirmation.',
        'Review the recommendation and approve or choose another technician.',
        pg_catalog.jsonb_build_object(
          'actor_user_id', p_actor_user_id,
          'assigned_staff_id', p_assigned_staff_id,
          'recommended_staff_id', v_assignment.recommended_staff_id,
          'reason', v_normalized_reason
        )
      );
      v_result_status := 'conflict';
      v_event_type := 'self_assignment_override_blocked';
      v_result := pg_catalog.jsonb_build_object(
        'ok', false, 'code', 'owner_confirmation_required',
        'command_id', p_command_id, 'replayed', false,
        'assignment_id', p_assignment_id, 'exception_id', v_exception_id,
        'status', v_assignment.status,
        'state_version', v_assignment.state_version
      );
      PERFORM public.turniq_store_online_command(
        p_command_id, p_salon_id, p_policy_version_id, p_device_id,
        p_local_sequence, p_actor_user_id, p_actor_role, p_command_type,
        p_request_fingerprint, v_result_status, v_result, p_occurred_at
      );
      INSERT INTO public.turniq_events (
        salon_id, policy_version_id, assignment_id, command_id, aggregate_type,
        aggregate_id, aggregate_version, event_type, actor_user_id,
        actor_staff_id, actor_role, actor_ref, reason_code, reason_detail,
        decision_fingerprint, request_fingerprint, payload, occurred_at
      ) VALUES (
        p_salon_id, p_policy_version_id, p_assignment_id, p_command_id,
        'assignment', p_assignment_id, v_event_version, v_event_type,
        p_actor_user_id, v_actor_staff_id, p_actor_role,
        'user:' || p_actor_user_id::text, 'owner_confirmation_required',
        v_normalized_reason, v_assignment.decision_fingerprint,
        p_request_fingerprint,
        pg_catalog.jsonb_build_object('exception_id', v_exception_id),
        p_occurred_at
      );
      RETURN v_result;
    END IF;

    BEGIN
      UPDATE public.bookings b
      SET staff_id = p_assigned_staff_id,
          resource_id = coalesce(b.resource_id, v_assignment.resource_id),
          status = 'confirmed',
          confirmed_at = coalesce(b.confirmed_at, p_occurred_at),
          no_show_candidate_at = NULL
      WHERE b.id = v_booking.id
        AND b.status = v_booking.status;
    EXCEPTION WHEN exclusion_violation OR unique_violation THEN
      RAISE EXCEPTION USING ERRCODE = '23P01',
        MESSAGE = 'TurnIQ assignment conflicts with live capacity';
    END;

    UPDATE public.turniq_assignments a
    SET shift_session_id = v_shift.id,
        assigned_staff_id = p_assigned_staff_id,
        status = 'confirmed',
        confirmation_kind = CASE WHEN p_command_type = 'override'
          THEN 'override' ELSE 'confirmed_recommendation' END,
        confirmation_actor_user_id = p_actor_user_id,
        override_reason = CASE WHEN p_command_type = 'override'
          THEN v_normalized_reason ELSE NULL END,
        confirmed_at = p_occurred_at,
        state_version = a.state_version + 1,
        updated_at = pg_catalog.transaction_timestamp()
    WHERE a.id = p_assignment_id
      AND a.state_version = v_assignment.state_version
    RETURNING * INTO v_assignment;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '40001',
        MESSAGE = 'TurnIQ assignment changed concurrently';
    END IF;

    SELECT coalesce(pg_catalog.jsonb_agg(code ORDER BY code), '[]'::jsonb)
    INTO v_skipped_reason_codes
    FROM (
      SELECT DISTINCT reason.value AS code
      FROM pg_catalog.jsonb_array_elements(v_assignment.skipped_candidates) item
      CROSS JOIN LATERAL pg_catalog.jsonb_array_elements_text(
        coalesce(item -> 'reasonCodes', '[]'::jsonb)
      ) reason(value)
    ) codes;

    v_event_type := CASE WHEN p_command_type = 'override'
      THEN 'assignment_overridden' ELSE 'assignment_confirmed' END;
    v_result := pg_catalog.jsonb_build_object(
      'ok', true, 'command_id', p_command_id, 'replayed', false,
      'assignment_id', p_assignment_id, 'booking_id', v_booking.id,
      'assigned_staff_id', p_assigned_staff_id, 'status', 'confirmed',
      'state_version', v_assignment.state_version,
      'fairness_receipt_id', v_fairness_receipt_id
    );
    PERFORM public.turniq_store_online_command(
      p_command_id, p_salon_id, p_policy_version_id, p_device_id,
      p_local_sequence, p_actor_user_id, p_actor_role, p_command_type,
      p_request_fingerprint, 'committed', v_result, p_occurred_at
    );
    INSERT INTO public.turniq_fairness_receipts (
      id, salon_id, policy_version_id, assignment_id, command_id,
      recommended_staff_id, assigned_staff_id, service_id, resource_id,
      requested_tech_source, request_trust_label, privacy_safe_explanation,
      skipped_reason_codes, fairness_band_cents, decision_fingerprint,
      command_fingerprint, actor_user_id, actor_role, assignment_outcome,
      override_reason
    ) VALUES (
      v_fairness_receipt_id, p_salon_id, p_policy_version_id, p_assignment_id,
      p_command_id, v_assignment.recommended_staff_id,
      v_assignment.assigned_staff_id, v_assignment.service_id,
      v_assignment.resource_id, v_assignment.requested_tech_source,
      v_assignment.request_trust_label, v_assignment.privacy_safe_explanation,
      v_skipped_reason_codes, (v_context ->> 'fairness_band_cents')::integer,
      v_assignment.decision_fingerprint, p_request_fingerprint,
      p_actor_user_id, p_actor_role, v_assignment.confirmation_kind,
      v_assignment.override_reason
    );
  ELSIF p_command_type = 'start' THEN
    IF v_assignment.status <> 'confirmed'
       OR v_assignment.assigned_staff_id IS NULL
       OR v_booking.status <> 'confirmed'
       OR p_occurred_at < v_assignment.confirmed_at THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'TurnIQ assignment is not ready to start';
    END IF;
    IF p_actor_role = 'nail_tech'
       AND v_actor_staff_id IS DISTINCT FROM v_assignment.assigned_staff_id THEN
      RAISE EXCEPTION USING ERRCODE = '42501',
        MESSAGE = 'Technician may start only own TurnIQ assignment';
    END IF;

    SELECT sh.* INTO v_shift
    FROM public.turniq_shift_sessions sh
    WHERE sh.id = v_assignment.shift_session_id
      AND sh.salon_id = p_salon_id
      AND sh.state = 'active'
      AND sh.checked_out_at IS NULL
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'assigned technician is not active';
    END IF;

    UPDATE public.bookings b
    SET status = 'in_progress', started_at = p_occurred_at,
        no_show_candidate_at = NULL
    WHERE b.id = v_booking.id AND b.status = 'confirmed';
    UPDATE public.turniq_assignments a
    SET status = 'in_progress', started_at = p_occurred_at,
        state_version = a.state_version + 1,
        updated_at = pg_catalog.transaction_timestamp()
    WHERE a.id = p_assignment_id
      AND a.state_version = v_assignment.state_version
    RETURNING * INTO v_assignment;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '40001',
        MESSAGE = 'TurnIQ assignment changed concurrently';
    END IF;
    v_event_type := 'service_started';
    v_result := pg_catalog.jsonb_build_object(
      'ok', true, 'command_id', p_command_id, 'replayed', false,
      'assignment_id', p_assignment_id, 'booking_id', v_booking.id,
      'assigned_staff_id', v_assignment.assigned_staff_id,
      'status', v_assignment.status, 'state_version', v_assignment.state_version
    );
    PERFORM public.turniq_store_online_command(
      p_command_id, p_salon_id, p_policy_version_id, p_device_id,
      p_local_sequence, p_actor_user_id, p_actor_role, p_command_type,
      p_request_fingerprint, 'committed', v_result, p_occurred_at
    );
  ELSE
    IF v_assignment.status <> 'in_progress'
       OR v_assignment.assigned_staff_id IS NULL
       OR v_booking.status <> 'in_progress'
       OR p_occurred_at < v_assignment.started_at THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'TurnIQ assignment is not ready to complete';
    END IF;
    IF p_actor_role = 'nail_tech'
       AND v_actor_staff_id IS DISTINCT FROM v_assignment.assigned_staff_id THEN
      RAISE EXCEPTION USING ERRCODE = '42501',
        MESSAGE = 'Technician may complete only own TurnIQ assignment';
    END IF;

    SELECT sh.* INTO v_shift
    FROM public.turniq_shift_sessions sh
    WHERE sh.id = v_assignment.shift_session_id
      AND sh.salon_id = p_salon_id
      AND sh.checked_out_at IS NULL
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'assigned technician shift is unavailable';
    END IF;

    v_actual_revenue := coalesce(
      v_booking.subtotal_cents,
      coalesce(v_booking.price_cents, 0) + coalesce(v_booking.addon_price_cents, 0)
    );
    v_actual_tax := v_booking.tax_amount_cents;

    UPDATE public.bookings b
    SET status = 'completed', no_show_candidate_at = NULL
    WHERE b.id = v_booking.id AND b.status = 'in_progress';
    UPDATE public.turniq_assignments a
    SET status = 'completed', turn_consumed = true,
        actual_service_revenue_cents = v_actual_revenue,
        actual_tax_cents = v_actual_tax,
        actual_tip_cents = NULL,
        completed_at = p_occurred_at,
        state_version = a.state_version + 1,
        updated_at = pg_catalog.transaction_timestamp()
    WHERE a.id = p_assignment_id
      AND a.state_version = v_assignment.state_version
    RETURNING * INTO v_assignment;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '40001',
        MESSAGE = 'TurnIQ assignment changed concurrently';
    END IF;
    UPDATE public.turniq_shift_sessions sh
    SET turns_consumed = sh.turns_consumed + 1,
        service_credit_since_checkin_cents =
          sh.service_credit_since_checkin_cents
          + v_assignment.opportunity_credit_cents,
        state_version = sh.state_version + 1,
        updated_at = pg_catalog.transaction_timestamp()
    WHERE sh.id = v_shift.id
      AND sh.state_version = v_shift.state_version;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '40001',
        MESSAGE = 'TurnIQ shift changed concurrently';
    END IF;

    v_event_type := 'service_completed';
    v_result := pg_catalog.jsonb_build_object(
      'ok', true, 'command_id', p_command_id, 'replayed', false,
      'assignment_id', p_assignment_id, 'booking_id', v_booking.id,
      'assigned_staff_id', v_assignment.assigned_staff_id,
      'status', v_assignment.status, 'state_version', v_assignment.state_version,
      'turn_consumed', true
    );
    PERFORM public.turniq_store_online_command(
      p_command_id, p_salon_id, p_policy_version_id, p_device_id,
      p_local_sequence, p_actor_user_id, p_actor_role, p_command_type,
      p_request_fingerprint, 'committed', v_result, p_occurred_at
    );
  END IF;

  INSERT INTO public.turniq_events (
    salon_id, policy_version_id, assignment_id, command_id, aggregate_type,
    aggregate_id, aggregate_version, event_type, actor_user_id, actor_staff_id,
    actor_role, actor_ref, reason_code, reason_detail, decision_fingerprint,
    request_fingerprint, payload, occurred_at
  ) VALUES (
    p_salon_id, p_policy_version_id, p_assignment_id, p_command_id,
    'assignment', p_assignment_id, v_event_version, v_event_type,
    p_actor_user_id, v_actor_staff_id, p_actor_role,
    'user:' || p_actor_user_id::text, p_command_type,
    CASE WHEN p_command_type = 'override' THEN v_normalized_reason ELSE NULL END,
    v_assignment.decision_fingerprint, p_request_fingerprint,
    pg_catalog.jsonb_build_object(
      'booking_id', v_booking.id,
      'assigned_staff_id', v_assignment.assigned_staff_id,
      'status', v_assignment.status,
      'state_version', v_assignment.state_version,
      'turn_consumed', v_assignment.turn_consumed
    ),
    p_occurred_at
  );
  RETURN v_result;
END
$function$;

REVOKE ALL ON FUNCTION public.turniq_sha256_jsonb(jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.turniq_online_context(uuid, uuid, uuid, text, timestamptz)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.turniq_replay_online_command(uuid, uuid, uuid, uuid, text, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.turniq_store_online_command(uuid, uuid, uuid, uuid, bigint, uuid, text, text, text, text, jsonb, timestamptz)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apply_turniq_shift_command_v1(uuid, uuid, uuid, text, text, uuid, uuid, bigint, uuid, text, text, timestamptz)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_turniq_recommendation_v1(uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, text, text, timestamptz, timestamptz, text, text, text, jsonb, jsonb, jsonb, uuid, uuid, bigint, uuid, text, text, timestamptz)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apply_turniq_assignment_command_v1(uuid, uuid, uuid, text, uuid, text, uuid, uuid, bigint, uuid, text, text, timestamptz)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.turniq_sha256_jsonb(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.turniq_online_context(uuid, uuid, uuid, text, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.turniq_replay_online_command(uuid, uuid, uuid, uuid, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.turniq_store_online_command(uuid, uuid, uuid, uuid, bigint, uuid, text, text, text, text, jsonb, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.apply_turniq_shift_command_v1(uuid, uuid, uuid, text, text, uuid, uuid, bigint, uuid, text, text, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_turniq_recommendation_v1(uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, text, text, timestamptz, timestamptz, text, text, text, jsonb, jsonb, jsonb, uuid, uuid, bigint, uuid, text, text, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.apply_turniq_assignment_command_v1(uuid, uuid, uuid, text, uuid, text, uuid, uuid, bigint, uuid, text, text, timestamptz) TO service_role;

COMMENT ON FUNCTION public.apply_turniq_shift_command_v1(uuid, uuid, uuid, text, text, uuid, uuid, bigint, uuid, text, text, timestamptz) IS
  'M3A service-only atomic shift state command with actor membership, own-tech scope, policy date, event, and idempotency receipt.';
COMMENT ON FUNCTION public.record_turniq_recommendation_v1(uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, text, text, timestamptz, timestamptz, text, text, text, jsonb, jsonb, jsonb, uuid, uuid, bigint, uuid, text, text, timestamptz) IS
  'M3A service-only persistence of one deterministic single-service recommendation. Does not mutate booking state.';
COMMENT ON FUNCTION public.apply_turniq_assignment_command_v1(uuid, uuid, uuid, text, uuid, text, uuid, uuid, bigint, uuid, text, text, timestamptz) IS
  'M3A service-only atomic confirm/override/start/complete command. Narrow own-tech start/complete is allowed; confirmation remains desk-only.';
