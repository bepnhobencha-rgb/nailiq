-- TurnIQ M5: exactly one owner-designated primary offline device per salon.
-- Additive and dormant: the existing TurnIQ feature flag remains default OFF,
-- and no salon/device is enabled by this migration.

CREATE TABLE public.turniq_offline_state (
  salon_id uuid PRIMARY KEY REFERENCES public.salons(id) ON DELETE CASCADE,
  state_version bigint NOT NULL DEFAULT 0 CHECK (state_version >= 0),
  device_generation bigint NOT NULL DEFAULT 0 CHECK (device_generation >= 0),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE TABLE public.turniq_offline_devices (
  id uuid NOT NULL,
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  generation bigint NOT NULL CHECK (generation > 0),
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 100),
  status text NOT NULL CHECK (status IN ('primary', 'revoked')),
  paired_by_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  paired_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  revoked_by_user_id uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  revoked_at timestamptz,
  revoke_reason text,
  last_acked_sequence bigint NOT NULL DEFAULT 0 CHECK (last_acked_sequence >= 0),
  snapshot_policy_version_id uuid,
  snapshot_state_version bigint CHECK (snapshot_state_version >= 0),
  snapshot_fingerprint text CHECK (
    snapshot_fingerprint IS NULL OR snapshot_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  snapshot_captured_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (salon_id, id),
  FOREIGN KEY (salon_id, snapshot_policy_version_id)
    REFERENCES public.turniq_policy_versions(salon_id, id) ON DELETE RESTRICT,
  CONSTRAINT turniq_offline_device_snapshot_check CHECK (
    (snapshot_policy_version_id IS NULL
      AND snapshot_state_version IS NULL
      AND snapshot_fingerprint IS NULL
      AND snapshot_captured_at IS NULL)
    OR
    (snapshot_policy_version_id IS NOT NULL
      AND snapshot_state_version IS NOT NULL
      AND snapshot_fingerprint IS NOT NULL
      AND snapshot_captured_at IS NOT NULL)
  ),
  CONSTRAINT turniq_offline_device_revocation_check CHECK (
    (status = 'primary'
      AND revoked_by_user_id IS NULL
      AND revoked_at IS NULL
      AND revoke_reason IS NULL)
    OR
    (status = 'revoked'
      AND revoked_by_user_id IS NOT NULL
      AND revoked_at IS NOT NULL
      AND length(btrim(revoke_reason)) BETWEEN 1 AND 500)
  )
);

CREATE UNIQUE INDEX turniq_one_primary_offline_device_idx
  ON public.turniq_offline_devices (salon_id)
  WHERE status = 'primary';
CREATE UNIQUE INDEX turniq_offline_device_generation_idx
  ON public.turniq_offline_devices (salon_id, generation);
CREATE INDEX turniq_offline_device_status_idx
  ON public.turniq_offline_devices (salon_id, status, updated_at DESC);
CREATE INDEX turniq_offline_device_paired_by_idx
  ON public.turniq_offline_devices (paired_by_user_id);
CREATE INDEX turniq_offline_device_revoked_by_idx
  ON public.turniq_offline_devices (revoked_by_user_id)
  WHERE revoked_by_user_id IS NOT NULL;
CREATE INDEX turniq_offline_device_snapshot_policy_fk_idx
  ON public.turniq_offline_devices (salon_id, snapshot_policy_version_id)
  WHERE snapshot_policy_version_id IS NOT NULL;

CREATE TABLE public.turniq_offline_reconciliations (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  device_generation bigint NOT NULL CHECK (device_generation > 0),
  command_id uuid NOT NULL,
  local_sequence bigint NOT NULL CHECK (local_sequence > 0),
  policy_version_id uuid NOT NULL,
  conflict_code text NOT NULL CHECK (
    conflict_code IN (
      'device_not_primary', 'device_generation_stale', 'sequence_gap',
      'stale_snapshot', 'stale_policy', 'command_conflict',
      'domain_conflict', 'storage_corrupt'
    )
  ),
  expected_state_version bigint CHECK (expected_state_version >= 0),
  actual_state_version bigint CHECK (actual_state_version >= 0),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  resolved_at timestamptz,
  resolved_by_user_id uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  resolution_reason text,
  FOREIGN KEY (salon_id, device_id)
    REFERENCES public.turniq_offline_devices(salon_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (salon_id, policy_version_id)
    REFERENCES public.turniq_policy_versions(salon_id, id) ON DELETE RESTRICT,
  UNIQUE (salon_id, command_id),
  CONSTRAINT turniq_offline_reconciliation_resolution_check CHECK (
    (status = 'open'
      AND resolved_at IS NULL
      AND resolved_by_user_id IS NULL
      AND resolution_reason IS NULL)
    OR
    (status IN ('resolved', 'dismissed')
      AND resolved_at IS NOT NULL
      AND resolved_by_user_id IS NOT NULL
      AND length(btrim(resolution_reason)) BETWEEN 1 AND 500)
  )
);

CREATE INDEX turniq_offline_reconciliation_open_idx
  ON public.turniq_offline_reconciliations (salon_id, created_at, id)
  WHERE status = 'open';
CREATE INDEX turniq_offline_reconciliation_device_idx
  ON public.turniq_offline_reconciliations
    (salon_id, device_id, local_sequence DESC);
CREATE INDEX turniq_offline_reconciliation_policy_fk_idx
  ON public.turniq_offline_reconciliations (salon_id, policy_version_id);
CREATE INDEX turniq_offline_reconciliation_resolved_by_idx
  ON public.turniq_offline_reconciliations (resolved_by_user_id)
  WHERE resolved_by_user_id IS NOT NULL;

-- Existing receipts form the initial monotonic salon state. Every future
-- committed TurnIQ command advances it exactly once, in the same transaction.
INSERT INTO public.turniq_offline_state (salon_id, state_version)
SELECT s.id, count(r.command_id)::bigint
FROM public.salons s
LEFT JOIN public.turniq_command_receipts r ON r.salon_id = s.id
GROUP BY s.id;

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

REVOKE ALL ON FUNCTION public.advance_turniq_offline_state_version()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER advance_turniq_offline_state_on_command
  AFTER INSERT ON public.turniq_command_receipts
  FOR EACH ROW EXECUTE FUNCTION public.advance_turniq_offline_state_version();

ALTER TABLE public.turniq_command_receipts
  DROP CONSTRAINT turniq_command_receipts_command_type_check,
  ADD CONSTRAINT turniq_command_receipts_command_type_check CHECK (
    command_type IN (
      'check_in', 'check_out', 'break', 'return', 'hold', 'release_hold',
      'recommend', 'confirm', 'override', 'start', 'complete',
      'add_service', 'service_update', 'walkin_intake', 'swap', 'correction',
      'refuse', 'redo', 'dispute', 'resolve_dispute',
      'acknowledge_exception', 'resolve_exception', 'dismiss_exception',
      'recommend_group', 'confirm_group'
    )
  );

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

ALTER TABLE public.turniq_offline_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.turniq_offline_state FORCE ROW LEVEL SECURITY;
ALTER TABLE public.turniq_offline_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.turniq_offline_devices FORCE ROW LEVEL SECURITY;
ALTER TABLE public.turniq_offline_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.turniq_offline_reconciliations FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
  public.turniq_offline_state,
  public.turniq_offline_devices,
  public.turniq_offline_reconciliations
FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT, INSERT, UPDATE ON TABLE
  public.turniq_offline_state,
  public.turniq_offline_devices,
  public.turniq_offline_reconciliations
TO service_role;

REVOKE ALL ON FUNCTION public.pair_turniq_primary_offline_device_v1(uuid, uuid, text, uuid, text, timestamptz)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.revoke_turniq_primary_offline_device_v1(uuid, uuid, uuid, text, text, timestamptz)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.inspect_turniq_offline_device_v1(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_turniq_offline_snapshot_v1(uuid, uuid, bigint, uuid, text, uuid, text, timestamptz)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_turniq_offline_conflict_v1(uuid, uuid, bigint, uuid, uuid, bigint, text, bigint, bigint, text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.resolve_turniq_offline_reconciliation_v1(uuid, uuid, uuid, uuid, text, text, timestamptz)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.preflight_turniq_offline_command_v1(uuid, uuid, bigint, uuid, uuid, bigint, bigint, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ack_turniq_offline_command_v1(uuid, uuid, bigint, bigint, timestamptz)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apply_turniq_offline_shift_command_v1(uuid, uuid, uuid, text, text, uuid, uuid, bigint, bigint, bigint, text, uuid, text, text, timestamptz)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apply_turniq_offline_assignment_command_v1(uuid, uuid, uuid, text, uuid, text, uuid, uuid, bigint, bigint, bigint, text, uuid, text, text, timestamptz)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apply_turniq_offline_walkin_command_v1(uuid, uuid, uuid, uuid, integer, uuid, uuid, uuid, bigint, bigint, bigint, text, uuid, text, text, timestamptz)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apply_turniq_offline_service_update_command_v1(uuid, uuid, uuid, uuid, uuid[], uuid, uuid, bigint, bigint, bigint, text, uuid, text, text, timestamptz)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.pair_turniq_primary_offline_device_v1(uuid, uuid, text, uuid, text, timestamptz)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.revoke_turniq_primary_offline_device_v1(uuid, uuid, uuid, text, text, timestamptz)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.inspect_turniq_offline_device_v1(uuid, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.sync_turniq_offline_snapshot_v1(uuid, uuid, bigint, uuid, text, uuid, text, timestamptz)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.preflight_turniq_offline_command_v1(uuid, uuid, bigint, uuid, uuid, bigint, bigint, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.ack_turniq_offline_command_v1(uuid, uuid, bigint, bigint, timestamptz)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.record_turniq_offline_conflict_v1(uuid, uuid, bigint, uuid, uuid, bigint, text, bigint, bigint, text, jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.resolve_turniq_offline_reconciliation_v1(uuid, uuid, uuid, uuid, text, text, timestamptz)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.apply_turniq_offline_shift_command_v1(uuid, uuid, uuid, text, text, uuid, uuid, bigint, bigint, bigint, text, uuid, text, text, timestamptz)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.apply_turniq_offline_assignment_command_v1(uuid, uuid, uuid, text, uuid, text, uuid, uuid, bigint, bigint, bigint, text, uuid, text, text, timestamptz)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.apply_turniq_offline_walkin_command_v1(uuid, uuid, uuid, uuid, integer, uuid, uuid, uuid, bigint, bigint, bigint, text, uuid, text, text, timestamptz)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.apply_turniq_offline_service_update_command_v1(uuid, uuid, uuid, uuid, uuid[], uuid, uuid, bigint, bigint, bigint, text, uuid, text, text, timestamptz)
  TO service_role;

COMMENT ON TABLE public.turniq_offline_devices IS
  'Owner-designated TurnIQ Primary Offline Device leases. At most one primary per salon; replacement is audited and old generations cannot replay.';
COMMENT ON TABLE public.turniq_offline_state IS
  'Monotonic salon TurnIQ command version used to detect offline divergence.';
COMMENT ON TABLE public.turniq_offline_reconciliations IS
  'Explicit offline conflicts. They are reviewed; neither client nor server state is silently overwritten.';

-- Rollback boundary: revoke every primary device and leave these dormant
-- evidence tables in place. Never drop command/event/receipt history during an
-- operational rollback.
