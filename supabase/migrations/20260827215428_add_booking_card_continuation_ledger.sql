-- A public booking is authoritative once its canonical create RPC commits.
-- Card policy/capability/provider work is a continuation and must never turn
-- that booking into a false create failure. This ledger records that separate
-- concern without retaining phone, card nonce, verification token, or provider
-- credentials. Its reconciler reads NailIQ state only.

CREATE TABLE public.booking_card_management_continuations (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  booking_id uuid NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  create_idempotency_key uuid NOT NULL,
  pricing_fingerprint text NOT NULL CHECK (pricing_fingerprint ~ '^[0-9a-f]{64}$'),
  scope text NOT NULL CHECK (scope IN ('individual', 'group_organizer')),
  stage text NOT NULL CHECK (stage IN (
    'assessment', 'capability', 'customer_action', 'provider_handoff'
  )),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'awaiting_customer', 'provider_reconciliation',
    'resolved', 'manual_review'
  )),
  reason_code text NOT NULL CHECK (reason_code IN (
    'assessment_unavailable', 'card_required', 'capability_unavailable',
    'consent_required', 'card_save_unresolved', 'unexpected_post_commit_error',
    'booking_inactive', 'card_saved', 'provider_operation_pending',
    'reconciliation_exhausted'
  )),
  card_save_operation_id uuid REFERENCES public.booking_card_save_operations(id) ON DELETE SET NULL,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 10),
  next_reconcile_at timestamptz,
  result_json jsonb,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (booking_id),
  UNIQUE (salon_id, create_idempotency_key),
  CONSTRAINT booking_card_management_continuation_resolution_check CHECK (
    (status IN ('resolved', 'manual_review') AND resolved_at IS NOT NULL)
    OR (status NOT IN ('resolved', 'manual_review') AND resolved_at IS NULL)
  )
);

CREATE INDEX idx_booking_card_management_continuations_due
  ON public.booking_card_management_continuations(next_reconcile_at, id)
  WHERE status IN ('pending', 'awaiting_customer', 'provider_reconciliation')
    AND next_reconcile_at IS NOT NULL;

ALTER TABLE public.booking_card_management_continuations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_card_management_continuations FORCE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.booking_card_management_continuations
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.booking_card_management_continuations
  TO service_role;
CREATE POLICY "deny direct api booking card continuations"
  ON public.booking_card_management_continuations
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

CREATE OR REPLACE FUNCTION public.record_booking_card_management_pending(
  p_salon_id uuid,
  p_booking_id uuid,
  p_create_idempotency_key uuid,
  p_pricing_fingerprint text,
  p_scope text,
  p_stage text,
  p_reason_code text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $record$
DECLARE
  v_booking public.bookings%ROWTYPE;
  v_existing public.booking_card_management_continuations%ROWTYPE;
  v_row public.booking_card_management_continuations%ROWTYPE;
  v_now timestamptz := transaction_timestamp();
BEGIN
  IF p_salon_id IS NULL OR p_booking_id IS NULL OR p_create_idempotency_key IS NULL
     OR coalesce(p_pricing_fingerprint, '') !~ '^[0-9a-f]{64}$'
     OR p_scope NOT IN ('individual', 'group_organizer')
     OR p_stage NOT IN ('assessment', 'capability', 'customer_action', 'provider_handoff')
     OR p_reason_code NOT IN (
       'assessment_unavailable', 'card_required', 'capability_unavailable',
       'consent_required', 'card_save_unresolved', 'unexpected_post_commit_error'
     ) THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'invalid_request');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'booking-card-continuation:' || p_booking_id::text, 0
  ));
  SELECT * INTO v_booking
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
  FROM public.booking_card_management_continuations
  WHERE booking_id = p_booking_id
     OR (salon_id = p_salon_id AND create_idempotency_key = p_create_idempotency_key)
  ORDER BY booking_id = p_booking_id DESC
  LIMIT 1
  FOR UPDATE;
  IF FOUND THEN
    IF v_existing.salon_id IS DISTINCT FROM p_salon_id
       OR v_existing.booking_id IS DISTINCT FROM p_booking_id
       OR v_existing.create_idempotency_key IS DISTINCT FROM p_create_idempotency_key
       OR v_existing.pricing_fingerprint IS DISTINCT FROM p_pricing_fingerprint
       OR v_existing.scope IS DISTINCT FROM p_scope THEN
      RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'create_binding_conflict');
    END IF;
    IF v_existing.status IN ('resolved', 'manual_review') THEN
      RETURN pg_catalog.jsonb_build_object(
        'ok', true, 'code', v_existing.status, 'idempotent', true,
        'continuation_id', v_existing.id, 'status', v_existing.status
      );
    END IF;
    UPDATE public.booking_card_management_continuations
    SET stage = p_stage,
        reason_code = p_reason_code,
        status = 'pending',
        next_reconcile_at = v_now,
        updated_at = v_now
    WHERE id = v_existing.id
    RETURNING * INTO v_row;
  ELSE
    INSERT INTO public.booking_card_management_continuations (
      salon_id, booking_id, create_idempotency_key, pricing_fingerprint,
      scope, stage, status, reason_code, next_reconcile_at
    ) VALUES (
      p_salon_id, p_booking_id, p_create_idempotency_key, p_pricing_fingerprint,
      p_scope, p_stage, 'pending', p_reason_code, v_now
    ) RETURNING * INTO v_row;
  END IF;

  -- A failed assessment cannot be treated as proof that no card is required.
  -- Surface a conservative desk follow-up without changing booking status.
  UPDATE public.bookings
  SET noshow_card_required = true
  WHERE id = p_booking_id
    AND salon_id = p_salon_id
    AND noshow_card_id IS NULL;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true, 'code', 'pending_recorded',
    'idempotent', v_existing.id IS NOT NULL,
    'continuation_id', v_row.id, 'status', v_row.status
  );
END;
$record$;

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
    WHERE c.status IN ('pending', 'awaiting_customer', 'provider_reconciliation')
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

REVOKE ALL ON FUNCTION public.record_booking_card_management_pending(
  uuid, uuid, uuid, text, text, text, text
), public.reconcile_due_booking_card_management_continuations(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_booking_card_management_pending(
  uuid, uuid, uuid, text, text, text, text
), public.reconcile_due_booking_card_management_continuations(integer)
  TO service_role;

COMMENT ON TABLE public.booking_card_management_continuations IS
  'PII-free post-commit card continuation ledger. Booking success remains authoritative; reconciliation never creates a booking or calls a payment provider.';

-- A capability rotation must not create a second provider operation for the
-- same canonical booking request. Advisory booking locks serialize the claim;
-- this unique identity is the final database backstop.
DO $dedupe_guard$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.booking_card_save_operations
    GROUP BY booking_id, request_id, provider, mode
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate booking card save operation identity requires manual review';
  END IF;
END;
$dedupe_guard$;

CREATE UNIQUE INDEX booking_card_save_operations_booking_request_unique
  ON public.booking_card_save_operations(booking_id, request_id, provider, mode);
