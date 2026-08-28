-- Arm card management inside the authoritative booking-create transaction.
-- The booking remains the committed customer outcome; this PII-free row only
-- guarantees that a crashed post-commit assessment is visible to operators.

ALTER TABLE public.booking_card_management_continuations
  DROP CONSTRAINT booking_card_management_continuations_status_check,
  DROP CONSTRAINT booking_card_management_continuations_reason_code_check;

ALTER TABLE public.booking_card_management_continuations
  ADD CONSTRAINT booking_card_management_continuations_status_check CHECK (
    status IN (
      'armed', 'pending', 'awaiting_customer', 'provider_reconciliation',
      'resolved', 'manual_review'
    )
  ),
  ADD CONSTRAINT booking_card_management_continuations_reason_code_check CHECK (
    reason_code IN (
      'assessment_scheduled', 'assessment_unavailable', 'card_required',
      'capability_unavailable', 'consent_required', 'card_save_unresolved',
      'unexpected_post_commit_error', 'booking_inactive', 'card_saved',
      'provider_operation_pending', 'reconciliation_exhausted',
      'card_not_required', 'not_applicable', 'assessment_missing'
    )
  );

DROP INDEX public.idx_booking_card_management_continuations_due;
CREATE INDEX idx_booking_card_management_continuations_due
  ON public.booking_card_management_continuations(next_reconcile_at, id)
  WHERE status IN (
    'armed', 'pending', 'awaiting_customer', 'provider_reconciliation'
  ) AND next_reconcile_at IS NOT NULL;

-- PostgreSQL does not automatically index foreign keys. These two focused
-- indexes cover continuation joins and cascade/update checks without widening
-- any application role's access.
CREATE INDEX idx_booking_card_management_continuations_card_save_operation_id
  ON public.booking_card_management_continuations(card_save_operation_id)
  WHERE card_save_operation_id IS NOT NULL;
CREATE INDEX idx_booking_card_save_operations_salon_id
  ON public.booking_card_save_operations(salon_id);

CREATE OR REPLACE FUNCTION public.arm_booking_card_management_continuation_on_create()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $arm$
DECLARE
  v_existing public.booking_card_management_continuations%ROWTYPE;
  v_enabled boolean;
  v_scope text;
  v_now timestamptz := transaction_timestamp();
BEGIN
  -- An existing canonical receipt can later change during reschedule or other
  -- lifecycle work. Only the transition that first establishes the receipt is
  -- part of create; never compare a later pricing fingerprint to the original
  -- continuation binding.
  IF TG_OP = 'UPDATE'
     AND OLD.status = 'confirmed'
     AND OLD.deleted_at IS NULL
     AND OLD.recovered_from_booking_id IS NULL
     AND OLD.idempotency_key IS NOT NULL
     AND coalesce(OLD.public_booking_pricing_fingerprint, '') ~ '^[0-9a-f]{64}$'
     AND pg_catalog.jsonb_typeof(OLD.public_booking_pricing_snapshot) = 'object'
     AND (
       OLD.group_id IS NULL
       OR (OLD.group_id IS NOT NULL AND OLD.is_group_organizer IS TRUE)
     ) THEN
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM 'confirmed'
     OR NEW.deleted_at IS NOT NULL
     OR NEW.recovered_from_booking_id IS NOT NULL
     OR NEW.idempotency_key IS NULL
     OR coalesce(NEW.public_booking_pricing_fingerprint, '') !~ '^[0-9a-f]{64}$'
     OR pg_catalog.jsonb_typeof(NEW.public_booking_pricing_snapshot) IS DISTINCT FROM 'object'
     OR NOT (
       NEW.group_id IS NULL
       OR (NEW.group_id IS NOT NULL AND NEW.is_group_organizer IS TRUE)
     ) THEN
    RETURN NEW;
  END IF;

  v_scope := CASE
    WHEN NEW.group_id IS NULL THEN 'individual'
    ELSE 'group_organizer'
  END;

  SELECT s.noshow_protection_enabled
  INTO v_enabled
  FROM public.salons s
  WHERE s.id = NEW.salon_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF NOT v_enabled THEN
    RETURN NEW;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'booking-card-continuation:' || NEW.id::text, 0
  ));
  SELECT * INTO v_existing
  FROM public.booking_card_management_continuations c
  WHERE c.booking_id = NEW.id
     OR (c.salon_id = NEW.salon_id AND c.create_idempotency_key = NEW.idempotency_key)
  ORDER BY c.booking_id = NEW.id DESC
  LIMIT 1
  FOR UPDATE;
  IF FOUND THEN
    IF v_existing.salon_id IS DISTINCT FROM NEW.salon_id
       OR v_existing.booking_id IS DISTINCT FROM NEW.id
       OR v_existing.create_idempotency_key IS DISTINCT FROM NEW.idempotency_key
       OR v_existing.pricing_fingerprint IS DISTINCT FROM NEW.public_booking_pricing_fingerprint
       OR v_existing.scope IS DISTINCT FROM v_scope THEN
      RAISE EXCEPTION 'booking_card_continuation_create_binding_conflict';
    END IF;
    RETURN NEW;
  END IF;

  INSERT INTO public.booking_card_management_continuations (
    salon_id, booking_id, create_idempotency_key, pricing_fingerprint,
    scope, stage, status, reason_code, next_reconcile_at, resolved_at,
    result_json
  ) VALUES (
    NEW.salon_id, NEW.id, NEW.idempotency_key,
    NEW.public_booking_pricing_fingerprint, v_scope, 'assessment',
    'armed', 'assessment_scheduled', v_now + interval '5 minutes', NULL,
    pg_catalog.jsonb_build_object(
      'status', 'armed', 'reason_code', 'assessment_scheduled'
    )
  );
  RETURN NEW;
END;
$arm$;

CREATE TRIGGER arm_booking_card_management_continuation_after_insert
  AFTER INSERT ON public.bookings
  FOR EACH ROW
  EXECUTE FUNCTION public.arm_booking_card_management_continuation_on_create();

CREATE TRIGGER arm_booking_card_management_continuation_after_create_binding
  AFTER UPDATE OF status, deleted_at, recovered_from_booking_id, idempotency_key,
    public_booking_pricing_fingerprint, public_booking_pricing_snapshot,
    group_id, is_group_organizer
  ON public.bookings
  FOR EACH ROW
  EXECUTE FUNCTION public.arm_booking_card_management_continuation_on_create();

CREATE OR REPLACE FUNCTION public.resolve_booking_card_management_continuation(
  p_salon_id uuid,
  p_booking_id uuid,
  p_create_idempotency_key uuid,
  p_pricing_fingerprint text,
  p_scope text,
  p_reason_code text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $resolve$
DECLARE
  v_existing public.booking_card_management_continuations%ROWTYPE;
  v_row public.booking_card_management_continuations%ROWTYPE;
  v_now timestamptz := transaction_timestamp();
BEGIN
  IF p_salon_id IS NULL OR p_booking_id IS NULL OR p_create_idempotency_key IS NULL
     OR coalesce(p_pricing_fingerprint, '') !~ '^[0-9a-f]{64}$'
     OR p_scope NOT IN ('individual', 'group_organizer')
     OR p_reason_code NOT IN ('card_not_required', 'not_applicable') THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'invalid_request');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'booking-card-continuation:' || p_booking_id::text, 0
  ));
  PERFORM 1
  FROM public.bookings
  WHERE id = p_booking_id
    AND salon_id = p_salon_id
    AND idempotency_key = p_create_idempotency_key
    AND public_booking_pricing_fingerprint = p_pricing_fingerprint
    AND pg_catalog.jsonb_typeof(public_booking_pricing_snapshot) = 'object'
    AND recovered_from_booking_id IS NULL
    AND deleted_at IS NULL
    AND status = 'confirmed'
    AND (
      (p_scope = 'individual' AND group_id IS NULL)
      OR (p_scope = 'group_organizer' AND group_id IS NOT NULL AND is_group_organizer IS TRUE)
    )
  FOR SHARE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'create_binding_invalid');
  END IF;

  SELECT * INTO v_existing
  FROM public.booking_card_management_continuations c
  WHERE c.booking_id = p_booking_id
     OR (c.salon_id = p_salon_id AND c.create_idempotency_key = p_create_idempotency_key)
  ORDER BY c.booking_id = p_booking_id DESC
  LIMIT 1
  FOR UPDATE;
  IF FOUND AND (
    v_existing.salon_id IS DISTINCT FROM p_salon_id
    OR v_existing.booking_id IS DISTINCT FROM p_booking_id
    OR v_existing.create_idempotency_key IS DISTINCT FROM p_create_idempotency_key
    OR v_existing.pricing_fingerprint IS DISTINCT FROM p_pricing_fingerprint
    OR v_existing.scope IS DISTINCT FROM p_scope
  ) THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'create_binding_conflict');
  END IF;

  IF FOUND AND v_existing.status = 'resolved' THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', true, 'code', 'resolved', 'idempotent', true,
      'continuation_id', v_existing.id, 'status', v_existing.status
    );
  END IF;

  IF FOUND THEN
    UPDATE public.booking_card_management_continuations
    SET stage = 'assessment', status = 'resolved', reason_code = p_reason_code,
        next_reconcile_at = NULL, resolved_at = v_now,
        result_json = pg_catalog.jsonb_build_object(
          'status', 'resolved', 'reason_code', p_reason_code
        ), updated_at = v_now
    WHERE id = v_existing.id
    RETURNING * INTO v_row;
  ELSE
    -- No row means the salon had no card continuation to assess when this
    -- booking committed (or the booking predates this ledger). Do not create a
    -- resolved row for every non-participating salon booking.
    RETURN pg_catalog.jsonb_build_object(
      'ok', true, 'code', 'no_continuation', 'idempotent', true,
      'continuation_id', NULL, 'status', 'resolved'
    );
  END IF;

  UPDATE public.bookings
  SET noshow_card_required = false
  WHERE id = p_booking_id AND salon_id = p_salon_id;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true, 'code', 'resolved', 'idempotent', false,
    'continuation_id', v_row.id, 'status', v_row.status
  );
END;
$resolve$;

CREATE OR REPLACE FUNCTION public.reconcile_due_booking_card_management_continuations(
  p_limit integer
)
RETURNS SETOF jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $reconcile$
DECLARE
  v_row public.booking_card_management_continuations%ROWTYPE;
  v_booking public.bookings%ROWTYPE;
  v_save public.booking_card_save_operations%ROWTYPE;
  v_now timestamptz := transaction_timestamp();
  v_attempt integer;
  v_status text;
  v_reason text;
BEGIN
  FOR v_row IN
    SELECT c.*
    FROM public.booking_card_management_continuations c
    WHERE c.status IN ('armed', 'pending', 'awaiting_customer', 'provider_reconciliation')
      AND c.next_reconcile_at <= v_now
    ORDER BY c.next_reconcile_at, c.id
    LIMIT least(greatest(coalesce(p_limit, 0), 0), 25)
    FOR UPDATE SKIP LOCKED
  LOOP
    SELECT * INTO v_booking
    FROM public.bookings
    WHERE id = v_row.booking_id AND salon_id = v_row.salon_id;

    v_save := NULL;
    IF FOUND THEN
      SELECT * INTO v_save
      FROM public.booking_card_save_operations op
      WHERE op.booking_id = v_row.booking_id
        AND op.salon_id = v_row.salon_id
        AND op.mode = 'save_card'
      ORDER BY op.created_at DESC, op.id DESC
      LIMIT 1;
    END IF;

    IF v_booking.id IS NULL OR v_booking.deleted_at IS NOT NULL
       OR v_booking.status = 'cancelled' THEN
      v_status := 'resolved';
      v_reason := 'booking_inactive';
    ELSIF v_booking.noshow_card_id IS NOT NULL THEN
      v_status := 'resolved';
      v_reason := 'card_saved';
    ELSIF v_save.id IS NOT NULL AND v_save.status IN ('sending', 'unknown') THEN
      v_status := 'provider_reconciliation';
      v_reason := 'provider_operation_pending';
    ELSIF v_booking.noshow_card_required IS TRUE THEN
      v_status := 'awaiting_customer';
      v_reason := v_row.reason_code;
    ELSIF v_row.status = 'armed' THEN
      -- The route never completed its post-commit assessment. Escalate to an
      -- operator without inventing a customer card requirement or retrying
      -- either the booking create or a provider operation.
      v_status := 'manual_review';
      v_reason := 'assessment_missing';
    ELSE
      v_attempt := v_row.attempt_count + 1;
      IF v_attempt >= 3 THEN
        v_status := 'manual_review';
        v_reason := 'reconciliation_exhausted';
      ELSE
        UPDATE public.booking_card_management_continuations
        SET attempt_count = v_attempt,
            next_reconcile_at = v_now + pg_catalog.make_interval(secs => 30 * (1 << (v_attempt - 1))),
            updated_at = v_now
        WHERE id = v_row.id;
        RETURN NEXT pg_catalog.jsonb_build_object(
          'ok', true, 'continuation_id', v_row.id, 'status', 'pending'
        );
        CONTINUE;
      END IF;
    END IF;

    UPDATE public.booking_card_management_continuations
    SET status = v_status,
        reason_code = v_reason,
        card_save_operation_id = CASE WHEN v_save.id IS NULL THEN NULL ELSE v_save.id END,
        attempt_count = least(attempt_count + 1, 10),
        next_reconcile_at = CASE
          WHEN v_status = 'awaiting_customer' THEN v_now + interval '15 minutes'
          WHEN v_status = 'provider_reconciliation' THEN v_now + interval '2 minutes'
          ELSE NULL
        END,
        resolved_at = CASE WHEN v_status IN ('resolved', 'manual_review') THEN v_now ELSE NULL END,
        result_json = pg_catalog.jsonb_build_object(
          'status', v_status, 'reason_code', v_reason
        ),
        updated_at = v_now
    WHERE id = v_row.id;
    RETURN NEXT pg_catalog.jsonb_build_object(
      'ok', true, 'continuation_id', v_row.id, 'status', v_status
    );
  END LOOP;
END;
$reconcile$;

REVOKE ALL ON FUNCTION public.arm_booking_card_management_continuation_on_create(),
  public.resolve_booking_card_management_continuation(uuid, uuid, uuid, text, text, text),
  public.reconcile_due_booking_card_management_continuations(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_booking_card_management_continuation(
  uuid, uuid, uuid, text, text, text
), public.reconcile_due_booking_card_management_continuations(integer)
  TO service_role;

COMMENT ON FUNCTION public.arm_booking_card_management_continuation_on_create() IS
  'Atomically arms a PII-free post-create card continuation only after an exact canonical booking binding exists.';
COMMENT ON FUNCTION public.resolve_booking_card_management_continuation(
  uuid, uuid, uuid, text, text, text
) IS 'Resolves post-create card assessment by exact canonical receipt; never creates or retries a booking or provider operation.';
