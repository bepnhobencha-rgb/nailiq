-- TurnIQ M3H1: refusal safety boundary.
--
-- A desk user must classify why a recommended technician did not take the
-- customer. Customer rejection never penalizes the technician. An approved
-- illness/emergency preserves queue position and starts a visible temporary
-- hold. Only an unapproved technician refusal moves the technician to the end.
-- The booking itself is intentionally untouched; a new recommendation remains
-- a separate explicit command.
--
-- This remains inert while turniq_trust_engine_enabled is false. Rollback is to
-- keep the flag OFF and stop invoking the service-only RPC. Preserve refusal
-- fields, command receipts and events as audit evidence.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.turniq_assignments
  ADD COLUMN refusal_category text,
  ADD COLUMN refusal_reason text,
  ADD COLUMN refusal_outcome text,
  ADD COLUMN refusal_actor_user_id uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  ADD COLUMN refused_at timestamptz;

ALTER TABLE public.turniq_assignments
  ADD CONSTRAINT turniq_assignment_refusal_truth_check CHECK (
    (
      refusal_category IS NULL
      AND refusal_reason IS NULL
      AND refusal_outcome IS NULL
      AND refusal_actor_user_id IS NULL
      AND refused_at IS NULL
    )
    OR (
      status = 'rejected'
      AND refusal_category IN (
        'customer_declined', 'illness_emergency', 'unapproved_refusal'
      )
      AND coalesce(length(btrim(refusal_reason)), 0) BETWEEN 1 AND 500
      AND refusal_outcome IN (
        'no_penalty', 'no_penalty_temporary_hold', 'moved_to_queue_end'
      )
      AND refusal_actor_user_id IS NOT NULL
      AND refused_at IS NOT NULL
      AND refused_at >= decision_timestamp
      AND (
        (refusal_category = 'customer_declined'
          AND refusal_outcome = 'no_penalty')
        OR (refusal_category = 'illness_emergency'
          AND refusal_outcome = 'no_penalty_temporary_hold')
        OR (refusal_category = 'unapproved_refusal'
          AND refusal_outcome = 'moved_to_queue_end')
      )
    )
  );

CREATE INDEX turniq_assignment_refusal_history_idx
  ON public.turniq_assignments (salon_id, refused_at DESC)
  WHERE refused_at IS NOT NULL;
CREATE INDEX turniq_assignment_refusal_actor_fk_idx
  ON public.turniq_assignments (refusal_actor_user_id)
  WHERE refusal_actor_user_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.apply_turniq_refusal_command_v1(
  p_salon_id uuid,
  p_policy_version_id uuid,
  p_assignment_id uuid,
  p_refusal_category text,
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
  v_assignment public.turniq_assignments%ROWTYPE;
  v_shift public.turniq_shift_sessions%ROWTYPE;
  v_policy public.turniq_policy_versions%ROWTYPE;
  v_reason text := nullif(pg_catalog.btrim(coalesce(p_reason, '')), '');
  v_outcome text;
  v_assignment_event_type text;
  v_assignment_event_version bigint;
  v_shift_event_type text;
  v_shift_event_version bigint;
  v_queue_position integer;
  v_result jsonb;
BEGIN
  IF p_command_id IS NULL OR p_device_id IS NULL OR p_assignment_id IS NULL
     OR p_local_sequence <= 0 OR p_request_fingerprint !~ '^[0-9a-f]{64}$'
     OR p_refusal_category NOT IN (
       'customer_declined', 'illness_emergency', 'unapproved_refusal'
     )
     OR v_reason IS NULL OR length(v_reason) > 500 THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'invalid TurnIQ refusal command';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('turniq-command:' || p_command_id::text, 0)
  );
  v_replay := public.turniq_replay_online_command(
    p_command_id, p_salon_id, p_policy_version_id, p_actor_user_id,
    p_actor_role, 'refuse', p_request_fingerprint
  );
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;

  v_context := public.turniq_online_context(
    p_salon_id, p_policy_version_id, p_actor_user_id, p_actor_role,
    p_occurred_at
  );
  IF p_actor_role NOT IN ('owner', 'admin', 'senior', 'receptionist') THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'TurnIQ refusal classification requires desk role';
  END IF;

  SELECT p.* INTO v_policy
  FROM public.turniq_policy_versions AS p
  WHERE p.id = p_policy_version_id
    AND p.salon_id = p_salon_id;
  IF NOT FOUND OR v_policy.refusal_policy <> 'move_to_end_unless_approved' THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'TurnIQ refusal policy is unavailable or stale';
  END IF;

  -- Queue-changing commands use the same salon-day lock namespace before row
  -- locks, so concurrent check-ins/refusals cannot assign the same tail slot.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'turniq-shift-queue:' || p_salon_id::text || ':'
        || (v_context ->> 'business_date'),
      0
    )
  );

  SELECT a.* INTO v_assignment
  FROM public.turniq_assignments AS a
  WHERE a.id = p_assignment_id
    AND a.salon_id = p_salon_id
  FOR UPDATE;
  IF NOT FOUND
     OR v_assignment.policy_version_id IS DISTINCT FROM p_policy_version_id
     OR v_assignment.status <> 'recommended'
     OR v_assignment.recommended_staff_id IS NULL
     OR v_assignment.refusal_category IS NOT NULL
     OR p_occurred_at < v_assignment.decision_timestamp THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'TurnIQ recommendation is unavailable or stale';
  END IF;

  SELECT sh.* INTO v_shift
  FROM public.turniq_shift_sessions AS sh
  WHERE sh.salon_id = p_salon_id
    AND sh.policy_version_id = p_policy_version_id
    AND sh.business_date = (v_context ->> 'business_date')::date
    AND sh.staff_id = v_assignment.recommended_staff_id
    AND sh.state = 'active'
    AND sh.checked_out_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'recommended technician shift is unavailable or stale';
  END IF;

  SELECT coalesce(max(e.aggregate_version), 0) + 1
  INTO v_assignment_event_version
  FROM public.turniq_events AS e
  WHERE e.salon_id = p_salon_id
    AND e.aggregate_type = 'assignment'
    AND e.aggregate_id = p_assignment_id;

  IF p_refusal_category = 'customer_declined' THEN
    v_outcome := 'no_penalty';
    v_assignment_event_type := 'customer_declined_recommendation';
  ELSIF p_refusal_category = 'illness_emergency' THEN
    v_outcome := 'no_penalty_temporary_hold';
    v_assignment_event_type := 'assignment_refused_approved_emergency';
    v_shift_event_type := 'shift_emergency_hold_started';
  ELSE
    v_outcome := 'moved_to_queue_end';
    v_assignment_event_type := 'assignment_refused_unapproved';
    v_shift_event_type := 'shift_moved_to_queue_end_after_refusal';
  END IF;

  IF v_shift_event_type IS NOT NULL THEN
    SELECT coalesce(max(e.aggregate_version), 0) + 1
    INTO v_shift_event_version
    FROM public.turniq_events AS e
    WHERE e.salon_id = p_salon_id
      AND e.aggregate_type = 'shift'
      AND e.aggregate_id = v_shift.id;

    IF p_refusal_category = 'illness_emergency' THEN
      UPDATE public.turniq_shift_sessions AS sh
      SET state = 'temporary_hold',
          hold_reason = v_reason,
          state_changed_at = p_occurred_at,
          state_version = sh.state_version + 1,
          updated_at = pg_catalog.transaction_timestamp()
      WHERE sh.id = v_shift.id
        AND sh.state_version = v_shift.state_version
      RETURNING sh.* INTO v_shift;
    ELSE
      SELECT coalesce(max(sh.queue_position), 0) + 1
      INTO v_queue_position
      FROM public.turniq_shift_sessions AS sh
      WHERE sh.salon_id = p_salon_id
        AND sh.business_date = (v_context ->> 'business_date')::date
        AND sh.checked_out_at IS NULL;

      UPDATE public.turniq_shift_sessions AS sh
      SET queue_position = v_queue_position,
          state_changed_at = p_occurred_at,
          state_version = sh.state_version + 1,
          updated_at = pg_catalog.transaction_timestamp()
      WHERE sh.id = v_shift.id
        AND sh.state_version = v_shift.state_version
      RETURNING sh.* INTO v_shift;
    END IF;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '40001',
        MESSAGE = 'TurnIQ shift changed concurrently';
    END IF;
  END IF;

  UPDATE public.turniq_assignments AS a
  SET status = 'rejected',
      refusal_category = p_refusal_category,
      refusal_reason = v_reason,
      refusal_outcome = v_outcome,
      refusal_actor_user_id = p_actor_user_id,
      refused_at = p_occurred_at,
      state_version = a.state_version + 1,
      updated_at = pg_catalog.transaction_timestamp()
  WHERE a.id = p_assignment_id
    AND a.state_version = v_assignment.state_version
  RETURNING a.* INTO v_assignment;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '40001',
      MESSAGE = 'TurnIQ assignment changed concurrently';
  END IF;

  v_result := pg_catalog.jsonb_build_object(
    'ok', true,
    'command_id', p_command_id,
    'replayed', false,
    'assignment_id', p_assignment_id,
    'status', v_assignment.status,
    'state_version', v_assignment.state_version,
    'refusal_category', p_refusal_category,
    'refusal_outcome', v_outcome,
    'recommended_staff_id', v_assignment.recommended_staff_id,
    'shift_session_id', v_shift.id,
    'queue_position', v_shift.queue_position,
    'shift_state', v_shift.state
  );
  PERFORM public.turniq_store_online_command(
    p_command_id, p_salon_id, p_policy_version_id, p_device_id,
    p_local_sequence, p_actor_user_id, p_actor_role, 'refuse',
    p_request_fingerprint, 'committed', v_result, p_occurred_at
  );

  INSERT INTO public.turniq_events (
    salon_id, policy_version_id, assignment_id, command_id, aggregate_type,
    aggregate_id, aggregate_version, event_type, actor_user_id, actor_staff_id,
    actor_role, actor_ref, reason_code, reason_detail, decision_fingerprint,
    request_fingerprint, payload, occurred_at
  ) VALUES (
    p_salon_id, p_policy_version_id, p_assignment_id, p_command_id,
    'assignment', p_assignment_id, v_assignment_event_version,
    v_assignment_event_type, p_actor_user_id,
    nullif(v_context ->> 'actor_staff_id', '')::uuid, p_actor_role,
    'user:' || p_actor_user_id::text, p_refusal_category, v_reason,
    v_assignment.decision_fingerprint, p_request_fingerprint,
    pg_catalog.jsonb_build_object(
      'refusal_outcome', v_outcome,
      'recommended_staff_id', v_assignment.recommended_staff_id,
      'shift_session_id', v_shift.id,
      'queue_position', v_shift.queue_position,
      'shift_state', v_shift.state
    ),
    p_occurred_at
  );

  IF v_shift_event_type IS NOT NULL THEN
    INSERT INTO public.turniq_events (
      salon_id, policy_version_id, assignment_id, command_id, aggregate_type,
      aggregate_id, aggregate_version, event_type, actor_user_id,
      actor_staff_id, actor_role, actor_ref, reason_code, reason_detail,
      decision_fingerprint, request_fingerprint, payload, occurred_at
    ) VALUES (
      p_salon_id, p_policy_version_id, p_assignment_id, p_command_id,
      'shift', v_shift.id, v_shift_event_version, v_shift_event_type,
      p_actor_user_id, nullif(v_context ->> 'actor_staff_id', '')::uuid,
      p_actor_role, 'user:' || p_actor_user_id::text,
      p_refusal_category, v_reason, v_assignment.decision_fingerprint,
      p_request_fingerprint,
      pg_catalog.jsonb_build_object(
        'refusal_outcome', v_outcome,
        'staff_id', v_shift.staff_id,
        'queue_position', v_shift.queue_position,
        'shift_state', v_shift.state,
        'state_version', v_shift.state_version
      ),
      p_occurred_at
    );
  END IF;

  RETURN v_result;
END
$function$;

REVOKE ALL ON FUNCTION public.apply_turniq_refusal_command_v1(
  uuid, uuid, uuid, text, text, uuid, uuid, bigint, uuid, text, text,
  timestamptz
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_turniq_refusal_command_v1(
  uuid, uuid, uuid, text, text, uuid, uuid, bigint, uuid, text, text,
  timestamptz
) TO service_role;

COMMENT ON FUNCTION public.apply_turniq_refusal_command_v1(
  uuid, uuid, uuid, text, text, uuid, uuid, bigint, uuid, text, text,
  timestamptz
) IS
  'M3H1 service-only refusal classification. Customer decline has no penalty, approved illness/emergency preserves queue position on hold, and only unapproved refusal moves the technician to the queue end.';

COMMIT;
