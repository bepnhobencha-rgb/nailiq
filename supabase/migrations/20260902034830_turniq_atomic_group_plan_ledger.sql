-- TurnIQ M4B: authoritative atomic group-plan ledger.
--
-- A group recommendation is recorded without mutating bookings. Confirmation
-- revalidates every member against current salon, staff, shift, skill,
-- appointment-gap and resource truth, then commits all members in one
-- transaction. Any stale or conflicting member aborts the entire group.
--
-- Rollback: keep turniq_trust_engine_enabled OFF and stop invoking the two
-- service-only RPCs. Preserve plan, assignment, receipt, command and event rows
-- as audit evidence. Do not delete ledger history.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.turniq_command_receipts
  DROP CONSTRAINT turniq_command_receipts_command_type_check;
ALTER TABLE public.turniq_command_receipts
  ADD CONSTRAINT turniq_command_receipts_command_type_check CHECK (
    command_type IN (
      'check_in', 'check_out', 'break', 'return', 'hold', 'release_hold',
      'recommend', 'confirm', 'override', 'start', 'complete',
      'add_service', 'swap', 'correction', 'refuse', 'redo', 'dispute',
      'resolve_dispute', 'acknowledge_exception', 'resolve_exception',
      'dismiss_exception', 'recommend_group', 'confirm_group'
    )
  );

ALTER TABLE public.turniq_events
  DROP CONSTRAINT turniq_events_aggregate_type_check;
ALTER TABLE public.turniq_events
  ADD CONSTRAINT turniq_events_aggregate_type_check CHECK (
    aggregate_type IN (
      'policy', 'shift', 'assignment', 'exception', 'dispute', 'device',
      'group_plan'
    )
  );

CREATE TABLE public.turniq_group_plans (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  policy_version_id uuid NOT NULL,
  booking_group_id uuid NOT NULL,
  party_size smallint NOT NULL CHECK (party_size BETWEEN 2 AND 12),
  requested_start_at timestamptz NOT NULL,
  decision_timestamp timestamptz NOT NULL,
  decision_fingerprint text NOT NULL
    CHECK (decision_fingerprint ~ '^[0-9a-f]{64}$'),
  snapshot_version text NOT NULL
    CHECK (length(btrim(snapshot_version)) BETWEEN 1 AND 120),
  privacy_safe_explanation text NOT NULL
    CHECK (length(btrim(privacy_safe_explanation)) BETWEEN 1 AND 500),
  objective_score jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(objective_score) = 'object'),
  conservative_eta jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(conservative_eta) = 'object'),
  status text NOT NULL DEFAULT 'recommended'
    CHECK (status IN ('recommended', 'confirming', 'confirmed', 'stale', 'rejected')),
  created_by_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  confirmed_by_user_id uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  confirmation_command_id uuid,
  confirmed_at timestamptz,
  state_version bigint NOT NULL DEFAULT 1 CHECK (state_version > 0),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT turniq_group_plan_confirmation_truth_check CHECK (
    (status <> 'confirmed' AND confirmed_by_user_id IS NULL
      AND confirmation_command_id IS NULL AND confirmed_at IS NULL)
    OR (status = 'confirmed' AND confirmed_by_user_id IS NOT NULL
      AND confirmation_command_id IS NOT NULL AND confirmed_at IS NOT NULL
      AND confirmed_at >= decision_timestamp)
  ),
  FOREIGN KEY (salon_id, policy_version_id)
    REFERENCES public.turniq_policy_versions(salon_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (salon_id, confirmation_command_id)
    REFERENCES public.turniq_command_receipts(salon_id, command_id)
    ON DELETE RESTRICT,
  UNIQUE (salon_id, id)
);

CREATE UNIQUE INDEX turniq_group_plan_one_active_group_idx
  ON public.turniq_group_plans (salon_id, booking_group_id)
  WHERE status IN ('recommended', 'confirming', 'confirmed');
CREATE INDEX turniq_group_plan_policy_fk_idx
  ON public.turniq_group_plans (salon_id, policy_version_id);
CREATE INDEX turniq_group_plan_created_by_fk_idx
  ON public.turniq_group_plans (created_by_user_id);
CREATE INDEX turniq_group_plan_confirmed_by_fk_idx
  ON public.turniq_group_plans (confirmed_by_user_id)
  WHERE confirmed_by_user_id IS NOT NULL;
CREATE INDEX turniq_group_plan_command_fk_idx
  ON public.turniq_group_plans (salon_id, confirmation_command_id)
  WHERE confirmation_command_id IS NOT NULL;

CREATE TABLE public.turniq_group_plan_items (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  group_plan_id uuid NOT NULL,
  item_position smallint NOT NULL CHECK (item_position > 0),
  task_ref text NOT NULL CHECK (length(btrim(task_ref)) BETWEEN 1 AND 120),
  assignment_id uuid NOT NULL,
  booking_id uuid NOT NULL REFERENCES public.bookings(id) ON DELETE RESTRICT,
  proposed_staff_id uuid NOT NULL REFERENCES public.staff(id) ON DELETE RESTRICT,
  proposed_shift_session_id uuid NOT NULL,
  proposed_resource_id uuid REFERENCES public.salon_resources(id) ON DELETE RESTRICT,
  starts_at timestamptz NOT NULL,
  safe_end_at timestamptz NOT NULL,
  booking_material_fingerprint text NOT NULL
    CHECK (booking_material_fingerprint ~ '^[0-9a-f]{64}$'),
  requested_fallback boolean NOT NULL DEFAULT false,
  wait_minutes integer NOT NULL DEFAULT 0 CHECK (wait_minutes >= 0),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CHECK (safe_end_at > starts_at),
  FOREIGN KEY (salon_id, group_plan_id)
    REFERENCES public.turniq_group_plans(salon_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (salon_id, assignment_id)
    REFERENCES public.turniq_assignments(salon_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (salon_id, proposed_shift_session_id)
    REFERENCES public.turniq_shift_sessions(salon_id, id) ON DELETE RESTRICT,
  UNIQUE (salon_id, id),
  UNIQUE (salon_id, group_plan_id, item_position),
  UNIQUE (salon_id, group_plan_id, task_ref),
  UNIQUE (salon_id, group_plan_id, booking_id),
  UNIQUE (salon_id, group_plan_id, assignment_id)
);

CREATE INDEX turniq_group_plan_item_booking_fk_idx
  ON public.turniq_group_plan_items (booking_id);
CREATE INDEX turniq_group_plan_item_staff_fk_idx
  ON public.turniq_group_plan_items (proposed_staff_id);
CREATE INDEX turniq_group_plan_item_resource_fk_idx
  ON public.turniq_group_plan_items (proposed_resource_id)
  WHERE proposed_resource_id IS NOT NULL;
CREATE INDEX turniq_group_plan_item_shift_fk_idx
  ON public.turniq_group_plan_items (salon_id, proposed_shift_session_id);

CREATE TRIGGER reject_turniq_group_plan_item_mutation
  BEFORE UPDATE OR DELETE ON public.turniq_group_plan_items
  FOR EACH ROW EXECUTE FUNCTION public.reject_turniq_immutable_mutation();

ALTER TABLE public.turniq_group_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.turniq_group_plans FORCE ROW LEVEL SECURITY;
ALTER TABLE public.turniq_group_plan_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.turniq_group_plan_items FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.turniq_group_plans FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.turniq_group_plan_items FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.turniq_group_plans TO service_role;
GRANT SELECT, INSERT ON TABLE public.turniq_group_plan_items TO service_role;

CREATE OR REPLACE FUNCTION public.record_turniq_group_plan_v1(
  p_salon_id uuid,
  p_policy_version_id uuid,
  p_booking_group_id uuid,
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
  v_resource_id uuid;
  v_staff_id uuid;
  v_customer_request_id uuid;
  v_opportunity_credit integer;
  v_material_fingerprint text;
  v_position integer := 0;
  v_count integer;
  v_result jsonb;
BEGIN
  IF p_booking_group_id IS NULL OR p_command_id IS NULL OR p_device_id IS NULL
     OR p_actor_user_id IS NULL OR p_local_sequence <= 0
     OR p_decision_fingerprint !~ '^[0-9a-f]{64}$'
     OR p_request_fingerprint !~ '^[0-9a-f]{64}$'
     OR coalesce(length(btrim(p_snapshot_version)), 0) NOT BETWEEN 1 AND 120
     OR coalesce(length(btrim(p_privacy_safe_explanation)), 0) NOT BETWEEN 1 AND 500
     OR jsonb_typeof(p_objective_score) <> 'object'
     OR jsonb_typeof(p_conservative_eta) <> 'object'
     OR jsonb_typeof(p_items) <> 'array'
     OR jsonb_array_length(p_items) NOT BETWEEN 2 AND 12 THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'invalid TurnIQ group recommendation command';
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
      MESSAGE = 'TurnIQ group recommendation requires desk role';
  END IF;

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
  IF v_count IS DISTINCT FROM jsonb_array_length(p_items) THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'TurnIQ group membership changed';
  END IF;

  INSERT INTO public.turniq_group_plans (
    salon_id, policy_version_id, booking_group_id, party_size,
    requested_start_at, decision_timestamp, decision_fingerprint,
    snapshot_version, privacy_safe_explanation, objective_score,
    conservative_eta, created_by_user_id
  ) VALUES (
    p_salon_id, p_policy_version_id, p_booking_group_id,
    jsonb_array_length(p_items),
    (p_items -> 0 ->> 'startsAt')::timestamptz,
    p_decision_timestamp, p_decision_fingerprint, btrim(p_snapshot_version),
    btrim(p_privacy_safe_explanation), p_objective_score,
    p_conservative_eta, p_actor_user_id
  ) RETURNING * INTO v_plan;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    v_position := v_position + 1;
    v_staff_id := (v_item ->> 'recommendedStaffId')::uuid;
    v_customer_request_id := (v_item ->> 'customerRequestId')::uuid;
    v_resource_id := nullif(v_item ->> 'resourceId', '')::uuid;

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
       OR (v_booking.start_time_utc AT TIME ZONE
          (v_context ->> 'business_timezone'))::date IS DISTINCT FROM
          (v_context ->> 'business_date')::date
       OR v_booking.start_time_utc IS DISTINCT FROM (v_item ->> 'startsAt')::timestamptz
       OR (v_item ->> 'safeEndAt')::timestamptz < v_booking.end_time_utc
       OR EXISTS (SELECT 1 FROM public.booking_addons ba WHERE ba.booking_id = v_booking.id)
       OR EXISTS (SELECT 1 FROM public.booking_service_segments seg
                  WHERE seg.booking_id = v_booking.id) THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'group booking member is not eligible for TurnIQ plan';
    END IF;
    -- A booking with an already-selected resource is authoritative. When the
    -- booking has no resource yet, the deterministic group planner may choose
    -- one and the confirmation transaction will revalidate and persist it.
    IF v_booking.resource_id IS NOT NULL
       AND v_resource_id IS DISTINCT FROM v_booking.resource_id THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'TurnIQ group plan resource mismatch';
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
        MESSAGE = 'group technician is not active in TurnIQ';
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
        MESSAGE = 'group technician is not qualified for booking services';
    END IF;
    IF v_resource_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.salon_resources r
      WHERE r.id = v_resource_id AND r.salon_id = p_salon_id
        AND r.status = 'active' AND r.deleted_at IS NULL
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'group resource is not active';
    END IF;

    SELECT main.price_cents + coalesce(addon.price_cents, 0)
    INTO v_opportunity_credit
    FROM public.services main
    LEFT JOIN public.services addon
      ON addon.id = v_booking.addon_service_id
      AND addon.salon_id = v_booking.salon_id
      AND addon.deleted_at IS NULL AND addon.is_addon
    WHERE main.id = v_booking.service_id
      AND main.salon_id = v_booking.salon_id AND main.deleted_at IS NULL;
    IF v_opportunity_credit IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23503',
        MESSAGE = 'group booking catalog truth is unavailable';
    END IF;

    v_material_fingerprint := public.turniq_sha256_jsonb(
      jsonb_build_object(
        'bookingId', v_booking.id, 'groupId', v_booking.group_id,
        'serviceId', v_booking.service_id, 'addonServiceId', v_booking.addon_service_id,
        'startAt', v_booking.start_time_utc, 'endAt', v_booking.end_time_utc,
        'status', v_booking.status, 'resourceId', v_booking.resource_id,
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
        'bookingId', v_booking.id, 'staffId', v_staff_id
      )), p_snapshot_version,
      coalesce(nullif(v_item ->> 'explanation', ''), p_privacy_safe_explanation),
      coalesce(v_item -> 'eligibleCandidates', '[]'::jsonb),
      coalesce(v_item -> 'skippedCandidates', '[]'::jsonb),
      coalesce(v_item -> 'internalDecisionTrace', '{}'::jsonb) ||
        jsonb_build_object('groupPlanId', v_plan.id, 'groupPlanVersion', 1),
      v_opportunity_credit
    ) RETURNING * INTO v_assignment;

    INSERT INTO public.turniq_group_plan_items (
      salon_id, group_plan_id, item_position, task_ref, assignment_id,
      booking_id, proposed_staff_id, proposed_shift_session_id,
      proposed_resource_id, starts_at, safe_end_at,
      booking_material_fingerprint, requested_fallback, wait_minutes
    ) VALUES (
      p_salon_id, v_plan.id, v_position, btrim(v_item ->> 'taskRef'),
      v_assignment.id, v_booking.id, v_staff_id, v_shift.id, v_resource_id,
      (v_item ->> 'startsAt')::timestamptz,
      (v_item ->> 'safeEndAt')::timestamptz, v_material_fingerprint,
      coalesce((v_item ->> 'requestedFallback')::boolean, false),
      coalesce((v_item ->> 'waitMinutes')::integer, 0)
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
      MESSAGE = 'TurnIQ group plan contains overlapping staff or resource';
  END IF;

  v_result := jsonb_build_object(
    'ok', true, 'command_id', p_command_id, 'replayed', false,
    'group_plan_id', v_plan.id, 'booking_group_id', p_booking_group_id,
    'party_size', v_plan.party_size, 'status', v_plan.status,
    'state_version', v_plan.state_version,
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
    1, 'group_plan_recommended', p_actor_user_id,
    nullif(v_context ->> 'actor_staff_id', '')::uuid, p_actor_role,
    'user:' || p_actor_user_id::text, 'recommend_group',
    p_decision_fingerprint, p_request_fingerprint,
    jsonb_build_object('booking_group_id', p_booking_group_id,
      'party_size', v_plan.party_size, 'status', v_plan.status), p_occurred_at
  );
  RETURN v_result;
END
$function$;

CREATE OR REPLACE FUNCTION public.confirm_turniq_group_plan_v1(
  p_salon_id uuid,
  p_policy_version_id uuid,
  p_group_plan_id uuid,
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
  v_assignment public.turniq_assignments%ROWTYPE;
  v_shift public.turniq_shift_sessions%ROWTYPE;
  v_main public.services%ROWTYPE;
  v_addon public.services%ROWTYPE;
  v_material_fingerprint text;
  v_required_safe_end timestamptz;
  v_has_fallback boolean;
  v_receipt_id uuid;
  v_receipts jsonb := '[]'::jsonb;
  v_skipped_reason_codes jsonb;
  v_result jsonb;
BEGIN
  IF p_group_plan_id IS NULL OR p_command_id IS NULL OR p_device_id IS NULL
     OR p_actor_user_id IS NULL OR p_local_sequence <= 0
     OR p_request_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'invalid TurnIQ group confirmation command';
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
      MESSAGE = 'TurnIQ group confirmation requires desk role';
  END IF;

  SELECT gp.* INTO v_plan
  FROM public.turniq_group_plans AS gp
  WHERE gp.id = p_group_plan_id AND gp.salon_id = p_salon_id
    AND gp.policy_version_id = p_policy_version_id
  FOR UPDATE;
  IF NOT FOUND OR v_plan.status <> 'recommended' THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'TurnIQ group plan is not ready to confirm';
  END IF;

  SELECT bool_or(i.requested_fallback) INTO v_has_fallback
  FROM public.turniq_group_plan_items AS i
  WHERE i.salon_id = p_salon_id AND i.group_plan_id = p_group_plan_id;
  IF v_has_fallback AND coalesce(length(btrim(p_override_reason)), 0) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'requested-technician fallback requires an override reason';
  END IF;

  -- Match the established booking-capacity lock namespace and deterministic
  -- order so group confirmation cannot race individual booking writes.
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
  PERFORM 1 FROM public.turniq_assignments a
  JOIN public.turniq_group_plan_items i ON i.assignment_id = a.id
  WHERE i.salon_id = p_salon_id AND i.group_plan_id = p_group_plan_id
  ORDER BY a.id FOR UPDATE OF a;

  IF (SELECT count(*) FROM public.bookings b
      WHERE b.salon_id = p_salon_id AND b.group_id = v_plan.booking_group_id
        AND b.deleted_at IS NULL
        AND b.status NOT IN ('cancelled', 'no_show', 'completed'))
     IS DISTINCT FROM v_plan.party_size THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'TurnIQ group membership changed; refresh required';
  END IF;

  FOR v_item IN
    SELECT i.* FROM public.turniq_group_plan_items i
    WHERE i.salon_id = p_salon_id AND i.group_plan_id = p_group_plan_id
    ORDER BY i.booking_id
  LOOP
    SELECT b.* INTO v_booking FROM public.bookings b
    WHERE b.id = v_item.booking_id AND b.salon_id = p_salon_id;
    SELECT a.* INTO v_assignment FROM public.turniq_assignments a
    WHERE a.id = v_item.assignment_id AND a.salon_id = p_salon_id;
    SELECT sh.* INTO v_shift FROM public.turniq_shift_sessions sh
    WHERE sh.id = v_item.proposed_shift_session_id AND sh.salon_id = p_salon_id;
    SELECT s.* INTO v_main FROM public.services s
    WHERE s.id = v_booking.service_id AND s.salon_id = p_salon_id;
    SELECT s.* INTO v_addon FROM public.services s
    WHERE s.id = v_booking.addon_service_id AND s.salon_id = p_salon_id;

    v_material_fingerprint := public.turniq_sha256_jsonb(
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
       OR v_booking.schedule_model <> 'single'
       OR v_booking.status NOT IN ('pending', 'confirmed', 'waiting')
       OR v_booking.staff_id IS NOT NULL
       OR (v_booking.start_time_utc AT TIME ZONE
          (v_context ->> 'business_timezone'))::date IS DISTINCT FROM
          (v_context ->> 'business_date')::date
       OR v_material_fingerprint IS DISTINCT FROM v_item.booking_material_fingerprint
       OR v_assignment.status <> 'recommended'
       OR v_assignment.recommended_staff_id IS DISTINCT FROM v_item.proposed_staff_id
       OR v_shift.state <> 'active' OR v_shift.checked_out_at IS NOT NULL
       OR v_shift.policy_version_id IS DISTINCT FROM p_policy_version_id
       OR v_shift.business_date IS DISTINCT FROM (v_context ->> 'business_date')::date
       OR NOT EXISTS (SELECT 1 FROM public.staff st
                      WHERE st.id = v_item.proposed_staff_id
                        AND st.salon_id = p_salon_id
                        AND st.status = 'active' AND st.deleted_at IS NULL)
       OR NOT EXISTS (SELECT 1 FROM public.staff_services ss
                      WHERE ss.staff_id = v_item.proposed_staff_id
                        AND ss.service_id = v_booking.service_id)
       OR (v_booking.addon_service_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM public.staff_services ss
            WHERE ss.staff_id = v_item.proposed_staff_id
              AND ss.service_id = v_booking.addon_service_id
          )) THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'TurnIQ group plan facts changed; refresh required';
    END IF;

    v_required_safe_end := v_booking.start_time_utc +
      make_interval(mins => v_main.duration_minutes + v_main.buffer_minutes +
        CASE WHEN v_addon.id IS NOT NULL AND v_addon.addon_timing = 'sequential'
          THEN v_addon.duration_minutes + v_addon.buffer_minutes ELSE 0 END);
    IF v_item.safe_end_at < v_booking.end_time_utc
       OR v_item.safe_end_at < v_required_safe_end THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'TurnIQ group appointment gap is no longer safe';
    END IF;

    IF v_item.proposed_resource_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.salon_resources r
      WHERE r.id = v_item.proposed_resource_id AND r.salon_id = p_salon_id
        AND r.status = 'active' AND r.deleted_at IS NULL
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'TurnIQ group resource is no longer active';
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.bookings b
      WHERE b.salon_id = p_salon_id AND b.id <> v_booking.id
        AND NOT EXISTS (SELECT 1 FROM public.turniq_group_plan_items pi
                        WHERE pi.group_plan_id = p_group_plan_id
                          AND pi.booking_id = b.id)
        AND b.staff_id = v_item.proposed_staff_id AND b.deleted_at IS NULL
        AND b.status NOT IN ('cancelled', 'no_show', 'completed')
        AND tstzrange(b.start_time_utc, b.end_time_utc, '[)') &&
            tstzrange(v_item.starts_at, v_item.safe_end_at, '[)')
    ) OR EXISTS (
      SELECT 1 FROM public.booking_service_segments seg
      WHERE seg.salon_id = p_salon_id
        AND seg.staff_id = v_item.proposed_staff_id
        AND seg.reservation_status NOT IN ('cancelled', 'no_show', 'completed')
        AND tstzrange(seg.occupied_start_utc, seg.occupied_end_utc, '[)') &&
            tstzrange(v_item.starts_at, v_item.safe_end_at, '[)')
    ) OR (v_item.proposed_resource_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.bookings b
      WHERE b.salon_id = p_salon_id AND b.id <> v_booking.id
        AND NOT EXISTS (SELECT 1 FROM public.turniq_group_plan_items pi
                        WHERE pi.group_plan_id = p_group_plan_id
                          AND pi.booking_id = b.id)
        AND b.resource_id = v_item.proposed_resource_id AND b.deleted_at IS NULL
        AND b.status NOT IN ('cancelled', 'no_show', 'completed')
        AND tstzrange(b.start_time_utc, b.end_time_utc, '[)') &&
            tstzrange(v_item.starts_at, v_item.safe_end_at, '[)')
    )) OR (v_item.proposed_resource_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.booking_service_segments seg
      WHERE seg.salon_id = p_salon_id
        AND seg.resource_id = v_item.proposed_resource_id
        AND seg.reservation_status NOT IN ('cancelled', 'no_show', 'completed')
        AND tstzrange(seg.occupied_start_utc, seg.occupied_end_utc, '[)') &&
            tstzrange(v_item.starts_at, v_item.safe_end_at, '[)')
    )) THEN
      RAISE EXCEPTION USING ERRCODE = '23P01',
        MESSAGE = 'TurnIQ group conflicts with live appointment capacity';
    END IF;
  END LOOP;

  -- Confirm assignments first. The existing single-booking safety trigger then
  -- sees no recommended row; all equivalent group checks have already passed
  -- under the same locks and transaction.
  UPDATE public.turniq_assignments a
  SET assigned_staff_id = i.proposed_staff_id,
      shift_session_id = i.proposed_shift_session_id,
      status = 'confirmed',
      confirmation_kind = CASE WHEN i.requested_fallback
        THEN 'override' ELSE 'confirmed_recommendation' END,
      confirmation_actor_user_id = p_actor_user_id,
      override_reason = CASE WHEN i.requested_fallback
        THEN btrim(p_override_reason) ELSE NULL END,
      confirmed_at = p_occurred_at,
      state_version = a.state_version + 1,
      updated_at = transaction_timestamp()
  FROM public.turniq_group_plan_items i
  WHERE i.salon_id = p_salon_id AND i.group_plan_id = p_group_plan_id
    AND a.id = i.assignment_id AND a.status = 'recommended';

  UPDATE public.bookings b
  SET staff_id = i.proposed_staff_id,
      resource_id = i.proposed_resource_id,
      status = 'confirmed',
      confirmed_at = coalesce(b.confirmed_at, p_occurred_at),
      no_show_candidate_at = NULL
  FROM public.turniq_group_plan_items i
  WHERE i.salon_id = p_salon_id AND i.group_plan_id = p_group_plan_id
    AND b.id = i.booking_id;

  FOR v_item IN
    SELECT i.* FROM public.turniq_group_plan_items i
    WHERE i.salon_id = p_salon_id AND i.group_plan_id = p_group_plan_id
    ORDER BY i.item_position
  LOOP
    v_receipts := v_receipts || jsonb_build_array(jsonb_build_object(
      'assignment_id', v_item.assignment_id,
      'fairness_receipt_id', extensions.gen_random_uuid()
    ));
  END LOOP;

  v_result := jsonb_build_object(
    'ok', true, 'command_id', p_command_id, 'replayed', false,
    'group_plan_id', p_group_plan_id, 'booking_group_id', v_plan.booking_group_id,
    'party_size', v_plan.party_size, 'status', 'confirmed',
    'state_version', v_plan.state_version + 1,
    'fairness_receipts', v_receipts
  );
  PERFORM public.turniq_store_online_command(
    p_command_id, p_salon_id, p_policy_version_id, p_device_id,
    p_local_sequence, p_actor_user_id, p_actor_role, 'confirm_group',
    p_request_fingerprint, 'committed', v_result, p_occurred_at
  );

  FOR v_item IN
    SELECT i.* FROM public.turniq_group_plan_items i
    WHERE i.salon_id = p_salon_id AND i.group_plan_id = p_group_plan_id
    ORDER BY i.item_position
  LOOP
    SELECT a.* INTO v_assignment FROM public.turniq_assignments a
    WHERE a.id = v_item.assignment_id;
    SELECT coalesce(jsonb_agg(code ORDER BY code), '[]'::jsonb)
    INTO v_skipped_reason_codes
    FROM (
      SELECT DISTINCT reason.value AS code
      FROM jsonb_array_elements(v_assignment.skipped_candidates) item
      CROSS JOIN LATERAL jsonb_array_elements_text(
        coalesce(item -> 'reasonCodes', '[]'::jsonb)
      ) reason(value)
    ) codes;
    SELECT (receipt ->> 'fairness_receipt_id')::uuid
    INTO v_receipt_id
    FROM jsonb_array_elements(v_receipts) receipt
    WHERE (receipt ->> 'assignment_id')::uuid = v_assignment.id;
    INSERT INTO public.turniq_fairness_receipts (
      id, salon_id, policy_version_id, assignment_id, command_id,
      recommended_staff_id, assigned_staff_id, service_id, resource_id,
      requested_tech_source, request_trust_label, privacy_safe_explanation,
      skipped_reason_codes, fairness_band_cents, decision_fingerprint,
      command_fingerprint, actor_user_id, actor_role, assignment_outcome,
      override_reason
    ) VALUES (
      v_receipt_id, p_salon_id, p_policy_version_id, v_assignment.id,
      p_command_id, v_assignment.recommended_staff_id,
      v_assignment.assigned_staff_id, v_assignment.service_id,
      v_assignment.resource_id, v_assignment.requested_tech_source,
      v_assignment.request_trust_label, v_assignment.privacy_safe_explanation,
      v_skipped_reason_codes, (v_context ->> 'fairness_band_cents')::integer,
      v_assignment.decision_fingerprint, p_request_fingerprint,
      p_actor_user_id, p_actor_role, v_assignment.confirmation_kind,
      v_assignment.override_reason
    );
  END LOOP;

  UPDATE public.turniq_group_plans gp
  SET status = 'confirmed', confirmed_by_user_id = p_actor_user_id,
      confirmation_command_id = p_command_id, confirmed_at = p_occurred_at,
      state_version = gp.state_version + 1, updated_at = transaction_timestamp()
  WHERE gp.id = p_group_plan_id AND gp.status = 'recommended';

  INSERT INTO public.turniq_events (
    salon_id, policy_version_id, command_id, aggregate_type, aggregate_id,
    aggregate_version, event_type, actor_user_id, actor_staff_id, actor_role,
    actor_ref, reason_code, decision_fingerprint, request_fingerprint,
    payload, occurred_at
  ) VALUES (
    p_salon_id, p_policy_version_id, p_command_id, 'group_plan', p_group_plan_id,
    v_plan.state_version + 1, 'group_plan_confirmed', p_actor_user_id,
    nullif(v_context ->> 'actor_staff_id', '')::uuid, p_actor_role,
    'user:' || p_actor_user_id::text, 'confirm_group',
    v_plan.decision_fingerprint, p_request_fingerprint,
    jsonb_build_object('booking_group_id', v_plan.booking_group_id,
      'party_size', v_plan.party_size, 'status', 'confirmed',
      'fairness_receipt_count', jsonb_array_length(v_receipts)), p_occurred_at
  );
  RETURN v_result;
EXCEPTION WHEN exclusion_violation OR unique_violation THEN
  RAISE EXCEPTION USING ERRCODE = '23P01',
    MESSAGE = 'TurnIQ group conflicts with live capacity';
END
$function$;

REVOKE ALL ON FUNCTION public.record_turniq_group_plan_v1(
  uuid, uuid, uuid, timestamptz, text, text, text, jsonb, jsonb, jsonb,
  uuid, uuid, bigint, uuid, text, text, timestamptz
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.confirm_turniq_group_plan_v1(
  uuid, uuid, uuid, text, uuid, uuid, bigint, uuid, text, text, timestamptz
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_turniq_group_plan_v1(
  uuid, uuid, uuid, timestamptz, text, text, text, jsonb, jsonb, jsonb,
  uuid, uuid, bigint, uuid, text, text, timestamptz
) TO service_role;
GRANT EXECUTE ON FUNCTION public.confirm_turniq_group_plan_v1(
  uuid, uuid, uuid, text, uuid, uuid, bigint, uuid, text, text, timestamptz
) TO service_role;

COMMENT ON TABLE public.turniq_group_plans IS
  'Authoritative immutable-input plan for one TurnIQ group recommendation; confirmation is all-or-nothing.';
COMMENT ON TABLE public.turniq_group_plan_items IS
  'Immutable members of a TurnIQ group plan, including proposed staff/resource and material booking fingerprint.';
COMMENT ON FUNCTION public.record_turniq_group_plan_v1(
  uuid, uuid, uuid, timestamptz, text, text, text, jsonb, jsonb, jsonb,
  uuid, uuid, bigint, uuid, text, text, timestamptz
) IS 'Service-only M4B command: records a group recommendation without mutating bookings.';
COMMENT ON FUNCTION public.confirm_turniq_group_plan_v1(
  uuid, uuid, uuid, text, uuid, uuid, bigint, uuid, text, text, timestamptz
) IS 'Service-only M4B command: revalidates and confirms every group member atomically.';

COMMIT;
