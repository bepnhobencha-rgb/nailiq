-- TurnIQ M4R: authoritative multi-technician handoff ledger.
--
-- One segments_v1 booking may contain overlapping or sequential service
-- segments performed by more than one technician. The booking sequence remains
-- authoritative for staff, time, resource and price material. TurnIQ records
-- one assignment/Fairness Receipt per actual performer and immutable links to
-- every attributed segment. A performer therefore consumes exactly one turn
-- for the customer, even when they complete multiple sequential segments.
--
-- All RPCs are service-role-only, require SUPERVISED/LIVE rollout, use command
-- receipts for exact replay and fail closed when booking material changes.
-- They never call payment or notification providers.
--
-- Rollback: keep the salon rollout OFF and stop invoking the three handoff
-- RPCs. Preserve plans, assignments, receipts, commands and events as audit
-- evidence. The replaced active-booking index may be restored only after no
-- active handoff performer assignments remain.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.turniq_command_receipts
  DROP CONSTRAINT turniq_command_receipts_command_type_check,
  ADD CONSTRAINT turniq_command_receipts_command_type_check CHECK (
    command_type IN (
      'check_in', 'check_out', 'break', 'return', 'hold', 'release_hold',
      'recommend', 'confirm', 'override', 'start', 'complete',
      'add_service', 'service_update', 'walkin_intake', 'swap', 'correction',
      'refuse', 'redo', 'dispute', 'resolve_dispute',
      'acknowledge_exception', 'resolve_exception', 'dismiss_exception',
      'recommend_group', 'confirm_group',
      'recommend_handoff', 'confirm_handoff'
    )
  );

ALTER TABLE public.turniq_events
  DROP CONSTRAINT turniq_events_aggregate_type_check,
  ADD CONSTRAINT turniq_events_aggregate_type_check CHECK (
    aggregate_type IN (
      'policy', 'shift', 'assignment', 'exception', 'dispute', 'device',
      'group_plan', 'handoff_plan'
    )
  );

ALTER TABLE public.turniq_fairness_receipts
  ADD COLUMN handoff_detail jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(handoff_detail) = 'object');

CREATE TABLE public.turniq_handoff_plans (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  policy_version_id uuid NOT NULL,
  booking_id uuid NOT NULL REFERENCES public.bookings(id) ON DELETE RESTRICT,
  customer_request_id uuid NOT NULL,
  decision_timestamp timestamptz NOT NULL,
  decision_fingerprint text NOT NULL
    CHECK (decision_fingerprint ~ '^[0-9a-f]{64}$'),
  snapshot_version text NOT NULL
    CHECK (length(btrim(snapshot_version)) BETWEEN 1 AND 120),
  privacy_safe_explanation text NOT NULL
    CHECK (length(btrim(privacy_safe_explanation)) BETWEEN 1 AND 500),
  objective_score jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(objective_score) = 'object'),
  candidate_trace jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(candidate_trace) = 'array'),
  status text NOT NULL DEFAULT 'recommended'
    CHECK (status IN ('recommended', 'confirmed', 'in_progress', 'completed')),
  created_by_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  confirmed_by_user_id uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  confirmation_command_id uuid,
  confirmed_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  state_version bigint NOT NULL DEFAULT 1 CHECK (state_version > 0),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT turniq_handoff_plan_lifecycle_check CHECK (
    (status = 'recommended' AND confirmed_by_user_id IS NULL
      AND confirmation_command_id IS NULL AND confirmed_at IS NULL
      AND started_at IS NULL AND completed_at IS NULL)
    OR (status = 'confirmed' AND confirmed_by_user_id IS NOT NULL
      AND confirmation_command_id IS NOT NULL AND confirmed_at IS NOT NULL
      AND started_at IS NULL AND completed_at IS NULL)
    OR (status = 'in_progress' AND confirmed_by_user_id IS NOT NULL
      AND confirmation_command_id IS NOT NULL AND confirmed_at IS NOT NULL
      AND started_at IS NOT NULL AND completed_at IS NULL)
    OR (status = 'completed' AND confirmed_by_user_id IS NOT NULL
      AND confirmation_command_id IS NOT NULL AND confirmed_at IS NOT NULL
      AND started_at IS NOT NULL AND completed_at IS NOT NULL)
  ),
  CONSTRAINT turniq_handoff_plan_time_order_check CHECK (
    (confirmed_at IS NULL OR confirmed_at >= decision_timestamp)
    AND (started_at IS NULL OR started_at >= confirmed_at)
    AND (completed_at IS NULL OR completed_at >= started_at)
  ),
  FOREIGN KEY (salon_id, policy_version_id)
    REFERENCES public.turniq_policy_versions(salon_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (salon_id, confirmation_command_id)
    REFERENCES public.turniq_command_receipts(salon_id, command_id)
    ON DELETE RESTRICT,
  UNIQUE (salon_id, id),
  UNIQUE (salon_id, customer_request_id)
);

CREATE UNIQUE INDEX turniq_handoff_plan_one_active_booking_idx
  ON public.turniq_handoff_plans (salon_id, booking_id)
  WHERE status IN ('recommended', 'confirmed', 'in_progress');
CREATE INDEX turniq_handoff_plan_policy_fk_idx
  ON public.turniq_handoff_plans (salon_id, policy_version_id);
CREATE INDEX turniq_handoff_plan_booking_fk_idx
  ON public.turniq_handoff_plans (booking_id);
CREATE INDEX turniq_handoff_plan_created_by_fk_idx
  ON public.turniq_handoff_plans (created_by_user_id);
CREATE INDEX turniq_handoff_plan_confirmed_by_fk_idx
  ON public.turniq_handoff_plans (confirmed_by_user_id)
  WHERE confirmed_by_user_id IS NOT NULL;
CREATE INDEX turniq_handoff_plan_command_fk_idx
  ON public.turniq_handoff_plans (salon_id, confirmation_command_id)
  WHERE confirmation_command_id IS NOT NULL;

ALTER TABLE public.turniq_assignments
  ADD COLUMN handoff_plan_id uuid;
ALTER TABLE public.turniq_assignments
  ADD CONSTRAINT turniq_assignments_handoff_plan_fk
  FOREIGN KEY (salon_id, handoff_plan_id)
  REFERENCES public.turniq_handoff_plans(salon_id, id) ON DELETE RESTRICT;
ALTER TABLE public.turniq_assignments
  ADD CONSTRAINT turniq_assignments_handoff_shape_check CHECK (
    handoff_plan_id IS NULL
    OR (booking_id IS NOT NULL AND assignment_group_id IS NULL
      AND booking_segment_id IS NULL)
  );

DROP INDEX public.turniq_assignment_one_active_booking_idx;
CREATE UNIQUE INDEX turniq_assignment_one_active_booking_idx
  ON public.turniq_assignments (salon_id, booking_id)
  WHERE booking_id IS NOT NULL AND handoff_plan_id IS NULL
    AND status IN ('recommended', 'confirmed', 'in_progress');
CREATE UNIQUE INDEX turniq_assignment_one_active_handoff_performer_idx
  ON public.turniq_assignments (salon_id, handoff_plan_id, recommended_staff_id)
  WHERE handoff_plan_id IS NOT NULL
    AND status IN ('recommended', 'confirmed', 'in_progress');
CREATE INDEX turniq_assignment_handoff_plan_fk_idx
  ON public.turniq_assignments (salon_id, handoff_plan_id)
  WHERE handoff_plan_id IS NOT NULL;

CREATE TABLE public.turniq_handoff_performers (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  handoff_plan_id uuid NOT NULL,
  performer_position smallint NOT NULL CHECK (performer_position BETWEEN 1 AND 5),
  assignment_id uuid NOT NULL,
  proposed_staff_id uuid NOT NULL REFERENCES public.staff(id) ON DELETE RESTRICT,
  proposed_shift_session_id uuid NOT NULL,
  opportunity_credit_cents integer NOT NULL CHECK (opportunity_credit_cents >= 0),
  segment_count smallint NOT NULL CHECK (segment_count BETWEEN 1 AND 5),
  requested_fallback boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  FOREIGN KEY (salon_id, handoff_plan_id)
    REFERENCES public.turniq_handoff_plans(salon_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (salon_id, assignment_id)
    REFERENCES public.turniq_assignments(salon_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (salon_id, proposed_shift_session_id)
    REFERENCES public.turniq_shift_sessions(salon_id, id) ON DELETE RESTRICT,
  UNIQUE (salon_id, id),
  UNIQUE (salon_id, handoff_plan_id, performer_position),
  UNIQUE (salon_id, handoff_plan_id, proposed_staff_id),
  UNIQUE (salon_id, handoff_plan_id, assignment_id)
);

CREATE INDEX turniq_handoff_performer_assignment_fk_idx
  ON public.turniq_handoff_performers (salon_id, assignment_id);
CREATE INDEX turniq_handoff_performer_staff_fk_idx
  ON public.turniq_handoff_performers (proposed_staff_id);
CREATE INDEX turniq_handoff_performer_shift_fk_idx
  ON public.turniq_handoff_performers (salon_id, proposed_shift_session_id);

CREATE TABLE public.turniq_handoff_plan_items (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  handoff_plan_id uuid NOT NULL,
  performer_id uuid NOT NULL,
  item_position smallint NOT NULL CHECK (item_position BETWEEN 1 AND 5),
  booking_segment_id uuid NOT NULL
    REFERENCES public.booking_service_segments(id) ON DELETE RESTRICT,
  proposed_staff_id uuid NOT NULL REFERENCES public.staff(id) ON DELETE RESTRICT,
  resource_id uuid REFERENCES public.salon_resources(id) ON DELETE RESTRICT,
  starts_at timestamptz NOT NULL,
  releases_at timestamptz NOT NULL,
  opportunity_credit_cents integer NOT NULL CHECK (opportunity_credit_cents >= 0),
  segment_material_fingerprint text NOT NULL
    CHECK (segment_material_fingerprint ~ '^[0-9a-f]{64}$'),
  requested_staff_id uuid REFERENCES public.staff(id) ON DELETE RESTRICT,
  requested_tech_source text CHECK (
    requested_tech_source IS NULL OR requested_tech_source IN (
      'customer_selected', 'ai_confirmed', 'staff_entered', 'in_person',
      'imported', 'override', 'legacy_unknown'
    )
  ),
  request_trust_label text CHECK (
    request_trust_label IS NULL OR request_trust_label IN (
      'customer_confirmed', 'customer_claim_recorded',
      'imported_unverified', 'manager_override', 'legacy_unknown'
    )
  ),
  requested_tech_actor_ref text,
  requested_tech_recorded_at timestamptz,
  requested_fallback boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CHECK (releases_at > starts_at),
  CONSTRAINT turniq_handoff_item_request_provenance_check CHECK (
    (requested_staff_id IS NULL AND requested_tech_source IS NULL
      AND request_trust_label IS NULL AND requested_tech_actor_ref IS NULL
      AND requested_tech_recorded_at IS NULL AND NOT requested_fallback)
    OR (requested_staff_id IS NOT NULL AND requested_tech_source IS NOT NULL
      AND request_trust_label IS NOT NULL
      AND coalesce(length(btrim(requested_tech_actor_ref)), 0) BETWEEN 1 AND 200
      AND requested_tech_recorded_at IS NOT NULL)
  ),
  FOREIGN KEY (salon_id, handoff_plan_id)
    REFERENCES public.turniq_handoff_plans(salon_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (salon_id, performer_id)
    REFERENCES public.turniq_handoff_performers(salon_id, id) ON DELETE RESTRICT,
  UNIQUE (salon_id, id),
  UNIQUE (salon_id, handoff_plan_id, item_position),
  UNIQUE (salon_id, handoff_plan_id, booking_segment_id)
);

CREATE INDEX turniq_handoff_item_segment_fk_idx
  ON public.turniq_handoff_plan_items (booking_segment_id);
CREATE INDEX turniq_handoff_item_performer_fk_idx
  ON public.turniq_handoff_plan_items (salon_id, performer_id);
CREATE INDEX turniq_handoff_item_staff_fk_idx
  ON public.turniq_handoff_plan_items (proposed_staff_id);
CREATE INDEX turniq_handoff_item_resource_fk_idx
  ON public.turniq_handoff_plan_items (resource_id)
  WHERE resource_id IS NOT NULL;

CREATE TRIGGER reject_turniq_handoff_performer_mutation
  BEFORE UPDATE OR DELETE ON public.turniq_handoff_performers
  FOR EACH ROW EXECUTE FUNCTION public.reject_turniq_immutable_mutation();
CREATE TRIGGER reject_turniq_handoff_item_mutation
  BEFORE UPDATE OR DELETE ON public.turniq_handoff_plan_items
  FOR EACH ROW EXECUTE FUNCTION public.reject_turniq_immutable_mutation();

ALTER TABLE public.turniq_handoff_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.turniq_handoff_plans FORCE ROW LEVEL SECURITY;
ALTER TABLE public.turniq_handoff_performers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.turniq_handoff_performers FORCE ROW LEVEL SECURITY;
ALTER TABLE public.turniq_handoff_plan_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.turniq_handoff_plan_items FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.turniq_handoff_plans
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.turniq_handoff_performers
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.turniq_handoff_plan_items
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.turniq_handoff_plans TO service_role;
GRANT SELECT, INSERT ON TABLE public.turniq_handoff_performers TO service_role;
GRANT SELECT, INSERT ON TABLE public.turniq_handoff_plan_items TO service_role;

CREATE OR REPLACE FUNCTION public.assert_turniq_supervised_online_v1(
  p_salon_id uuid
)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_stage text;
BEGIN
  SELECT c.stage INTO v_stage
  FROM public.turniq_rollout_controls AS c
  WHERE c.salon_id = p_salon_id;
  IF coalesce(v_stage, 'off') NOT IN ('supervised', 'live') THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'TurnIQ online mutation requires supervised or live rollout';
  END IF;
END
$function$;

CREATE OR REPLACE FUNCTION public.turniq_handoff_segment_fingerprint_v1(
  p_segment public.booking_service_segments
)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SECURITY INVOKER
SET search_path = ''
AS $function$
  SELECT public.turniq_sha256_jsonb(pg_catalog.jsonb_build_object(
    'bookingId', p_segment.booking_id,
    'segmentId', p_segment.id,
    'position', p_segment.position,
    'lineId', p_segment.line_id,
    'serviceId', p_segment.service_id,
    'staffId', p_segment.staff_id,
    'resourceId', p_segment.resource_id,
    'startsAt', p_segment.occupied_start_utc,
    'releasesAt', p_segment.occupied_end_utc,
    'reservationStatus', p_segment.reservation_status,
    'serviceListCents', p_segment.original_service_price_cents,
    'permittedAddonCents', p_segment.addon_pre_voucher_cents
  ))
$function$;

CREATE OR REPLACE FUNCTION public.record_turniq_handoff_plan_v1(
  p_salon_id uuid,
  p_policy_version_id uuid,
  p_booking_id uuid,
  p_customer_request_id uuid,
  p_decision_timestamp timestamptz,
  p_decision_fingerprint text,
  p_snapshot_version text,
  p_privacy_safe_explanation text,
  p_objective_score jsonb,
  p_candidate_trace jsonb,
  p_segments jsonb,
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
  v_booking public.bookings%ROWTYPE;
  v_plan public.turniq_handoff_plans%ROWTYPE;
  v_segment public.booking_service_segments%ROWTYPE;
  v_shift public.turniq_shift_sessions%ROWTYPE;
  v_item jsonb;
  v_staff_id uuid;
  v_shift_id uuid;
  v_resource_id uuid;
  v_requested_staff_id uuid;
  v_performer public.turniq_handoff_performers%ROWTYPE;
  v_assignment public.turniq_assignments%ROWTYPE;
  v_performer_position integer := 0;
  v_item_position integer := 0;
  v_expected_segments integer;
  v_credit integer;
  v_segment_count integer;
  v_requested_fallback boolean;
  v_service_id uuid;
  v_common_resource_id uuid;
  v_eligible jsonb;
  v_skipped jsonb;
  v_performer_result jsonb := '[]'::jsonb;
  v_result jsonb;
BEGIN
  IF p_booking_id IS NULL OR p_customer_request_id IS NULL
     OR p_command_id IS NULL OR p_device_id IS NULL OR p_actor_user_id IS NULL
     OR p_local_sequence <= 0 OR p_decision_timestamp IS NULL
     OR p_decision_fingerprint !~ '^[0-9a-f]{64}$'
     OR p_request_fingerprint !~ '^[0-9a-f]{64}$'
     OR coalesce(length(btrim(p_snapshot_version)), 0) NOT BETWEEN 1 AND 120
     OR coalesce(length(btrim(p_privacy_safe_explanation)), 0) NOT BETWEEN 1 AND 500
     OR jsonb_typeof(p_objective_score) <> 'object'
     OR jsonb_typeof(p_candidate_trace) <> 'array'
     OR jsonb_typeof(p_segments) <> 'array'
     OR jsonb_array_length(p_segments) NOT BETWEEN 2 AND 5 THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'invalid TurnIQ handoff recommendation command';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('turniq-command:' || p_command_id::text, 0)
  );
  v_replay := public.turniq_replay_online_command(
    p_command_id, p_salon_id, p_policy_version_id, p_actor_user_id,
    p_actor_role, 'recommend_handoff', p_request_fingerprint
  );
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;

  v_context := public.turniq_online_context(
    p_salon_id, p_policy_version_id, p_actor_user_id, p_actor_role, p_occurred_at
  );
  PERFORM public.assert_turniq_supervised_online_v1(p_salon_id);
  IF p_actor_role NOT IN ('owner', 'admin', 'senior', 'receptionist') THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'TurnIQ handoff recommendation requires desk role';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'booking-capacity:sequence:' || p_salon_id::text || ':' || p_booking_id::text,
      0
    )
  );
  SELECT b.* INTO v_booking
  FROM public.bookings AS b
  WHERE b.id = p_booking_id AND b.salon_id = p_salon_id
  FOR UPDATE;
  IF NOT FOUND OR v_booking.deleted_at IS NOT NULL
     OR v_booking.schedule_model <> 'segments_v1'
     OR v_booking.status NOT IN ('pending', 'confirmed', 'waiting')
     OR (v_booking.start_time_utc AT TIME ZONE
        (v_context ->> 'business_timezone'))::date IS DISTINCT FROM
        (v_context ->> 'business_date')::date
     OR (p_decision_timestamp AT TIME ZONE
        (v_context ->> 'business_timezone'))::date IS DISTINCT FROM
        (v_context ->> 'business_date')::date THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'booking is not eligible for TurnIQ handoff';
  END IF;

  PERFORM 1 FROM public.booking_service_segments AS seg
  WHERE seg.salon_id = p_salon_id AND seg.booking_id = p_booking_id
  ORDER BY seg.id FOR UPDATE;
  SELECT count(*) INTO v_expected_segments
  FROM public.booking_service_segments AS seg
  WHERE seg.salon_id = p_salon_id AND seg.booking_id = p_booking_id
    AND seg.reservation_status IN ('pending', 'confirmed', 'waiting');
  IF v_expected_segments IS DISTINCT FROM jsonb_array_length(p_segments) THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'TurnIQ handoff segment membership changed';
  END IF;

  IF (SELECT count(DISTINCT value ->> 'segmentId')
      FROM jsonb_array_elements(p_segments))
       IS DISTINCT FROM jsonb_array_length(p_segments)
     OR (SELECT count(DISTINCT value ->> 'recommendedStaffId')
         FROM jsonb_array_elements(p_segments)) NOT BETWEEN 1 AND 5 THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'TurnIQ handoff segment or performer set is invalid';
  END IF;

  -- Match the segment lock order and lock every referenced shift in stable UUID
  -- order before validating individual items. This prevents opposite JSON
  -- ordering on concurrent recommendations from creating a deadlock cycle.
  PERFORM 1 FROM public.turniq_shift_sessions sh
  WHERE sh.id IN (
    SELECT DISTINCT (value ->> 'shiftSessionId')::uuid
    FROM jsonb_array_elements(p_segments)
  )
  ORDER BY sh.id FOR UPDATE;

  -- Validate every immutable booking fact before creating any ledger row.
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_segments) LOOP
    v_staff_id := nullif(v_item ->> 'recommendedStaffId', '')::uuid;
    v_shift_id := nullif(v_item ->> 'shiftSessionId', '')::uuid;
    v_resource_id := nullif(v_item ->> 'resourceId', '')::uuid;
    v_requested_staff_id := nullif(v_item ->> 'requestedStaffId', '')::uuid;
    v_credit := (v_item ->> 'opportunityCreditCents')::integer;
    SELECT seg.* INTO v_segment
    FROM public.booking_service_segments AS seg
    WHERE seg.id = nullif(v_item ->> 'segmentId', '')::uuid
      AND seg.salon_id = p_salon_id AND seg.booking_id = p_booking_id;
    IF NOT FOUND OR v_segment.reservation_status NOT IN ('pending', 'confirmed', 'waiting')
       OR v_staff_id IS NULL OR v_shift_id IS NULL
       OR v_segment.staff_id IS DISTINCT FROM v_staff_id
       OR v_segment.resource_id IS DISTINCT FROM v_resource_id
       OR v_segment.occupied_start_utc IS DISTINCT FROM
          (v_item ->> 'startsAt')::timestamptz
       OR v_segment.occupied_end_utc IS DISTINCT FROM
          (v_item ->> 'releasesAt')::timestamptz
       OR v_segment.service_id IS DISTINCT FROM
          nullif(v_item ->> 'serviceId', '')::uuid
       OR v_credit IS DISTINCT FROM
          v_segment.original_service_price_cents + v_segment.addon_pre_voucher_cents
       OR (v_requested_staff_id IS NULL) IS DISTINCT FROM
          ((v_item ->> 'requestedTechSource') IS NULL)
       OR (v_requested_staff_id IS NULL) IS DISTINCT FROM
          ((v_item ->> 'requestTrustLabel') IS NULL)
       OR (v_requested_staff_id IS NULL) IS DISTINCT FROM
          ((v_item ->> 'requestedTechActorRef') IS NULL)
       OR (v_requested_staff_id IS NULL) IS DISTINCT FROM
          ((v_item ->> 'requestedTechRecordedAt') IS NULL)
       OR (v_requested_staff_id IS NOT NULL AND
          coalesce((v_item ->> 'requestedFallback')::boolean, false)
            IS DISTINCT FROM (v_requested_staff_id <> v_staff_id)) THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'TurnIQ handoff booking material changed';
    END IF;
    IF v_requested_staff_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.staff st
      WHERE st.id = v_requested_staff_id AND st.salon_id = p_salon_id
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23503',
        MESSAGE = 'TurnIQ requested technician does not belong to salon';
    END IF;
    SELECT sh.* INTO v_shift
    FROM public.turniq_shift_sessions AS sh
    WHERE sh.id = v_shift_id AND sh.salon_id = p_salon_id
      AND sh.policy_version_id = p_policy_version_id
      AND sh.staff_id = v_staff_id
      AND sh.business_date = (v_context ->> 'business_date')::date
      AND sh.state = 'active' AND sh.checked_out_at IS NULL
    ;
    IF NOT FOUND OR NOT EXISTS (
      SELECT 1 FROM public.staff st
      WHERE st.id = v_staff_id AND st.salon_id = p_salon_id
        AND st.status = 'active' AND st.deleted_at IS NULL
    ) OR NOT EXISTS (
      SELECT 1 FROM public.staff_services ss
      WHERE ss.staff_id = v_staff_id AND ss.service_id = v_segment.service_id
    ) OR EXISTS (
      SELECT 1 FROM public.booking_addons ba
      WHERE ba.booking_id = p_booking_id
        AND ba.booking_service_segment_id = v_segment.id
        AND NOT EXISTS (
          SELECT 1 FROM public.staff_services ss
          WHERE ss.staff_id = v_staff_id AND ss.service_id = ba.service_id
        )
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'TurnIQ handoff performer is no longer eligible';
    END IF;
  END LOOP;

  INSERT INTO public.turniq_handoff_plans (
    salon_id, policy_version_id, booking_id, customer_request_id,
    decision_timestamp, decision_fingerprint, snapshot_version,
    privacy_safe_explanation, objective_score, candidate_trace,
    created_by_user_id
  ) VALUES (
    p_salon_id, p_policy_version_id, p_booking_id, p_customer_request_id,
    p_decision_timestamp, p_decision_fingerprint, btrim(p_snapshot_version),
    btrim(p_privacy_safe_explanation), p_objective_score, p_candidate_trace,
    p_actor_user_id
  ) RETURNING * INTO v_plan;

  FOR v_staff_id IN
    SELECT DISTINCT (value ->> 'recommendedStaffId')::uuid
    FROM jsonb_array_elements(p_segments)
    ORDER BY 1
  LOOP
    v_performer_position := v_performer_position + 1;
    SELECT
      (array_agg((value ->> 'shiftSessionId')::uuid
        ORDER BY value ->> 'segmentId'))[1],
      sum((value ->> 'opportunityCreditCents')::integer)::integer,
      count(*)::integer,
      bool_or(coalesce((value ->> 'requestedFallback')::boolean, false)),
      CASE WHEN count(DISTINCT value ->> 'serviceId') = 1
        THEN (array_agg((value ->> 'serviceId')::uuid
          ORDER BY value ->> 'segmentId'))[1] ELSE NULL END,
      CASE WHEN count(DISTINCT coalesce(value ->> 'resourceId', '')) = 1
        THEN (array_agg(nullif(value ->> 'resourceId', '')::uuid
          ORDER BY value ->> 'segmentId'))[1] ELSE NULL END
    INTO v_shift_id, v_credit, v_segment_count, v_requested_fallback,
      v_service_id, v_common_resource_id
    FROM jsonb_array_elements(p_segments) AS item(value)
    WHERE (value ->> 'recommendedStaffId')::uuid = v_staff_id;
    IF (SELECT count(DISTINCT value ->> 'shiftSessionId')
        FROM jsonb_array_elements(p_segments) AS item(value)
        WHERE (value ->> 'recommendedStaffId')::uuid = v_staff_id) <> 1 THEN
      RAISE EXCEPTION USING ERRCODE = '22023',
        MESSAGE = 'TurnIQ handoff performer shift is inconsistent';
    END IF;
    SELECT
      coalesce(jsonb_agg(value ORDER BY value ->> 'segmentId')
        FILTER (WHERE coalesce((value ->> 'eligible')::boolean, false)), '[]'::jsonb),
      coalesce(jsonb_agg(value ORDER BY value ->> 'segmentId')
        FILTER (WHERE NOT coalesce((value ->> 'eligible')::boolean, false)), '[]'::jsonb)
    INTO v_eligible, v_skipped
    FROM jsonb_array_elements(p_candidate_trace) AS trace(value)
    WHERE value ->> 'staffId' = v_staff_id::text;

    INSERT INTO public.turniq_assignments (
      salon_id, policy_version_id, shift_session_id, booking_id,
      handoff_plan_id, customer_request_id, recommended_staff_id,
      service_id, resource_id, decision_timestamp, decision_fingerprint,
      snapshot_version, privacy_safe_explanation, eligible_candidates,
      skipped_candidates, internal_decision_trace, opportunity_credit_cents
    ) VALUES (
      p_salon_id, p_policy_version_id, v_shift_id, p_booking_id,
      v_plan.id, extensions.gen_random_uuid(), v_staff_id,
      v_service_id, v_common_resource_id, p_decision_timestamp,
      p_decision_fingerprint, btrim(p_snapshot_version),
      btrim(p_privacy_safe_explanation), v_eligible, v_skipped,
      pg_catalog.jsonb_build_object(
        'handoffPlanId', v_plan.id,
        'objectiveScore', p_objective_score,
        'candidateTrace', p_candidate_trace
      ),
      v_credit
    ) RETURNING * INTO v_assignment;

    INSERT INTO public.turniq_handoff_performers (
      salon_id, handoff_plan_id, performer_position, assignment_id,
      proposed_staff_id, proposed_shift_session_id,
      opportunity_credit_cents, segment_count, requested_fallback
    ) VALUES (
      p_salon_id, v_plan.id, v_performer_position, v_assignment.id,
      v_staff_id, v_shift_id, v_credit, v_segment_count, v_requested_fallback
    ) RETURNING * INTO v_performer;

    v_performer_result := v_performer_result || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'performer_id', v_performer.id,
        'assignment_id', v_assignment.id,
        'staff_id', v_staff_id,
        'opportunity_credit_cents', v_credit,
        'turns_to_consume', 1
      )
    );
  END LOOP;

  FOR v_item IN
    SELECT value FROM jsonb_array_elements(p_segments)
    ORDER BY value ->> 'segmentId'
  LOOP
    v_item_position := v_item_position + 1;
    v_staff_id := (v_item ->> 'recommendedStaffId')::uuid;
    v_resource_id := nullif(v_item ->> 'resourceId', '')::uuid;
    v_requested_staff_id := nullif(v_item ->> 'requestedStaffId', '')::uuid;
    SELECT hp.* INTO v_performer
    FROM public.turniq_handoff_performers AS hp
    WHERE hp.salon_id = p_salon_id AND hp.handoff_plan_id = v_plan.id
      AND hp.proposed_staff_id = v_staff_id;
    SELECT seg.* INTO v_segment
    FROM public.booking_service_segments AS seg
    WHERE seg.id = (v_item ->> 'segmentId')::uuid;

    INSERT INTO public.turniq_handoff_plan_items (
      salon_id, handoff_plan_id, performer_id, item_position,
      booking_segment_id, proposed_staff_id, resource_id, starts_at,
      releases_at, opportunity_credit_cents, segment_material_fingerprint,
      requested_staff_id, requested_tech_source, request_trust_label,
      requested_tech_actor_ref, requested_tech_recorded_at, requested_fallback
    ) VALUES (
      p_salon_id, v_plan.id, v_performer.id, v_item_position,
      v_segment.id, v_staff_id, v_resource_id,
      v_segment.occupied_start_utc, v_segment.occupied_end_utc,
      v_segment.original_service_price_cents + v_segment.addon_pre_voucher_cents,
      public.turniq_handoff_segment_fingerprint_v1(v_segment),
      v_requested_staff_id, v_item ->> 'requestedTechSource',
      v_item ->> 'requestTrustLabel', v_item ->> 'requestedTechActorRef',
      nullif(v_item ->> 'requestedTechRecordedAt', '')::timestamptz,
      coalesce((v_item ->> 'requestedFallback')::boolean, false)
    );
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM public.turniq_handoff_performers hp
    WHERE hp.handoff_plan_id = v_plan.id AND (
      hp.segment_count IS DISTINCT FROM (
        SELECT count(*) FROM public.turniq_handoff_plan_items i
        WHERE i.performer_id = hp.id
      ) OR hp.opportunity_credit_cents IS DISTINCT FROM (
        SELECT sum(i.opportunity_credit_cents)::integer
        FROM public.turniq_handoff_plan_items i WHERE i.performer_id = hp.id
      )
    )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'TurnIQ handoff performer aggregation mismatch';
  END IF;

  v_result := pg_catalog.jsonb_build_object(
    'ok', true, 'command_id', p_command_id, 'replayed', false,
    'handoff_plan_id', v_plan.id, 'booking_id', p_booking_id,
    'status', v_plan.status, 'state_version', v_plan.state_version,
    'performers', v_performer_result
  );
  PERFORM public.turniq_store_online_command(
    p_command_id, p_salon_id, p_policy_version_id, p_device_id,
    p_local_sequence, p_actor_user_id, p_actor_role, 'recommend_handoff',
    p_request_fingerprint, 'committed', v_result, p_occurred_at
  );
  INSERT INTO public.turniq_events (
    salon_id, policy_version_id, command_id, aggregate_type, aggregate_id,
    aggregate_version, event_type, actor_user_id, actor_staff_id, actor_role,
    actor_ref, reason_code, decision_fingerprint, request_fingerprint,
    payload, occurred_at
  ) VALUES (
    p_salon_id, p_policy_version_id, p_command_id, 'handoff_plan', v_plan.id,
    1, 'handoff_plan_recommended', p_actor_user_id,
    nullif(v_context ->> 'actor_staff_id', '')::uuid, p_actor_role,
    'user:' || p_actor_user_id::text, 'recommend_handoff',
    p_decision_fingerprint, p_request_fingerprint,
    pg_catalog.jsonb_build_object(
      'booking_id', p_booking_id,
      'performer_count', jsonb_array_length(v_performer_result),
      'segment_count', jsonb_array_length(p_segments)
    ), p_occurred_at
  );
  INSERT INTO public.turniq_events (
    salon_id, policy_version_id, assignment_id, command_id, aggregate_type,
    aggregate_id, aggregate_version, event_type, actor_user_id,
    actor_staff_id, actor_role, actor_ref, reason_code,
    decision_fingerprint, request_fingerprint, payload, occurred_at
  )
  SELECT
    p_salon_id, p_policy_version_id, hp.assignment_id, p_command_id,
    'assignment', hp.assignment_id, 1, 'handoff_performer_recommended',
    p_actor_user_id, nullif(v_context ->> 'actor_staff_id', '')::uuid,
    p_actor_role, 'user:' || p_actor_user_id::text, 'recommend_handoff',
    p_decision_fingerprint, p_request_fingerprint,
    pg_catalog.jsonb_build_object(
      'handoff_plan_id', v_plan.id,
      'staff_id', hp.proposed_staff_id,
      'segment_count', hp.segment_count,
      'turns_to_consume', 1
    ), p_occurred_at
  FROM public.turniq_handoff_performers hp
  WHERE hp.handoff_plan_id = v_plan.id
  ORDER BY hp.performer_position;
  RETURN v_result;
END
$function$;

CREATE OR REPLACE FUNCTION public.confirm_turniq_handoff_plan_v1(
  p_salon_id uuid,
  p_policy_version_id uuid,
  p_handoff_plan_id uuid,
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
  v_plan public.turniq_handoff_plans%ROWTYPE;
  v_booking public.bookings%ROWTYPE;
  v_performer public.turniq_handoff_performers%ROWTYPE;
  v_assignment public.turniq_assignments%ROWTYPE;
  v_segment public.booking_service_segments%ROWTYPE;
  v_item public.turniq_handoff_plan_items%ROWTYPE;
  v_has_fallback boolean;
  v_receipt_id uuid;
  v_receipts jsonb := '[]'::jsonb;
  v_skipped_reason_codes jsonb;
  v_handoff_detail jsonb;
  v_result jsonb;
BEGIN
  IF p_handoff_plan_id IS NULL OR p_command_id IS NULL OR p_device_id IS NULL
     OR p_actor_user_id IS NULL OR p_local_sequence <= 0
     OR p_request_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'invalid TurnIQ handoff confirmation command';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('turniq-command:' || p_command_id::text, 0)
  );
  v_replay := public.turniq_replay_online_command(
    p_command_id, p_salon_id, p_policy_version_id, p_actor_user_id,
    p_actor_role, 'confirm_handoff', p_request_fingerprint
  );
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  v_context := public.turniq_online_context(
    p_salon_id, p_policy_version_id, p_actor_user_id, p_actor_role, p_occurred_at
  );
  PERFORM public.assert_turniq_supervised_online_v1(p_salon_id);
  IF p_actor_role NOT IN ('owner', 'admin', 'senior', 'receptionist') THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'TurnIQ handoff confirmation requires desk role';
  END IF;

  SELECT hp.* INTO v_plan
  FROM public.turniq_handoff_plans hp
  WHERE hp.id = p_handoff_plan_id AND hp.salon_id = p_salon_id
    AND hp.policy_version_id = p_policy_version_id
  FOR UPDATE;
  IF NOT FOUND OR v_plan.status <> 'recommended'
     OR p_occurred_at < v_plan.decision_timestamp THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'TurnIQ handoff plan is not ready to confirm';
  END IF;
  SELECT bool_or(hp.requested_fallback) INTO v_has_fallback
  FROM public.turniq_handoff_performers hp
  WHERE hp.handoff_plan_id = p_handoff_plan_id;
  IF v_has_fallback
     AND coalesce(length(btrim(p_override_reason)), 0) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'requested-technician fallback requires an override reason';
  END IF;
  IF v_has_fallback AND p_actor_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'requested-technician fallback requires owner or admin confirmation';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'booking-capacity:sequence:' || p_salon_id::text || ':' || v_plan.booking_id::text,
      0
    )
  );
  FOR v_performer IN
    SELECT hp.* FROM public.turniq_handoff_performers hp
    WHERE hp.handoff_plan_id = p_handoff_plan_id
    ORDER BY hp.proposed_staff_id
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'booking-capacity:staff:' || p_salon_id::text || ':' ||
        v_performer.proposed_staff_id::text, 0
      )
    );
  END LOOP;
  FOR v_item IN
    SELECT DISTINCT ON (i.resource_id) i.*
    FROM public.turniq_handoff_plan_items i
    WHERE i.handoff_plan_id = p_handoff_plan_id AND i.resource_id IS NOT NULL
    ORDER BY i.resource_id, i.booking_segment_id
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'booking-capacity:resource:' || p_salon_id::text || ':' ||
        v_item.resource_id::text, 0
      )
    );
  END LOOP;

  SELECT b.* INTO v_booking FROM public.bookings b
  WHERE b.id = v_plan.booking_id AND b.salon_id = p_salon_id
  FOR UPDATE;
  PERFORM 1 FROM public.turniq_assignments a
  JOIN public.turniq_handoff_performers hp ON hp.assignment_id = a.id
  WHERE hp.handoff_plan_id = p_handoff_plan_id
  ORDER BY a.id FOR UPDATE OF a;
  PERFORM 1 FROM public.turniq_shift_sessions sh
  JOIN public.turniq_handoff_performers hp
    ON hp.proposed_shift_session_id = sh.id
  WHERE hp.handoff_plan_id = p_handoff_plan_id
  ORDER BY sh.id FOR UPDATE OF sh;
  PERFORM 1 FROM public.booking_service_segments seg
  JOIN public.turniq_handoff_plan_items i ON i.booking_segment_id = seg.id
  WHERE i.handoff_plan_id = p_handoff_plan_id
  ORDER BY seg.id FOR UPDATE OF seg;

  IF v_booking.deleted_at IS NOT NULL OR v_booking.schedule_model <> 'segments_v1'
     OR v_booking.status NOT IN ('pending', 'confirmed', 'waiting')
     OR (SELECT count(*) FROM public.booking_service_segments seg
         WHERE seg.salon_id = p_salon_id AND seg.booking_id = v_booking.id
           AND seg.reservation_status IN ('pending', 'confirmed', 'waiting'))
        IS DISTINCT FROM
        (SELECT count(*) FROM public.turniq_handoff_plan_items i
         WHERE i.handoff_plan_id = p_handoff_plan_id) THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'TurnIQ handoff booking changed; refresh required';
  END IF;

  FOR v_item IN
    SELECT i.* FROM public.turniq_handoff_plan_items i
    WHERE i.handoff_plan_id = p_handoff_plan_id ORDER BY i.booking_segment_id
  LOOP
    SELECT seg.* INTO v_segment FROM public.booking_service_segments seg
    WHERE seg.id = v_item.booking_segment_id AND seg.salon_id = p_salon_id;
    IF NOT FOUND OR v_segment.booking_id IS DISTINCT FROM v_booking.id
       OR v_segment.staff_id IS DISTINCT FROM v_item.proposed_staff_id
       OR v_segment.resource_id IS DISTINCT FROM v_item.resource_id
       OR v_segment.occupied_start_utc IS DISTINCT FROM v_item.starts_at
       OR v_segment.occupied_end_utc IS DISTINCT FROM v_item.releases_at
       OR v_segment.reservation_status NOT IN ('pending', 'confirmed', 'waiting')
       OR public.turniq_handoff_segment_fingerprint_v1(v_segment)
          IS DISTINCT FROM v_item.segment_material_fingerprint THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'TurnIQ handoff segment facts changed; refresh required';
    END IF;
  END LOOP;

  FOR v_performer IN
    SELECT hp.* FROM public.turniq_handoff_performers hp
    WHERE hp.handoff_plan_id = p_handoff_plan_id ORDER BY hp.performer_position
  LOOP
    SELECT a.* INTO v_assignment FROM public.turniq_assignments a
    WHERE a.id = v_performer.assignment_id AND a.salon_id = p_salon_id;
    IF v_assignment.status <> 'recommended'
       OR v_assignment.recommended_staff_id IS DISTINCT FROM
          v_performer.proposed_staff_id
       OR v_assignment.opportunity_credit_cents IS DISTINCT FROM
          v_performer.opportunity_credit_cents
       OR NOT EXISTS (
         SELECT 1 FROM public.turniq_shift_sessions sh
         WHERE sh.id = v_performer.proposed_shift_session_id
           AND sh.salon_id = p_salon_id
           AND sh.policy_version_id = p_policy_version_id
           AND sh.staff_id = v_performer.proposed_staff_id
           AND sh.business_date = (v_context ->> 'business_date')::date
           AND sh.state = 'active' AND sh.checked_out_at IS NULL
       ) OR NOT EXISTS (
         SELECT 1 FROM public.staff st
         WHERE st.id = v_performer.proposed_staff_id
           AND st.salon_id = p_salon_id
           AND st.status = 'active' AND st.deleted_at IS NULL
       ) OR EXISTS (
         SELECT 1 FROM public.turniq_handoff_plan_items i
         JOIN public.booking_service_segments seg
           ON seg.id = i.booking_segment_id
         WHERE i.performer_id = v_performer.id
           AND (
             NOT EXISTS (
               SELECT 1 FROM public.staff_services ss
               WHERE ss.staff_id = v_performer.proposed_staff_id
                 AND ss.service_id = seg.service_id
             ) OR EXISTS (
               SELECT 1 FROM public.booking_addons ba
               WHERE ba.booking_id = v_booking.id
                 AND ba.booking_service_segment_id = seg.id
                 AND NOT EXISTS (
                   SELECT 1 FROM public.staff_services ss
                   WHERE ss.staff_id = v_performer.proposed_staff_id
                     AND ss.service_id = ba.service_id
                 )
             )
           )
       ) THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'TurnIQ handoff performer facts changed; refresh required';
    END IF;
  END LOOP;

  UPDATE public.bookings b
  SET status = 'confirmed', confirmed_at = coalesce(b.confirmed_at, p_occurred_at),
      no_show_candidate_at = NULL
  WHERE b.id = v_booking.id AND b.status IN ('pending', 'waiting', 'confirmed');

  FOR v_performer IN
    SELECT hp.* FROM public.turniq_handoff_performers hp
    WHERE hp.handoff_plan_id = p_handoff_plan_id ORDER BY hp.performer_position
  LOOP
    v_receipts := v_receipts || jsonb_build_array(jsonb_build_object(
      'assignment_id', v_performer.assignment_id,
      'fairness_receipt_id', extensions.gen_random_uuid(),
      'staff_id', v_performer.proposed_staff_id
    ));
  END LOOP;
  v_result := pg_catalog.jsonb_build_object(
    'ok', true, 'command_id', p_command_id, 'replayed', false,
    'handoff_plan_id', p_handoff_plan_id, 'booking_id', v_booking.id,
    'status', 'confirmed', 'state_version', v_plan.state_version + 1,
    'fairness_receipts', v_receipts
  );
  PERFORM public.turniq_store_online_command(
    p_command_id, p_salon_id, p_policy_version_id, p_device_id,
    p_local_sequence, p_actor_user_id, p_actor_role, 'confirm_handoff',
    p_request_fingerprint, 'committed', v_result, p_occurred_at
  );

  FOR v_performer IN
    SELECT hp.* FROM public.turniq_handoff_performers hp
    WHERE hp.handoff_plan_id = p_handoff_plan_id ORDER BY hp.performer_position
  LOOP
    UPDATE public.turniq_assignments a
    SET assigned_staff_id = v_performer.proposed_staff_id,
        shift_session_id = v_performer.proposed_shift_session_id,
        status = 'confirmed',
        confirmation_kind = CASE WHEN v_performer.requested_fallback
          THEN 'override' ELSE 'confirmed_recommendation' END,
        confirmation_actor_user_id = p_actor_user_id,
        override_reason = CASE WHEN v_performer.requested_fallback
          THEN btrim(p_override_reason) ELSE NULL END,
        confirmed_at = p_occurred_at, state_version = a.state_version + 1,
        updated_at = transaction_timestamp()
    WHERE a.id = v_performer.assignment_id AND a.status = 'recommended'
    RETURNING * INTO v_assignment;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '40001',
        MESSAGE = 'TurnIQ handoff assignment changed concurrently';
    END IF;

    SELECT coalesce(jsonb_agg(code ORDER BY code), '[]'::jsonb)
    INTO v_skipped_reason_codes
    FROM (
      SELECT DISTINCT reason.value AS code
      FROM jsonb_array_elements(v_assignment.skipped_candidates) candidate
      CROSS JOIN LATERAL jsonb_array_elements_text(
        coalesce(candidate -> 'reasonCodes', '[]'::jsonb)
      ) reason(value)
    ) codes;
    SELECT pg_catalog.jsonb_build_object(
      'handoffPlanId', p_handoff_plan_id,
      'turnsToConsume', 1,
      'segments', coalesce(jsonb_agg(jsonb_build_object(
        'segmentId', i.booking_segment_id,
        'resourceId', i.resource_id,
        'startsAt', i.starts_at,
        'releasesAt', i.releases_at,
        'opportunityCreditCents', i.opportunity_credit_cents,
        'requestedStaffId', i.requested_staff_id,
        'requestedTechSource', i.requested_tech_source,
        'requestTrustLabel', i.request_trust_label,
        'requestedFallback', i.requested_fallback
      ) ORDER BY i.item_position), '[]'::jsonb)
    ) INTO v_handoff_detail
    FROM public.turniq_handoff_plan_items i
    WHERE i.performer_id = v_performer.id;
    SELECT (receipt ->> 'fairness_receipt_id')::uuid INTO v_receipt_id
    FROM jsonb_array_elements(v_receipts) receipt
    WHERE (receipt ->> 'assignment_id')::uuid = v_assignment.id;
    INSERT INTO public.turniq_fairness_receipts (
      id, salon_id, policy_version_id, assignment_id, command_id,
      recommended_staff_id, assigned_staff_id, service_id, resource_id,
      privacy_safe_explanation, skipped_reason_codes, fairness_band_cents,
      decision_fingerprint, command_fingerprint, actor_user_id, actor_role,
      assignment_outcome, override_reason, handoff_detail
    ) VALUES (
      v_receipt_id, p_salon_id, p_policy_version_id, v_assignment.id,
      p_command_id, v_assignment.recommended_staff_id,
      v_assignment.assigned_staff_id, v_assignment.service_id,
      v_assignment.resource_id, v_assignment.privacy_safe_explanation,
      v_skipped_reason_codes, (v_context ->> 'fairness_band_cents')::integer,
      v_assignment.decision_fingerprint, p_request_fingerprint,
      p_actor_user_id, p_actor_role, v_assignment.confirmation_kind,
      v_assignment.override_reason, v_handoff_detail
    );
    INSERT INTO public.turniq_events (
      salon_id, policy_version_id, assignment_id, command_id, aggregate_type,
      aggregate_id, aggregate_version, event_type, actor_user_id,
      actor_staff_id, actor_role, actor_ref, reason_code, reason_detail,
      decision_fingerprint, request_fingerprint, payload, occurred_at
    ) VALUES (
      p_salon_id, p_policy_version_id, v_assignment.id, p_command_id,
      'assignment', v_assignment.id, v_assignment.state_version,
      CASE WHEN v_performer.requested_fallback
        THEN 'handoff_performer_overridden' ELSE 'handoff_performer_confirmed' END,
      p_actor_user_id, nullif(v_context ->> 'actor_staff_id', '')::uuid,
      p_actor_role, 'user:' || p_actor_user_id::text,
      CASE WHEN v_performer.requested_fallback
        THEN 'requested_technician_fallback' ELSE 'confirm_handoff' END,
      CASE WHEN v_performer.requested_fallback
        THEN btrim(p_override_reason) ELSE NULL END,
      v_assignment.decision_fingerprint, p_request_fingerprint,
      jsonb_build_object(
        'handoff_plan_id', p_handoff_plan_id,
        'fairness_receipt_id', v_receipt_id,
        'turns_to_consume', 1
      ), p_occurred_at
    );
  END LOOP;

  UPDATE public.turniq_handoff_plans hp
  SET status = 'confirmed', confirmed_by_user_id = p_actor_user_id,
      confirmation_command_id = p_command_id, confirmed_at = p_occurred_at,
      state_version = hp.state_version + 1, updated_at = transaction_timestamp()
  WHERE hp.id = p_handoff_plan_id AND hp.status = 'recommended'
  RETURNING * INTO v_plan;
  INSERT INTO public.turniq_events (
    salon_id, policy_version_id, command_id, aggregate_type, aggregate_id,
    aggregate_version, event_type, actor_user_id, actor_staff_id, actor_role,
    actor_ref, reason_code, reason_detail, decision_fingerprint,
    request_fingerprint, payload, occurred_at
  ) VALUES (
    p_salon_id, p_policy_version_id, p_command_id, 'handoff_plan', v_plan.id,
    v_plan.state_version, 'handoff_plan_confirmed', p_actor_user_id,
    nullif(v_context ->> 'actor_staff_id', '')::uuid, p_actor_role,
    'user:' || p_actor_user_id::text, 'confirm_handoff',
    CASE WHEN v_has_fallback THEN btrim(p_override_reason) ELSE NULL END,
    v_plan.decision_fingerprint, p_request_fingerprint,
    jsonb_build_object(
      'booking_id', v_plan.booking_id,
      'fairness_receipts', v_receipts,
      'requested_fallback', v_has_fallback
    ), p_occurred_at
  );
  RETURN v_result;
END
$function$;

CREATE OR REPLACE FUNCTION public.apply_turniq_handoff_performer_command_v1(
  p_salon_id uuid,
  p_policy_version_id uuid,
  p_handoff_plan_id uuid,
  p_performer_id uuid,
  p_command_type text,
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
  v_plan public.turniq_handoff_plans%ROWTYPE;
  v_performer public.turniq_handoff_performers%ROWTYPE;
  v_assignment public.turniq_assignments%ROWTYPE;
  v_booking public.bookings%ROWTYPE;
  v_shift public.turniq_shift_sessions%ROWTYPE;
  v_actual_revenue integer;
  v_actual_tax integer;
  v_plan_changed boolean := false;
  v_result jsonb;
BEGIN
  IF p_handoff_plan_id IS NULL OR p_performer_id IS NULL
     OR p_command_type NOT IN ('start', 'complete') OR p_command_id IS NULL
     OR p_device_id IS NULL OR p_actor_user_id IS NULL OR p_local_sequence <= 0
     OR p_request_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'invalid TurnIQ handoff performer command';
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
    p_salon_id, p_policy_version_id, p_actor_user_id, p_actor_role, p_occurred_at
  );
  PERFORM public.assert_turniq_supervised_online_v1(p_salon_id);

  SELECT hp.* INTO v_plan FROM public.turniq_handoff_plans hp
  WHERE hp.id = p_handoff_plan_id AND hp.salon_id = p_salon_id
    AND hp.policy_version_id = p_policy_version_id FOR UPDATE;
  SELECT hp.* INTO v_performer FROM public.turniq_handoff_performers hp
  WHERE hp.id = p_performer_id AND hp.salon_id = p_salon_id
    AND hp.handoff_plan_id = p_handoff_plan_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'TurnIQ handoff performer is unavailable';
  END IF;
  SELECT a.* INTO v_assignment FROM public.turniq_assignments a
  WHERE a.id = v_performer.assignment_id AND a.salon_id = p_salon_id
  FOR UPDATE;
  SELECT b.* INTO v_booking FROM public.bookings b
  WHERE b.id = v_plan.booking_id AND b.salon_id = p_salon_id FOR UPDATE;
  SELECT sh.* INTO v_shift FROM public.turniq_shift_sessions sh
  WHERE sh.id = v_performer.proposed_shift_session_id
    AND sh.salon_id = p_salon_id FOR UPDATE;
  PERFORM 1 FROM public.booking_service_segments seg
  JOIN public.turniq_handoff_plan_items i ON i.booking_segment_id = seg.id
  WHERE i.performer_id = p_performer_id
  ORDER BY seg.id FOR UPDATE OF seg;

  IF p_actor_role = 'nail_tech'
     AND nullif(v_context ->> 'actor_staff_id', '')::uuid
       IS DISTINCT FROM v_performer.proposed_staff_id THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Technician may update only own TurnIQ handoff work';
  END IF;
  IF p_actor_role NOT IN ('owner', 'admin', 'senior', 'receptionist', 'nail_tech')
     OR v_shift.checked_out_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'TurnIQ handoff performer command is not authorized';
  END IF;

  IF p_command_type = 'start' THEN
    IF v_plan.status NOT IN ('confirmed', 'in_progress')
       OR v_assignment.status <> 'confirmed'
       OR v_booking.status NOT IN ('confirmed', 'in_progress')
       OR v_shift.state <> 'active'
       OR p_occurred_at < v_assignment.confirmed_at THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'TurnIQ handoff performer is not ready to start';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.turniq_handoff_plan_items i
      JOIN public.booking_service_segments seg ON seg.id = i.booking_segment_id
      WHERE i.performer_id = p_performer_id
        AND seg.reservation_status NOT IN ('confirmed', 'in_progress')
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'TurnIQ handoff segment is not ready to start';
    END IF;
    IF v_booking.status = 'confirmed' THEN
      UPDATE public.bookings b SET status = 'in_progress',
        started_at = coalesce(b.started_at, p_occurred_at),
        no_show_candidate_at = NULL
      WHERE b.id = v_booking.id AND b.status = 'confirmed';
    END IF;
    UPDATE public.turniq_assignments a
    SET status = 'in_progress', started_at = p_occurred_at,
        state_version = a.state_version + 1, updated_at = transaction_timestamp()
    WHERE a.id = v_assignment.id AND a.state_version = v_assignment.state_version
    RETURNING * INTO v_assignment;
    IF v_plan.status = 'confirmed' THEN
      UPDATE public.turniq_handoff_plans hp
      SET status = 'in_progress', started_at = p_occurred_at,
          state_version = hp.state_version + 1, updated_at = transaction_timestamp()
      WHERE hp.id = v_plan.id AND hp.state_version = v_plan.state_version
      RETURNING * INTO v_plan;
      v_plan_changed := true;
    END IF;
  ELSE
    IF v_plan.status <> 'in_progress' OR v_assignment.status <> 'in_progress'
       OR v_booking.status <> 'in_progress'
       OR p_occurred_at < v_assignment.started_at THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'TurnIQ handoff performer is not ready to complete';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.turniq_handoff_plan_items i
      JOIN public.booking_service_segments seg ON seg.id = i.booking_segment_id
      WHERE i.performer_id = p_performer_id
        AND seg.reservation_status <> 'in_progress'
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'TurnIQ handoff segment is not in progress';
    END IF;
    SELECT sum(seg.subtotal_cents)::integer, sum(seg.tax_cents)::integer
    INTO v_actual_revenue, v_actual_tax
    FROM public.booking_service_segments seg
    JOIN public.turniq_handoff_plan_items i ON i.booking_segment_id = seg.id
    WHERE i.performer_id = p_performer_id;
    UPDATE public.booking_service_segments seg
    SET reservation_status = 'completed', updated_at = transaction_timestamp()
    FROM public.turniq_handoff_plan_items i
    WHERE i.performer_id = p_performer_id
      AND i.booking_segment_id = seg.id
      AND seg.reservation_status = 'in_progress';
    UPDATE public.turniq_assignments a
    SET status = 'completed', turn_consumed = true,
        actual_service_revenue_cents = coalesce(v_actual_revenue, 0),
        actual_tax_cents = coalesce(v_actual_tax, 0), actual_tip_cents = NULL,
        completed_at = p_occurred_at, state_version = a.state_version + 1,
        updated_at = transaction_timestamp()
    WHERE a.id = v_assignment.id AND a.state_version = v_assignment.state_version
    RETURNING * INTO v_assignment;
    UPDATE public.turniq_shift_sessions sh
    SET turns_consumed = sh.turns_consumed + 1,
        service_credit_since_checkin_cents =
          sh.service_credit_since_checkin_cents + v_assignment.opportunity_credit_cents,
        state_version = sh.state_version + 1,
        updated_at = transaction_timestamp()
    WHERE sh.id = v_shift.id AND sh.state_version = v_shift.state_version;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '40001',
        MESSAGE = 'TurnIQ handoff shift changed concurrently';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.turniq_handoff_performers hp
      JOIN public.turniq_assignments a ON a.id = hp.assignment_id
      WHERE hp.handoff_plan_id = v_plan.id AND a.status <> 'completed'
    ) THEN
      UPDATE public.bookings b SET status = 'completed', no_show_candidate_at = NULL
      WHERE b.id = v_booking.id AND b.status = 'in_progress';
      UPDATE public.turniq_handoff_plans hp
      SET status = 'completed', completed_at = p_occurred_at,
          state_version = hp.state_version + 1, updated_at = transaction_timestamp()
      WHERE hp.id = v_plan.id AND hp.state_version = v_plan.state_version
      RETURNING * INTO v_plan;
      v_plan_changed := true;
    END IF;
  END IF;

  IF v_assignment.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '40001',
      MESSAGE = 'TurnIQ handoff assignment changed concurrently';
  END IF;
  v_result := jsonb_build_object(
    'ok', true, 'command_id', p_command_id, 'replayed', false,
    'handoff_plan_id', v_plan.id, 'performer_id', v_performer.id,
    'assignment_id', v_assignment.id, 'booking_id', v_booking.id,
    'status', v_assignment.status,
    'state_version', v_assignment.state_version,
    'turn_consumed', v_assignment.turn_consumed,
    'plan_status', v_plan.status
  );
  PERFORM public.turniq_store_online_command(
    p_command_id, p_salon_id, p_policy_version_id, p_device_id,
    p_local_sequence, p_actor_user_id, p_actor_role, p_command_type,
    p_request_fingerprint, 'committed', v_result, p_occurred_at
  );
  INSERT INTO public.turniq_events (
    salon_id, policy_version_id, assignment_id, command_id, aggregate_type,
    aggregate_id, aggregate_version, event_type, actor_user_id,
    actor_staff_id, actor_role, actor_ref, reason_code,
    decision_fingerprint, request_fingerprint, payload, occurred_at
  ) VALUES (
    p_salon_id, p_policy_version_id, v_assignment.id, p_command_id,
    'assignment', v_assignment.id, v_assignment.state_version,
    CASE WHEN p_command_type = 'start'
      THEN 'handoff_performer_started' ELSE 'handoff_performer_completed' END,
    p_actor_user_id, nullif(v_context ->> 'actor_staff_id', '')::uuid,
    p_actor_role, 'user:' || p_actor_user_id::text, p_command_type,
    v_assignment.decision_fingerprint, p_request_fingerprint,
    jsonb_build_object(
      'handoff_plan_id', v_plan.id,
      'performer_id', v_performer.id,
      'booking_id', v_booking.id,
      'turn_consumed', v_assignment.turn_consumed,
      'plan_status', v_plan.status
    ), p_occurred_at
  );
  IF v_plan_changed THEN
    INSERT INTO public.turniq_events (
      salon_id, policy_version_id, command_id, aggregate_type, aggregate_id,
      aggregate_version, event_type, actor_user_id, actor_staff_id, actor_role,
      actor_ref, reason_code, decision_fingerprint, request_fingerprint,
      payload, occurred_at
    ) VALUES (
      p_salon_id, p_policy_version_id, p_command_id, 'handoff_plan', v_plan.id,
      v_plan.state_version,
      CASE WHEN v_plan.status = 'in_progress'
        THEN 'handoff_plan_started' ELSE 'handoff_plan_completed' END,
      p_actor_user_id, nullif(v_context ->> 'actor_staff_id', '')::uuid,
      p_actor_role, 'user:' || p_actor_user_id::text, p_command_type,
      v_plan.decision_fingerprint, p_request_fingerprint,
      jsonb_build_object('booking_id', v_booking.id, 'status', v_plan.status),
      p_occurred_at
    );
  END IF;
  RETURN v_result;
END
$function$;

REVOKE ALL ON FUNCTION public.assert_turniq_supervised_online_v1(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.turniq_handoff_segment_fingerprint_v1(
  public.booking_service_segments
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.record_turniq_handoff_plan_v1(
  uuid, uuid, uuid, uuid, timestamptz, text, text, text, jsonb, jsonb, jsonb,
  uuid, uuid, bigint, uuid, text, text, timestamptz
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.confirm_turniq_handoff_plan_v1(
  uuid, uuid, uuid, text, uuid, uuid, bigint, uuid, text, text, timestamptz
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.apply_turniq_handoff_performer_command_v1(
  uuid, uuid, uuid, uuid, text, uuid, uuid, bigint, uuid, text, text, timestamptz
) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.assert_turniq_supervised_online_v1(uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.turniq_handoff_segment_fingerprint_v1(
  public.booking_service_segments
) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_turniq_handoff_plan_v1(
  uuid, uuid, uuid, uuid, timestamptz, text, text, text, jsonb, jsonb, jsonb,
  uuid, uuid, bigint, uuid, text, text, timestamptz
) TO service_role;
GRANT EXECUTE ON FUNCTION public.confirm_turniq_handoff_plan_v1(
  uuid, uuid, uuid, text, uuid, uuid, bigint, uuid, text, text, timestamptz
) TO service_role;
GRANT EXECUTE ON FUNCTION public.apply_turniq_handoff_performer_command_v1(
  uuid, uuid, uuid, uuid, text, uuid, uuid, bigint, uuid, text, text, timestamptz
) TO service_role;

COMMENT ON TABLE public.turniq_handoff_plans IS
  'One authoritative TurnIQ plan for a committed multi-service booking; booking timing/staff/resource truth is revalidated, never silently rewritten.';
COMMENT ON TABLE public.turniq_handoff_performers IS
  'Immutable one-turn performer aggregation for a TurnIQ handoff plan.';
COMMENT ON TABLE public.turniq_handoff_plan_items IS
  'Immutable links from each booking service segment to its actual performer, credit and requested-tech provenance.';
COMMENT ON COLUMN public.turniq_fairness_receipts.handoff_detail IS
  'Segment-level provenance and attribution for multi-technician receipts; empty for non-handoff assignments.';
COMMENT ON FUNCTION public.record_turniq_handoff_plan_v1(
  uuid, uuid, uuid, uuid, timestamptz, text, text, text, jsonb, jsonb, jsonb,
  uuid, uuid, bigint, uuid, text, text, timestamptz
) IS 'Service-only M4R command: records a deterministic multi-technician plan without changing booking truth.';
COMMENT ON FUNCTION public.confirm_turniq_handoff_plan_v1(
  uuid, uuid, uuid, text, uuid, uuid, bigint, uuid, text, text, timestamptz
) IS 'Service-only M4R command: revalidates and confirms every handoff performer with one durable Fairness Receipt each.';
COMMENT ON FUNCTION public.apply_turniq_handoff_performer_command_v1(
  uuid, uuid, uuid, uuid, text, uuid, uuid, bigint, uuid, text, text, timestamptz
) IS 'Service-only M4R command: starts or completes one actual performer atomically; each performer consumes at most one turn per customer.';

DO $proof$
DECLARE
  v_table text;
  v_fn regprocedure;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'turniq_handoff_plans', 'turniq_handoff_performers',
    'turniq_handoff_plan_items'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.oid = ('public.' || v_table)::regclass
        AND c.relrowsecurity AND c.relforcerowsecurity
    ) OR pg_catalog.has_table_privilege('anon', 'public.' || v_table, 'SELECT')
       OR pg_catalog.has_table_privilege('authenticated', 'public.' || v_table, 'SELECT') THEN
      RAISE EXCEPTION 'TurnIQ handoff table security mismatch: %', v_table;
    END IF;
  END LOOP;
  FOREACH v_fn IN ARRAY ARRAY[
    'public.record_turniq_handoff_plan_v1(uuid,uuid,uuid,uuid,timestamptz,text,text,text,jsonb,jsonb,jsonb,uuid,uuid,bigint,uuid,text,text,timestamptz)'::regprocedure,
    'public.confirm_turniq_handoff_plan_v1(uuid,uuid,uuid,text,uuid,uuid,bigint,uuid,text,text,timestamptz)'::regprocedure,
    'public.apply_turniq_handoff_performer_command_v1(uuid,uuid,uuid,uuid,text,uuid,uuid,bigint,uuid,text,text,timestamptz)'::regprocedure
  ] LOOP
    IF pg_catalog.has_function_privilege('anon', v_fn, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', v_fn, 'EXECUTE')
       OR NOT pg_catalog.has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'TurnIQ handoff RPC privilege mismatch: %', v_fn;
    END IF;
  END LOOP;
END
$proof$;

COMMIT;
