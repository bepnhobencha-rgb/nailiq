-- TurnIQ QA parity hotfix: PostgreSQL special forms such as COALESCE and
-- EXTRACT cannot be schema-qualified. Recreate the M5/M6 functions with
-- portable syntax. This migration is dormant while TurnIQ remains OFF and
-- preserves all existing table/RLS/function grants.

CREATE OR REPLACE FUNCTION public.advance_turniq_offline_state_version()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO ''
AS $function$
BEGIN
  INSERT INTO public.turniq_offline_state (salon_id, state_version, updated_at)
  VALUES (NEW.salon_id, 1, transaction_timestamp())
  ON CONFLICT (salon_id) DO UPDATE
  SET state_version = public.turniq_offline_state.state_version + 1,
      updated_at = transaction_timestamp();
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.pair_turniq_primary_offline_device_v1(
  p_salon_id uuid,
  p_device_id uuid,
  p_label text,
  p_actor_user_id uuid,
  p_actor_role text,
  p_occurred_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO ''
AS $function$
DECLARE
  v_state public.turniq_offline_state%ROWTYPE;
  v_existing public.turniq_offline_devices%ROWTYPE;
  v_generation bigint;
  v_label text := pg_catalog.btrim(coalesce(p_label, ''));
  v_now timestamptz := coalesce(p_occurred_at, transaction_timestamp());
BEGIN
  IF p_salon_id IS NULL OR p_device_id IS NULL OR p_actor_user_id IS NULL
     OR p_actor_role NOT IN ('owner', 'admin')
     OR length(v_label) NOT BETWEEN 1 AND 100
     OR NOT EXISTS (
       SELECT 1 FROM public.salon_members m
       JOIN public.salons s ON s.id = m.salon_id
       WHERE m.salon_id = p_salon_id AND m.user_id = p_actor_user_id
         AND m.role = p_actor_role AND s.archived_at IS NULL
         AND coalesce(
           s.feature_flags -> 'turniq_trust_engine_enabled', 'false'::jsonb
         ) = 'true'::jsonb
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid TurnIQ device pairing';
  END IF;

  INSERT INTO public.turniq_offline_state (salon_id)
  VALUES (p_salon_id)
  ON CONFLICT (salon_id) DO NOTHING;

  SELECT * INTO v_state
  FROM public.turniq_offline_state
  WHERE salon_id = p_salon_id
  FOR UPDATE;

  SELECT * INTO v_existing
  FROM public.turniq_offline_devices
  WHERE salon_id = p_salon_id AND status = 'primary'
  FOR UPDATE;
  IF FOUND AND v_existing.id = p_device_id
     AND v_existing.paired_by_user_id = p_actor_user_id THEN
    UPDATE public.turniq_offline_devices
    SET last_seen_at = v_now, updated_at = v_now
    WHERE salon_id = p_salon_id AND id = p_device_id;
    RETURN pg_catalog.jsonb_build_object(
      'ok', true,
      'device_id', p_device_id,
      'device_generation', v_existing.generation,
      'state_version', v_state.state_version,
      'last_acked_sequence', v_existing.last_acked_sequence,
      'status', 'primary',
      'replayed', true
    );
  END IF;

  v_generation := v_state.device_generation + 1;

  UPDATE public.turniq_offline_devices
  SET status = 'revoked',
      revoked_by_user_id = p_actor_user_id,
      revoked_at = v_now,
      revoke_reason = 'replaced_by_new_primary',
      updated_at = v_now
  WHERE salon_id = p_salon_id AND status = 'primary';

  INSERT INTO public.turniq_offline_devices (
    id, salon_id, generation, label, status, paired_by_user_id,
    paired_at, last_seen_at, created_at, updated_at
  ) VALUES (
    p_device_id, p_salon_id, v_generation, v_label, 'primary',
    p_actor_user_id, v_now, v_now, v_now, v_now
  );

  UPDATE public.turniq_offline_state
  SET device_generation = v_generation, updated_at = v_now
  WHERE salon_id = p_salon_id;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'device_id', p_device_id,
    'device_generation', v_generation,
    'state_version', v_state.state_version,
    'last_acked_sequence', 0,
    'status', 'primary'
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.revoke_turniq_primary_offline_device_v1(
  p_salon_id uuid,
  p_device_id uuid,
  p_actor_user_id uuid,
  p_actor_role text,
  p_reason text,
  p_occurred_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO ''
AS $function$
DECLARE
  v_reason text := pg_catalog.btrim(coalesce(p_reason, ''));
  v_now timestamptz := coalesce(p_occurred_at, transaction_timestamp());
  v_updated integer;
BEGIN
  IF p_salon_id IS NULL OR p_device_id IS NULL OR p_actor_user_id IS NULL
     OR p_actor_role NOT IN ('owner', 'admin')
     OR length(v_reason) NOT BETWEEN 1 AND 500
     OR NOT EXISTS (
       SELECT 1 FROM public.salon_members m
       WHERE m.salon_id = p_salon_id AND m.user_id = p_actor_user_id
         AND m.role = p_actor_role
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid TurnIQ device revocation';
  END IF;

  UPDATE public.turniq_offline_devices
  SET status = 'revoked',
      revoked_by_user_id = p_actor_user_id,
      revoked_at = v_now,
      revoke_reason = v_reason,
      updated_at = v_now
  WHERE salon_id = p_salon_id AND id = p_device_id AND status = 'primary';
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  RETURN pg_catalog.jsonb_build_object(
    'ok', v_updated = 1,
    'device_id', p_device_id,
    'status', CASE WHEN v_updated = 1 THEN 'revoked' ELSE 'not_primary' END
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.inspect_turniq_offline_device_v1(
  p_salon_id uuid,
  p_device_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO ''
AS $function$
  SELECT pg_catalog.jsonb_build_object(
    'ok', true,
    'device_id', d.id,
    'device_generation', d.generation,
    'status', d.status,
    'last_acked_sequence', d.last_acked_sequence,
    'state_version', s.state_version,
    'snapshot_policy_version_id', d.snapshot_policy_version_id,
    'snapshot_state_version', d.snapshot_state_version,
    'snapshot_fingerprint', d.snapshot_fingerprint,
    'snapshot_captured_at', d.snapshot_captured_at,
    'last_seen_at', d.last_seen_at
  )
  FROM public.turniq_offline_devices d
  JOIN public.turniq_offline_state s ON s.salon_id = d.salon_id
  WHERE d.salon_id = p_salon_id AND d.id = p_device_id
$function$;

CREATE OR REPLACE FUNCTION public.sync_turniq_offline_snapshot_v1(
  p_salon_id uuid,
  p_device_id uuid,
  p_device_generation bigint,
  p_policy_version_id uuid,
  p_snapshot_fingerprint text,
  p_actor_user_id uuid,
  p_actor_role text,
  p_captured_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO ''
AS $function$
DECLARE
  v_state public.turniq_offline_state%ROWTYPE;
  v_device public.turniq_offline_devices%ROWTYPE;
  v_now timestamptz := coalesce(p_captured_at, transaction_timestamp());
BEGIN
  IF p_actor_user_id IS NULL OR p_actor_role NOT IN ('owner', 'admin')
     OR p_snapshot_fingerprint !~ '^[0-9a-f]{64}$'
     OR NOT EXISTS (
       SELECT 1 FROM public.salon_members m
       JOIN public.salons s ON s.id = m.salon_id
       WHERE m.salon_id = p_salon_id AND m.user_id = p_actor_user_id
         AND m.role = p_actor_role AND s.archived_at IS NULL
         AND coalesce(
           s.feature_flags -> 'turniq_trust_engine_enabled', 'false'::jsonb
         ) = 'true'::jsonb
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid TurnIQ offline snapshot';
  END IF;

  SELECT * INTO v_state
  FROM public.turniq_offline_state
  WHERE salon_id = p_salon_id
  FOR UPDATE;
  SELECT * INTO v_device
  FROM public.turniq_offline_devices
  WHERE salon_id = p_salon_id AND id = p_device_id
  FOR UPDATE;

  IF NOT FOUND OR v_device.status <> 'primary'
     OR v_device.generation <> p_device_generation THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'device_not_primary');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.turniq_policy_versions p
    WHERE p.salon_id = p_salon_id AND p.id = p_policy_version_id
  ) THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'stale_policy');
  END IF;

  UPDATE public.turniq_offline_devices
  SET snapshot_policy_version_id = p_policy_version_id,
      snapshot_state_version = v_state.state_version,
      snapshot_fingerprint = p_snapshot_fingerprint,
      snapshot_captured_at = v_now,
      last_seen_at = v_now,
      updated_at = v_now
  WHERE salon_id = p_salon_id AND id = p_device_id;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'device_id', p_device_id,
    'device_generation', p_device_generation,
    'state_version', v_state.state_version,
    'last_acked_sequence', v_device.last_acked_sequence,
    'status', 'primary'
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.record_turniq_offline_conflict_v1(
  p_salon_id uuid,
  p_device_id uuid,
  p_device_generation bigint,
  p_policy_version_id uuid,
  p_command_id uuid,
  p_local_sequence bigint,
  p_conflict_code text,
  p_expected_state_version bigint,
  p_actual_state_version bigint,
  p_request_fingerprint text,
  p_detail jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO ''
AS $function$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.turniq_offline_reconciliations (
    salon_id, device_id, device_generation, command_id, local_sequence,
    policy_version_id, conflict_code, expected_state_version,
    actual_state_version, request_fingerprint, detail
  ) VALUES (
    p_salon_id, p_device_id, p_device_generation, p_command_id,
    p_local_sequence, p_policy_version_id, p_conflict_code,
    p_expected_state_version, p_actual_state_version,
    p_request_fingerprint, coalesce(p_detail, '{}'::jsonb)
  )
  ON CONFLICT (salon_id, command_id) DO UPDATE
  SET detail = public.turniq_offline_reconciliations.detail
  RETURNING id INTO v_id;
  IF NOT EXISTS (
    SELECT 1 FROM public.turniq_exceptions e
    WHERE e.salon_id = p_salon_id
      AND e.exception_type = 'offline_conflict'
      AND e.detail ->> 'offline_conflict_id' = v_id::text
  ) THEN
    INSERT INTO public.turniq_exceptions (
      salon_id, policy_version_id, exception_type,
      privacy_safe_summary, recommended_action, detail
    ) VALUES (
      p_salon_id, p_policy_version_id, 'offline_conflict',
      'An offline TurnIQ action conflicts with current salon state.',
      'Review the local action and keep the authoritative server state or re-enter it safely.',
      pg_catalog.jsonb_build_object(
        'offline_conflict_id', v_id,
        'device_id', p_device_id,
        'command_id', p_command_id,
        'conflict_code', p_conflict_code
      )
    );
  END IF;
  RETURN v_id;
END
$function$;

CREATE OR REPLACE FUNCTION public.resolve_turniq_offline_reconciliation_v1(
  p_salon_id uuid,
  p_device_id uuid,
  p_conflict_id uuid,
  p_actor_user_id uuid,
  p_actor_role text,
  p_reason text,
  p_resolved_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO ''
AS $function$
DECLARE
  v_reason text := pg_catalog.btrim(coalesce(p_reason, ''));
  v_now timestamptz := coalesce(p_resolved_at, transaction_timestamp());
  v_updated integer;
BEGIN
  IF p_actor_user_id IS NULL OR p_actor_role NOT IN ('owner', 'admin')
     OR length(v_reason) NOT BETWEEN 1 AND 500
     OR NOT EXISTS (
       SELECT 1 FROM public.salon_members m
       WHERE m.salon_id = p_salon_id AND m.user_id = p_actor_user_id
         AND m.role = p_actor_role
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'offline reconciliation requires owner/admin';
  END IF;

  UPDATE public.turniq_offline_reconciliations r
  SET status = 'resolved', resolved_at = v_now,
      resolved_by_user_id = p_actor_user_id, resolution_reason = v_reason
  WHERE r.salon_id = p_salon_id AND r.device_id = p_device_id
    AND r.id = p_conflict_id AND r.status = 'open';
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;

  UPDATE public.turniq_exceptions e
  SET status = 'resolved', resolved_at = v_now,
      resolved_by_user_id = p_actor_user_id, resolution_reason = v_reason,
      updated_at = v_now
  WHERE e.salon_id = p_salon_id
    AND e.exception_type = 'offline_conflict'
    AND e.status IN ('open', 'acknowledged')
    AND e.detail ->> 'offline_conflict_id' = p_conflict_id::text;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true, 'conflict_id', p_conflict_id, 'status', 'resolved'
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.preflight_turniq_offline_command_v1(
  p_salon_id uuid,
  p_device_id uuid,
  p_device_generation bigint,
  p_policy_version_id uuid,
  p_command_id uuid,
  p_local_sequence bigint,
  p_expected_state_version bigint,
  p_snapshot_fingerprint text,
  p_request_fingerprint text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO ''
AS $function$
DECLARE
  v_state public.turniq_offline_state%ROWTYPE;
  v_device public.turniq_offline_devices%ROWTYPE;
  v_receipt public.turniq_command_receipts%ROWTYPE;
  v_code text;
  v_conflict_id uuid;
  v_device_exists boolean := false;
BEGIN
  IF p_salon_id IS NULL OR p_device_id IS NULL OR p_device_generation IS NULL
     OR p_policy_version_id IS NULL OR p_command_id IS NULL
     OR p_local_sequence IS NULL OR p_local_sequence < 1
     OR p_expected_state_version IS NULL OR p_expected_state_version < 0
     OR p_snapshot_fingerprint !~ '^[0-9a-f]{64}$'
     OR p_request_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'domain_conflict');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('turniq-offline-command:' || p_command_id::text, 0)
  );

  SELECT * INTO v_receipt
  FROM public.turniq_command_receipts
  WHERE command_id = p_command_id;
  IF FOUND THEN
    IF v_receipt.salon_id = p_salon_id
       AND v_receipt.device_id = p_device_id
       AND v_receipt.local_sequence = p_local_sequence
       AND v_receipt.policy_version_id = p_policy_version_id
       AND v_receipt.request_fingerprint = p_request_fingerprint THEN
      RETURN pg_catalog.jsonb_build_object('ok', true, 'replay', true);
    END IF;
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'command_conflict');
  END IF;

  SELECT * INTO v_state
  FROM public.turniq_offline_state
  WHERE salon_id = p_salon_id
  FOR UPDATE;
  SELECT * INTO v_device
  FROM public.turniq_offline_devices
  WHERE salon_id = p_salon_id AND id = p_device_id
  FOR UPDATE;
  v_device_exists := FOUND;

  IF NOT v_device_exists OR v_device.status <> 'primary' THEN
    v_code := 'device_not_primary';
  ELSIF v_device.generation <> p_device_generation THEN
    v_code := 'device_generation_stale';
  ELSIF v_device.snapshot_policy_version_id IS DISTINCT FROM p_policy_version_id THEN
    v_code := 'stale_policy';
  ELSIF v_device.snapshot_fingerprint IS DISTINCT FROM p_snapshot_fingerprint THEN
    v_code := 'stale_snapshot';
  ELSIF p_local_sequence <> v_device.last_acked_sequence + 1 THEN
    v_code := 'sequence_gap';
  ELSIF p_expected_state_version <> v_state.state_version THEN
    v_code := 'stale_snapshot';
  END IF;

  IF v_code IS NOT NULL THEN
    -- A never-paired device has no parent lease row. Return the fail-closed
    -- result without trying to create a reconciliation row that would violate
    -- the (salon_id, device_id) foreign key. Revoked/stale known devices retain
    -- durable conflict evidence.
    IF v_device_exists THEN
      v_conflict_id := public.record_turniq_offline_conflict_v1(
        p_salon_id, p_device_id, p_device_generation, p_policy_version_id,
        p_command_id, p_local_sequence, v_code, p_expected_state_version,
        v_state.state_version, p_request_fingerprint,
        pg_catalog.jsonb_build_object('safe_action', 'refresh_and_reconcile')
      );
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'code', v_code, 'conflict_id', v_conflict_id
    );
  END IF;

  RETURN pg_catalog.jsonb_build_object('ok', true, 'replay', false);
END
$function$;

CREATE OR REPLACE FUNCTION public.ack_turniq_offline_command_v1(
  p_salon_id uuid,
  p_device_id uuid,
  p_device_generation bigint,
  p_local_sequence bigint,
  p_seen_at timestamptz
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO ''
AS $function$
DECLARE
  v_state_version bigint;
BEGIN
  UPDATE public.turniq_offline_devices
  SET last_acked_sequence = p_local_sequence,
      last_seen_at = coalesce(p_seen_at, transaction_timestamp()),
      updated_at = coalesce(p_seen_at, transaction_timestamp())
  WHERE salon_id = p_salon_id AND id = p_device_id
    AND generation = p_device_generation AND status = 'primary'
    AND last_acked_sequence + 1 = p_local_sequence;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'TurnIQ offline acknowledgement conflict';
  END IF;
  SELECT state_version INTO v_state_version
  FROM public.turniq_offline_state WHERE salon_id = p_salon_id;
  RETURN v_state_version;
END
$function$;

CREATE OR REPLACE FUNCTION public.apply_turniq_offline_walkin_command_v1(
  p_salon_id uuid,
  p_policy_version_id uuid,
  p_local_ticket_id uuid,
  p_service_id uuid,
  p_party_size integer,
  p_requested_staff_id uuid,
  p_command_id uuid,
  p_device_id uuid,
  p_device_generation bigint,
  p_local_sequence bigint,
  p_expected_state_version bigint,
  p_snapshot_fingerprint text,
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
  v_preflight jsonb;
  v_context jsonb;
  v_replay jsonb;
  v_booking_id uuid;
  v_price_cents integer;
  v_state_version bigint;
  v_result jsonb;
BEGIN
  IF p_local_ticket_id IS NULL OR p_service_id IS NULL
     OR p_party_size NOT BETWEEN 1 AND 12
     OR p_actor_role NOT IN ('owner', 'admin', 'senior', 'receptionist') THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'domain_conflict');
  END IF;

  v_preflight := public.preflight_turniq_offline_command_v1(
    p_salon_id, p_device_id, p_device_generation, p_policy_version_id,
    p_command_id, p_local_sequence, p_expected_state_version,
    p_snapshot_fingerprint, p_request_fingerprint
  );
  IF NOT coalesce((v_preflight->>'ok')::boolean, false) THEN
    RETURN v_preflight;
  END IF;

  IF coalesce((v_preflight->>'replay')::boolean, false) THEN
    v_replay := public.turniq_replay_online_command(
      p_command_id, p_salon_id, p_policy_version_id, p_actor_user_id,
      p_actor_role, 'walkin_intake', p_request_fingerprint
    );
    SELECT state_version INTO v_state_version
    FROM public.turniq_offline_state WHERE salon_id = p_salon_id;
    RETURN v_replay || pg_catalog.jsonb_build_object(
      'offline_state_version', v_state_version, 'offline_replayed', true
    );
  END IF;

  BEGIN
    v_context := public.turniq_online_context(
      p_salon_id, p_policy_version_id, p_actor_user_id, p_actor_role, p_occurred_at
    );
    PERFORM v_context;

    SELECT s.price_cents INTO v_price_cents
    FROM public.services s
    WHERE s.id = p_service_id AND s.salon_id = p_salon_id
      AND s.deleted_at IS NULL AND NOT s.is_addon
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'offline walk-in service unavailable';
    END IF;
    IF p_requested_staff_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.staff st
      WHERE st.id = p_requested_staff_id AND st.salon_id = p_salon_id
        AND st.status = 'active' AND st.deleted_at IS NULL
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'offline requested staff unavailable';
    END IF;

    INSERT INTO public.bookings (
      salon_id, service_id, staff_id, client_name, client_phone,
      status, price_cents, source, booking_channel, joined_queue_at,
      walkin_source, party_size, staff_requested_by_client, idempotency_key
    ) VALUES (
      p_salon_id, p_service_id, p_requested_staff_id,
      'Offline guest ' || pg_catalog.left(p_local_ticket_id::text, 8), null,
      'waiting', v_price_cents, 'walkin', 'walkin', p_occurred_at,
      'walk_in', p_party_size, p_requested_staff_id IS NOT NULL, p_command_id
    )
    RETURNING id INTO v_booking_id;

    v_result := pg_catalog.jsonb_build_object(
      'ok', true, 'command_id', p_command_id, 'replayed', false,
      'aggregate_id', v_booking_id, 'booking_id', v_booking_id,
      'local_ticket_id', p_local_ticket_id, 'status', 'waiting',
      'state_version', 1
    );
    PERFORM public.turniq_store_online_command(
      p_command_id, p_salon_id, p_policy_version_id, p_device_id,
      p_local_sequence, p_actor_user_id, p_actor_role, 'walkin_intake',
      p_request_fingerprint, 'committed', v_result, p_occurred_at
    );
    INSERT INTO public.turniq_events (
      salon_id, policy_version_id, command_id, aggregate_type, aggregate_id,
      aggregate_version, event_type, actor_user_id, actor_role, actor_ref,
      reason_code, request_fingerprint, payload, occurred_at
    ) VALUES (
      p_salon_id, p_policy_version_id, p_command_id, 'device', p_device_id,
      p_local_sequence, 'offline_walkin_intake_committed', p_actor_user_id,
      p_actor_role, 'user:' || p_actor_user_id::text, 'offline_walkin_intake',
      p_request_fingerprint,
      pg_catalog.jsonb_build_object(
        'booking_id', v_booking_id, 'local_ticket_id', p_local_ticket_id,
        'service_id', p_service_id, 'party_size', p_party_size,
        'identity_match_required', true
      ),
      p_occurred_at
    );
    v_state_version := public.ack_turniq_offline_command_v1(
      p_salon_id, p_device_id, p_device_generation, p_local_sequence, p_occurred_at
    );
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.record_turniq_offline_conflict_v1(
      p_salon_id, p_device_id, p_device_generation, p_policy_version_id,
      p_command_id, p_local_sequence, 'domain_conflict',
      p_expected_state_version,
      (SELECT state_version FROM public.turniq_offline_state WHERE salon_id = p_salon_id),
      p_request_fingerprint,
      pg_catalog.jsonb_build_object('safe_action', 'refresh_and_reconcile')
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'domain_conflict');
  END;

  RETURN v_result || pg_catalog.jsonb_build_object(
    'offline_state_version', v_state_version, 'offline_replayed', false
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.apply_turniq_offline_service_update_command_v1(
  p_salon_id uuid,
  p_policy_version_id uuid,
  p_assignment_id uuid,
  p_service_id uuid,
  p_addon_service_ids uuid[],
  p_command_id uuid,
  p_device_id uuid,
  p_device_generation bigint,
  p_local_sequence bigint,
  p_expected_state_version bigint,
  p_snapshot_fingerprint text,
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
  v_preflight jsonb;
  v_context jsonb;
  v_replay jsonb;
  v_assignment public.turniq_assignments%ROWTYPE;
  v_addon_id uuid;
  v_main_price integer;
  v_addon_price integer := 0;
  v_state_version bigint;
  v_result jsonb;
BEGIN
  IF p_assignment_id IS NULL OR p_service_id IS NULL
     OR p_addon_service_ids IS NULL
     OR pg_catalog.cardinality(p_addon_service_ids) > 1 THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'domain_conflict');
  END IF;

  v_preflight := public.preflight_turniq_offline_command_v1(
    p_salon_id, p_device_id, p_device_generation, p_policy_version_id,
    p_command_id, p_local_sequence, p_expected_state_version,
    p_snapshot_fingerprint, p_request_fingerprint
  );
  IF NOT coalesce((v_preflight->>'ok')::boolean, false) THEN
    RETURN v_preflight;
  END IF;

  IF coalesce((v_preflight->>'replay')::boolean, false) THEN
    v_replay := public.turniq_replay_online_command(
      p_command_id, p_salon_id, p_policy_version_id, p_actor_user_id,
      p_actor_role, 'service_update', p_request_fingerprint
    );
    SELECT state_version INTO v_state_version
    FROM public.turniq_offline_state WHERE salon_id = p_salon_id;
    RETURN v_replay || pg_catalog.jsonb_build_object(
      'offline_state_version', v_state_version, 'offline_replayed', true
    );
  END IF;

  BEGIN
    v_context := public.turniq_online_context(
      p_salon_id, p_policy_version_id, p_actor_user_id, p_actor_role, p_occurred_at
    );
    SELECT a.* INTO v_assignment
    FROM public.turniq_assignments a
    WHERE a.id = p_assignment_id AND a.salon_id = p_salon_id
      AND a.policy_version_id = p_policy_version_id
    FOR UPDATE;
    IF NOT FOUND OR v_assignment.status <> 'in_progress'
       OR v_assignment.booking_id IS NULL
       OR v_assignment.service_id IS DISTINCT FROM p_service_id THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'offline service update is not eligible';
    END IF;
    IF p_actor_role = 'nail_tech'
       AND nullif(v_context->>'actor_staff_id', '')::uuid
           IS DISTINCT FROM v_assignment.assigned_staff_id THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'technician may update only own active service';
    END IF;

    SELECT s.price_cents INTO v_main_price
    FROM public.services s
    WHERE s.id = p_service_id AND s.salon_id = p_salon_id
      AND s.deleted_at IS NULL AND NOT s.is_addon
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'offline main service unavailable';
    END IF;

    IF pg_catalog.cardinality(p_addon_service_ids) = 1 THEN
      v_addon_id := p_addon_service_ids[1];
      SELECT s.price_cents INTO v_addon_price
      FROM public.services s
      WHERE s.id = v_addon_id AND s.salon_id = p_salon_id
        AND s.deleted_at IS NULL AND s.is_addon
        AND s.duration_minutes = 0
      FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '55000',
          MESSAGE = 'timed add-ons require online schedule validation';
      END IF;
    END IF;

    UPDATE public.bookings b
    SET addon_service_id = v_addon_id,
        addon_price_cents = v_addon_price,
        local_updated_at = p_occurred_at
    WHERE b.id = v_assignment.booking_id AND b.salon_id = p_salon_id
      AND b.status = 'in_progress';
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'active booking changed while offline';
    END IF;

    UPDATE public.turniq_assignments a
    SET opportunity_credit_cents = v_main_price + v_addon_price,
        state_version = a.state_version + 1,
        updated_at = transaction_timestamp()
    WHERE a.id = p_assignment_id AND a.salon_id = p_salon_id
      AND a.state_version = v_assignment.state_version
    RETURNING * INTO v_assignment;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'assignment changed concurrently';
    END IF;

    v_result := pg_catalog.jsonb_build_object(
      'ok', true, 'command_id', p_command_id, 'replayed', false,
      'aggregate_id', v_assignment.id, 'assignment_id', v_assignment.id,
      'status', v_assignment.status, 'state_version', v_assignment.state_version,
      'fairness_receipt_id', null
    );
    PERFORM public.turniq_store_online_command(
      p_command_id, p_salon_id, p_policy_version_id, p_device_id,
      p_local_sequence, p_actor_user_id, p_actor_role, 'service_update',
      p_request_fingerprint, 'committed', v_result, p_occurred_at
    );
    INSERT INTO public.turniq_events (
      salon_id, policy_version_id, assignment_id, command_id, aggregate_type,
      aggregate_id, aggregate_version, event_type, actor_user_id, actor_role,
      actor_ref, reason_code, request_fingerprint, payload, occurred_at
    ) VALUES (
      p_salon_id, p_policy_version_id, v_assignment.id, p_command_id,
      'assignment', v_assignment.id, v_assignment.state_version,
      'offline_service_update_committed', p_actor_user_id, p_actor_role,
      'user:' || p_actor_user_id::text, 'offline_service_update',
      p_request_fingerprint,
      pg_catalog.jsonb_build_object(
        'service_id', p_service_id,
        'addon_service_ids', pg_catalog.to_jsonb(p_addon_service_ids),
        'opportunity_credit_cents', v_assignment.opportunity_credit_cents,
        'schedule_time_changed', false
      ),
      p_occurred_at
    );
    v_state_version := public.ack_turniq_offline_command_v1(
      p_salon_id, p_device_id, p_device_generation, p_local_sequence, p_occurred_at
    );
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.record_turniq_offline_conflict_v1(
      p_salon_id, p_device_id, p_device_generation, p_policy_version_id,
      p_command_id, p_local_sequence, 'domain_conflict',
      p_expected_state_version,
      (SELECT state_version FROM public.turniq_offline_state WHERE salon_id = p_salon_id),
      p_request_fingerprint,
      pg_catalog.jsonb_build_object('safe_action', 'refresh_and_reconcile')
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'domain_conflict');
  END;

  RETURN v_result || pg_catalog.jsonb_build_object(
    'offline_state_version', v_state_version, 'offline_replayed', false
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.apply_turniq_offline_shift_command_v1(
  p_salon_id uuid,
  p_policy_version_id uuid,
  p_staff_id uuid,
  p_command_type text,
  p_reason text,
  p_command_id uuid,
  p_device_id uuid,
  p_device_generation bigint,
  p_local_sequence bigint,
  p_expected_state_version bigint,
  p_snapshot_fingerprint text,
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
  v_preflight jsonb;
  v_result jsonb;
  v_state_version bigint;
BEGIN
  v_preflight := public.preflight_turniq_offline_command_v1(
    p_salon_id, p_device_id, p_device_generation, p_policy_version_id,
    p_command_id, p_local_sequence, p_expected_state_version,
    p_snapshot_fingerprint, p_request_fingerprint
  );
  IF NOT coalesce((v_preflight->>'ok')::boolean, false) THEN
    RETURN v_preflight;
  END IF;

  BEGIN
    v_result := public.apply_turniq_shift_command_v1(
      p_salon_id, p_policy_version_id, p_staff_id, p_command_type, p_reason,
      p_command_id, p_device_id, p_local_sequence, p_actor_user_id,
      p_actor_role, p_request_fingerprint, p_occurred_at
    );
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.record_turniq_offline_conflict_v1(
      p_salon_id, p_device_id, p_device_generation, p_policy_version_id,
      p_command_id, p_local_sequence, 'domain_conflict',
      p_expected_state_version,
      (SELECT state_version FROM public.turniq_offline_state WHERE salon_id = p_salon_id),
      p_request_fingerprint,
      pg_catalog.jsonb_build_object('safe_action', 'refresh_and_reconcile')
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'domain_conflict');
  END;

  IF NOT coalesce((v_preflight->>'replay')::boolean, false) THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.turniq_command_receipts r
      WHERE r.command_id = p_command_id AND r.salon_id = p_salon_id
        AND r.request_fingerprint = p_request_fingerprint
    ) THEN
      PERFORM public.record_turniq_offline_conflict_v1(
        p_salon_id, p_device_id, p_device_generation, p_policy_version_id,
        p_command_id, p_local_sequence, 'domain_conflict',
        p_expected_state_version,
        (SELECT state_version FROM public.turniq_offline_state WHERE salon_id = p_salon_id),
        p_request_fingerprint,
        pg_catalog.jsonb_build_object('safe_action', 'refresh_and_reconcile')
      );
      RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'domain_conflict');
    END IF;
    v_state_version := public.ack_turniq_offline_command_v1(
      p_salon_id, p_device_id, p_device_generation, p_local_sequence, p_occurred_at
    );
  ELSE
    SELECT state_version INTO v_state_version
    FROM public.turniq_offline_state WHERE salon_id = p_salon_id;
  END IF;

  RETURN v_result || pg_catalog.jsonb_build_object(
    'offline_state_version', v_state_version,
    'offline_replayed', coalesce((v_preflight->>'replay')::boolean, false)
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.apply_turniq_offline_assignment_command_v1(
  p_salon_id uuid,
  p_policy_version_id uuid,
  p_assignment_id uuid,
  p_command_type text,
  p_assigned_staff_id uuid,
  p_override_reason text,
  p_command_id uuid,
  p_device_id uuid,
  p_device_generation bigint,
  p_local_sequence bigint,
  p_expected_state_version bigint,
  p_snapshot_fingerprint text,
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
  v_preflight jsonb;
  v_result jsonb;
  v_state_version bigint;
BEGIN
  v_preflight := public.preflight_turniq_offline_command_v1(
    p_salon_id, p_device_id, p_device_generation, p_policy_version_id,
    p_command_id, p_local_sequence, p_expected_state_version,
    p_snapshot_fingerprint, p_request_fingerprint
  );
  IF NOT coalesce((v_preflight->>'ok')::boolean, false) THEN
    RETURN v_preflight;
  END IF;

  BEGIN
    IF p_command_type = 'complete' THEN
      v_result := public.complete_turniq_assignment_command_v2(
        p_salon_id, p_policy_version_id, p_assignment_id, p_command_id,
        p_device_id, p_local_sequence, p_actor_user_id, p_actor_role,
        p_request_fingerprint, p_occurred_at
      );
    ELSE
      v_result := public.apply_turniq_assignment_command_v1(
        p_salon_id, p_policy_version_id, p_assignment_id, p_command_type,
        p_assigned_staff_id, p_override_reason, p_command_id, p_device_id,
        p_local_sequence, p_actor_user_id, p_actor_role,
        p_request_fingerprint, p_occurred_at
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.record_turniq_offline_conflict_v1(
      p_salon_id, p_device_id, p_device_generation, p_policy_version_id,
      p_command_id, p_local_sequence, 'domain_conflict',
      p_expected_state_version,
      (SELECT state_version FROM public.turniq_offline_state WHERE salon_id = p_salon_id),
      p_request_fingerprint,
      pg_catalog.jsonb_build_object('safe_action', 'refresh_and_reconcile')
    );
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'domain_conflict');
  END;

  IF NOT coalesce((v_preflight->>'replay')::boolean, false) THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.turniq_command_receipts r
      WHERE r.command_id = p_command_id AND r.salon_id = p_salon_id
        AND r.request_fingerprint = p_request_fingerprint
    ) THEN
      PERFORM public.record_turniq_offline_conflict_v1(
        p_salon_id, p_device_id, p_device_generation, p_policy_version_id,
        p_command_id, p_local_sequence, 'domain_conflict',
        p_expected_state_version,
        (SELECT state_version FROM public.turniq_offline_state WHERE salon_id = p_salon_id),
        p_request_fingerprint,
        pg_catalog.jsonb_build_object('safe_action', 'refresh_and_reconcile')
      );
      RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'domain_conflict');
    END IF;
    v_state_version := public.ack_turniq_offline_command_v1(
      p_salon_id, p_device_id, p_device_generation, p_local_sequence, p_occurred_at
    );
  ELSE
    SELECT state_version INTO v_state_version
    FROM public.turniq_offline_state WHERE salon_id = p_salon_id;
  END IF;

  RETURN v_result || pg_catalog.jsonb_build_object(
    'offline_state_version', v_state_version,
    'offline_replayed', coalesce((v_preflight->>'replay')::boolean, false)
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.get_turniq_pilot_evidence_v1(
  p_salon_id uuid,
  p_business_date date,
  p_actor_user_id uuid,
  p_actor_role text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO ''
AS $function$
DECLARE
  v_timezone text;
  v_start timestamptz;
  v_end timestamptz;
  v_result jsonb;
BEGIN
  IF p_salon_id IS NULL OR p_business_date IS NULL OR p_actor_user_id IS NULL
     OR p_actor_role NOT IN ('owner', 'admin')
     OR NOT EXISTS (
       SELECT 1 FROM public.salon_members m
       WHERE m.salon_id = p_salon_id AND m.user_id = p_actor_user_id
         AND m.role = p_actor_role
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'TurnIQ pilot evidence requires owner/admin';
  END IF;

  SELECT s.timezone INTO v_timezone
  FROM public.salons s
  WHERE s.id = p_salon_id AND s.archived_at IS NULL
    AND coalesce(
      s.feature_flags -> 'turniq_trust_engine_enabled', 'false'::jsonb
    ) = 'true'::jsonb;
  IF NOT FOUND OR coalesce(length(pg_catalog.btrim(v_timezone)), 0) = 0 THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'TurnIQ is not enabled for salon';
  END IF;

  v_start := p_business_date::timestamp AT TIME ZONE v_timezone;
  v_end := (p_business_date + 1)::timestamp AT TIME ZONE v_timezone;

  WITH day_assignments AS (
    SELECT a.*
    FROM public.turniq_assignments a
    WHERE a.salon_id = p_salon_id
      AND a.decision_timestamp >= v_start AND a.decision_timestamp < v_end
  ),
  day_receipts AS (
    SELECT r.*
    FROM public.turniq_fairness_receipts r
    WHERE r.salon_id = p_salon_id
      AND r.created_at >= v_start AND r.created_at < v_end
  ),
  assignment_metrics AS (
    SELECT
      count(*)::integer AS recommendations,
      count(DISTINCT CASE
        WHEN booking_id IS NOT NULL THEN 'booking:' || booking_id::text
        ELSE 'request:' || customer_request_id::text
      END)
        FILTER (WHERE status = 'completed')::integer AS completed_customers,
      count(*) FILTER (WHERE confirmation_kind IS NOT NULL)::integer AS confirmed,
      count(*) FILTER (WHERE confirmation_kind = 'confirmed_recommendation')::integer AS accepted,
      count(*) FILTER (WHERE confirmation_kind = 'override')::integer AS overrides,
      (pg_catalog.percentile_cont(0.5) WITHIN GROUP (
        ORDER BY extract(epoch FROM (confirmed_at - decision_timestamp))
      ) FILTER (WHERE confirmed_at IS NOT NULL))::numeric AS median_assignment_seconds
    FROM day_assignments
  ),
  customer_waits AS (
    SELECT
      CASE
        WHEN a.booking_id IS NOT NULL THEN 'booking:' || a.booking_id::text
        ELSE 'request:' || a.customer_request_id::text
      END AS customer_key,
      pg_catalog.min(
        extract(epoch FROM (a.started_at - b.joined_queue_at)) / 60.0
      )::numeric AS wait_minutes
    FROM day_assignments a
    LEFT JOIN public.bookings b ON b.id = a.booking_id AND b.salon_id = a.salon_id
    WHERE b.joined_queue_at IS NOT NULL AND a.started_at IS NOT NULL
    GROUP BY CASE
      WHEN a.booking_id IS NOT NULL THEN 'booking:' || a.booking_id::text
      ELSE 'request:' || a.customer_request_id::text
    END
  ),
  wait_metrics AS (
    SELECT
      (pg_catalog.percentile_cont(0.5) WITHIN GROUP (
        ORDER BY wait_minutes
      ))::numeric AS wait_p50_minutes,
      (pg_catalog.percentile_cont(0.9) WITHIN GROUP (
        ORDER BY wait_minutes
      ))::numeric AS wait_p90_minutes
    FROM customer_waits
  ),
  walkin_metrics AS (
    SELECT
      count(*)::integer AS walkins_joined,
      count(*) FILTER (WHERE b.status = 'cancelled')::integer AS walkaways
    FROM public.bookings b
    WHERE b.salon_id = p_salon_id
      AND b.source = 'walkin'
      AND b.joined_queue_at >= v_start AND b.joined_queue_at < v_end
  ),
  opportunity AS (
    SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'staff_id', q.assigned_staff_id,
      'opportunity_credit_cents', q.credit_cents,
      'turns', q.turns
    ) ORDER BY q.assigned_staff_id), '[]'::jsonb) AS distribution,
    coalesce(pg_catalog.max(q.credit_cents) - pg_catalog.min(q.credit_cents), 0)::bigint AS spread_cents
    FROM (
      SELECT assigned_staff_id,
        pg_catalog.sum(opportunity_credit_cents)::bigint AS credit_cents,
        count(*)::integer AS turns
      FROM day_assignments
      WHERE status = 'completed' AND assigned_staff_id IS NOT NULL
      GROUP BY assigned_staff_id
    ) q
  ),
  request_sources AS (
    SELECT coalesce(pg_catalog.jsonb_object_agg(q.source, q.total), '{}'::jsonb) AS counts
    FROM (
      SELECT coalesce(requested_tech_source, 'none') AS source,
        count(*)::integer AS total
      FROM day_assignments
      GROUP BY coalesce(requested_tech_source, 'none')
    ) q
  ),
  trust_counts AS (
    SELECT
      (SELECT count(*)::integer FROM public.turniq_exceptions e
       WHERE e.salon_id = p_salon_id AND e.created_at >= v_start AND e.created_at < v_end) AS exceptions,
      (SELECT count(*)::integer FROM public.turniq_exceptions e
       WHERE e.salon_id = p_salon_id AND e.status IN ('open', 'acknowledged')) AS unresolved_exceptions,
      (SELECT count(*)::integer FROM public.turniq_disputes d
       WHERE d.salon_id = p_salon_id AND d.created_at >= v_start AND d.created_at < v_end) AS disputes,
      (SELECT count(*)::integer FROM public.turniq_disputes d
       WHERE d.salon_id = p_salon_id AND d.status IN ('open', 'under_review')) AS unresolved_disputes,
      (SELECT count(*)::integer FROM public.turniq_offline_reconciliations o
       WHERE o.salon_id = p_salon_id AND o.status = 'open') AS unresolved_offline_conflicts,
      (SELECT count(*)::integer FROM public.turniq_offline_reconciliations o
       WHERE o.salon_id = p_salon_id AND o.conflict_code = 'command_conflict'
         AND o.created_at >= v_start AND o.created_at < v_end) AS duplicate_command_conflicts
  ),
  receipt_metrics AS (
    SELECT count(*)::integer AS receipts,
      count(*) FILTER (WHERE r.actor_role NOT IN ('owner', 'admin'))::integer AS team_confirmed_without_owner,
      pg_catalog.sum(
        CASE WHEN r.actor_role IN ('owner', 'admin')
          THEN extract(epoch FROM (r.created_at - a.decision_timestamp))
          ELSE 0
        END
      )::numeric AS owner_decision_seconds_observed
    FROM day_receipts r
    LEFT JOIN day_assignments a ON a.id = r.assignment_id
  )
  SELECT pg_catalog.jsonb_build_object(
    'business_date', p_business_date,
    'targets_are_hypotheses', true,
    'recommendations', a.recommendations,
    'completed_customers', a.completed_customers,
    'confirmed_assignments', a.confirmed,
    'recommendation_acceptance_basis_points',
      CASE WHEN a.confirmed = 0 THEN null ELSE pg_catalog.round(a.accepted * 10000.0 / a.confirmed)::integer END,
    'overrides', a.overrides,
    'median_assignment_seconds', pg_catalog.round(a.median_assignment_seconds)::integer,
    'wait_p50_minutes', pg_catalog.round(w.wait_p50_minutes)::integer,
    'wait_p90_minutes', pg_catalog.round(w.wait_p90_minutes)::integer,
    'walkins_joined', x.walkins_joined,
    'walkaways', x.walkaways,
    'walkaway_rate_basis_points',
      CASE WHEN x.walkins_joined = 0 THEN null ELSE pg_catalog.round(x.walkaways * 10000.0 / x.walkins_joined)::integer END,
    'walkaway_rate_is_proxy', true,
    'fairness_receipts', r.receipts,
    'normal_turns_without_owner_basis_points',
      CASE WHEN r.receipts = 0 THEN null ELSE pg_catalog.round(r.team_confirmed_without_owner * 10000.0 / r.receipts)::integer END,
    'exceptions', t.exceptions,
    'unresolved_exceptions', t.unresolved_exceptions,
    'disputes', t.disputes,
    'unresolved_disputes', t.unresolved_disputes,
    'unresolved_offline_conflicts', t.unresolved_offline_conflicts,
    'duplicate_command_conflicts', t.duplicate_command_conflicts,
    'owner_decision_seconds_observed', pg_catalog.round(r.owner_decision_seconds_observed)::integer,
    'offline_loss_evidence_complete', false,
    'request_source_counts', s.counts,
    'opportunity_distribution', o.distribution,
    'opportunity_spread_cents', o.spread_cents
  ) INTO v_result
  FROM assignment_metrics a
  CROSS JOIN wait_metrics w
  CROSS JOIN opportunity o
  CROSS JOIN request_sources s
  CROSS JOIN trust_counts t
  CROSS JOIN receipt_metrics r
  CROSS JOIN walkin_metrics x;

  RETURN v_result;
END
$function$;

-- Rollback: restore the prior function definitions only if the M5/M6
-- migrations are also rolled back. Do not drop immutable TurnIQ evidence.
