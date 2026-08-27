-- The reconciliation migration at 20260827085412 is already applied in
-- production. Keep that migration immutable and install the lease-based claim
-- protocol as a forward migration so existing databases receive the change.

ALTER TABLE public.booking_card_save_operations
  ADD COLUMN IF NOT EXISTS reconciliation_token uuid,
  ADD COLUMN IF NOT EXISTS reconciliation_lease_expires_at timestamptz;

CREATE OR REPLACE FUNCTION public.reconcile_stale_booking_card_save_operations(p_limit integer)
RETURNS SETOF jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $discover$
DECLARE
  v_row public.booking_card_save_operations%ROWTYPE;
  v_limit integer := least(greatest(coalesce(p_limit, 0), 0), 25);
  v_token uuid;
BEGIN
  FOR v_row IN
    SELECT op.*
    FROM public.booking_card_save_operations op
    WHERE op.status IN ('sending', 'unknown')
      AND op.dispatch_prepared_at IS NOT NULL
      AND op.next_reconcile_at <= transaction_timestamp()
      AND (
        op.reconciliation_lease_expires_at IS NULL
        OR op.reconciliation_lease_expires_at <= transaction_timestamp()
      )
    ORDER BY op.next_reconcile_at, op.id
    LIMIT v_limit
    FOR UPDATE SKIP LOCKED
  LOOP
    v_token := extensions.gen_random_uuid();
    UPDATE public.booking_card_save_operations
    SET reconciliation_token = v_token,
        reconciliation_lease_expires_at = transaction_timestamp() + interval '2 minutes',
        updated_at = transaction_timestamp()
    WHERE id = v_row.id;
    RETURN NEXT pg_catalog.jsonb_build_object(
      'ok', true,
      'code', 'reconcile_required',
      'operation_id', v_row.id,
      'attempt_token', v_token,
      'provider', v_row.provider,
      'booking_id', v_row.booking_id,
      'salon_id', v_row.salon_id,
      'provider_reference_key', 'nq-card:' || v_row.id::text,
      'reconciliation_attempt_count', v_row.reconciliation_attempt_count
    );
  END LOOP;
END;
$discover$;

CREATE OR REPLACE FUNCTION public.complete_booking_card_save_reconciliation(
  p_operation_id uuid,
  p_attempt_token uuid,
  p_outcome text,
  p_card_id text DEFAULT NULL,
  p_customer_id text DEFAULT NULL,
  p_card_brand text DEFAULT NULL,
  p_card_last4 text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $complete$
DECLARE
  v_op public.booking_card_save_operations%ROWTYPE;
  v_booking public.bookings%ROWTYPE;
  v_now timestamptz := transaction_timestamp();
  v_count integer;
  v_result jsonb;
BEGIN
  IF p_operation_id IS NULL OR p_attempt_token IS NULL
     OR p_outcome NOT IN ('found', 'not_found', 'manual_review') THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'invalid_completion');
  END IF;

  SELECT * INTO v_op
  FROM public.booking_card_save_operations
  WHERE id = p_operation_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'operation_not_found');
  END IF;
  IF v_op.reconciliation_token <> p_attempt_token
     OR v_op.reconciliation_lease_expires_at <= v_now
     OR v_op.status NOT IN ('sending', 'unknown')
     OR v_op.dispatch_prepared_at IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'claim_mismatch');
  END IF;

  SELECT * INTO v_booking
  FROM public.bookings
  WHERE id = v_op.booking_id AND salon_id = v_op.salon_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'booking_not_found');
  END IF;

  IF p_outcome = 'found' THEN
    IF coalesce(trim(p_card_id), '') = '' OR length(trim(p_card_id)) > 255
       OR coalesce(trim(p_customer_id), '') = '' OR length(trim(p_customer_id)) > 255
       OR coalesce(trim(p_card_brand), '') = '' OR length(trim(p_card_brand)) > 50
       OR coalesce(trim(p_card_last4), '') !~ '^[0-9]{4}$' THEN
      RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'invalid_completion');
    END IF;
    IF v_booking.noshow_card_id IS NOT NULL
       AND v_booking.noshow_card_id IS DISTINCT FROM trim(p_card_id) THEN
      UPDATE public.booking_card_save_operations
      SET resolution_code = 'manual_review_required', next_reconcile_at = NULL,
          updated_at = v_now
      WHERE id = v_op.id;
      RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'card_state_conflict');
    END IF;

    UPDATE public.bookings
    SET noshow_card_id = trim(p_card_id),
        noshow_customer_id = trim(p_customer_id),
        noshow_card_brand = trim(p_card_brand),
        noshow_card_last4 = trim(p_card_last4),
        noshow_consent_at = v_op.consent_at,
        noshow_consent_meta = v_op.consent_meta,
        noshow_charge_status = 'saved',
        noshow_card_required = false
    WHERE id = v_booking.id;

    v_result := pg_catalog.jsonb_build_object(
      'ok', true, 'code', 'reconciled_saved', 'outcome', 'succeeded',
      'booking_id', v_op.booking_id, 'salon_id', v_op.salon_id,
      'provider', v_op.provider, 'mode', v_op.mode,
      'provider_reference', trim(p_card_id),
      'card_brand', trim(p_card_brand), 'card_last4', trim(p_card_last4),
      'idempotent', false
    );
    UPDATE public.booking_card_save_operations
    SET status = 'succeeded', provider_reference = trim(p_card_id),
        completion_fingerprint = pg_catalog.encode(extensions.digest(
          pg_catalog.convert_to(v_result::text, 'UTF8'), 'sha256'), 'hex'),
        error_code = NULL, result_json = v_result,
        completed_at = coalesce(completed_at, v_now), updated_at = v_now,
        next_reconcile_at = NULL, resolution_code = 'provider_card_found',
        reconciliation_token = NULL, reconciliation_lease_expires_at = NULL
    WHERE id = v_op.id;
    RETURN v_result;
  END IF;

  v_count := v_op.reconciliation_attempt_count + 1;
  UPDATE public.booking_card_save_operations
  SET status = CASE WHEN status = 'sending' THEN 'unknown' ELSE status END,
      reconciliation_attempt_count = v_count,
      next_reconcile_at = CASE
        WHEN p_outcome = 'manual_review' OR v_count >= 3 THEN NULL
        ELSE v_now + pg_catalog.make_interval(secs => (30 * pg_catalog.power(2, v_count - 1))::integer)
      END,
      resolution_code = CASE
        WHEN p_outcome = 'manual_review' THEN 'manual_review_required'
        WHEN v_count >= 3 THEN 'manual_review_required'
        ELSE 'provider_card_not_found'
      END,
      error_code = CASE
        WHEN p_outcome = 'manual_review' THEN 'provider_reconciliation_ambiguous'
        WHEN v_count >= 3 THEN 'provider_reconciliation_ambiguous'
        ELSE 'provider_card_not_found'
      END,
      result_json = pg_catalog.jsonb_build_object(
        'ok', false,
        'code', CASE
          WHEN p_outcome = 'manual_review' THEN 'manual_review_required'
          WHEN v_count >= 3 THEN 'manual_review_required'
          ELSE 'reconciliation_pending'
        END,
        'booking_id', v_op.booking_id,
        'salon_id', v_op.salon_id,
        'outcome', 'unknown'
      ),
      completion_fingerprint = coalesce(completion_fingerprint,
        pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
          pg_catalog.jsonb_build_object('outcome','unknown','operation_id',v_op.id)::text,
          'UTF8'), 'sha256'), 'hex')),
      completed_at = coalesce(completed_at, v_now),
      reconciliation_token = NULL,
      reconciliation_lease_expires_at = NULL,
      updated_at = v_now
  WHERE id = v_op.id;
  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'code', CASE
      WHEN p_outcome = 'manual_review' THEN 'manual_review_required'
      WHEN v_count >= 3 THEN 'manual_review_required'
      ELSE 'reconciliation_pending'
    END
  );
END;
$complete$;

REVOKE ALL ON FUNCTION public.reconcile_stale_booking_card_save_operations(integer),
  public.complete_booking_card_save_reconciliation(uuid,uuid,text,text,text,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_stale_booking_card_save_operations(integer),
  public.complete_booking_card_save_reconciliation(uuid,uuid,text,text,text,text,text)
  TO service_role;
