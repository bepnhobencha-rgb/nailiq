-- TurnIQ M3F dispute and exception commands.
--
-- This migration is inert while the per-salon TurnIQ feature flag is OFF. It
-- adds only service-role RPCs; no booking, payment, provider, notification, or
-- resource trigger is installed.
--
-- Rollback boundary: keep turniq_trust_engine_enabled OFF and stop invoking
-- these RPCs. Preserve command receipts, immutable events, disputes, and
-- exceptions as trust evidence.

ALTER TABLE public.turniq_command_receipts
  DROP CONSTRAINT turniq_command_receipts_command_type_check;

ALTER TABLE public.turniq_command_receipts
  ADD CONSTRAINT turniq_command_receipts_command_type_check CHECK (
    command_type IN (
      'check_in', 'check_out', 'break', 'return', 'hold', 'release_hold',
      'recommend', 'confirm', 'override', 'start', 'complete',
      'add_service', 'swap', 'refuse', 'redo', 'dispute', 'resolve_dispute',
      'acknowledge_exception', 'resolve_exception', 'dismiss_exception'
    )
  );

ALTER TABLE public.turniq_exceptions
  ADD COLUMN state_version bigint NOT NULL DEFAULT 1
    CHECK (state_version > 0);

ALTER TABLE public.turniq_disputes
  ADD COLUMN state_version bigint NOT NULL DEFAULT 1
    CHECK (state_version > 0);

CREATE UNIQUE INDEX turniq_dispute_one_active_receipt_staff_idx
  ON public.turniq_disputes (salon_id, fairness_receipt_id, raised_by_staff_id)
  WHERE status IN ('open', 'under_review');

CREATE OR REPLACE FUNCTION public.create_turniq_dispute_v1(
  p_salon_id uuid,
  p_policy_version_id uuid,
  p_fairness_receipt_id uuid,
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
  v_receipt public.turniq_fairness_receipts%ROWTYPE;
  v_actor_staff_id uuid;
  v_dispute public.turniq_disputes%ROWTYPE;
  v_exception public.turniq_exceptions%ROWTYPE;
  v_result jsonb;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
BEGIN
  IF p_command_id IS NULL OR p_device_id IS NULL
     OR p_fairness_receipt_id IS NULL OR p_local_sequence <= 0
     OR p_request_fingerprint !~ '^[0-9a-f]{64}$'
     OR p_category NOT IN (
       'assignment', 'skip_reason', 'turn_credit', 'service_credit',
       'override', 'other'
     )
     OR coalesce(length(v_reason), 0) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'invalid TurnIQ dispute command';
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
      MESSAGE = 'TurnIQ dispute requires an active technician identity';
  END IF;

  SELECT fr.*
  INTO v_receipt
  FROM public.turniq_fairness_receipts fr
  WHERE fr.id = p_fairness_receipt_id
    AND fr.salon_id = p_salon_id
  FOR SHARE;

  IF NOT FOUND OR v_receipt.policy_version_id IS DISTINCT FROM p_policy_version_id THEN
    RAISE EXCEPTION USING ERRCODE = '23503',
      MESSAGE = 'TurnIQ fairness receipt does not belong to policy';
  END IF;
  IF v_receipt.assigned_staff_id IS DISTINCT FROM v_actor_staff_id THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Technician may dispute only own fairness receipt';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'turniq-dispute:' || p_salon_id::text || ':' ||
      p_fairness_receipt_id::text || ':' || v_actor_staff_id::text,
      0
    )
  );
  IF EXISTS (
    SELECT 1
    FROM public.turniq_disputes d
    WHERE d.salon_id = p_salon_id
      AND d.fairness_receipt_id = p_fairness_receipt_id
      AND d.raised_by_staff_id = v_actor_staff_id
      AND d.status IN ('open', 'under_review')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'TurnIQ fairness receipt already has an active dispute';
  END IF;

  INSERT INTO public.turniq_disputes (
    salon_id, policy_version_id, assignment_id, fairness_receipt_id,
    raised_by_staff_id, category, privacy_safe_reason, status
  ) VALUES (
    p_salon_id, p_policy_version_id, v_receipt.assignment_id,
    p_fairness_receipt_id, v_actor_staff_id, p_category, v_reason, 'open'
  ) RETURNING * INTO v_dispute;

  INSERT INTO public.turniq_exceptions (
    salon_id, policy_version_id, assignment_id, exception_type, status,
    privacy_safe_summary, recommended_action, detail
  ) VALUES (
    p_salon_id, p_policy_version_id, v_receipt.assignment_id,
    'staff_dispute', 'open',
    'A team member asked for a TurnIQ fairness review.',
    'Review the Fairness Receipt and resolve or dismiss with a reason.',
    pg_catalog.jsonb_build_object('dispute_id', v_dispute.id)
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
    p_salon_id, p_policy_version_id, v_receipt.assignment_id, p_command_id,
    'dispute', v_dispute.id, v_dispute.state_version, 'dispute_opened',
    p_actor_user_id, v_actor_staff_id, p_actor_role,
    'user:' || p_actor_user_id::text, p_category, v_reason,
    p_request_fingerprint,
    pg_catalog.jsonb_build_object(
      'fairness_receipt_id', p_fairness_receipt_id,
      'exception_id', v_exception.id,
      'status', v_dispute.status,
      'state_version', v_dispute.state_version
    ),
    p_occurred_at
  ),
  (
    p_salon_id, p_policy_version_id, v_receipt.assignment_id, p_command_id,
    'exception', v_exception.id, v_exception.state_version,
    'exception_opened', p_actor_user_id, v_actor_staff_id, p_actor_role,
    'user:' || p_actor_user_id::text, 'staff_dispute', NULL,
    p_request_fingerprint,
    pg_catalog.jsonb_build_object(
      'dispute_id', v_dispute.id,
      'status', v_exception.status,
      'state_version', v_exception.state_version
    ),
    p_occurred_at
  );

  RETURN v_result;
END
$function$;

CREATE OR REPLACE FUNCTION public.resolve_turniq_dispute_v1(
  p_salon_id uuid,
  p_policy_version_id uuid,
  p_dispute_id uuid,
  p_resolution_status text,
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
  v_actor_staff_id uuid;
  v_dispute public.turniq_disputes%ROWTYPE;
  v_exception public.turniq_exceptions%ROWTYPE;
  v_result jsonb;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
BEGIN
  IF p_command_id IS NULL OR p_device_id IS NULL OR p_dispute_id IS NULL
     OR p_local_sequence <= 0 OR p_request_fingerprint !~ '^[0-9a-f]{64}$'
     OR p_resolution_status NOT IN ('resolved', 'dismissed')
     OR coalesce(length(v_reason), 0) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'invalid TurnIQ dispute resolution command';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('turniq-command:' || p_command_id::text, 0)
  );
  v_replay := public.turniq_replay_online_command(
    p_command_id, p_salon_id, p_policy_version_id, p_actor_user_id,
    p_actor_role, 'resolve_dispute', p_request_fingerprint
  );
  IF v_replay IS NOT NULL THEN
    RETURN v_replay;
  END IF;

  v_context := public.turniq_online_context(
    p_salon_id, p_policy_version_id, p_actor_user_id, p_actor_role,
    p_occurred_at
  );
  IF p_actor_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'TurnIQ dispute resolution requires owner or admin';
  END IF;
  v_actor_staff_id := nullif(v_context ->> 'actor_staff_id', '')::uuid;

  SELECT d.*
  INTO v_dispute
  FROM public.turniq_disputes d
  WHERE d.id = p_dispute_id
    AND d.salon_id = p_salon_id
  FOR UPDATE;

  IF NOT FOUND OR v_dispute.policy_version_id IS DISTINCT FROM p_policy_version_id THEN
    RAISE EXCEPTION USING ERRCODE = '23503',
      MESSAGE = 'TurnIQ dispute does not belong to policy';
  END IF;
  IF v_dispute.status NOT IN ('open', 'under_review') THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'TurnIQ dispute is already final';
  END IF;

  SELECT e.*
  INTO v_exception
  FROM public.turniq_exceptions e
  WHERE e.salon_id = p_salon_id
    AND e.policy_version_id = p_policy_version_id
    AND e.assignment_id = v_dispute.assignment_id
    AND e.exception_type = 'staff_dispute'
    AND e.detail ->> 'dispute_id' = p_dispute_id::text
    AND e.status IN ('open', 'acknowledged')
  ORDER BY e.created_at, e.id
  LIMIT 1
  FOR UPDATE;

  UPDATE public.turniq_disputes
  SET status = p_resolution_status,
      resolved_at = p_occurred_at,
      resolved_by_user_id = p_actor_user_id,
      resolution_reason = v_reason,
      updated_at = p_occurred_at,
      state_version = state_version + 1
  WHERE id = v_dispute.id
  RETURNING * INTO v_dispute;

  IF v_exception.id IS NOT NULL THEN
    UPDATE public.turniq_exceptions
    SET status = p_resolution_status,
        resolved_at = p_occurred_at,
        resolved_by_user_id = p_actor_user_id,
        resolution_reason = v_reason,
        updated_at = p_occurred_at,
        state_version = state_version + 1
    WHERE id = v_exception.id
    RETURNING * INTO v_exception;
  END IF;

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
    p_local_sequence, p_actor_user_id, p_actor_role, 'resolve_dispute',
    p_request_fingerprint, 'committed', v_result, p_occurred_at
  );

  INSERT INTO public.turniq_events (
    salon_id, policy_version_id, assignment_id, command_id, aggregate_type,
    aggregate_id, aggregate_version, event_type, actor_user_id,
    actor_staff_id, actor_role, actor_ref, reason_code, reason_detail,
    request_fingerprint, payload, occurred_at
  ) VALUES (
    p_salon_id, p_policy_version_id, v_dispute.assignment_id, p_command_id,
    'dispute', v_dispute.id, v_dispute.state_version,
    'dispute_' || p_resolution_status, p_actor_user_id, v_actor_staff_id,
    p_actor_role, 'user:' || p_actor_user_id::text, 'resolve_dispute',
    v_reason, p_request_fingerprint,
    pg_catalog.jsonb_build_object(
      'status', v_dispute.status,
      'state_version', v_dispute.state_version,
      'exception_id', v_exception.id
    ),
    p_occurred_at
  );

  IF v_exception.id IS NOT NULL THEN
    INSERT INTO public.turniq_events (
      salon_id, policy_version_id, assignment_id, command_id,
      aggregate_type, aggregate_id, aggregate_version, event_type,
      actor_user_id, actor_staff_id, actor_role, actor_ref, reason_code,
      reason_detail, request_fingerprint, payload, occurred_at
    ) VALUES (
      p_salon_id, p_policy_version_id, v_dispute.assignment_id, p_command_id,
      'exception', v_exception.id, v_exception.state_version,
      'exception_' || p_resolution_status, p_actor_user_id, v_actor_staff_id,
      p_actor_role, 'user:' || p_actor_user_id::text, 'staff_dispute',
      v_reason, p_request_fingerprint,
      pg_catalog.jsonb_build_object(
        'dispute_id', v_dispute.id,
        'status', v_exception.status,
        'state_version', v_exception.state_version
      ),
      p_occurred_at
    );
  END IF;

  RETURN v_result;
END
$function$;

CREATE OR REPLACE FUNCTION public.apply_turniq_exception_command_v1(
  p_salon_id uuid,
  p_policy_version_id uuid,
  p_exception_id uuid,
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
  v_actor_staff_id uuid;
  v_exception public.turniq_exceptions%ROWTYPE;
  v_next_status text;
  v_result jsonb;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
BEGIN
  IF p_command_id IS NULL OR p_device_id IS NULL OR p_exception_id IS NULL
     OR p_local_sequence <= 0 OR p_request_fingerprint !~ '^[0-9a-f]{64}$'
     OR p_command_type NOT IN (
       'acknowledge_exception', 'resolve_exception', 'dismiss_exception'
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'invalid TurnIQ exception command';
  END IF;
  IF p_command_type IN ('resolve_exception', 'dismiss_exception')
     AND coalesce(length(v_reason), 0) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'TurnIQ exception resolution requires a reason';
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
  IF p_actor_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'TurnIQ exception command requires owner or admin';
  END IF;
  v_actor_staff_id := nullif(v_context ->> 'actor_staff_id', '')::uuid;

  SELECT e.*
  INTO v_exception
  FROM public.turniq_exceptions e
  WHERE e.id = p_exception_id
    AND e.salon_id = p_salon_id
  FOR UPDATE;

  IF NOT FOUND OR v_exception.policy_version_id IS DISTINCT FROM p_policy_version_id THEN
    RAISE EXCEPTION USING ERRCODE = '23503',
      MESSAGE = 'TurnIQ exception does not belong to policy';
  END IF;
  IF v_exception.exception_type = 'staff_dispute'
     AND p_command_type IN ('resolve_exception', 'dismiss_exception') THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Staff dispute exception must use dispute resolution command';
  END IF;
  IF p_command_type = 'acknowledge_exception' THEN
    IF v_exception.status <> 'open' THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'TurnIQ exception cannot be acknowledged from current state';
    END IF;
    v_next_status := 'acknowledged';
  ELSE
    IF v_exception.status NOT IN ('open', 'acknowledged') THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'TurnIQ exception is already final';
    END IF;
    v_next_status := CASE p_command_type
      WHEN 'resolve_exception' THEN 'resolved'
      ELSE 'dismissed'
    END;
  END IF;

  UPDATE public.turniq_exceptions
  SET status = v_next_status,
      resolved_at = CASE
        WHEN v_next_status IN ('resolved', 'dismissed') THEN p_occurred_at
        ELSE NULL
      END,
      resolved_by_user_id = CASE
        WHEN v_next_status IN ('resolved', 'dismissed') THEN p_actor_user_id
        ELSE NULL
      END,
      resolution_reason = CASE
        WHEN v_next_status IN ('resolved', 'dismissed') THEN v_reason
        ELSE NULL
      END,
      updated_at = p_occurred_at,
      state_version = state_version + 1
  WHERE id = v_exception.id
  RETURNING * INTO v_exception;

  v_result := pg_catalog.jsonb_build_object(
    'ok', true,
    'command_id', p_command_id,
    'replayed', false,
    'aggregate_id', v_exception.id,
    'exception_id', v_exception.id,
    'status', v_exception.status,
    'state_version', v_exception.state_version
  );
  PERFORM public.turniq_store_online_command(
    p_command_id, p_salon_id, p_policy_version_id, p_device_id,
    p_local_sequence, p_actor_user_id, p_actor_role, p_command_type,
    p_request_fingerprint, 'committed', v_result, p_occurred_at
  );

  INSERT INTO public.turniq_events (
    salon_id, policy_version_id, assignment_id, command_id, aggregate_type,
    aggregate_id, aggregate_version, event_type, actor_user_id,
    actor_staff_id, actor_role, actor_ref, reason_code, reason_detail,
    request_fingerprint, payload, occurred_at
  ) VALUES (
    p_salon_id, p_policy_version_id, v_exception.assignment_id, p_command_id,
    'exception', v_exception.id, v_exception.state_version,
    'exception_' || v_exception.status, p_actor_user_id, v_actor_staff_id,
    p_actor_role, 'user:' || p_actor_user_id::text, p_command_type, v_reason,
    p_request_fingerprint,
    pg_catalog.jsonb_build_object(
      'status', v_exception.status,
      'state_version', v_exception.state_version
    ),
    p_occurred_at
  );

  RETURN v_result;
END
$function$;

REVOKE ALL ON FUNCTION public.create_turniq_dispute_v1(
  uuid, uuid, uuid, text, text, uuid, uuid, bigint, uuid, text, text, timestamptz
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.resolve_turniq_dispute_v1(
  uuid, uuid, uuid, text, text, uuid, uuid, bigint, uuid, text, text, timestamptz
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apply_turniq_exception_command_v1(
  uuid, uuid, uuid, text, text, uuid, uuid, bigint, uuid, text, text, timestamptz
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_turniq_dispute_v1(
  uuid, uuid, uuid, text, text, uuid, uuid, bigint, uuid, text, text, timestamptz
) TO service_role;
GRANT EXECUTE ON FUNCTION public.resolve_turniq_dispute_v1(
  uuid, uuid, uuid, text, text, uuid, uuid, bigint, uuid, text, text, timestamptz
) TO service_role;
GRANT EXECUTE ON FUNCTION public.apply_turniq_exception_command_v1(
  uuid, uuid, uuid, text, text, uuid, uuid, bigint, uuid, text, text, timestamptz
) TO service_role;

COMMENT ON FUNCTION public.create_turniq_dispute_v1(
  uuid, uuid, uuid, text, text, uuid, uuid, bigint, uuid, text, text, timestamptz
) IS 'M3F service-only atomic own-receipt dispute command. Creates a quiet owner exception and immutable events; no provider side effect.';
COMMENT ON FUNCTION public.resolve_turniq_dispute_v1(
  uuid, uuid, uuid, text, text, uuid, uuid, bigint, uuid, text, text, timestamptz
) IS 'M3F owner/admin dispute resolution command. Resolves the linked exception and appends immutable history atomically.';
COMMENT ON FUNCTION public.apply_turniq_exception_command_v1(
  uuid, uuid, uuid, text, text, uuid, uuid, bigint, uuid, text, text, timestamptz
) IS 'M3F owner/admin exception acknowledge/resolve/dismiss command with idempotent receipt and immutable event.';
