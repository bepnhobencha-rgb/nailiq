-- TurnIQ M4G: persist and atomically confirm a selected staggered group plan.
--
-- The M4E/M4F timing engine is read-only. This migration adds a service-only
-- bridge that can persist its trusted output without changing a booking, then
-- later move every group member and confirm the existing M4B ledger inside one
-- transaction. Any stale member, trigger rewrite or capacity conflict rolls
-- back the whole group.
--
-- Rollback: keep turniq_trust_engine_enabled OFF and stop invoking the two M4G
-- RPCs. Preserve group plans, assignments, command receipts, Fairness Receipts
-- and events as immutable audit evidence. Do not delete ledger history.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.turniq_group_plans
  ADD COLUMN planning_mode text NOT NULL DEFAULT 'fixed',
  ADD COLUMN timing_intent text,
  ADD COLUMN source_simulation_id uuid,
  ADD COLUMN simulation_fingerprint text;

ALTER TABLE public.turniq_group_plans
  ADD CONSTRAINT turniq_group_plans_planning_mode_check CHECK (
    planning_mode IN ('fixed', 'staggered')
  ),
  ADD CONSTRAINT turniq_group_plans_timing_truth_check CHECK (
    (
      planning_mode = 'fixed'
      AND timing_intent IS NULL
      AND source_simulation_id IS NULL
      AND simulation_fingerprint IS NULL
    ) OR (
      planning_mode = 'staggered'
      AND timing_intent IN ('start_together', 'finish_together', 'smart_wave')
      AND source_simulation_id IS NOT NULL
      AND simulation_fingerprint ~ '^[0-9a-f]{64}$'
    )
  );

CREATE UNIQUE INDEX turniq_group_plan_simulation_once_idx
  ON public.turniq_group_plans (salon_id, source_simulation_id)
  WHERE source_simulation_id IS NOT NULL;

ALTER TABLE public.turniq_group_plan_items
  ADD COLUMN original_start_at timestamptz,
  ADD COLUMN original_end_at timestamptz,
  ADD COLUMN original_booking_material_fingerprint text,
  ADD COLUMN wave_number smallint;

ALTER TABLE public.turniq_group_plan_items
  ADD CONSTRAINT turniq_group_plan_items_original_window_check CHECK (
    (original_start_at IS NULL AND original_end_at IS NULL)
    OR (
      original_start_at IS NOT NULL
      AND original_end_at IS NOT NULL
      AND original_end_at > original_start_at
    )
  ),
  ADD CONSTRAINT turniq_group_plan_items_original_fingerprint_check CHECK (
    original_booking_material_fingerprint IS NULL
    OR original_booking_material_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT turniq_group_plan_items_wave_check CHECK (
    wave_number IS NULL OR wave_number BETWEEN 1 AND 12
  );

CREATE OR REPLACE FUNCTION public.record_turniq_staggered_group_plan_v1(
  p_salon_id uuid,
  p_policy_version_id uuid,
  p_booking_group_id uuid,
  p_requested_start_at timestamptz,
  p_timing_intent text,
  p_simulation_id uuid,
  p_simulation_fingerprint text,
  p_decision_timestamp timestamptz,
  p_decision_fingerprint text,
  p_snapshot_version text,
  p_privacy_safe_explanation text,
  p_objective_score jsonb,
  p_conservative_eta jsonb,
  p_items jsonb,
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
SET search_path = ''
AS $function$
DECLARE
  v_context jsonb;
  v_replay jsonb;
  v_plan public.turniq_group_plans%ROWTYPE;
  v_item jsonb;
  v_booking public.bookings%ROWTYPE;
  v_shift public.turniq_shift_sessions%ROWTYPE;
  v_assignment public.turniq_assignments%ROWTYPE;
  v_main public.services%ROWTYPE;
  v_addon public.services%ROWTYPE;
  v_resource_id uuid;
  v_staff_id uuid;
  v_customer_request_id uuid;
  v_opportunity_credit integer;
  v_original_fingerprint text;
  v_planned_fingerprint text;
  v_starts_at timestamptz;
  v_safe_end_at timestamptz;
  v_required_safe_end timestamptz;
  v_position integer := 0;
  v_count integer;
  v_result jsonb;
BEGIN
  IF p_booking_group_id IS NULL OR p_requested_start_at IS NULL
     OR p_simulation_id IS NULL OR p_command_id IS NULL OR p_device_id IS NULL
     OR p_actor_user_id IS NULL OR p_local_sequence <= 0
     OR p_timing_intent NOT IN ('start_together', 'finish_together', 'smart_wave')
     OR p_simulation_fingerprint !~ '^[0-9a-f]{64}$'
     OR p_decision_fingerprint !~ '^[0-9a-f]{64}$'
     OR p_request_fingerprint !~ '^[0-9a-f]{64}$'
     OR coalesce(length(btrim(p_snapshot_version)), 0) NOT BETWEEN 1 AND 120
     OR coalesce(length(btrim(p_privacy_safe_explanation)), 0) NOT BETWEEN 1 AND 500
     OR jsonb_typeof(p_objective_score) <> 'object'
     OR jsonb_typeof(p_conservative_eta) <> 'object'
     OR jsonb_typeof(p_items) <> 'array'
     OR jsonb_array_length(p_items) NOT BETWEEN 2 AND 12 THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'invalid TurnIQ staggered group recommendation command';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('turniq-command:' || p_command_id::text, 0)
  );
  v_replay := public.turniq_replay_online_command(
    p_command_id, p_salon_id, p_policy_version_id, p_actor_user_id,
    p_actor_role, 'recommend_group', p_request_fingerprint
  );
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;

  v_context := public.turniq_online_context(
    p_salon_id, p_policy_version_id, p_actor_user_id, p_actor_role, p_occurred_at
  );
  IF p_actor_role NOT IN ('owner', 'admin', 'senior', 'receptionist') THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'TurnIQ staggered group recommendation requires desk role';
  END IF;
  IF (p_requested_start_at AT TIME ZONE
      (v_context ->> 'business_timezone'))::date IS DISTINCT FROM
      (v_context ->> 'business_date')::date THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'TurnIQ staggered group request is outside the active business day';
  END IF;

  -- Lock the current group in stable order. Recording a plan is read-only for
  -- bookings, but the lock makes the material fingerprints one coherent truth.
  PERFORM 1
  FROM public.bookings AS b
  WHERE b.salon_id = p_salon_id AND b.group_id = p_booking_group_id
    AND b.deleted_at IS NULL
    AND b.status NOT IN ('cancelled', 'no_show', 'completed')
  ORDER BY b.id
  FOR UPDATE;

  SELECT count(*) INTO v_count
  FROM public.bookings AS b
  WHERE b.salon_id = p_salon_id AND b.group_id = p_booking_group_id
    AND b.deleted_at IS NULL
    AND b.status NOT IN ('cancelled', 'no_show', 'completed');
  IF v_count IS DISTINCT FROM jsonb_array_length(p_items)
     OR (SELECT count(DISTINCT (item ->> 'bookingId')::uuid)
         FROM jsonb_array_elements(p_items) AS item)
        IS DISTINCT FROM jsonb_array_length(p_items)
     OR (SELECT count(DISTINCT b.id)
         FROM public.bookings b
         JOIN jsonb_array_elements(p_items) item
           ON (item ->> 'bookingId')::uuid = b.id
         WHERE b.salon_id = p_salon_id
           AND b.group_id = p_booking_group_id
           AND b.deleted_at IS NULL
           AND b.status NOT IN ('cancelled', 'no_show', 'completed'))
        IS DISTINCT FROM v_count THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'TurnIQ staggered group membership changed';
  END IF;

  INSERT INTO public.turniq_group_plans (
    salon_id, policy_version_id, booking_group_id, party_size,
    requested_start_at, decision_timestamp, decision_fingerprint,
    snapshot_version, privacy_safe_explanation, objective_score,
    conservative_eta, created_by_user_id, planning_mode, timing_intent,
    source_simulation_id, simulation_fingerprint
  ) VALUES (
    p_salon_id, p_policy_version_id, p_booking_group_id,
    jsonb_array_length(p_items), p_requested_start_at,
    p_decision_timestamp, p_decision_fingerprint, btrim(p_snapshot_version),
    btrim(p_privacy_safe_explanation), p_objective_score,
    p_conservative_eta, p_actor_user_id, 'staggered', p_timing_intent,
    p_simulation_id, p_simulation_fingerprint
  ) RETURNING * INTO v_plan;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    v_position := v_position + 1;
    BEGIN
      v_staff_id := (v_item ->> 'recommendedStaffId')::uuid;
      v_customer_request_id := (v_item ->> 'customerRequestId')::uuid;
      v_resource_id := nullif(v_item ->> 'resourceId', '')::uuid;
      v_starts_at := (v_item ->> 'startsAt')::timestamptz;
      v_safe_end_at := (v_item ->> 'safeEndAt')::timestamptz;
    EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format
      OR datetime_field_overflow THEN
      RAISE EXCEPTION USING ERRCODE = '22023',
        MESSAGE = 'invalid TurnIQ staggered group item';
    END;
    IF coalesce(length(btrim(v_item ->> 'taskRef')), 0) NOT BETWEEN 1 AND 120
       OR v_starts_at < p_requested_start_at
       OR v_starts_at > p_requested_start_at + interval '12 hours'
       OR v_safe_end_at <= v_starts_at
       OR coalesce((v_item ->> 'waveNumber')::integer, 0) NOT BETWEEN 1 AND 12
       OR coalesce((v_item ->> 'waitMinutes')::integer, -1) < 0
       OR (v_starts_at AT TIME ZONE
          (v_context ->> 'business_timezone'))::date IS DISTINCT FROM
          (v_context ->> 'business_date')::date
       OR ((v_safe_end_at - interval '1 microsecond') AT TIME ZONE
          (v_context ->> 'business_timezone'))::date IS DISTINCT FROM
          (v_context ->> 'business_date')::date THEN
      RAISE EXCEPTION USING ERRCODE = '22023',
        MESSAGE = 'TurnIQ staggered group item is outside the safe window';
    END IF;

    SELECT b.* INTO v_booking
    FROM public.bookings AS b
    WHERE b.id = (v_item ->> 'bookingId')::uuid
      AND b.salon_id = p_salon_id
      AND b.group_id = p_booking_group_id
    FOR UPDATE;
    IF NOT FOUND OR v_booking.deleted_at IS NOT NULL
       OR v_booking.schedule_model <> 'single'
       OR v_booking.status NOT IN ('pending', 'confirmed', 'waiting')
       OR v_booking.staff_id IS NOT NULL
       OR v_booking.start_time_utc IS NULL OR v_booking.end_time_utc IS NULL
       OR v_booking.start_time_utc >= v_booking.end_time_utc
       OR (v_booking.start_time_utc AT TIME ZONE
          (v_context ->> 'business_timezone'))::date IS DISTINCT FROM
          (v_context ->> 'business_date')::date
       OR EXISTS (SELECT 1 FROM public.booking_addons ba
                  WHERE ba.booking_id = v_booking.id)
       OR EXISTS (SELECT 1 FROM public.booking_service_segments seg
                  WHERE seg.booking_id = v_booking.id) THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'group booking member is not eligible for staggered TurnIQ plan';
    END IF;
    IF v_booking.resource_id IS NOT NULL
       AND v_resource_id IS DISTINCT FROM v_booking.resource_id THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'TurnIQ staggered group plan resource mismatch';
    END IF;

    SELECT sh.* INTO v_shift
    FROM public.turniq_shift_sessions AS sh
    WHERE sh.salon_id = p_salon_id
      AND sh.policy_version_id = p_policy_version_id
      AND sh.business_date = (v_context ->> 'business_date')::date
      AND sh.staff_id = v_staff_id
      AND sh.state = 'active' AND sh.checked_out_at IS NULL
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'staggered group technician is not active in TurnIQ';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.staff st
      WHERE st.id = v_staff_id AND st.salon_id = p_salon_id
        AND st.status = 'active' AND st.deleted_at IS NULL
    ) OR NOT EXISTS (
      SELECT 1 FROM public.staff_services ss
      WHERE ss.staff_id = v_staff_id AND ss.service_id = v_booking.service_id
    ) OR (v_booking.addon_service_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.staff_services ss
      WHERE ss.staff_id = v_staff_id
        AND ss.service_id = v_booking.addon_service_id
    )) THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'staggered group technician is not qualified';
    END IF;

    SELECT s.* INTO v_main FROM public.services s
    WHERE s.id = v_booking.service_id AND s.salon_id = p_salon_id
      AND s.deleted_at IS NULL;
    SELECT s.* INTO v_addon FROM public.services s
    WHERE s.id = v_booking.addon_service_id AND s.salon_id = p_salon_id
      AND s.deleted_at IS NULL AND s.is_addon;
    IF v_main.id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23503',
        MESSAGE = 'staggered group catalog truth is unavailable';
    END IF;
    v_required_safe_end := v_starts_at + make_interval(
      mins => v_main.duration_minutes + v_main.buffer_minutes +
        CASE WHEN v_addon.id IS NOT NULL AND v_addon.addon_timing = 'sequential'
          THEN v_addon.duration_minutes + v_addon.buffer_minutes ELSE 0 END
    );
    IF v_safe_end_at IS DISTINCT FROM v_required_safe_end THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'TurnIQ staggered group duration does not match catalog truth';
    END IF;

    IF v_resource_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.salon_resources r
      WHERE r.id = v_resource_id AND r.salon_id = p_salon_id
        AND r.status = 'active' AND r.deleted_at IS NULL
        AND (v_main.resource_requirement_mode <> 'specific'
          OR r.kind = ANY(v_main.required_resource_kinds))
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'staggered group resource is not active or compatible';
    END IF;
    IF v_main.resource_requirement_mode = 'none' AND v_resource_id IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'staggered group service does not use a resource';
    ELSIF v_main.resource_requirement_mode = 'specific' AND v_resource_id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'staggered group service requires a resource';
    END IF;

    v_opportunity_credit := v_main.price_cents + coalesce(v_addon.price_cents, 0);
    v_original_fingerprint := public.turniq_sha256_jsonb(
      jsonb_build_object(
        'bookingId', v_booking.id, 'groupId', v_booking.group_id,
        'serviceId', v_booking.service_id, 'addonServiceId', v_booking.addon_service_id,
        'startAt', v_booking.start_time_utc, 'endAt', v_booking.end_time_utc,
        'status', v_booking.status, 'resourceId', v_booking.resource_id,
        'scheduleModel', v_booking.schedule_model
      )
    );
    v_planned_fingerprint := public.turniq_sha256_jsonb(
      jsonb_build_object(
        'bookingId', v_booking.id, 'groupId', v_booking.group_id,
        'serviceId', v_booking.service_id, 'addonServiceId', v_booking.addon_service_id,
        'startAt', v_starts_at, 'endAt', v_safe_end_at,
        'status', v_booking.status, 'resourceId', v_resource_id,
        'scheduleModel', v_booking.schedule_model
      )
    );

    INSERT INTO public.turniq_assignments (
      salon_id, policy_version_id, shift_session_id, booking_id,
      assignment_group_id, customer_request_id, recommended_staff_id,
      requested_staff_id, service_id, resource_id, requested_tech_source,
      request_trust_label, requested_tech_actor_ref,
      requested_tech_recorded_at, decision_timestamp, decision_fingerprint,
      snapshot_version, privacy_safe_explanation, eligible_candidates,
      skipped_candidates, internal_decision_trace, opportunity_credit_cents
    ) VALUES (
      p_salon_id, p_policy_version_id, v_shift.id, v_booking.id, v_plan.id,
      v_customer_request_id, v_staff_id,
      nullif(v_item ->> 'requestedStaffId', '')::uuid,
      v_booking.service_id, v_resource_id,
      nullif(v_item ->> 'requestedTechSource', ''),
      nullif(v_item ->> 'requestTrustLabel', ''),
      nullif(v_item ->> 'requestedTechActorRef', ''),
      nullif(v_item ->> 'requestedTechRecordedAt', '')::timestamptz,
      p_decision_timestamp,
      public.turniq_sha256_jsonb(jsonb_build_object(
        'groupDecisionFingerprint', p_decision_fingerprint,
        'simulationFingerprint', p_simulation_fingerprint,
        'bookingId', v_booking.id, 'staffId', v_staff_id,
        'startsAt', v_starts_at, 'safeEndAt', v_safe_end_at
      )), p_snapshot_version,
      coalesce(nullif(v_item ->> 'explanation', ''), p_privacy_safe_explanation),
      coalesce(v_item -> 'eligibleCandidates', '[]'::jsonb),
      coalesce(v_item -> 'skippedCandidates', '[]'::jsonb),
      coalesce(v_item -> 'internalDecisionTrace', '{}'::jsonb) ||
        jsonb_build_object(
          'groupPlanId', v_plan.id, 'groupPlanVersion', 2,
          'timingIntent', p_timing_intent,
          'simulationId', p_simulation_id,
          'waveNumber', (v_item ->> 'waveNumber')::integer
        ),
      v_opportunity_credit
    ) RETURNING * INTO v_assignment;

    INSERT INTO public.turniq_group_plan_items (
      salon_id, group_plan_id, item_position, task_ref, assignment_id,
      booking_id, proposed_staff_id, proposed_shift_session_id,
      proposed_resource_id, starts_at, safe_end_at,
      booking_material_fingerprint, requested_fallback, wait_minutes,
      original_start_at, original_end_at,
      original_booking_material_fingerprint, wave_number
    ) VALUES (
      p_salon_id, v_plan.id, v_position, btrim(v_item ->> 'taskRef'),
      v_assignment.id, v_booking.id, v_staff_id, v_shift.id, v_resource_id,
      v_starts_at, v_safe_end_at, v_planned_fingerprint,
      coalesce((v_item ->> 'requestedFallback')::boolean, false),
      coalesce((v_item ->> 'waitMinutes')::integer, 0),
      v_booking.start_time_utc, v_booking.end_time_utc,
      v_original_fingerprint, (v_item ->> 'waveNumber')::smallint
    );
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM public.turniq_group_plan_items a
    JOIN public.turniq_group_plan_items b
      ON b.group_plan_id = a.group_plan_id AND b.id > a.id
     AND (b.proposed_staff_id = a.proposed_staff_id
       OR (b.proposed_resource_id IS NOT NULL
         AND b.proposed_resource_id = a.proposed_resource_id))
     AND tstzrange(b.starts_at, b.safe_end_at, '[)') &&
         tstzrange(a.starts_at, a.safe_end_at, '[)')
    WHERE a.group_plan_id = v_plan.id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23P01',
      MESSAGE = 'TurnIQ staggered group plan contains overlapping capacity';
  END IF;

  v_result := jsonb_build_object(
    'ok', true, 'command_id', p_command_id, 'replayed', false,
    'group_plan_id', v_plan.id, 'booking_group_id', p_booking_group_id,
    'party_size', v_plan.party_size, 'status', v_plan.status,
    'state_version', v_plan.state_version,
    'planning_mode', v_plan.planning_mode,
    'timing_intent', v_plan.timing_intent,
    'simulation_id', v_plan.source_simulation_id,
    'simulation_fingerprint', v_plan.simulation_fingerprint,
    'decision_fingerprint', v_plan.decision_fingerprint
  );
  PERFORM public.turniq_store_online_command(
    p_command_id, p_salon_id, p_policy_version_id, p_device_id,
    p_local_sequence, p_actor_user_id, p_actor_role, 'recommend_group',
    p_request_fingerprint, 'committed', v_result, p_occurred_at
  );
  INSERT INTO public.turniq_events (
    salon_id, policy_version_id, command_id, aggregate_type, aggregate_id,
    aggregate_version, event_type, actor_user_id, actor_staff_id, actor_role,
    actor_ref, reason_code, decision_fingerprint, request_fingerprint,
    payload, occurred_at
  ) VALUES (
    p_salon_id, p_policy_version_id, p_command_id, 'group_plan', v_plan.id,
    1, 'staggered_group_plan_recommended', p_actor_user_id,
    nullif(v_context ->> 'actor_staff_id', '')::uuid, p_actor_role,
    'user:' || p_actor_user_id::text, 'recommend_group',
    p_decision_fingerprint, p_request_fingerprint,
    jsonb_build_object(
      'booking_group_id', p_booking_group_id, 'party_size', v_plan.party_size,
      'status', v_plan.status, 'planning_mode', v_plan.planning_mode,
      'timing_intent', v_plan.timing_intent,
      'simulation_id', v_plan.source_simulation_id
    ), p_occurred_at
  );
  RETURN v_result;
END
$function$;

CREATE OR REPLACE FUNCTION public.confirm_turniq_staggered_group_plan_v1(
  p_salon_id uuid,
  p_policy_version_id uuid,
  p_group_plan_id uuid,
  p_expected_state_version bigint,
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
SET search_path = ''
AS $function$
DECLARE
  v_context jsonb;
  v_replay jsonb;
  v_plan public.turniq_group_plans%ROWTYPE;
  v_item public.turniq_group_plan_items%ROWTYPE;
  v_booking public.bookings%ROWTYPE;
  v_original_fingerprint text;
  v_result jsonb;
BEGIN
  IF p_group_plan_id IS NULL OR p_expected_state_version <= 0
     OR p_command_id IS NULL OR p_device_id IS NULL
     OR p_actor_user_id IS NULL OR p_local_sequence <= 0
     OR p_request_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'invalid TurnIQ staggered group confirmation command';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('turniq-command:' || p_command_id::text, 0)
  );
  v_replay := public.turniq_replay_online_command(
    p_command_id, p_salon_id, p_policy_version_id, p_actor_user_id,
    p_actor_role, 'confirm_group', p_request_fingerprint
  );
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;

  v_context := public.turniq_online_context(
    p_salon_id, p_policy_version_id, p_actor_user_id, p_actor_role, p_occurred_at
  );
  IF p_actor_role NOT IN ('owner', 'admin', 'senior', 'receptionist') THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'TurnIQ staggered group confirmation requires desk role';
  END IF;

  SELECT gp.* INTO v_plan
  FROM public.turniq_group_plans gp
  WHERE gp.id = p_group_plan_id AND gp.salon_id = p_salon_id
    AND gp.policy_version_id = p_policy_version_id
  FOR UPDATE;
  IF NOT FOUND OR v_plan.status <> 'recommended'
     OR v_plan.planning_mode <> 'staggered'
     OR v_plan.state_version IS DISTINCT FROM p_expected_state_version
     OR v_plan.source_simulation_id IS NULL
     OR v_plan.simulation_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'TurnIQ staggered group plan is stale; refresh required';
  END IF;

  -- Capacity locks are acquired in the same global order as M4B and booking
  -- writes. Re-entering these locks inside confirm_turniq_group_plan_v1 is safe.
  FOR v_item IN
    SELECT i.* FROM public.turniq_group_plan_items i
    WHERE i.salon_id = p_salon_id AND i.group_plan_id = p_group_plan_id
    ORDER BY i.proposed_staff_id, i.booking_id
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'booking-capacity:staff:' || p_salon_id::text || ':' ||
        v_item.proposed_staff_id::text, 0
      )
    );
  END LOOP;
  FOR v_item IN
    SELECT DISTINCT ON (i.proposed_resource_id) i.*
    FROM public.turniq_group_plan_items i
    WHERE i.salon_id = p_salon_id AND i.group_plan_id = p_group_plan_id
      AND i.proposed_resource_id IS NOT NULL
    ORDER BY i.proposed_resource_id, i.booking_id
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'booking-capacity:resource:' || p_salon_id::text || ':' ||
        v_item.proposed_resource_id::text, 0
      )
    );
  END LOOP;

  PERFORM 1 FROM public.bookings b
  JOIN public.turniq_group_plan_items i ON i.booking_id = b.id
  WHERE i.salon_id = p_salon_id AND i.group_plan_id = p_group_plan_id
  ORDER BY b.id FOR UPDATE OF b;

  IF (SELECT count(*) FROM public.turniq_group_plan_items i
      WHERE i.salon_id = p_salon_id AND i.group_plan_id = p_group_plan_id)
       IS DISTINCT FROM v_plan.party_size
     OR (SELECT count(*) FROM public.bookings b
         WHERE b.salon_id = p_salon_id AND b.group_id = v_plan.booking_group_id
           AND b.deleted_at IS NULL
           AND b.status NOT IN ('cancelled', 'no_show', 'completed'))
       IS DISTINCT FROM v_plan.party_size THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'TurnIQ staggered group membership changed; refresh required';
  END IF;

  -- Prove that every booking still matches the exact pre-simulation material
  -- snapshot before moving even one member. A stale member aborts the statement.
  FOR v_item IN
    SELECT i.* FROM public.turniq_group_plan_items i
    WHERE i.salon_id = p_salon_id AND i.group_plan_id = p_group_plan_id
    ORDER BY i.booking_id
  LOOP
    SELECT b.* INTO v_booking FROM public.bookings b
    WHERE b.id = v_item.booking_id AND b.salon_id = p_salon_id;
    v_original_fingerprint := public.turniq_sha256_jsonb(
      jsonb_build_object(
        'bookingId', v_booking.id, 'groupId', v_booking.group_id,
        'serviceId', v_booking.service_id, 'addonServiceId', v_booking.addon_service_id,
        'startAt', v_booking.start_time_utc, 'endAt', v_booking.end_time_utc,
        'status', v_booking.status, 'resourceId', v_booking.resource_id,
        'scheduleModel', v_booking.schedule_model
      )
    );
    IF v_booking.deleted_at IS NOT NULL
       OR v_booking.group_id IS DISTINCT FROM v_plan.booking_group_id
       OR v_booking.staff_id IS NOT NULL
       OR v_booking.schedule_model <> 'single'
       OR v_booking.status NOT IN ('pending', 'confirmed', 'waiting')
       OR v_item.original_start_at IS NULL OR v_item.original_end_at IS NULL
       OR v_item.original_booking_material_fingerprint IS NULL
       OR v_original_fingerprint IS DISTINCT FROM
          v_item.original_booking_material_fingerprint
       OR v_booking.start_time_utc IS DISTINCT FROM v_item.original_start_at
       OR v_booking.end_time_utc IS DISTINCT FROM v_item.original_end_at
       OR (v_item.starts_at AT TIME ZONE
          (v_context ->> 'business_timezone'))::date IS DISTINCT FROM
          (v_context ->> 'business_date')::date
       OR ((v_item.safe_end_at - interval '1 microsecond') AT TIME ZONE
          (v_context ->> 'business_timezone'))::date IS DISTINCT FROM
          (v_context ->> 'business_date')::date THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'TurnIQ staggered group facts changed; no booking moved';
    END IF;
  END LOOP;

  -- One set-based statement moves every member to the selected wave and sets
  -- its already-validated resource. Booking triggers remain active. Any trigger
  -- rewrite or exclusion conflict makes the later M4B fingerprint check fail,
  -- rolling this update back with the entire outer transaction.
  UPDATE public.bookings b
  SET start_time_utc = i.starts_at,
      end_time_utc = i.safe_end_at,
      resource_id = i.proposed_resource_id,
      wave_number = i.wave_number
  FROM public.turniq_group_plan_items i
  WHERE i.salon_id = p_salon_id AND i.group_plan_id = p_group_plan_id
    AND b.id = i.booking_id;

  v_result := public.confirm_turniq_group_plan_v1(
    p_salon_id, p_policy_version_id, p_group_plan_id, p_override_reason,
    p_command_id, p_device_id, p_local_sequence, p_actor_user_id,
    p_actor_role, p_request_fingerprint, p_occurred_at
  );
  -- Return the exact M4B command receipt payload. A retry must be byte-for-byte
  -- equivalent to the first committed response, not a wrapper-only variant.
  RETURN v_result;
EXCEPTION WHEN exclusion_violation OR unique_violation THEN
  RAISE EXCEPTION USING ERRCODE = '23P01',
    MESSAGE = 'TurnIQ staggered group conflicts with live capacity; no booking moved';
END
$function$;

REVOKE ALL ON FUNCTION public.record_turniq_staggered_group_plan_v1(
  uuid, uuid, uuid, timestamptz, text, uuid, text, timestamptz, text, text,
  text, jsonb, jsonb, jsonb, uuid, uuid, bigint, uuid, text, text, timestamptz
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.confirm_turniq_staggered_group_plan_v1(
  uuid, uuid, uuid, bigint, text, uuid, uuid, bigint, uuid, text, text,
  timestamptz
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_turniq_staggered_group_plan_v1(
  uuid, uuid, uuid, timestamptz, text, uuid, text, timestamptz, text, text,
  text, jsonb, jsonb, jsonb, uuid, uuid, bigint, uuid, text, text, timestamptz
) TO service_role;
GRANT EXECUTE ON FUNCTION public.confirm_turniq_staggered_group_plan_v1(
  uuid, uuid, uuid, bigint, text, uuid, uuid, bigint, uuid, text, text,
  timestamptz
) TO service_role;

COMMENT ON FUNCTION public.record_turniq_staggered_group_plan_v1(
  uuid, uuid, uuid, timestamptz, text, uuid, text, timestamptz, text, text,
  text, jsonb, jsonb, jsonb, uuid, uuid, bigint, uuid, text, text, timestamptz
) IS 'Service-only M4G command: persist a trusted staggered timing simulation without moving any booking.';
COMMENT ON FUNCTION public.confirm_turniq_staggered_group_plan_v1(
  uuid, uuid, uuid, bigint, text, uuid, uuid, bigint, uuid, text, text,
  timestamptz
) IS 'Service-only M4G command: move and confirm all staggered group members atomically through the M4B ledger.';

COMMIT;
