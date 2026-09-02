-- TurnIQ M4M customer check-in capability and shadow ledger.
--
-- Additive and inert while salons.feature_flags.turniq_trust_engine_enabled is
-- absent/false. The capability authorizes only a PII-free shadow intake
-- receipt. It cannot create or mutate a booking, assignment, shift, resource,
-- notification, payment, or provider operation.
--
-- Rollback boundary: stop issuing capabilities and keep the salon flag OFF.
-- Preserve receipts as audit evidence. Revoking active capabilities is safe;
-- do not drop the append-only ledger during an incident.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE public.turniq_customer_checkin_capabilities (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  booking_id uuid REFERENCES public.bookings(id) ON DELETE RESTRICT,
  service_id uuid REFERENCES public.services(id) ON DELETE RESTRICT,
  channel text NOT NULL CHECK (channel IN ('qr', 'kiosk')),
  visit_kind text NOT NULL CHECK (visit_kind IN ('booked', 'walkin')),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  max_uses integer NOT NULL CHECK (max_uses BETWEEN 1 AND 500),
  use_count integer NOT NULL DEFAULT 0 CHECK (use_count BETWEEN 0 AND max_uses),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by_user_id uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  issued_by_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT turniq_customer_checkin_capability_subject_check CHECK (
    (visit_kind = 'booked' AND booking_id IS NOT NULL AND service_id IS NOT NULL)
    OR (visit_kind = 'walkin' AND booking_id IS NULL)
  ),
  CONSTRAINT turniq_customer_checkin_capability_revocation_check CHECK (
    (revoked_at IS NULL AND revoked_by_user_id IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by_user_id IS NOT NULL)
  ),
  UNIQUE (salon_id, id)
);

CREATE INDEX turniq_checkin_capability_active_idx
  ON public.turniq_customer_checkin_capabilities (salon_id, expires_at)
  WHERE revoked_at IS NULL;
CREATE INDEX turniq_checkin_capability_booking_fk_idx
  ON public.turniq_customer_checkin_capabilities (salon_id, booking_id)
  WHERE booking_id IS NOT NULL;
CREATE INDEX turniq_checkin_capability_service_fk_idx
  ON public.turniq_customer_checkin_capabilities (salon_id, service_id)
  WHERE service_id IS NOT NULL;

CREATE TABLE public.turniq_customer_checkin_receipts (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  capability_id uuid NOT NULL,
  command_id uuid NOT NULL,
  booking_id uuid REFERENCES public.bookings(id) ON DELETE RESTRICT,
  service_id uuid NOT NULL REFERENCES public.services(id) ON DELETE RESTRICT,
  channel text NOT NULL CHECK (channel IN ('qr', 'kiosk')),
  visit_kind text NOT NULL CHECK (visit_kind IN ('booked', 'walkin')),
  party_size integer NOT NULL CHECK (party_size BETWEEN 1 AND 12),
  actor_ref text NOT NULL CHECK (actor_ref ~ '^[0-9a-f]{64}$'),
  requested_staff_id uuid REFERENCES public.staff(id) ON DELETE RESTRICT,
  requested_tech_source text CHECK (
    requested_tech_source IS NULL OR requested_tech_source = 'customer_selected'
  ),
  request_trust_label text CHECK (
    request_trust_label IS NULL OR request_trust_label = 'customer_confirmed'
  ),
  next_route text NOT NULL CHECK (
    next_route IN (
      'single_engine_candidate', 'group_optimizer_required',
      'requested_tech_validation', 'identity_match_required'
    )
  ),
  reason_codes jsonb NOT NULL CHECK (jsonb_typeof(reason_codes) = 'array'),
  intake_fingerprint text NOT NULL CHECK (intake_fingerprint ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'shadow_received'
    CHECK (status = 'shadow_received'),
  submitted_at timestamptz NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT turniq_customer_checkin_receipt_request_check CHECK (
    (requested_staff_id IS NULL
      AND requested_tech_source IS NULL
      AND request_trust_label IS NULL)
    OR (requested_staff_id IS NOT NULL
      AND requested_tech_source = 'customer_selected'
      AND request_trust_label = 'customer_confirmed')
  ),
  FOREIGN KEY (salon_id, capability_id)
    REFERENCES public.turniq_customer_checkin_capabilities(salon_id, id)
    ON DELETE RESTRICT,
  UNIQUE (salon_id, id),
  UNIQUE (salon_id, command_id)
);

CREATE INDEX turniq_checkin_receipt_committed_idx
  ON public.turniq_customer_checkin_receipts (salon_id, committed_at DESC);
CREATE INDEX turniq_checkin_receipt_capability_fk_idx
  ON public.turniq_customer_checkin_receipts (salon_id, capability_id);
CREATE INDEX turniq_checkin_receipt_booking_fk_idx
  ON public.turniq_customer_checkin_receipts (salon_id, booking_id)
  WHERE booking_id IS NOT NULL;
CREATE INDEX turniq_checkin_receipt_service_fk_idx
  ON public.turniq_customer_checkin_receipts (salon_id, service_id);
CREATE INDEX turniq_checkin_receipt_requested_staff_fk_idx
  ON public.turniq_customer_checkin_receipts (salon_id, requested_staff_id)
  WHERE requested_staff_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.enforce_turniq_customer_checkin_same_salon()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO ''
AS $function$
BEGIN
  IF TG_TABLE_NAME = 'turniq_customer_checkin_capabilities' THEN
    IF NEW.service_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.services s
      WHERE s.id = NEW.service_id AND s.salon_id = NEW.salon_id
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'TurnIQ check-in capability service must belong to salon';
    END IF;
    IF NEW.booking_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.bookings b
      WHERE b.id = NEW.booking_id AND b.salon_id = NEW.salon_id
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'TurnIQ check-in capability booking must belong to salon';
    END IF;
  ELSIF TG_TABLE_NAME = 'turniq_customer_checkin_receipts' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.turniq_customer_checkin_capabilities c
      WHERE c.id = NEW.capability_id
        AND c.salon_id = NEW.salon_id
        AND c.booking_id IS NOT DISTINCT FROM NEW.booking_id
        AND (c.service_id IS NULL OR c.service_id = NEW.service_id)
        AND c.channel = NEW.channel
        AND c.visit_kind = NEW.visit_kind
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'TurnIQ check-in receipt capability context mismatch';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.services s
      WHERE s.id = NEW.service_id AND s.salon_id = NEW.salon_id
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'TurnIQ check-in receipt service must belong to salon';
    END IF;
    IF NEW.booking_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.bookings b
      WHERE b.id = NEW.booking_id AND b.salon_id = NEW.salon_id
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'TurnIQ check-in receipt booking must belong to salon';
    END IF;
    IF NEW.requested_staff_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.staff s
      WHERE s.id = NEW.requested_staff_id AND s.salon_id = NEW.salon_id
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'TurnIQ check-in receipt requested staff must belong to salon';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.guard_turniq_customer_checkin_capability_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO ''
AS $function$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.salon_id IS DISTINCT FROM OLD.salon_id
     OR NEW.booking_id IS DISTINCT FROM OLD.booking_id
     OR NEW.service_id IS DISTINCT FROM OLD.service_id
     OR NEW.channel IS DISTINCT FROM OLD.channel
     OR NEW.visit_kind IS DISTINCT FROM OLD.visit_kind
     OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.max_uses IS DISTINCT FROM OLD.max_uses
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.issued_by_user_id IS DISTINCT FROM OLD.issued_by_user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.use_count < OLD.use_count
     OR NEW.use_count > OLD.use_count + 1 THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'TurnIQ check-in capability immutable material cannot change';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND (
       NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
       OR NEW.revoked_by_user_id IS DISTINCT FROM OLD.revoked_by_user_id
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'TurnIQ check-in capability revocation is irreversible';
  END IF;
  IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
     AND NEW.revoked_by_user_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'TurnIQ check-in capability revocation requires an actor';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER enforce_turniq_customer_checkin_capability_salon
  BEFORE INSERT OR UPDATE ON public.turniq_customer_checkin_capabilities
  FOR EACH ROW EXECUTE FUNCTION public.enforce_turniq_customer_checkin_same_salon();
CREATE TRIGGER guard_turniq_customer_checkin_capability_update
  BEFORE UPDATE ON public.turniq_customer_checkin_capabilities
  FOR EACH ROW EXECUTE FUNCTION public.guard_turniq_customer_checkin_capability_update();
CREATE TRIGGER enforce_turniq_customer_checkin_receipt_salon
  BEFORE INSERT ON public.turniq_customer_checkin_receipts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_turniq_customer_checkin_same_salon();

CREATE TRIGGER reject_turniq_customer_checkin_receipt_mutation
  BEFORE UPDATE OR DELETE ON public.turniq_customer_checkin_receipts
  FOR EACH ROW EXECUTE FUNCTION public.reject_turniq_immutable_mutation();

ALTER TABLE public.turniq_customer_checkin_capabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.turniq_customer_checkin_capabilities FORCE ROW LEVEL SECURITY;
ALTER TABLE public.turniq_customer_checkin_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.turniq_customer_checkin_receipts FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
  public.turniq_customer_checkin_capabilities,
  public.turniq_customer_checkin_receipts
FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT, INSERT, UPDATE ON TABLE
  public.turniq_customer_checkin_capabilities TO service_role;
GRANT SELECT, INSERT ON TABLE
  public.turniq_customer_checkin_receipts TO service_role;

CREATE OR REPLACE FUNCTION public.issue_turniq_customer_checkin_capability_v1(
  p_salon_id uuid,
  p_booking_id uuid,
  p_service_id uuid,
  p_channel text,
  p_visit_kind text,
  p_token_hash text,
  p_expires_at timestamptz,
  p_max_uses integer,
  p_actor_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO ''
AS $function$
DECLARE
  v_capability public.turniq_customer_checkin_capabilities%ROWTYPE;
  v_booking public.bookings%ROWTYPE;
BEGIN
  IF p_salon_id IS NULL OR p_actor_user_id IS NULL
     OR p_channel NOT IN ('qr', 'kiosk')
     OR p_visit_kind NOT IN ('booked', 'walkin')
     OR p_token_hash IS NULL
     OR p_token_hash !~ '^[0-9a-f]{64}$'
     OR p_expires_at IS NULL
     OR p_expires_at <= pg_catalog.clock_timestamp()
     OR p_expires_at > pg_catalog.clock_timestamp() + interval '24 hours'
     OR p_max_uses IS NULL
     OR p_max_uses NOT BETWEEN 1 AND 500
     OR (p_visit_kind = 'booked' AND p_service_id IS NULL)
     OR (p_visit_kind = 'walkin' AND p_service_id IS NULL AND p_channel <> 'kiosk') THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'invalid_request');
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.salons s
    WHERE s.id = p_salon_id
      AND s.feature_flags @> '{"turniq_trust_engine_enabled": true}'::jsonb
  ) THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'feature_disabled');
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.salon_members sm
    WHERE sm.salon_id = p_salon_id
      AND sm.user_id = p_actor_user_id
      AND sm.role IN ('owner', 'admin', 'senior', 'receptionist')
  ) THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'forbidden');
  END IF;

  IF p_service_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.services s
      WHERE s.id = p_service_id
        AND s.salon_id = p_salon_id
        AND s.deleted_at IS NULL
    ) THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'service_not_found');
  END IF;

  IF p_visit_kind = 'booked' THEN
    IF p_booking_id IS NULL OR p_max_uses <> 1 THEN
      RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'invalid_booked_capability');
    END IF;
    SELECT b.* INTO v_booking
    FROM public.bookings b
    WHERE b.id = p_booking_id
      AND b.salon_id = p_salon_id
      AND b.service_id = p_service_id
      AND b.deleted_at IS NULL
      AND b.status IN ('pending', 'confirmed')
      AND b.start_time_utc >= pg_catalog.clock_timestamp() - interval '2 hours'
      AND b.start_time_utc <= pg_catalog.clock_timestamp() + interval '24 hours';
    IF NOT FOUND THEN
      RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'booking_not_found');
    END IF;
  ELSIF p_booking_id IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'invalid_walkin_capability');
  END IF;

  INSERT INTO public.turniq_customer_checkin_capabilities (
    salon_id, booking_id, service_id, channel, visit_kind, token_hash,
    max_uses, expires_at, issued_by_user_id
  ) VALUES (
    p_salon_id, p_booking_id, p_service_id, p_channel, p_visit_kind,
    p_token_hash, p_max_uses, p_expires_at, p_actor_user_id
  )
  RETURNING * INTO v_capability;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'capability_id', v_capability.id,
    'expires_at', v_capability.expires_at,
    'max_uses', v_capability.max_uses
  );
EXCEPTION
  WHEN unique_violation THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'token_conflict');
END
$function$;

CREATE OR REPLACE FUNCTION public.revoke_turniq_customer_checkin_capability_v1(
  p_salon_id uuid,
  p_capability_id uuid,
  p_actor_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO ''
AS $function$
DECLARE
  v_capability public.turniq_customer_checkin_capabilities%ROWTYPE;
  v_replayed boolean := false;
BEGIN
  IF p_salon_id IS NULL OR p_capability_id IS NULL OR p_actor_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'invalid_request');
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.salon_members sm
    WHERE sm.salon_id = p_salon_id
      AND sm.user_id = p_actor_user_id
      AND sm.role IN ('owner', 'admin', 'senior', 'receptionist')
  ) THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'forbidden');
  END IF;

  SELECT c.* INTO v_capability
  FROM public.turniq_customer_checkin_capabilities c
  WHERE c.id = p_capability_id
    AND c.salon_id = p_salon_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;

  IF v_capability.revoked_at IS NULL THEN
    UPDATE public.turniq_customer_checkin_capabilities
    SET revoked_at = transaction_timestamp(),
        revoked_by_user_id = p_actor_user_id,
        updated_at = transaction_timestamp()
    WHERE id = v_capability.id
    RETURNING * INTO v_capability;
  ELSE
    v_replayed := true;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'replayed', v_replayed,
    'capability_id', v_capability.id,
    'revoked_at', v_capability.revoked_at
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.record_turniq_customer_checkin_shadow_v1(
  p_capability_token_hash text,
  p_channel text,
  p_visit_kind text,
  p_command_id uuid,
  p_service_id uuid,
  p_party_size integer,
  p_submitted_at timestamptz,
  p_actor_ref text,
  p_requested_staff_id uuid,
  p_intake_fingerprint text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO ''
AS $function$
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_capability public.turniq_customer_checkin_capabilities%ROWTYPE;
  v_receipt public.turniq_customer_checkin_receipts%ROWTYPE;
  v_booking public.bookings%ROWTYPE;
  v_next_route text;
  v_reason_codes jsonb;
BEGIN
  IF p_capability_token_hash IS NULL
     OR p_capability_token_hash !~ '^[0-9a-f]{64}$'
     OR p_channel NOT IN ('qr', 'kiosk')
     OR p_visit_kind NOT IN ('booked', 'walkin')
     OR p_command_id IS NULL OR p_service_id IS NULL
     OR p_party_size IS NULL
     OR p_party_size NOT BETWEEN 1 AND 12
     OR p_submitted_at IS NULL
     OR p_actor_ref IS NULL
     OR p_actor_ref !~ '^[0-9a-f]{64}$'
     OR p_intake_fingerprint IS NULL
     OR p_intake_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'invalid_request');
  END IF;

  SELECT c.* INTO v_capability
  FROM public.turniq_customer_checkin_capabilities c
  WHERE c.token_hash = p_capability_token_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'invalid_capability');
  END IF;

  SELECT r.* INTO v_receipt
  FROM public.turniq_customer_checkin_receipts r
  WHERE r.salon_id = v_capability.salon_id
    AND r.command_id = p_command_id;

  IF FOUND THEN
    IF v_receipt.salon_id IS DISTINCT FROM v_capability.salon_id
       OR v_receipt.capability_id IS DISTINCT FROM v_capability.id
       OR v_receipt.intake_fingerprint IS DISTINCT FROM p_intake_fingerprint THEN
      RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'idempotency_conflict');
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'ok', true, 'replayed', true, 'receipt_id', v_receipt.id,
      'status', v_receipt.status, 'next_route', v_receipt.next_route,
      'intake_fingerprint', v_receipt.intake_fingerprint
    );
  END IF;

  -- Freshness constrains only a new receipt. An exact command retry must keep
  -- returning its committed result after a reload or a long network outage.
  IF p_submitted_at < v_now - interval '15 minutes'
     OR p_submitted_at > v_now + interval '5 minutes' THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'invalid_request');
  END IF;

  IF v_capability.revoked_at IS NOT NULL
     OR v_capability.expires_at <= v_now
     OR v_capability.use_count >= v_capability.max_uses THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'capability_unavailable');
  END IF;

  IF v_capability.channel IS DISTINCT FROM p_channel
     OR v_capability.visit_kind IS DISTINCT FROM p_visit_kind THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'capability_mismatch');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.salons s
    WHERE s.id = v_capability.salon_id
      AND s.feature_flags @> '{"turniq_trust_engine_enabled": true}'::jsonb
  ) THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'feature_disabled');
  END IF;

  IF (v_capability.service_id IS NOT NULL
       AND p_service_id IS DISTINCT FROM v_capability.service_id)
     OR NOT EXISTS (
       SELECT 1 FROM public.services s
       WHERE s.id = p_service_id
         AND s.salon_id = v_capability.salon_id
         AND s.deleted_at IS NULL
     ) THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'service_mismatch');
  END IF;

  IF v_capability.visit_kind = 'booked' THEN
    SELECT b.* INTO v_booking
    FROM public.bookings b
    WHERE b.id = v_capability.booking_id
      AND b.salon_id = v_capability.salon_id
      AND b.service_id = p_service_id
      AND b.deleted_at IS NULL
      AND b.status IN ('pending', 'confirmed');
    IF NOT FOUND OR p_party_size IS DISTINCT FROM coalesce(v_booking.party_size, 1) THEN
      RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'booking_mismatch');
    END IF;
  END IF;

  IF p_requested_staff_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.staff s
    WHERE s.id = p_requested_staff_id
      AND s.salon_id = v_capability.salon_id
      AND s.status = 'active'
      AND s.deleted_at IS NULL
  ) THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'requested_staff_mismatch');
  END IF;

  IF v_capability.visit_kind = 'walkin' THEN
    v_next_route := 'identity_match_required';
  ELSIF p_requested_staff_id IS NOT NULL THEN
    v_next_route := 'requested_tech_validation';
  ELSIF p_party_size > 1 THEN
    v_next_route := 'group_optimizer_required';
  ELSE
    v_next_route := 'single_engine_candidate';
  END IF;

  v_reason_codes := pg_catalog.jsonb_build_array(
    'CHECKIN_SHADOW_RECEIVED',
    CASE WHEN v_capability.visit_kind = 'booked'
      THEN 'BOOKED_CAPABILITY_MATCH_REQUIRED'
      ELSE 'WALKIN_IDENTITY_MATCH_REQUIRED' END
  );
  IF p_requested_staff_id IS NOT NULL THEN
    v_reason_codes := v_reason_codes || '"REQUESTED_TECH_CUSTOMER_CONFIRMED"'::jsonb;
  END IF;
  IF v_next_route = 'group_optimizer_required' THEN
    v_reason_codes := v_reason_codes || '"GROUP_OPTIMIZER_REQUIRED"'::jsonb;
  ELSIF v_next_route = 'single_engine_candidate' THEN
    v_reason_codes := v_reason_codes || '"SINGLE_ENGINE_CANDIDATE"'::jsonb;
  END IF;

  INSERT INTO public.turniq_customer_checkin_receipts (
    salon_id, capability_id, command_id, booking_id, service_id, channel,
    visit_kind, party_size, actor_ref, requested_staff_id,
    requested_tech_source, request_trust_label, next_route, reason_codes,
    intake_fingerprint, submitted_at
  ) VALUES (
    v_capability.salon_id, v_capability.id, p_command_id,
    v_capability.booking_id, p_service_id, v_capability.channel,
    v_capability.visit_kind, p_party_size, p_actor_ref, p_requested_staff_id,
    CASE WHEN p_requested_staff_id IS NULL THEN NULL ELSE 'customer_selected' END,
    CASE WHEN p_requested_staff_id IS NULL THEN NULL ELSE 'customer_confirmed' END,
    v_next_route, v_reason_codes, p_intake_fingerprint, p_submitted_at
  ) RETURNING * INTO v_receipt;

  UPDATE public.turniq_customer_checkin_capabilities
  SET use_count = use_count + 1,
      updated_at = transaction_timestamp()
  WHERE id = v_capability.id;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true, 'replayed', false, 'receipt_id', v_receipt.id,
    'status', v_receipt.status, 'next_route', v_receipt.next_route,
    'intake_fingerprint', v_receipt.intake_fingerprint
  );
END
$function$;

REVOKE ALL ON FUNCTION public.issue_turniq_customer_checkin_capability_v1(
  uuid, uuid, uuid, text, text, text, timestamptz, integer, uuid
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.enforce_turniq_customer_checkin_same_salon()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.guard_turniq_customer_checkin_capability_update()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.record_turniq_customer_checkin_shadow_v1(
  text, text, text, uuid, uuid, integer, timestamptz, text, uuid, text
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.revoke_turniq_customer_checkin_capability_v1(
  uuid, uuid, uuid
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.issue_turniq_customer_checkin_capability_v1(
  uuid, uuid, uuid, text, text, text, timestamptz, integer, uuid
) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_turniq_customer_checkin_shadow_v1(
  text, text, text, uuid, uuid, integer, timestamptz, text, uuid, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.revoke_turniq_customer_checkin_capability_v1(
  uuid, uuid, uuid
) TO service_role;

COMMENT ON TABLE public.turniq_customer_checkin_capabilities IS
  'Short-lived server-only bearer capability hashes for PII-free TurnIQ QR/kiosk shadow intake.';
COMMENT ON TABLE public.turniq_customer_checkin_receipts IS
  'Append-only, idempotent TurnIQ customer intake receipts. Never creates a booking, assignment, notification, or payment.';

COMMIT;
