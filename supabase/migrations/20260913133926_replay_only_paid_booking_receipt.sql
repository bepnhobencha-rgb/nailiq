-- R09: resume an already-bound paid booking without fresh create authority.
-- No provider dispatch/refund and no data backfill. Apply after the incentive contract.
DO $guard$
BEGIN
  IF md5(rtrim(pg_get_functiondef('public.create_public_booking_with_deposit_payment(uuid, uuid, uuid, text, text, timestamp with time zone, timestamp with time zone, text, text, uuid[], text, uuid, uuid, uuid, boolean, uuid, text, uuid, uuid, text, uuid)'::regprocedure), E' \n\r\t')) <> '1027bf624b77e06d3625c405c7707f93' THEN
    RAISE EXCEPTION 'R09 paid replay canonical source drift';
  END IF;
END;
$guard$;

CREATE OR REPLACE FUNCTION public.replay_public_booking_with_deposit_payment(p_salon_id uuid, p_service_id uuid, p_staff_id uuid, p_client_name text, p_client_phone text, p_start_time_utc timestamp with time zone, p_end_time_utc timestamp with time zone, p_status text, p_client_notes text, p_addon_service_ids uuid[], p_client_email text, p_resource_id uuid, p_combo_id uuid, p_voucher_id uuid, p_apply_email_discount boolean, p_idempotency_key uuid, p_expected_pricing_fingerprint text, p_payment_operation_id uuid, p_payment_request_id uuid, p_expected_payment_material_fingerprint text, p_otp_session_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $replay$
DECLARE
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_booking_id uuid;
BEGIN
  IF v_role <> 'service_role' THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  -- Hold the same operation lock used by canonical binding/compensation. A caller
  -- choosing replay can never turn an unbound operation into a fresh booking.
  SELECT op.booking_id INTO v_booking_id
  FROM public.booking_payment_operations op
  WHERE op.id = p_payment_operation_id AND op.salon_id = p_salon_id
    AND op.request_id = p_payment_request_id AND op.operation_kind = 'deposit_charge'
  FOR UPDATE;
  IF NOT FOUND OR v_booking_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'booking_recovery_required');
  END IF;
  -- The canonical bound branch revalidates both fingerprints, booking identity,
  -- and payment material against durable receipts before returning them. Because
  -- the locked operation is already bound, its fresh-create branch is unreachable.
  RETURN public.create_public_booking_with_deposit_payment(
    p_salon_id, p_service_id, p_staff_id, p_client_name, p_client_phone, p_start_time_utc, p_end_time_utc, p_status, p_client_notes, p_addon_service_ids, p_client_email, p_resource_id, p_combo_id, p_voucher_id, p_apply_email_discount, p_idempotency_key, p_expected_pricing_fingerprint, p_payment_operation_id, p_payment_request_id, p_expected_payment_material_fingerprint, p_otp_session_id
  );
END;
$replay$;
REVOKE ALL ON FUNCTION public.replay_public_booking_with_deposit_payment(uuid, uuid, uuid, text, text, timestamp with time zone, timestamp with time zone, text, text, uuid[], text, uuid, uuid, uuid, boolean, uuid, text, uuid, uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replay_public_booking_with_deposit_payment(uuid, uuid, uuid, text, text, timestamp with time zone, timestamp with time zone, text, text, uuid[], text, uuid, uuid, uuid, boolean, uuid, text, uuid, uuid, text, uuid) TO service_role;
COMMENT ON FUNCTION public.replay_public_booking_with_deposit_payment(uuid, uuid, uuid, text, text, timestamp with time zone, timestamp with time zone, text, text, uuid[], text, uuid, uuid, uuid, boolean, uuid, text, uuid, uuid, text, uuid)
IS 'Service-only exact replay of an already-bound deposit booking. Missing/unbound operations cannot create a booking, charge or refund.';
