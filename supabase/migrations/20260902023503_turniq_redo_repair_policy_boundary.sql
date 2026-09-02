-- TurnIQ M3H2: redo / repair policy boundary.
--
-- A redo is a new assignment that references a completed original assignment.
-- The desk classifies it before confirmation. The active, versioned salon
-- policy supplies the immutable turn/credit outcome; browser input can never
-- choose those booleans. Missing policy is an audited owner exception and the
-- assignment remains unchanged. Completion stays atomic with booking, shift,
-- command receipt and ledger evidence.
--
-- This remains inert while turniq_trust_engine_enabled is false. Rollback is
-- to keep the flag OFF and stop invoking the service-only RPCs. Preserve rules,
-- classification, receipts and events as audit evidence.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE public.turniq_policy_redo_rules (
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  policy_version_id uuid NOT NULL,
  category text NOT NULL CHECK (
    category IN (
      'quality_issue', 'customer_damage_or_change',
      'warranty_or_goodwill', 'other'
    )
  ),
  consumes_turn boolean NOT NULL,
  credits_opportunity boolean NOT NULL,
  created_by_user_id uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (salon_id, policy_version_id, category),
  FOREIGN KEY (salon_id, policy_version_id)
    REFERENCES public.turniq_policy_versions(salon_id, id) ON DELETE RESTRICT
);

CREATE INDEX turniq_policy_redo_rule_policy_fk_idx
  ON public.turniq_policy_redo_rules (salon_id, policy_version_id);
CREATE INDEX turniq_policy_redo_rule_actor_fk_idx
  ON public.turniq_policy_redo_rules (created_by_user_id)
  WHERE created_by_user_id IS NOT NULL;

ALTER TABLE public.turniq_policy_redo_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.turniq_policy_redo_rules FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.turniq_policy_redo_rules
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE public.turniq_policy_redo_rules TO service_role;

CREATE TRIGGER reject_turniq_redo_rule_mutation
  BEFORE UPDATE OR DELETE ON public.turniq_policy_redo_rules
  FOR EACH ROW EXECUTE FUNCTION public.reject_turniq_immutable_mutation();

ALTER TABLE public.turniq_assignments
  ADD COLUMN redo_original_assignment_id uuid,
  ADD COLUMN redo_category text,
  ADD COLUMN redo_note text,
  ADD COLUMN redo_consumes_turn boolean,
  ADD COLUMN redo_credits_opportunity boolean,
  ADD COLUMN redo_actor_user_id uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  ADD COLUMN redo_classified_at timestamptz;

ALTER TABLE public.turniq_assignments
  ADD CONSTRAINT turniq_assignment_redo_original_fk
    FOREIGN KEY (salon_id, redo_original_assignment_id)
    REFERENCES public.turniq_assignments(salon_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT turniq_assignment_redo_truth_check CHECK (
    (
      redo_original_assignment_id IS NULL
      AND redo_category IS NULL
      AND redo_note IS NULL
      AND redo_consumes_turn IS NULL
      AND redo_credits_opportunity IS NULL
      AND redo_actor_user_id IS NULL
      AND redo_classified_at IS NULL
    )
    OR (
      redo_original_assignment_id IS NOT NULL
      AND redo_original_assignment_id <> id
      AND redo_category IN (
        'quality_issue', 'customer_damage_or_change',
        'warranty_or_goodwill', 'other'
      )
      AND coalesce(length(btrim(redo_note)), 0) BETWEEN 1 AND 500
      AND redo_consumes_turn IS NOT NULL
      AND redo_credits_opportunity IS NOT NULL
      AND redo_actor_user_id IS NOT NULL
      AND redo_classified_at IS NOT NULL
      AND redo_classified_at >= decision_timestamp
    )
  );

CREATE INDEX turniq_assignment_redo_original_fk_idx
  ON public.turniq_assignments (salon_id, redo_original_assignment_id)
  WHERE redo_original_assignment_id IS NOT NULL;
CREATE INDEX turniq_assignment_redo_history_idx
  ON public.turniq_assignments (salon_id, redo_classified_at DESC)
  WHERE redo_classified_at IS NOT NULL;
CREATE INDEX turniq_assignment_redo_actor_fk_idx
  ON public.turniq_assignments (redo_actor_user_id)
  WHERE redo_actor_user_id IS NOT NULL;

ALTER TABLE public.turniq_assignments
  DROP CONSTRAINT turniq_assignment_lifecycle_truth_check;
ALTER TABLE public.turniq_assignments
  ADD CONSTRAINT turniq_assignment_lifecycle_truth_check CHECK (
    (status = 'recommended' AND confirmation_kind IS NULL
      AND confirmation_actor_user_id IS NULL AND override_reason IS NULL
      AND confirmed_at IS NULL AND started_at IS NULL
      AND completed_at IS NULL AND NOT turn_consumed)
    OR (status = 'confirmed' AND confirmation_kind IS NOT NULL
      AND confirmation_actor_user_id IS NOT NULL
      AND confirmed_at IS NOT NULL AND started_at IS NULL
      AND completed_at IS NULL AND NOT turn_consumed)
    OR (status = 'in_progress' AND confirmation_kind IS NOT NULL
      AND confirmation_actor_user_id IS NOT NULL
      AND confirmed_at IS NOT NULL AND started_at IS NOT NULL
      AND completed_at IS NULL AND NOT turn_consumed)
    OR (status = 'completed' AND confirmation_kind IS NOT NULL
      AND confirmation_actor_user_id IS NOT NULL
      AND confirmed_at IS NOT NULL AND started_at IS NOT NULL
      AND completed_at IS NOT NULL
      AND (
        turn_consumed
        OR (redo_original_assignment_id IS NOT NULL
          AND redo_consumes_turn = false AND NOT turn_consumed)
      ))
    OR (status IN ('cancelled', 'rejected') AND completed_at IS NULL
      AND NOT turn_consumed)
  );

ALTER TABLE public.turniq_exceptions
  DROP CONSTRAINT turniq_exceptions_exception_type_check;
ALTER TABLE public.turniq_exceptions
  ADD CONSTRAINT turniq_exceptions_exception_type_check CHECK (
    exception_type IN (
      'unsafe_assignment', 'impossible_assignment', 'self_assignment_override',
      'staff_dispute', 'request_pattern_review', 'stale_policy',
      'stale_snapshot', 'offline_conflict', 'duplicate_command',
      'appointment_risk', 'resource_risk', 'redo_policy_missing'
    )
  );

CREATE OR REPLACE FUNCTION public.guard_turniq_redo_completion_path()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO ''
AS $function$
BEGIN
  IF OLD.status = 'recommended'
     AND NEW.status = 'confirmed'
     AND EXISTS (
       SELECT 1
       FROM public.turniq_exceptions AS e
       WHERE e.salon_id = OLD.salon_id
         AND e.assignment_id = OLD.id
         AND e.exception_type = 'redo_policy_missing'
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'redo policy exception requires a fresh recommendation';
  END IF;
  IF OLD.status = 'in_progress'
     AND NEW.status = 'completed'
     AND OLD.redo_original_assignment_id IS NOT NULL
     AND coalesce(
       pg_catalog.current_setting('turniq.redo_completion_v2', true),
       'off'
     ) <> 'on' THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'redo completion requires policy-aware TurnIQ command';
  END IF;
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION public.guard_turniq_redo_completion_path()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER guard_turniq_redo_completion_path
  BEFORE UPDATE ON public.turniq_assignments
  FOR EACH ROW EXECUTE FUNCTION public.guard_turniq_redo_completion_path();

CREATE OR REPLACE FUNCTION public.apply_turniq_redo_classification_v1(
  p_salon_id uuid,
  p_policy_version_id uuid,
  p_assignment_id uuid,
  p_original_assignment_id uuid,
  p_redo_category text,
  p_note text,
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
  v_original public.turniq_assignments%ROWTYPE;
  v_rule public.turniq_policy_redo_rules%ROWTYPE;
  v_note text := nullif(pg_catalog.btrim(coalesce(p_note, '')), '');
  v_actor_staff_id uuid;
  v_event_version bigint;
  v_exception_id uuid;
  v_result jsonb;
BEGIN
  IF p_command_id IS NULL OR p_device_id IS NULL OR p_assignment_id IS NULL
     OR p_original_assignment_id IS NULL
     OR p_assignment_id = p_original_assignment_id
     OR p_local_sequence <= 0 OR p_request_fingerprint !~ '^[0-9a-f]{64}$'
     OR p_redo_category NOT IN (
       'quality_issue', 'customer_damage_or_change',
       'warranty_or_goodwill', 'other'
     )
     OR v_note IS NULL OR length(v_note) > 500 THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'invalid TurnIQ redo classification';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('turniq-command:' || p_command_id::text, 0)
  );
  v_replay := public.turniq_replay_online_command(
    p_command_id, p_salon_id, p_policy_version_id, p_actor_user_id,
    p_actor_role, 'redo', p_request_fingerprint
  );
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;

  v_context := public.turniq_online_context(
    p_salon_id, p_policy_version_id, p_actor_user_id, p_actor_role,
    p_occurred_at
  );
  v_actor_staff_id := nullif(v_context ->> 'actor_staff_id', '')::uuid;
  IF p_actor_role NOT IN ('owner', 'admin', 'senior', 'receptionist') THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'TurnIQ redo classification requires desk role';
  END IF;

  -- Lock both assignments in stable UUID order before reading either one.
  PERFORM 1
  FROM public.turniq_assignments AS a
  WHERE a.salon_id = p_salon_id
    AND a.id IN (p_assignment_id, p_original_assignment_id)
  ORDER BY a.id
  FOR UPDATE;

  SELECT a.* INTO v_assignment
  FROM public.turniq_assignments AS a
  WHERE a.salon_id = p_salon_id AND a.id = p_assignment_id;
  SELECT a.* INTO v_original
  FROM public.turniq_assignments AS a
  WHERE a.salon_id = p_salon_id AND a.id = p_original_assignment_id;

  IF v_assignment.id IS NULL OR v_original.id IS NULL
     OR v_assignment.policy_version_id IS DISTINCT FROM p_policy_version_id
     OR v_assignment.status <> 'recommended'
     OR v_assignment.redo_original_assignment_id IS NOT NULL
     OR v_original.status <> 'completed'
     OR p_occurred_at < v_assignment.decision_timestamp THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'TurnIQ redo assignment or original receipt is unavailable';
  END IF;

  SELECT coalesce(max(e.aggregate_version), 0) + 1
  INTO v_event_version
  FROM public.turniq_events AS e
  WHERE e.salon_id = p_salon_id
    AND e.aggregate_type = 'assignment'
    AND e.aggregate_id = p_assignment_id;

  SELECT r.* INTO v_rule
  FROM public.turniq_policy_redo_rules AS r
  WHERE r.salon_id = p_salon_id
    AND r.policy_version_id = p_policy_version_id
    AND r.category = p_redo_category;

  IF NOT FOUND THEN
    v_exception_id := extensions.gen_random_uuid();
    INSERT INTO public.turniq_exceptions (
      id, salon_id, policy_version_id, assignment_id, exception_type,
      privacy_safe_summary, recommended_action, detail
    ) VALUES (
      v_exception_id, p_salon_id, p_policy_version_id, p_assignment_id,
      'redo_policy_missing',
      'This redo category has no approved turn and credit rule.',
      'Create a new TurnIQ policy version with an explicit redo rule before confirming.',
      pg_catalog.jsonb_build_object(
        'redo_category', p_redo_category,
        'original_assignment_id', p_original_assignment_id
      )
    );
    v_result := pg_catalog.jsonb_build_object(
      'ok', false,
      'code', 'policy_configuration_required',
      'command_id', p_command_id,
      'replayed', false,
      'assignment_id', p_assignment_id,
      'exception_id', v_exception_id,
      'status', v_assignment.status,
      'state_version', v_assignment.state_version
    );
    PERFORM public.turniq_store_online_command(
      p_command_id, p_salon_id, p_policy_version_id, p_device_id,
      p_local_sequence, p_actor_user_id, p_actor_role, 'redo',
      p_request_fingerprint, 'conflict', v_result, p_occurred_at
    );
    INSERT INTO public.turniq_events (
      salon_id, policy_version_id, assignment_id, command_id, aggregate_type,
      aggregate_id, aggregate_version, event_type, actor_user_id,
      actor_staff_id, actor_role, actor_ref, reason_code, reason_detail,
      decision_fingerprint, request_fingerprint, payload, occurred_at
    ) VALUES (
      p_salon_id, p_policy_version_id, p_assignment_id, p_command_id,
      'assignment', p_assignment_id, v_event_version,
      'redo_policy_missing', p_actor_user_id, v_actor_staff_id, p_actor_role,
      'user:' || p_actor_user_id::text, 'policy_configuration_required',
      v_note, v_assignment.decision_fingerprint, p_request_fingerprint,
      pg_catalog.jsonb_build_object(
        'exception_id', v_exception_id,
        'redo_category', p_redo_category,
        'original_assignment_id', p_original_assignment_id
      ),
      p_occurred_at
    );
    RETURN v_result;
  END IF;

  UPDATE public.turniq_assignments AS a
  SET redo_original_assignment_id = p_original_assignment_id,
      redo_category = p_redo_category,
      redo_note = v_note,
      redo_consumes_turn = v_rule.consumes_turn,
      redo_credits_opportunity = v_rule.credits_opportunity,
      redo_actor_user_id = p_actor_user_id,
      redo_classified_at = p_occurred_at,
      state_version = a.state_version + 1,
      updated_at = pg_catalog.transaction_timestamp()
  WHERE a.id = p_assignment_id
    AND a.state_version = v_assignment.state_version
  RETURNING a.* INTO v_assignment;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '40001',
      MESSAGE = 'TurnIQ redo assignment changed concurrently';
  END IF;

  v_result := pg_catalog.jsonb_build_object(
    'ok', true,
    'command_id', p_command_id,
    'replayed', false,
    'assignment_id', p_assignment_id,
    'status', v_assignment.status,
    'state_version', v_assignment.state_version,
    'redo_category', v_assignment.redo_category,
    'redo_consumes_turn', v_assignment.redo_consumes_turn,
    'redo_credits_opportunity', v_assignment.redo_credits_opportunity
  );
  PERFORM public.turniq_store_online_command(
    p_command_id, p_salon_id, p_policy_version_id, p_device_id,
    p_local_sequence, p_actor_user_id, p_actor_role, 'redo',
    p_request_fingerprint, 'committed', v_result, p_occurred_at
  );
  INSERT INTO public.turniq_events (
    salon_id, policy_version_id, assignment_id, command_id, aggregate_type,
    aggregate_id, aggregate_version, event_type, actor_user_id, actor_staff_id,
    actor_role, actor_ref, reason_code, reason_detail, decision_fingerprint,
    request_fingerprint, payload, occurred_at
  ) VALUES (
    p_salon_id, p_policy_version_id, p_assignment_id, p_command_id,
    'assignment', p_assignment_id, v_event_version, 'redo_classified',
    p_actor_user_id, v_actor_staff_id, p_actor_role,
    'user:' || p_actor_user_id::text, p_redo_category, v_note,
    v_assignment.decision_fingerprint, p_request_fingerprint,
    pg_catalog.jsonb_build_object(
      'original_assignment_id', p_original_assignment_id,
      'consumes_turn', v_assignment.redo_consumes_turn,
      'credits_opportunity', v_assignment.redo_credits_opportunity
    ),
    p_occurred_at
  );
  RETURN v_result;
END
$function$;

CREATE OR REPLACE FUNCTION public.complete_turniq_assignment_command_v2(
  p_salon_id uuid,
  p_policy_version_id uuid,
  p_assignment_id uuid,
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
  v_actor_staff_id uuid;
  v_event_version bigint;
  v_actual_revenue integer;
  v_actual_tax integer;
  v_consumes_turn boolean := true;
  v_credits_opportunity boolean := true;
  v_applied_credit integer := 0;
  v_result jsonb;
BEGIN
  IF p_command_id IS NULL OR p_device_id IS NULL OR p_assignment_id IS NULL
     OR p_local_sequence <= 0 OR p_request_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'invalid TurnIQ completion command';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('turniq-command:' || p_command_id::text, 0)
  );
  v_replay := public.turniq_replay_online_command(
    p_command_id, p_salon_id, p_policy_version_id, p_actor_user_id,
    p_actor_role, 'complete', p_request_fingerprint
  );
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;

  v_context := public.turniq_online_context(
    p_salon_id, p_policy_version_id, p_actor_user_id, p_actor_role,
    p_occurred_at
  );
  v_actor_staff_id := nullif(v_context ->> 'actor_staff_id', '')::uuid;

  SELECT a.* INTO v_assignment
  FROM public.turniq_assignments AS a
  WHERE a.id = p_assignment_id AND a.salon_id = p_salon_id
  FOR UPDATE;
  IF NOT FOUND OR v_assignment.policy_version_id IS DISTINCT FROM p_policy_version_id
     OR v_assignment.status <> 'in_progress'
     OR v_assignment.assigned_staff_id IS NULL
     OR p_occurred_at < v_assignment.started_at THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'TurnIQ assignment is not ready to complete';
  END IF;
  IF p_actor_role = 'nail_tech'
     AND v_actor_staff_id IS DISTINCT FROM v_assignment.assigned_staff_id THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Technician may complete only own TurnIQ assignment';
  END IF;

  SELECT b.* INTO v_booking
  FROM public.bookings AS b
  WHERE b.id = v_assignment.booking_id AND b.salon_id = p_salon_id
  FOR UPDATE;
  IF NOT FOUND OR v_booking.deleted_at IS NOT NULL
     OR v_booking.schedule_model <> 'single'
     OR v_booking.status <> 'in_progress' THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'TurnIQ booking is unavailable or unsupported';
  END IF;

  SELECT sh.* INTO v_shift
  FROM public.turniq_shift_sessions AS sh
  WHERE sh.id = v_assignment.shift_session_id
    AND sh.salon_id = p_salon_id
    AND sh.checked_out_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'assigned technician shift is unavailable';
  END IF;

  IF v_assignment.redo_original_assignment_id IS NOT NULL THEN
    IF v_assignment.redo_category IS NULL
       OR v_assignment.redo_consumes_turn IS NULL
       OR v_assignment.redo_credits_opportunity IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'TurnIQ redo classification is incomplete';
    END IF;
    v_consumes_turn := v_assignment.redo_consumes_turn;
    v_credits_opportunity := v_assignment.redo_credits_opportunity;
    PERFORM pg_catalog.set_config('turniq.redo_completion_v2', 'on', true);
  END IF;
  v_applied_credit := CASE WHEN v_credits_opportunity
    THEN v_assignment.opportunity_credit_cents ELSE 0 END;
  v_actual_revenue := coalesce(
    v_booking.subtotal_cents,
    coalesce(v_booking.price_cents, 0) + coalesce(v_booking.addon_price_cents, 0)
  );
  v_actual_tax := v_booking.tax_amount_cents;

  SELECT coalesce(max(e.aggregate_version), 0) + 1
  INTO v_event_version
  FROM public.turniq_events AS e
  WHERE e.salon_id = p_salon_id
    AND e.aggregate_type = 'assignment'
    AND e.aggregate_id = p_assignment_id;

  UPDATE public.bookings AS b
  SET status = 'completed', no_show_candidate_at = NULL
  WHERE b.id = v_booking.id AND b.status = 'in_progress';
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '40001',
      MESSAGE = 'TurnIQ booking changed concurrently';
  END IF;

  UPDATE public.turniq_assignments AS a
  SET status = 'completed',
      turn_consumed = v_consumes_turn,
      actual_service_revenue_cents = v_actual_revenue,
      actual_tax_cents = v_actual_tax,
      actual_tip_cents = NULL,
      completed_at = p_occurred_at,
      state_version = a.state_version + 1,
      updated_at = pg_catalog.transaction_timestamp()
  WHERE a.id = p_assignment_id
    AND a.state_version = v_assignment.state_version
  RETURNING a.* INTO v_assignment;
  IF v_assignment.redo_original_assignment_id IS NOT NULL THEN
    PERFORM pg_catalog.set_config('turniq.redo_completion_v2', 'off', true);
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '40001',
      MESSAGE = 'TurnIQ assignment changed concurrently';
  END IF;

  UPDATE public.turniq_shift_sessions AS sh
  SET turns_consumed = sh.turns_consumed
        + CASE WHEN v_consumes_turn THEN 1 ELSE 0 END,
      service_credit_since_checkin_cents =
        sh.service_credit_since_checkin_cents + v_applied_credit,
      state_version = sh.state_version + 1,
      updated_at = pg_catalog.transaction_timestamp()
  WHERE sh.id = v_shift.id
    AND sh.state_version = v_shift.state_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '40001',
      MESSAGE = 'TurnIQ shift changed concurrently';
  END IF;

  v_result := pg_catalog.jsonb_build_object(
    'ok', true,
    'command_id', p_command_id,
    'replayed', false,
    'assignment_id', p_assignment_id,
    'booking_id', v_booking.id,
    'assigned_staff_id', v_assignment.assigned_staff_id,
    'status', v_assignment.status,
    'state_version', v_assignment.state_version,
    'turn_consumed', v_consumes_turn,
    'opportunity_credit_applied_cents', v_applied_credit
  );
  PERFORM public.turniq_store_online_command(
    p_command_id, p_salon_id, p_policy_version_id, p_device_id,
    p_local_sequence, p_actor_user_id, p_actor_role, 'complete',
    p_request_fingerprint, 'committed', v_result, p_occurred_at
  );
  INSERT INTO public.turniq_events (
    salon_id, policy_version_id, assignment_id, command_id, aggregate_type,
    aggregate_id, aggregate_version, event_type, actor_user_id, actor_staff_id,
    actor_role, actor_ref, reason_code, reason_detail, decision_fingerprint,
    request_fingerprint, payload, occurred_at
  ) VALUES (
    p_salon_id, p_policy_version_id, p_assignment_id, p_command_id,
    'assignment', p_assignment_id, v_event_version, 'service_completed',
    p_actor_user_id, v_actor_staff_id, p_actor_role,
    'user:' || p_actor_user_id::text, 'complete', NULL,
    v_assignment.decision_fingerprint, p_request_fingerprint,
    pg_catalog.jsonb_build_object(
      'booking_id', v_booking.id,
      'assigned_staff_id', v_assignment.assigned_staff_id,
      'status', v_assignment.status,
      'state_version', v_assignment.state_version,
      'turn_consumed', v_consumes_turn,
      'redo_category', v_assignment.redo_category,
      'redo_original_assignment_id', v_assignment.redo_original_assignment_id,
      'opportunity_credit_applied_cents', v_applied_credit
    ),
    p_occurred_at
  );
  RETURN v_result;
END
$function$;

REVOKE ALL ON FUNCTION public.apply_turniq_redo_classification_v1(
  uuid, uuid, uuid, uuid, text, text, uuid, uuid, bigint, uuid, text, text,
  timestamptz
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_turniq_assignment_command_v2(
  uuid, uuid, uuid, uuid, uuid, bigint, uuid, text, text, timestamptz
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.apply_turniq_redo_classification_v1(
  uuid, uuid, uuid, uuid, text, text, uuid, uuid, bigint, uuid, text, text,
  timestamptz
) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_turniq_assignment_command_v2(
  uuid, uuid, uuid, uuid, uuid, bigint, uuid, text, text, timestamptz
) TO service_role;

COMMENT ON TABLE public.turniq_policy_redo_rules IS
  'Immutable per-policy redo category outcomes. Missing categories fail closed; no universal redo rule is assumed.';
COMMENT ON COLUMN public.turniq_assignments.redo_original_assignment_id IS
  'Completed TurnIQ assignment whose service this new assignment repairs; the original record is never rewritten.';
COMMENT ON COLUMN public.turniq_assignments.redo_consumes_turn IS
  'Policy-derived fairness outcome captured at classification; never supplied by browser input.';
COMMENT ON COLUMN public.turniq_assignments.redo_credits_opportunity IS
  'Policy-derived opportunity-credit outcome captured at classification; actual revenue remains separate business truth.';

COMMIT;
