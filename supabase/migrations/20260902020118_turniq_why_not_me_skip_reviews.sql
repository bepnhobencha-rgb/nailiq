-- TurnIQ M3G privacy-safe "Why not me?" skip reviews.
--
-- This migration is inert while the per-salon TurnIQ feature flag is OFF. It
-- extends the existing trust ledger so a technician who appears in an
-- assignment's persisted skipped-candidate trace can ask for owner review.
-- The service-only RPC does not mutate the assignment, queue, booking, resource,
-- payment, provider, or notification state.
--
-- Rollback boundary: keep turniq_trust_engine_enabled OFF and stop invoking
-- create_turniq_skip_dispute_v1. Preserve disputes, exceptions, command
-- receipts, and immutable events as trust evidence.

ALTER TABLE public.turniq_disputes
  ALTER COLUMN fairness_receipt_id DROP NOT NULL,
  ADD COLUMN target_type text NOT NULL DEFAULT 'fairness_receipt';

ALTER TABLE public.turniq_disputes
  ADD CONSTRAINT turniq_disputes_target_type_check CHECK (
    target_type IN ('fairness_receipt', 'skip_decision')
  ),
  ADD CONSTRAINT turniq_disputes_target_reference_check CHECK (
    (target_type = 'fairness_receipt' AND fairness_receipt_id IS NOT NULL)
    OR (target_type = 'skip_decision' AND fairness_receipt_id IS NULL)
  );

CREATE UNIQUE INDEX turniq_dispute_one_active_skip_staff_idx
  ON public.turniq_disputes (salon_id, assignment_id, raised_by_staff_id)
  WHERE target_type = 'skip_decision'
    AND status IN ('open', 'under_review');

DROP TRIGGER enforce_turniq_dispute_same_salon ON public.turniq_disputes;

CREATE OR REPLACE FUNCTION public.enforce_turniq_dispute_same_salon_v2()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO ''
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.turniq_assignments a
    WHERE a.id = NEW.assignment_id
      AND a.salon_id = NEW.salon_id
      AND a.policy_version_id = NEW.policy_version_id
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.staff s
    WHERE s.id = NEW.raised_by_staff_id
      AND s.salon_id = NEW.salon_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23503',
      MESSAGE = 'TurnIQ dispute reference does not belong to salon or policy';
  END IF;

  IF NEW.target_type = 'fairness_receipt' AND NOT EXISTS (
    SELECT 1
    FROM public.turniq_fairness_receipts fr
    WHERE fr.id = NEW.fairness_receipt_id
      AND fr.salon_id = NEW.salon_id
      AND fr.policy_version_id = NEW.policy_version_id
      AND fr.assignment_id = NEW.assignment_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23503',
      MESSAGE = 'TurnIQ fairness receipt does not belong to dispute assignment';
  END IF;

  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION public.enforce_turniq_dispute_same_salon_v2()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER enforce_turniq_dispute_same_salon
  BEFORE INSERT OR UPDATE ON public.turniq_disputes
  FOR EACH ROW EXECUTE FUNCTION public.enforce_turniq_dispute_same_salon_v2();

CREATE OR REPLACE FUNCTION public.create_turniq_skip_dispute_v1(
  p_salon_id uuid,
  p_policy_version_id uuid,
  p_assignment_id uuid,
  p_category text,
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
  v_actor_staff_id uuid;
  v_skip_trace jsonb;
  v_reason_codes jsonb;
  v_dispute public.turniq_disputes%ROWTYPE;
  v_exception public.turniq_exceptions%ROWTYPE;
  v_result jsonb;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
BEGIN
  IF p_command_id IS NULL OR p_device_id IS NULL OR p_assignment_id IS NULL
     OR p_local_sequence <= 0 OR p_request_fingerprint !~ '^[0-9a-f]{64}$'
     OR p_category NOT IN ('assignment', 'skip_reason', 'other')
     OR coalesce(length(v_reason), 0) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'invalid TurnIQ skip review command';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('turniq-command:' || p_command_id::text, 0)
  );
  v_replay := public.turniq_replay_online_command(
    p_command_id, p_salon_id, p_policy_version_id, p_actor_user_id,
    p_actor_role, 'dispute', p_request_fingerprint
  );
  IF v_replay IS NOT NULL THEN
    RETURN v_replay;
  END IF;

  v_context := public.turniq_online_context(
    p_salon_id, p_policy_version_id, p_actor_user_id, p_actor_role,
    p_occurred_at
  );
  v_actor_staff_id := nullif(v_context ->> 'actor_staff_id', '')::uuid;
  IF v_actor_staff_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'TurnIQ skip review requires an active technician identity';
  END IF;

  SELECT a.*
  INTO v_assignment
  FROM public.turniq_assignments a
  WHERE a.id = p_assignment_id
    AND a.salon_id = p_salon_id
  FOR SHARE;

  IF NOT FOUND
     OR v_assignment.policy_version_id IS DISTINCT FROM p_policy_version_id THEN
    RAISE EXCEPTION USING ERRCODE = '23503',
      MESSAGE = 'TurnIQ assignment does not belong to policy';
  END IF;

  SELECT candidate
  INTO v_skip_trace
  FROM pg_catalog.jsonb_array_elements(v_assignment.skipped_candidates) AS candidate
  WHERE coalesce(candidate ->> 'staffId', candidate ->> 'staff_id')
    = v_actor_staff_id::text
  LIMIT 1;

  IF v_skip_trace IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Technician may review only own persisted skip decision';
  END IF;

  v_reason_codes := coalesce(
    v_skip_trace -> 'reasonCodes',
    v_skip_trace -> 'reason_codes',
    '[]'::jsonb
  );
  IF pg_catalog.jsonb_typeof(v_reason_codes) <> 'array' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'TurnIQ persisted skip reason codes are invalid';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'turniq-skip-dispute:' || p_salon_id::text || ':' ||
      p_assignment_id::text || ':' || v_actor_staff_id::text,
      0
    )
  );
  IF EXISTS (
    SELECT 1
    FROM public.turniq_disputes d
    WHERE d.salon_id = p_salon_id
      AND d.assignment_id = p_assignment_id
      AND d.raised_by_staff_id = v_actor_staff_id
      AND d.target_type = 'skip_decision'
      AND d.status IN ('open', 'under_review')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'TurnIQ skip decision already has an active review';
  END IF;

  INSERT INTO public.turniq_disputes (
    salon_id, policy_version_id, assignment_id, fairness_receipt_id,
    target_type, raised_by_staff_id, category, privacy_safe_reason, status
  ) VALUES (
    p_salon_id, p_policy_version_id, p_assignment_id, NULL,
    'skip_decision', v_actor_staff_id, p_category, v_reason, 'open'
  ) RETURNING * INTO v_dispute;

  INSERT INTO public.turniq_exceptions (
    salon_id, policy_version_id, assignment_id, exception_type, status,
    privacy_safe_summary, recommended_action, detail
  ) VALUES (
    p_salon_id, p_policy_version_id, p_assignment_id,
    'staff_dispute', 'open',
    'A team member asked for review of their TurnIQ skip reason.',
    'Review the persisted skip reason and resolve or dismiss with a reason.',
    pg_catalog.jsonb_build_object(
      'dispute_id', v_dispute.id,
      'target_type', 'skip_decision'
    )
  ) RETURNING * INTO v_exception;

  v_result := pg_catalog.jsonb_build_object(
    'ok', true,
    'command_id', p_command_id,
    'replayed', false,
    'aggregate_id', v_dispute.id,
    'dispute_id', v_dispute.id,
    'exception_id', v_exception.id,
    'status', v_dispute.status,
    'state_version', v_dispute.state_version
  );
  PERFORM public.turniq_store_online_command(
    p_command_id, p_salon_id, p_policy_version_id, p_device_id,
    p_local_sequence, p_actor_user_id, p_actor_role, 'dispute',
    p_request_fingerprint, 'committed', v_result, p_occurred_at
  );

  INSERT INTO public.turniq_events (
    salon_id, policy_version_id, assignment_id, command_id, aggregate_type,
    aggregate_id, aggregate_version, event_type, actor_user_id,
    actor_staff_id, actor_role, actor_ref, reason_code, reason_detail,
    request_fingerprint, payload, occurred_at
  ) VALUES
  (
    p_salon_id, p_policy_version_id, p_assignment_id, p_command_id,
    'dispute', v_dispute.id, v_dispute.state_version, 'dispute_opened',
    p_actor_user_id, v_actor_staff_id, p_actor_role,
    'user:' || p_actor_user_id::text, p_category, v_reason,
    p_request_fingerprint,
    pg_catalog.jsonb_build_object(
      'target_type', 'skip_decision',
      'skip_reason_codes', v_reason_codes,
      'exception_id', v_exception.id,
      'status', v_dispute.status,
      'state_version', v_dispute.state_version
    ),
    p_occurred_at
  ),
  (
    p_salon_id, p_policy_version_id, p_assignment_id, p_command_id,
    'exception', v_exception.id, v_exception.state_version,
    'exception_opened', p_actor_user_id, v_actor_staff_id, p_actor_role,
    'user:' || p_actor_user_id::text, 'staff_dispute', NULL,
    p_request_fingerprint,
    pg_catalog.jsonb_build_object(
      'dispute_id', v_dispute.id,
      'target_type', 'skip_decision',
      'status', v_exception.status,
      'state_version', v_exception.state_version
    ),
    p_occurred_at
  );

  RETURN v_result;
END
$function$;

REVOKE ALL ON FUNCTION public.create_turniq_skip_dispute_v1(
  uuid, uuid, uuid, text, text, uuid, uuid, bigint, uuid, text, text, timestamptz
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_turniq_skip_dispute_v1(
  uuid, uuid, uuid, text, text, uuid, uuid, bigint, uuid, text, text, timestamptz
) TO service_role;

COMMENT ON FUNCTION public.create_turniq_skip_dispute_v1(
  uuid, uuid, uuid, text, text, uuid, uuid, bigint, uuid, text, text, timestamptz
) IS 'M3G service-only atomic own-skip review command. Creates a quiet owner exception and immutable evidence; no assignment or provider side effect.';
