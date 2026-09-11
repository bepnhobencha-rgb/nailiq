-- Finish card continuations for terminal bookings and exhausted provider
-- reconciliation. This only replaces the existing service-role worker;
-- it does not run it, enable its release flag, or rewrite historical rows.
-- Booking state, card-save operations, fees and provider evidence are untouched.

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
       OR v_booking.status IN ('cancelled', 'completed', 'no_show') THEN
      v_status := 'resolved';
      v_reason := 'booking_inactive';
    ELSIF v_booking.noshow_card_id IS NOT NULL THEN
      v_status := 'resolved';
      v_reason := 'card_saved';
    ELSIF v_save.id IS NOT NULL AND v_save.status IN ('sending', 'unknown')
       AND v_save.resolution_code = 'manual_review_required' THEN
      -- Provider reconciliation has stopped. Preserve that evidence and stop
      -- scheduling a continuation that can no longer complete automatically.
      v_status := 'manual_review';
      v_reason := 'reconciliation_exhausted';
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

REVOKE ALL ON FUNCTION public.reconcile_due_booking_card_management_continuations(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_due_booking_card_management_continuations(integer)
  TO service_role;
