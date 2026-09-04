-- TurnIQ staff PIN check-in for a shared salon device.
--
-- A PIN is an additional technician-presence check, not a replacement for the
-- authenticated salon session. Only Owner/Admin may configure a PIN. A valid
-- PIN may authorize check-in/out and break/return through the existing atomic
-- shift command, while a separate immutable receipt retains both the session
-- actor and the PIN-identified technician.
--
-- No plaintext PIN, reversible secret, notification or provider call is
-- stored or performed. This migration remains dormant while TurnIQ is OFF.
-- Rollback: keep TurnIQ OFF and stop calling the two RPCs. Preserve receipts as
-- evidence; do not drop them during an incident.

CREATE TABLE public.turniq_staff_pin_credentials (
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  staff_id uuid NOT NULL REFERENCES public.staff(id) ON DELETE CASCADE,
  pin_hash text NOT NULL CHECK (length(pin_hash) BETWEEN 20 AND 200),
  pin_version integer NOT NULL DEFAULT 1 CHECK (pin_version > 0),
  failed_attempts smallint NOT NULL DEFAULT 0
    CHECK (failed_attempts BETWEEN 0 AND 5),
  locked_until timestamptz,
  configured_by_user_id uuid NOT NULL
    REFERENCES auth.users(id) ON DELETE RESTRICT,
  configured_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.transaction_timestamp(),
  PRIMARY KEY (salon_id, staff_id)
);

CREATE INDEX turniq_staff_pin_credentials_staff_fk_idx
  ON public.turniq_staff_pin_credentials (staff_id);
CREATE INDEX turniq_staff_pin_credentials_actor_fk_idx
  ON public.turniq_staff_pin_credentials (configured_by_user_id);

CREATE TABLE public.turniq_staff_pin_configuration_receipts (
  command_id uuid PRIMARY KEY,
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  staff_id uuid NOT NULL REFERENCES public.staff(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  actor_role text NOT NULL CHECK (actor_role IN ('owner', 'admin')),
  pin_version integer NOT NULL CHECK (pin_version > 0),
  configured_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.transaction_timestamp()
);

CREATE INDEX turniq_staff_pin_config_salon_staff_idx
  ON public.turniq_staff_pin_configuration_receipts
    (salon_id, staff_id, configured_at DESC);
CREATE INDEX turniq_staff_pin_config_staff_fk_idx
  ON public.turniq_staff_pin_configuration_receipts (staff_id);
CREATE INDEX turniq_staff_pin_config_actor_fk_idx
  ON public.turniq_staff_pin_configuration_receipts (actor_user_id);

CREATE TABLE public.turniq_staff_pin_shift_receipts (
  command_id uuid PRIMARY KEY,
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  policy_version_id uuid NOT NULL,
  staff_id uuid NOT NULL REFERENCES public.staff(id) ON DELETE RESTRICT,
  session_actor_user_id uuid NOT NULL
    REFERENCES auth.users(id) ON DELETE RESTRICT,
  session_actor_role text NOT NULL CHECK (
    session_actor_role IN ('owner', 'admin', 'senior', 'receptionist', 'nail_tech')
  ),
  command_type text NOT NULL CHECK (
    command_type IN ('check_in', 'check_out', 'break', 'return')
  ),
  pin_version integer NOT NULL CHECK (pin_version > 0),
  request_fingerprint text NOT NULL
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  verified_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.transaction_timestamp(),
  FOREIGN KEY (salon_id, policy_version_id)
    REFERENCES public.turniq_policy_versions(salon_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (salon_id, command_id)
    REFERENCES public.turniq_command_receipts(salon_id, command_id)
      ON DELETE RESTRICT
);

CREATE INDEX turniq_staff_pin_shift_salon_staff_idx
  ON public.turniq_staff_pin_shift_receipts
    (salon_id, staff_id, verified_at DESC);
CREATE INDEX turniq_staff_pin_shift_policy_fk_idx
  ON public.turniq_staff_pin_shift_receipts (salon_id, policy_version_id);
CREATE INDEX turniq_staff_pin_shift_staff_fk_idx
  ON public.turniq_staff_pin_shift_receipts (staff_id);
CREATE INDEX turniq_staff_pin_shift_actor_fk_idx
  ON public.turniq_staff_pin_shift_receipts (session_actor_user_id);

CREATE OR REPLACE FUNCTION public.enforce_turniq_staff_pin_same_salon()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.staff AS st
    WHERE st.id = NEW.staff_id AND st.salon_id = NEW.salon_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23503',
      MESSAGE = 'TurnIQ PIN staff does not belong to salon';
  END IF;
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION public.enforce_turniq_staff_pin_same_salon()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER enforce_turniq_staff_pin_credential_salon
  BEFORE INSERT OR UPDATE ON public.turniq_staff_pin_credentials
  FOR EACH ROW EXECUTE FUNCTION public.enforce_turniq_staff_pin_same_salon();
CREATE TRIGGER enforce_turniq_staff_pin_config_salon
  BEFORE INSERT OR UPDATE ON public.turniq_staff_pin_configuration_receipts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_turniq_staff_pin_same_salon();
CREATE TRIGGER enforce_turniq_staff_pin_shift_salon
  BEFORE INSERT OR UPDATE ON public.turniq_staff_pin_shift_receipts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_turniq_staff_pin_same_salon();

CREATE TRIGGER reject_turniq_staff_pin_config_receipt_mutation
  BEFORE UPDATE OR DELETE ON public.turniq_staff_pin_configuration_receipts
  FOR EACH ROW EXECUTE FUNCTION public.reject_turniq_immutable_mutation();
CREATE TRIGGER reject_turniq_staff_pin_shift_receipt_mutation
  BEFORE UPDATE OR DELETE ON public.turniq_staff_pin_shift_receipts
  FOR EACH ROW EXECUTE FUNCTION public.reject_turniq_immutable_mutation();

ALTER TABLE public.turniq_staff_pin_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.turniq_staff_pin_credentials FORCE ROW LEVEL SECURITY;
ALTER TABLE public.turniq_staff_pin_configuration_receipts
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.turniq_staff_pin_configuration_receipts
  FORCE ROW LEVEL SECURITY;
ALTER TABLE public.turniq_staff_pin_shift_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.turniq_staff_pin_shift_receipts FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.turniq_staff_pin_credentials
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.turniq_staff_pin_configuration_receipts
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.turniq_staff_pin_shift_receipts
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.turniq_staff_pin_credentials
  TO service_role;
GRANT SELECT, INSERT ON TABLE public.turniq_staff_pin_configuration_receipts
  TO service_role;
GRANT SELECT, INSERT ON TABLE public.turniq_staff_pin_shift_receipts
  TO service_role;

CREATE OR REPLACE FUNCTION public.configure_turniq_staff_pin_v1(
  p_salon_id uuid,
  p_staff_id uuid,
  p_pin text,
  p_command_id uuid,
  p_actor_user_id uuid,
  p_actor_role text,
  p_occurred_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_prior public.turniq_staff_pin_configuration_receipts%ROWTYPE;
  v_pin_version integer;
BEGIN
  IF p_salon_id IS NULL OR p_staff_id IS NULL OR p_command_id IS NULL
     OR p_actor_user_id IS NULL OR p_occurred_at IS NULL
     OR p_pin IS NULL OR p_actor_role IS NULL
     OR p_actor_role NOT IN ('owner', 'admin')
     OR p_pin !~ '^[0-9]{4,8}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'invalid TurnIQ staff PIN configuration';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.salon_members AS m
    WHERE m.salon_id = p_salon_id
      AND m.user_id = p_actor_user_id
      AND m.role = p_actor_role
  ) THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'forbidden');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.salons AS s
    JOIN public.turniq_rollout_controls AS c ON c.salon_id = s.id
    WHERE s.id = p_salon_id
      AND s.archived_at IS NULL
      AND coalesce(
        s.feature_flags -> 'turniq_trust_engine_enabled',
        'false'::jsonb
      ) = 'true'::jsonb
      AND c.stage IN ('shadow', 'supervised', 'live')
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'code', 'feature_disabled'
    );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.staff AS st
    WHERE st.id = p_staff_id AND st.salon_id = p_salon_id
      AND st.status = 'active' AND st.deleted_at IS NULL
  ) THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'stale_state');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'turniq-pin-config:' || p_salon_id::text || ':' || p_staff_id::text,
      0
    )
  );
  SELECT r.* INTO v_prior
  FROM public.turniq_staff_pin_configuration_receipts AS r
  WHERE r.command_id = p_command_id;
  IF FOUND THEN
    IF v_prior.salon_id IS DISTINCT FROM p_salon_id
       OR v_prior.staff_id IS DISTINCT FROM p_staff_id
       OR v_prior.actor_user_id IS DISTINCT FROM p_actor_user_id
       OR v_prior.actor_role IS DISTINCT FROM p_actor_role THEN
      RAISE EXCEPTION USING ERRCODE = '23505',
        MESSAGE = 'TurnIQ staff PIN configuration command conflict';
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'ok', true,
      'command_id', v_prior.command_id,
      'staff_id', v_prior.staff_id,
      'pin_version', v_prior.pin_version,
      'configured_at', v_prior.configured_at,
      'replayed', true
    );
  END IF;

  INSERT INTO public.turniq_staff_pin_credentials (
    salon_id, staff_id, pin_hash, pin_version, failed_attempts, locked_until,
    configured_by_user_id, configured_at, updated_at
  ) VALUES (
    p_salon_id, p_staff_id,
    extensions.crypt(p_pin, extensions.gen_salt('bf', 12)),
    1, 0, NULL, p_actor_user_id, p_occurred_at,
    pg_catalog.transaction_timestamp()
  )
  ON CONFLICT (salon_id, staff_id) DO UPDATE
  SET pin_hash = extensions.crypt(p_pin, extensions.gen_salt('bf', 12)),
      pin_version = public.turniq_staff_pin_credentials.pin_version + 1,
      failed_attempts = 0,
      locked_until = NULL,
      configured_by_user_id = EXCLUDED.configured_by_user_id,
      configured_at = EXCLUDED.configured_at,
      updated_at = pg_catalog.transaction_timestamp()
  RETURNING pin_version INTO v_pin_version;

  INSERT INTO public.turniq_staff_pin_configuration_receipts (
    command_id, salon_id, staff_id, actor_user_id, actor_role, pin_version,
    configured_at
  ) VALUES (
    p_command_id, p_salon_id, p_staff_id, p_actor_user_id, p_actor_role,
    v_pin_version, p_occurred_at
  );

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'command_id', p_command_id,
    'staff_id', p_staff_id,
    'pin_version', v_pin_version,
    'configured_at', p_occurred_at,
    'replayed', false
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.apply_turniq_staff_pin_shift_command_v1(
  p_salon_id uuid,
  p_policy_version_id uuid,
  p_staff_id uuid,
  p_pin text,
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
SET search_path = ''
AS $function$
DECLARE
  v_context jsonb;
  v_credential public.turniq_staff_pin_credentials%ROWTYPE;
  v_prior public.turniq_staff_pin_shift_receipts%ROWTYPE;
  v_prior_result jsonb;
  v_failed_attempts smallint;
  v_result jsonb;
BEGIN
  IF p_salon_id IS NULL OR p_policy_version_id IS NULL OR p_staff_id IS NULL
     OR p_command_id IS NULL OR p_device_id IS NULL OR p_actor_user_id IS NULL
     OR p_occurred_at IS NULL OR p_local_sequence IS NULL
     OR p_local_sequence <= 0 OR p_pin IS NULL OR p_actor_role IS NULL
     OR p_command_type IS NULL OR p_request_fingerprint IS NULL
     OR p_actor_role NOT IN (
       'owner', 'admin', 'senior', 'receptionist', 'nail_tech'
     )
     OR p_command_type NOT IN ('check_in', 'check_out', 'break', 'return')
     OR p_pin !~ '^[0-9]{4,8}$'
     OR p_request_fingerprint !~ '^[0-9a-f]{64}$'
     OR (
       p_command_type = 'break'
       AND coalesce(length(pg_catalog.btrim(p_reason)), 0) NOT BETWEEN 1 AND 500
     )
     OR (p_command_type <> 'break' AND p_reason IS NOT NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'invalid TurnIQ staff PIN shift command';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('turniq-command:' || p_command_id::text, 0)
  );
  SELECT pr.* INTO v_prior
  FROM public.turniq_staff_pin_shift_receipts AS pr
  WHERE pr.command_id = p_command_id;
  IF FOUND THEN
    SELECT cr.result INTO STRICT v_prior_result
    FROM public.turniq_command_receipts AS cr
    WHERE cr.salon_id = v_prior.salon_id
      AND cr.command_id = v_prior.command_id;
    IF v_prior.salon_id IS DISTINCT FROM p_salon_id
       OR v_prior.policy_version_id IS DISTINCT FROM p_policy_version_id
       OR v_prior.staff_id IS DISTINCT FROM p_staff_id
       OR v_prior.session_actor_user_id IS DISTINCT FROM p_actor_user_id
       OR v_prior.session_actor_role IS DISTINCT FROM p_actor_role
       OR v_prior.command_type IS DISTINCT FROM p_command_type
       OR v_prior.request_fingerprint IS DISTINCT FROM p_request_fingerprint THEN
      RAISE EXCEPTION USING ERRCODE = '23505',
        MESSAGE = 'TurnIQ staff PIN shift command conflict';
    END IF;
    RETURN v_prior_result || pg_catalog.jsonb_build_object('replayed', true);
  END IF;

  v_context := public.turniq_online_context(
    p_salon_id, p_policy_version_id, p_actor_user_id, p_actor_role,
    p_occurred_at
  );
  PERFORM public.assert_turniq_supervised_online_v1(p_salon_id);
  IF p_actor_role = 'nail_tech'
     AND nullif(v_context ->> 'actor_staff_id', '')::uuid
       IS DISTINCT FROM p_staff_id THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'forbidden');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'turniq-pin-check:' || p_salon_id::text || ':' || p_staff_id::text,
      0
    )
  );
  SELECT c.* INTO v_credential
  FROM public.turniq_staff_pin_credentials AS c
  WHERE c.salon_id = p_salon_id AND c.staff_id = p_staff_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'invalid_pin');
  END IF;
  IF v_credential.locked_until IS NOT NULL
     AND v_credential.locked_until > pg_catalog.transaction_timestamp() THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'pin_locked');
  END IF;

  IF v_credential.pin_hash IS DISTINCT FROM
      extensions.crypt(p_pin, v_credential.pin_hash) THEN
    v_failed_attempts := LEAST(
      5,
      (v_credential.failed_attempts + 1)::integer
    )::smallint;
    UPDATE public.turniq_staff_pin_credentials AS c
    SET failed_attempts = v_failed_attempts,
        locked_until = CASE WHEN v_failed_attempts >= 5
          THEN pg_catalog.transaction_timestamp() + interval '10 minutes'
          ELSE NULL END,
        updated_at = pg_catalog.transaction_timestamp()
    WHERE c.salon_id = p_salon_id AND c.staff_id = p_staff_id;
    RETURN pg_catalog.jsonb_build_object(
      'ok', false,
      'code', CASE WHEN v_failed_attempts >= 5
        THEN 'pin_locked' ELSE 'invalid_pin' END
    );
  END IF;

  UPDATE public.turniq_staff_pin_credentials AS c
  SET failed_attempts = 0,
      locked_until = NULL,
      updated_at = pg_catalog.transaction_timestamp()
  WHERE c.salon_id = p_salon_id AND c.staff_id = p_staff_id;

  v_result := public.apply_turniq_shift_command_v1(
    p_salon_id, p_policy_version_id, p_staff_id, p_command_type, p_reason,
    p_command_id, p_device_id, p_local_sequence, p_actor_user_id,
    p_actor_role, p_request_fingerprint, p_occurred_at
  );

  INSERT INTO public.turniq_staff_pin_shift_receipts (
    command_id, salon_id, policy_version_id, staff_id,
    session_actor_user_id, session_actor_role, command_type, pin_version,
    request_fingerprint, verified_at
  ) VALUES (
    p_command_id, p_salon_id, p_policy_version_id, p_staff_id,
    p_actor_user_id, p_actor_role, p_command_type, v_credential.pin_version,
    p_request_fingerprint, p_occurred_at
  );
  RETURN v_result;
END
$function$;

REVOKE ALL ON FUNCTION public.configure_turniq_staff_pin_v1(
  uuid, uuid, text, uuid, uuid, text, timestamptz
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.configure_turniq_staff_pin_v1(
  uuid, uuid, text, uuid, uuid, text, timestamptz
) TO service_role;

REVOKE ALL ON FUNCTION public.apply_turniq_staff_pin_shift_command_v1(
  uuid, uuid, uuid, text, text, text, uuid, uuid, bigint, uuid, text, text,
  timestamptz
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_turniq_staff_pin_shift_command_v1(
  uuid, uuid, uuid, text, text, text, uuid, uuid, bigint, uuid, text, text,
  timestamptz
) TO service_role;

COMMENT ON TABLE public.turniq_staff_pin_credentials IS
  'Private bcrypt-hashed technician PIN credentials with bounded lockout. No browser role has direct access.';
COMMENT ON TABLE public.turniq_staff_pin_configuration_receipts IS
  'Immutable Owner/Admin attribution for TurnIQ staff PIN setup and rotation.';
COMMENT ON TABLE public.turniq_staff_pin_shift_receipts IS
  'Immutable link between the authenticated shared-device session and the PIN-identified technician shift command.';
COMMENT ON FUNCTION public.configure_turniq_staff_pin_v1(
  uuid, uuid, text, uuid, uuid, text, timestamptz
) IS 'Service-role-only Owner/Admin PIN setup. Stores only a bcrypt hash and immutable configuration receipt.';
COMMENT ON FUNCTION public.apply_turniq_staff_pin_shift_command_v1(
  uuid, uuid, uuid, text, text, text, uuid, uuid, bigint, uuid, text, text,
  timestamptz
) IS 'Service-role-only shared-device PIN check-in/out and break/return wrapper around the existing atomic TurnIQ shift command.';
