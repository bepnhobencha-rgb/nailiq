-- TurnIQ M3E business-day rollover.
--
-- Check-in remains one atomic command. If the same technician still has an
-- open shift from an earlier salon-local business day, the command closes that
-- stale shift, appends an immutable rollover event under its original policy,
-- and then joins today's queue at the end with today's fairness baseline.
-- Future-dated or same-day open shifts still fail closed.
--
-- Rollback boundary: keep TurnIQ OFF and restore the M3A definition of
-- apply_turniq_shift_command_v1. Preserve all shift/event rows as evidence.

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
  v_open_shift_found boolean := false;
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
  v_open_shift_found := FOUND;

  IF p_command_type = 'check_in'
     AND v_open_shift_found
     AND v_shift.business_date < v_business_date
     AND p_occurred_at >= v_shift.state_changed_at THEN
    UPDATE public.turniq_shift_sessions sh
    SET state = 'checked_out',
        checked_out_at = p_occurred_at,
        hold_reason = NULL,
        state_changed_at = p_occurred_at,
        state_version = sh.state_version + 1,
        updated_at = pg_catalog.transaction_timestamp()
    WHERE sh.id = v_shift.id
      AND sh.state_version = v_shift.state_version
    RETURNING * INTO v_shift;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '40001',
        MESSAGE = 'TurnIQ stale shift changed concurrently';
    END IF;

    INSERT INTO public.turniq_events (
      salon_id, policy_version_id, command_id, aggregate_type, aggregate_id,
      aggregate_version, event_type, actor_user_id, actor_staff_id, actor_role,
      actor_ref, reason_code, reason_detail, request_fingerprint, payload,
      occurred_at
    ) VALUES (
      p_salon_id, v_shift.policy_version_id, NULL, 'shift', v_shift.id,
      v_shift.state_version, 'shift_business_day_closed', p_actor_user_id,
      nullif(v_context ->> 'actor_staff_id', '')::uuid, p_actor_role,
      'user:' || p_actor_user_id::text, 'business_day_rollover',
      'Closed automatically when the technician checked in on a later business day.',
      p_request_fingerprint,
      pg_catalog.jsonb_build_object(
        'state', v_shift.state,
        'previous_business_date', v_shift.business_date,
        'next_business_date', v_business_date,
        'state_version', v_shift.state_version
      ),
      p_occurred_at
    );
    v_open_shift_found := false;
  END IF;

  IF p_command_type = 'check_in' THEN
    IF v_open_shift_found THEN
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
    IF NOT v_open_shift_found
       OR v_shift.business_date IS DISTINCT FROM v_business_date
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

REVOKE ALL ON FUNCTION public.apply_turniq_shift_command_v1(
  uuid, uuid, uuid, text, text, uuid, uuid, bigint, uuid, text, text,
  timestamptz
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_turniq_shift_command_v1(
  uuid, uuid, uuid, text, text, uuid, uuid, bigint, uuid, text, text,
  timestamptz
) TO service_role;
