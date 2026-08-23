-- Owner/Admin archived-booking surface: atomically claim exactly the amount
-- the user confirmed as the remaining refundable deposit while the booking is
-- still cancelled. Provider dispatch stays outside SQL.
--
-- Replay is checked before mutable booking state so a lost HTTP response can
-- recover the original receipt even after the refund advanced the counters.
CREATE OR REPLACE FUNCTION public.claim_cancelled_booking_remaining_deposit_refund(
  p_salon_id uuid,
  p_booking_id uuid,
  p_request_id uuid,
  p_expected_remaining_cents integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_booking public.bookings%ROWTYPE;
  v_existing public.booking_payment_operations%ROWTYPE;
  v_parent public.booking_payment_operations%ROWTYPE;
  v_reserved integer := 0;
  v_remaining integer;
  v_loaded jsonb;
BEGIN
  IF p_salon_id IS NULL OR p_booking_id IS NULL OR p_request_id IS NULL
     OR p_expected_remaining_cents IS NULL OR p_expected_remaining_cents <= 0 THEN
    RETURN jsonb_build_object('success',false,'code','invalid_input');
  END IF;

  -- A logical request owns immutable money intent. This branch deliberately
  -- precedes today's booking/refund counters for exact response-loss replay.
  SELECT * INTO v_existing
  FROM public.booking_payment_operations
  WHERE salon_id=p_salon_id
    AND request_id=p_request_id
    AND operation_kind='deposit_refund'
  FOR UPDATE;
  IF FOUND THEN
    IF v_existing.booking_id IS DISTINCT FROM p_booking_id
       OR v_existing.amount_cents IS DISTINCT FROM p_expected_remaining_cents THEN
      RETURN jsonb_build_object(
        'success',false,'code','operation_conflict','operation_id',v_existing.id
      );
    END IF;
    RETURN public.claim_booking_payment_operation(
      p_salon_id,
      p_booking_id,
      p_request_id,
      'deposit_refund',
      v_existing.amount_cents,
      v_existing.material_fingerprint
    );
  END IF;

  SELECT * INTO v_booking
  FROM public.bookings
  WHERE id=p_booking_id AND salon_id=p_salon_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success',false,'code','booking_not_found');
  END IF;
  IF v_booking.status <> 'cancelled' THEN
    RETURN jsonb_build_object('success',false,'code','booking_not_cancelled');
  END IF;

  SELECT * INTO v_parent
  FROM public.booking_payment_operations o
  WHERE o.salon_id=p_salon_id
    AND o.booking_id=p_booking_id
    AND o.operation_kind='deposit_charge'
    AND o.status='succeeded'
    AND o.provider_payment_id IS NOT NULL
  ORDER BY o.completed_at DESC, o.id DESC
  LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success',false,'code','legacy_payment_not_ledgered');
  END IF;

  SELECT coalesce(sum(o.amount_cents),0)::integer INTO v_reserved
  FROM public.booking_payment_operations o
  WHERE o.salon_id=p_salon_id
    AND o.booking_id=p_booking_id
    AND o.operation_kind='deposit_refund'
    AND o.status IN ('sending','pending_provider','reconciling','unknown');

  v_remaining := greatest(
    0,
    v_parent.amount_cents
      - coalesce(v_booking.deposit_refunded_cents,0)
      - v_reserved
  );
  IF v_reserved > 0 THEN
    RETURN jsonb_build_object(
      'success',false,
      'code','refund_reconciliation_required',
      'remaining_refundable_cents',v_remaining
    );
  END IF;
  IF v_remaining <= 0 THEN
    RETURN jsonb_build_object('success',false,'code','deposit_fully_refunded');
  END IF;
  IF p_expected_remaining_cents <> v_remaining THEN
    RETURN jsonb_build_object(
      'success',false,
      'code','refund_remaining_changed',
      'remaining_refundable_cents',v_remaining
    );
  END IF;

  v_loaded := public.resolve_booking_payment_operation_material(
    p_salon_id,
    p_booking_id,
    'deposit_refund',
    v_remaining,
    true,
    NULL
  );
  IF coalesce((v_loaded->>'success')::boolean,false) IS NOT TRUE THEN
    RETURN v_loaded;
  END IF;

  RETURN public.claim_booking_payment_operation(
    p_salon_id,
    p_booking_id,
    p_request_id,
    'deposit_refund',
    v_remaining,
    v_loaded->>'material_fingerprint'
  );
END
$function$;

REVOKE ALL ON FUNCTION public.claim_cancelled_booking_remaining_deposit_refund(
  uuid,uuid,uuid,integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_cancelled_booking_remaining_deposit_refund(
  uuid,uuid,uuid,integer
) TO service_role;

COMMENT ON FUNCTION public.claim_cancelled_booking_remaining_deposit_refund(
  uuid,uuid,uuid,integer
) IS
  'Claims exactly the user-confirmed remaining deposit for a cancelled booking; stable request replay precedes mutable state and provider dispatch remains outside SQL.';
