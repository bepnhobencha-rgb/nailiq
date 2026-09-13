-- R09: authorize phone-bound incentives with explicit, fresh SMS proof.
-- Prices, advertised $2-once-per-phone terms, and durable fingerprints stay unchanged.
-- Existing arities deliberately forward NULL: no ambient role/GUC is phone proof.
-- Apply transactionally before the companion CRM isolation migration. No data backfill.
-- Lock order: client advisory -> existing profile -> OTP -> voucher -> booking resources.
CREATE OR REPLACE FUNCTION public.booking_incentive_phone_ownership(
  p_otp_session_id uuid, p_salon_id uuid, p_phone text, p_lock_session boolean
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $proof$
DECLARE
  v_session public.phone_otp_sessions%ROWTYPE;
  v_phone text := public.canonical_phone(p_phone);
  v_now timestamptz;
BEGIN
  IF p_otp_session_id IS NULL OR p_salon_id IS NULL
     OR v_phone IS NULL OR length(regexp_replace(v_phone, '\D', '', 'g')) < 7
     OR p_lock_session IS NULL THEN RETURN false; END IF;
  IF p_lock_session THEN
    SELECT otp.* INTO v_session FROM public.phone_otp_sessions otp
    WHERE otp.id = p_otp_session_id AND otp.salon_id = p_salon_id
      AND public.canonical_phone(otp.phone) = v_phone
      AND otp.verified_channel = 'sms' FOR UPDATE;
  ELSE
    SELECT otp.* INTO v_session FROM public.phone_otp_sessions otp
    WHERE otp.id = p_otp_session_id AND otp.salon_id = p_salon_id
      AND public.canonical_phone(otp.phone) = v_phone
      AND otp.verified_channel = 'sms';
  END IF;
  IF NOT FOUND THEN RETURN false; END IF;
  -- Read wall-clock time after lock acquisition; transaction time can be stale.
  v_now := clock_timestamp();
  RETURN coalesce(
    v_session.salon_id = p_salon_id
    AND public.canonical_phone(v_session.phone) = v_phone
    AND v_session.verified_channel = 'sms'
    AND isfinite(v_session.verified_at) AND isfinite(v_session.expires_at)
    AND v_session.verified_at <= v_now AND v_now < v_session.expires_at
    AND v_session.consumed_at IS NULL
    AND v_session.consumed_by_booking_id IS NULL,
    false
  );
END;
$proof$;
REVOKE ALL ON FUNCTION public.booking_incentive_phone_ownership(uuid,uuid,text,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.booking_incentive_phone_ownership(uuid,uuid,text,boolean) TO service_role;
COMMENT ON FUNCTION public.booking_incentive_phone_ownership(uuid,uuid,text,boolean)
IS 'Fresh exact SMS authority. Commit callers must take canonical client advisory/profile locks before requesting the OTP row lock. No legacy profile timestamp or JWT role grants phone ownership.';


-- resolve_public_booking_pricing: new explicit-proof overload and legacy NULL wrapper.
DO $migration$
DECLARE v_definition text;
BEGIN
  v_definition := pg_get_functiondef('public.resolve_public_booking_pricing(uuid, uuid, uuid, timestamp with time zone, timestamp with time zone, uuid[], uuid, uuid, text, text, boolean, boolean)'::regprocedure);
  IF md5(rtrim(v_definition, E' \n\r\t')) <> '0b54ff55f18d1199de411b66cef73709' THEN
    RAISE EXCEPTION 'R09 source drift: resolve_public_booking_pricing-12';
  END IF;
  v_definition := replace(v_definition, $old0$CREATE OR REPLACE FUNCTION public.resolve_public_booking_pricing(p_salon_id uuid, p_service_id uuid, p_staff_id uuid, p_start_time_utc timestamp with time zone, p_end_time_utc timestamp with time zone, p_addon_service_ids uuid[], p_combo_id uuid, p_voucher_id uuid, p_client_phone text, p_client_email text, p_apply_email_discount boolean, p_lock_claims boolean DEFAULT false)$old0$, $new0$CREATE OR REPLACE FUNCTION public.resolve_public_booking_pricing(p_salon_id uuid, p_service_id uuid, p_staff_id uuid, p_start_time_utc timestamp with time zone, p_end_time_utc timestamp with time zone, p_addon_service_ids uuid[], p_combo_id uuid, p_voucher_id uuid, p_client_phone text, p_client_email text, p_apply_email_discount boolean, p_lock_claims boolean, p_otp_session_id uuid)$new0$);
  v_definition := replace(v_definition, $old1$'public-booking-client:' || v_digits$old1$, $new1$'public-booking-client:' || public.canonical_phone(v_digits)$new1$);
  v_definition := replace(v_definition, $old2$cp.phone = v_digits$old2$, $new2$cp.phone = public.canonical_phone(v_digits)$new2$);
  v_definition := replace(v_definition, $old3$regexp_replace(v_voucher_row.client_phone, '\D', '', 'g') <> v_digits$old3$, $new3$public.canonical_phone(v_voucher_row.client_phone) <> public.canonical_phone(v_digits)$new3$);
  v_definition := replace(v_definition, $old4$  IF p_lock_claims
     AND (
       p_voucher_id IS NOT NULL
       OR (
         p_apply_email_discount IS TRUE
         AND nullif(trim(coalesce(p_client_email, '')), '') IS NOT NULL
       )
     ) THEN$old4$, $new4$  IF p_lock_claims THEN$new4$);
  v_definition := replace(v_definition, $old5$  IF p_lock_claims
     AND (
       p_voucher_id IS NOT NULL
       OR p_apply_email_discount IS TRUE
     ) THEN$old5$, $new5$  IF p_lock_claims THEN$new5$);
  v_definition := replace(v_definition, $old6$  IF p_apply_email_discount IS TRUE
     AND nullif$old6$, $new6$  IF p_apply_email_discount IS TRUE
     AND NOT public.booking_incentive_phone_ownership(
       p_otp_session_id, p_salon_id, p_client_phone, p_lock_claims
     ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'phone_verification_required');
  END IF;

  IF p_apply_email_discount IS TRUE
     AND nullif$new6$);
  v_definition := replace(v_definition, $old7$    IF NOT FOUND
       OR v_voucher_row.salon_id$old7$, $new7$    -- A personalized voucher is not a bearer coupon: prove its declared phone.
    IF (v_voucher_row.client_phone IS NOT NULL OR v_voucher_row.client_profile_id IS NOT NULL)
       AND NOT public.booking_incentive_phone_ownership(
         p_otp_session_id, p_salon_id, p_client_phone, p_lock_claims
       ) THEN
      RETURN jsonb_build_object('success', false, 'code', 'phone_verification_required');
    END IF;

    IF NOT FOUND
       OR v_voucher_row.salon_id$new7$);
  EXECUTE v_definition;
END;
$migration$;
CREATE OR REPLACE FUNCTION public.resolve_public_booking_pricing(p_salon_id uuid, p_service_id uuid, p_staff_id uuid, p_start_time_utc timestamp with time zone, p_end_time_utc timestamp with time zone, p_addon_service_ids uuid[], p_combo_id uuid, p_voucher_id uuid, p_client_phone text, p_client_email text, p_apply_email_discount boolean, p_lock_claims boolean DEFAULT false)
 RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path TO ''
AS $legacy$
  SELECT public.resolve_public_booking_pricing(p_salon_id, p_service_id, p_staff_id, p_start_time_utc, p_end_time_utc, p_addon_service_ids, p_combo_id, p_voucher_id, p_client_phone, p_client_email, p_apply_email_discount, p_lock_claims, NULL::uuid);
$legacy$;
REVOKE ALL ON FUNCTION public.resolve_public_booking_pricing(uuid, uuid, uuid, timestamp with time zone, timestamp with time zone, uuid[], uuid, uuid, text, text, boolean, boolean, uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_public_booking_pricing(uuid, uuid, uuid, timestamp with time zone, timestamp with time zone, uuid[], uuid, uuid, text, text, boolean, boolean, uuid) TO service_role;


-- quote_public_booking: new explicit-proof overload and legacy NULL wrapper.
DO $migration$
DECLARE v_definition text;
BEGIN
  v_definition := pg_get_functiondef('public.quote_public_booking(uuid, uuid, uuid, timestamp with time zone, timestamp with time zone, uuid[], uuid, uuid, text, text, boolean)'::regprocedure);
  IF md5(rtrim(v_definition, E' \n\r\t')) <> 'dbf487b2c7b1a3752977e0e9ae5be4d4' THEN
    RAISE EXCEPTION 'R09 source drift: quote_public_booking-11';
  END IF;
  v_definition := replace(v_definition, $old0$CREATE OR REPLACE FUNCTION public.quote_public_booking(p_salon_id uuid, p_service_id uuid, p_staff_id uuid, p_start_time_utc timestamp with time zone, p_end_time_utc timestamp with time zone, p_addon_service_ids uuid[], p_combo_id uuid, p_voucher_id uuid, p_client_phone text, p_client_email text, p_apply_email_discount boolean)$old0$, $new0$CREATE OR REPLACE FUNCTION public.quote_public_booking(p_salon_id uuid, p_service_id uuid, p_staff_id uuid, p_start_time_utc timestamp with time zone, p_end_time_utc timestamp with time zone, p_addon_service_ids uuid[], p_combo_id uuid, p_voucher_id uuid, p_client_phone text, p_client_email text, p_apply_email_discount boolean, p_otp_session_id uuid)$new0$);
  v_definition := replace(v_definition, $old1$p_client_email, p_apply_email_discount, false$old1$, $new1$p_client_email, p_apply_email_discount, false, p_otp_session_id$new1$);
  EXECUTE v_definition;
END;
$migration$;
CREATE OR REPLACE FUNCTION public.quote_public_booking(p_salon_id uuid, p_service_id uuid, p_staff_id uuid, p_start_time_utc timestamp with time zone, p_end_time_utc timestamp with time zone, p_addon_service_ids uuid[], p_combo_id uuid, p_voucher_id uuid, p_client_phone text, p_client_email text, p_apply_email_discount boolean)
 RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path TO ''
AS $legacy$
  SELECT public.quote_public_booking(p_salon_id, p_service_id, p_staff_id, p_start_time_utc, p_end_time_utc, p_addon_service_ids, p_combo_id, p_voucher_id, p_client_phone, p_client_email, p_apply_email_discount, NULL::uuid);
$legacy$;
REVOKE ALL ON FUNCTION public.quote_public_booking(uuid, uuid, uuid, timestamp with time zone, timestamp with time zone, uuid[], uuid, uuid, text, text, boolean, uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.quote_public_booking(uuid, uuid, uuid, timestamp with time zone, timestamp with time zone, uuid[], uuid, uuid, text, text, boolean, uuid) TO service_role;


-- resolve_group_booking_pricing: new explicit-proof overload and legacy NULL wrapper.
DO $migration$
DECLARE v_definition text;
BEGIN
  v_definition := pg_get_functiondef('public.resolve_group_booking_pricing(uuid, jsonb, uuid, text, text, boolean, boolean)'::regprocedure);
  IF md5(rtrim(v_definition, E' \n\r\t')) <> 'bf1ea38e21b15128a8d76969bb233fb4' THEN
    RAISE EXCEPTION 'R09 source drift: resolve_group_booking_pricing-7';
  END IF;
  v_definition := replace(v_definition, $old0$CREATE OR REPLACE FUNCTION public.resolve_group_booking_pricing(p_salon_id uuid, p_bookings jsonb, p_voucher_id uuid, p_client_phone text, p_client_email text, p_apply_email_discount boolean, p_lock_claims boolean DEFAULT false)$old0$, $new0$CREATE OR REPLACE FUNCTION public.resolve_group_booking_pricing(p_salon_id uuid, p_bookings jsonb, p_voucher_id uuid, p_client_phone text, p_client_email text, p_apply_email_discount boolean, p_lock_claims boolean, p_otp_session_id uuid)$new0$);
  v_definition := replace(v_definition, $old1$'public-booking-client:' || v_member_phone$old1$, $new1$'public-booking-client:' || public.canonical_phone(v_member_phone)$new1$);
  v_definition := replace(v_definition, $old2$SELECT DISTINCT n.value->>'client_phone'$old2$, $new2$SELECT DISTINCT public.canonical_phone(n.value->>'client_phone')$new2$);
  v_definition := replace(v_definition, $old3$ORDER BY n.value->>'client_phone'$old3$, $new3$ORDER BY public.canonical_phone(n.value->>'client_phone')$new3$);
  v_definition := replace(v_definition, $old4$cp.phone = v_digits$old4$, $new4$cp.phone = public.canonical_phone(v_digits)$new4$);
  v_definition := replace(v_definition, $old5$  SELECT cp.id, cp.email_discount_claimed_at
  INTO v_profile_id$old5$, $new5$  IF p_apply_email_discount IS TRUE
     AND NOT public.booking_incentive_phone_ownership(
       p_otp_session_id, p_salon_id, p_client_phone, p_lock_claims
     ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'phone_verification_required');
  END IF;

  SELECT cp.id, cp.email_discount_claimed_at
  INTO v_profile_id$new5$);
  EXECUTE v_definition;
END;
$migration$;
CREATE OR REPLACE FUNCTION public.resolve_group_booking_pricing(p_salon_id uuid, p_bookings jsonb, p_voucher_id uuid, p_client_phone text, p_client_email text, p_apply_email_discount boolean, p_lock_claims boolean DEFAULT false)
 RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path TO ''
AS $legacy$
  SELECT public.resolve_group_booking_pricing(p_salon_id, p_bookings, p_voucher_id, p_client_phone, p_client_email, p_apply_email_discount, p_lock_claims, NULL::uuid);
$legacy$;
REVOKE ALL ON FUNCTION public.resolve_group_booking_pricing(uuid, jsonb, uuid, text, text, boolean, boolean, uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_group_booking_pricing(uuid, jsonb, uuid, text, text, boolean, boolean, uuid) TO service_role;


-- quote_group_booking: new explicit-proof overload and legacy NULL wrapper.
DO $migration$
DECLARE v_definition text;
BEGIN
  v_definition := pg_get_functiondef('public.quote_group_booking(uuid, jsonb, uuid, text, text, boolean)'::regprocedure);
  IF md5(rtrim(v_definition, E' \n\r\t')) <> 'aaa1c771a161cd3f92e5e67e29612b2d' THEN
    RAISE EXCEPTION 'R09 source drift: quote_group_booking-6';
  END IF;
  v_definition := replace(v_definition, $old0$CREATE OR REPLACE FUNCTION public.quote_group_booking(p_salon_id uuid, p_bookings jsonb, p_voucher_id uuid, p_client_phone text, p_client_email text, p_apply_email_discount boolean)$old0$, $new0$CREATE OR REPLACE FUNCTION public.quote_group_booking(p_salon_id uuid, p_bookings jsonb, p_voucher_id uuid, p_client_phone text, p_client_email text, p_apply_email_discount boolean, p_otp_session_id uuid)$new0$);
  v_definition := replace(v_definition, $old1$    p_apply_email_discount,
    false$old1$, $new1$    p_apply_email_discount,
    false,
    p_otp_session_id$new1$);
  EXECUTE v_definition;
END;
$migration$;
CREATE OR REPLACE FUNCTION public.quote_group_booking(p_salon_id uuid, p_bookings jsonb, p_voucher_id uuid, p_client_phone text, p_client_email text, p_apply_email_discount boolean)
 RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path TO ''
AS $legacy$
  SELECT public.quote_group_booking(p_salon_id, p_bookings, p_voucher_id, p_client_phone, p_client_email, p_apply_email_discount, NULL::uuid);
$legacy$;
REVOKE ALL ON FUNCTION public.quote_group_booking(uuid, jsonb, uuid, text, text, boolean, uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.quote_group_booking(uuid, jsonb, uuid, text, text, boolean, uuid) TO service_role;


-- create_public_booking: new explicit-proof overload and legacy NULL wrapper.
DO $migration$
DECLARE v_definition text;
BEGIN
  v_definition := pg_get_functiondef('public.create_public_booking(uuid, uuid, uuid, text, text, timestamp with time zone, timestamp with time zone, text, text, uuid[], text, uuid, uuid, uuid, boolean, uuid, text)'::regprocedure);
  IF md5(rtrim(v_definition, E' \n\r\t')) <> 'b9fca0558f3662eb08c656cd849dfa5e' THEN
    RAISE EXCEPTION 'R09 source drift: create_public_booking-17';
  END IF;
  v_definition := replace(v_definition, $old0$CREATE OR REPLACE FUNCTION public.create_public_booking(p_salon_id uuid, p_service_id uuid, p_staff_id uuid, p_client_name text, p_client_phone text, p_start_time_utc timestamp with time zone, p_end_time_utc timestamp with time zone, p_status text, p_client_notes text, p_addon_service_ids uuid[], p_client_email text, p_resource_id uuid, p_combo_id uuid, p_voucher_id uuid, p_apply_email_discount boolean, p_idempotency_key uuid, p_expected_pricing_fingerprint text)$old0$, $new0$CREATE OR REPLACE FUNCTION public.create_public_booking(p_salon_id uuid, p_service_id uuid, p_staff_id uuid, p_client_name text, p_client_phone text, p_start_time_utc timestamp with time zone, p_end_time_utc timestamp with time zone, p_status text, p_client_notes text, p_addon_service_ids uuid[], p_client_email text, p_resource_id uuid, p_combo_id uuid, p_voucher_id uuid, p_apply_email_discount boolean, p_idempotency_key uuid, p_expected_pricing_fingerprint text, p_otp_session_id uuid)$new0$);
  v_definition := replace(v_definition, $old1$cp.phone = v_digits$old1$, $new1$cp.phone = public.canonical_phone(v_digits)$new1$);
  v_definition := replace(v_definition, $old2$  v_pre_voucher_subtotal integer;$old2$, $new2$  v_sms_proven boolean := false;
  v_sms_verified_at timestamptz;
  v_incentive_commit_at timestamptz;
  v_profile_id uuid;
  v_pre_voucher_subtotal integer;$new2$);
  v_definition := replace(v_definition, $old3$    p_apply_email_discount, true
$old3$, $new3$    p_apply_email_discount, true, p_otp_session_id
$new3$);
  v_definition := replace(v_definition, $old4$  v_trailing_buffer := coalesce$old4$, $new4$  v_sms_proven := public.booking_incentive_phone_ownership(
    p_otp_session_id, p_salon_id, p_client_phone, true
  );
  IF v_sms_proven THEN
    SELECT otp.verified_at INTO v_sms_verified_at
    FROM public.phone_otp_sessions otp WHERE otp.id = p_otp_session_id;
  END IF;

  IF NOT v_sms_proven AND (
    p_apply_email_discount IS TRUE OR EXISTS (
      SELECT 1 FROM public.vouchers v WHERE v.id = p_voucher_id
        AND (v.client_phone IS NOT NULL OR v.client_profile_id IS NOT NULL)
    )
  ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'phone_verification_required');
  END IF;

  v_trailing_buffer := coalesce$new4$);
  v_definition := replace(v_definition, $old5$    UPDATE public.bookings b
    SET end_time_utc$old5$, $new5$    -- Raw insert may return a normal failure; CRM resolution belongs after success
    -- inside this same subtransaction, so a failed booking cannot increment history.
    IF v_sms_proven THEN
      v_profile_id := public.resolve_client_profile(
        v_digits, trim(p_client_name),
        nullif(lower(trim(coalesce(p_client_email, ''))), ''), p_staff_id
      );
    END IF;

    UPDATE public.bookings b
    SET end_time_utc$new5$);
  v_definition := replace(v_definition, $old6$    SET end_time_utc = p_end_time_utc,$old6$, $new6$    SET client_profile_id = v_profile_id,
        is_party_member = false,
        end_time_utc = p_end_time_utc,$new6$);
  v_definition := replace(v_definition, $old7$    IF v_email_discount > 0 THEN$old7$, $new7$    IF v_sms_proven THEN
      -- Quote locked this exact SMS session. Consume in the booking transaction.
      v_incentive_commit_at := clock_timestamp();
      UPDATE public.phone_otp_sessions otp
      SET consumed_at = v_incentive_commit_at, consumed_by_booking_id = v_booking_id
      WHERE otp.id = p_otp_session_id AND otp.consumed_at IS NULL
        AND otp.consumed_by_booking_id IS NULL
        AND otp.verified_channel = 'sms'
        AND isfinite(otp.verified_at) AND isfinite(otp.expires_at)
        AND otp.verified_at <= v_incentive_commit_at AND v_incentive_commit_at < otp.expires_at;
      IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'NIOTP', MESSAGE = 'booking_sms_expired_before_commit';
      END IF;
      UPDATE public.bookings b
      SET otp_session_id = p_otp_session_id, verification_method = 'otp',
          verification_completed_at = v_sms_verified_at
      WHERE b.id = v_booking_id AND b.salon_id = p_salon_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'booking_sms_binding_invariant'; END IF;
    END IF;

    IF v_email_discount > 0 THEN$new7$);
  v_definition := replace(v_definition, $old8$  EXCEPTION
    WHEN exclusion_violation THEN$old8$, $new8$  EXCEPTION
    WHEN SQLSTATE 'NIOTP' THEN
      RETURN jsonb_build_object('success', false, 'code', 'phone_verification_required');
    WHEN exclusion_violation THEN$new8$);
  EXECUTE v_definition;
END;
$migration$;
CREATE OR REPLACE FUNCTION public.create_public_booking(p_salon_id uuid, p_service_id uuid, p_staff_id uuid, p_client_name text, p_client_phone text, p_start_time_utc timestamp with time zone, p_end_time_utc timestamp with time zone, p_status text, p_client_notes text, p_addon_service_ids uuid[], p_client_email text, p_resource_id uuid, p_combo_id uuid, p_voucher_id uuid, p_apply_email_discount boolean, p_idempotency_key uuid, p_expected_pricing_fingerprint text)
 RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path TO ''
AS $legacy$
  SELECT public.create_public_booking(p_salon_id, p_service_id, p_staff_id, p_client_name, p_client_phone, p_start_time_utc, p_end_time_utc, p_status, p_client_notes, p_addon_service_ids, p_client_email, p_resource_id, p_combo_id, p_voucher_id, p_apply_email_discount, p_idempotency_key, p_expected_pricing_fingerprint, NULL::uuid);
$legacy$;
REVOKE ALL ON FUNCTION public.create_public_booking(uuid, uuid, uuid, text, text, timestamp with time zone, timestamp with time zone, text, text, uuid[], text, uuid, uuid, uuid, boolean, uuid, text, uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.create_public_booking(uuid, uuid, uuid, text, text, timestamp with time zone, timestamp with time zone, text, text, uuid[], text, uuid, uuid, uuid, boolean, uuid, text, uuid) TO anon,service_role;


-- create_group_bookings: new explicit-proof overload and legacy NULL wrapper.
DO $migration$
DECLARE v_definition text;
BEGIN
  v_definition := pg_get_functiondef('public.create_group_bookings(uuid, jsonb, uuid, text, text, boolean, uuid, text)'::regprocedure);
  IF md5(rtrim(v_definition, E' \n\r\t')) <> '0ec864ab64c0aa58fd476f247c3bb684' THEN
    RAISE EXCEPTION 'R09 source drift: create_group_bookings-8';
  END IF;
  v_definition := replace(v_definition, $old0$CREATE OR REPLACE FUNCTION public.create_group_bookings(p_salon_id uuid, p_bookings jsonb, p_voucher_id uuid, p_client_phone text, p_client_email text, p_apply_email_discount boolean, p_group_idempotency_key uuid, p_expected_pricing_fingerprint text)$old0$, $new0$CREATE OR REPLACE FUNCTION public.create_group_bookings(p_salon_id uuid, p_bookings jsonb, p_voucher_id uuid, p_client_phone text, p_client_email text, p_apply_email_discount boolean, p_group_idempotency_key uuid, p_expected_pricing_fingerprint text, p_otp_session_id uuid)$new0$);
  v_definition := replace(v_definition, $old1$cp.phone = v_digits$old1$, $new1$cp.phone = public.canonical_phone(v_digits)$new1$);
  v_definition := replace(v_definition, $old2$  v_persisted_snapshot jsonb;$old2$, $new2$  v_sms_proven boolean := false;
  v_sms_verified_at timestamptz;
  v_incentive_commit_at timestamptz;
  v_persisted_snapshot jsonb;$new2$);
  v_definition := replace(v_definition, $old3$    p_apply_email_discount,
    true$old3$, $new3$    p_apply_email_discount,
    true,
    p_otp_session_id$new3$);
  v_definition := replace(v_definition, $old4$  v_group_size := (v_quote$old4$, $new4$  v_sms_proven := public.booking_incentive_phone_ownership(
    p_otp_session_id, p_salon_id, p_client_phone, true
  );
  IF v_sms_proven THEN
    SELECT otp.verified_at INTO v_sms_verified_at
    FROM public.phone_otp_sessions otp WHERE otp.id = p_otp_session_id;
  END IF;

  IF NOT v_sms_proven AND (
    p_apply_email_discount IS TRUE OR EXISTS (
      SELECT 1 FROM public.vouchers v WHERE v.id = p_voucher_id
        AND (v.client_phone IS NOT NULL OR v.client_profile_id IS NOT NULL)
    )
  ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'phone_verification_required');
  END IF;

  v_group_size := (v_quote$new4$);
  v_definition := replace(v_definition, $old5$      IF v_member_phone IS NOT NULL THEN$old5$, $new5$      IF v_member_index = 0 AND v_sms_proven AND v_member_phone IS NOT NULL THEN$new5$);
  v_definition := replace(v_definition, $old6$        v_profile_id IS NULL,
        v_member_index = 0,$old6$, $new6$        v_member_phone IS NULL,
        v_member_index = 0,$new6$);
  v_definition := replace(v_definition, $old7$    IF (v_quote->>'email_discount_cents')::integer > 0 THEN$old7$, $new7$    IF v_sms_proven THEN
      -- Quote locked this exact SMS session. Consume in the booking transaction.
      v_incentive_commit_at := clock_timestamp();
      UPDATE public.phone_otp_sessions otp
      SET consumed_at = v_incentive_commit_at, consumed_by_booking_id = v_organizer_booking_id
      WHERE otp.id = p_otp_session_id AND otp.consumed_at IS NULL
        AND otp.consumed_by_booking_id IS NULL
        AND otp.verified_channel = 'sms'
        AND isfinite(otp.verified_at) AND isfinite(otp.expires_at)
        AND otp.verified_at <= v_incentive_commit_at AND v_incentive_commit_at < otp.expires_at;
      IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'NIOTP', MESSAGE = 'booking_sms_expired_before_commit';
      END IF;
      UPDATE public.bookings b
      SET otp_session_id = p_otp_session_id, verification_method = 'otp',
          verification_completed_at = v_sms_verified_at
      WHERE b.id = v_organizer_booking_id AND b.salon_id = p_salon_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'booking_sms_binding_invariant'; END IF;
    END IF;

    IF (v_quote->>'email_discount_cents')::integer > 0 THEN$new7$);
  v_definition := replace(v_definition, $old8$  EXCEPTION
    WHEN exclusion_violation THEN$old8$, $new8$  EXCEPTION
    WHEN SQLSTATE 'NIOTP' THEN
      RETURN jsonb_build_object('success', false, 'code', 'phone_verification_required');
    WHEN exclusion_violation THEN$new8$);
  EXECUTE v_definition;
END;
$migration$;
CREATE OR REPLACE FUNCTION public.create_group_bookings(p_salon_id uuid, p_bookings jsonb, p_voucher_id uuid, p_client_phone text, p_client_email text, p_apply_email_discount boolean, p_group_idempotency_key uuid, p_expected_pricing_fingerprint text)
 RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path TO ''
AS $legacy$
  SELECT public.create_group_bookings(p_salon_id, p_bookings, p_voucher_id, p_client_phone, p_client_email, p_apply_email_discount, p_group_idempotency_key, p_expected_pricing_fingerprint, NULL::uuid);
$legacy$;
REVOKE ALL ON FUNCTION public.create_group_bookings(uuid, jsonb, uuid, text, text, boolean, uuid, text, uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.create_group_bookings(uuid, jsonb, uuid, text, text, boolean, uuid, text, uuid) TO service_role;


-- resolve_booking_sequence_pricing_and_schedule: proof propagation without changing request/pricing fingerprints.
DO $migration$
DECLARE v_definition text;
BEGIN
  v_definition := pg_get_functiondef('public.resolve_booking_sequence_pricing_and_schedule(jsonb, boolean)'::regprocedure);
  IF md5(rtrim(v_definition, E' \n\r\t')) <> '0a686d28dc07a05bb8f3bd46daf0020f' THEN
    RAISE EXCEPTION 'R09 source drift: resolve_booking_sequence_pricing_and_schedule-2';
  END IF;
  v_definition := replace(v_definition, $old0$'public-booking-client:' || v_client_phone$old0$, $new0$'public-booking-client:' || public.canonical_phone(v_client_phone)$new0$);
  v_definition := replace(v_definition, $old1$cp.phone = v_client_phone$old1$, $new1$cp.phone = public.canonical_phone(v_client_phone)$new1$);
  v_definition := replace(v_definition, $old2$pg_catalog.regexp_replace(v_voucher.client_phone, '\D', '', 'g') <> v_client_phone$old2$, $new2$public.canonical_phone(v_voucher.client_phone) <> public.canonical_phone(v_client_phone)$new2$);
  v_definition := replace(v_definition, $old3$  v_request_id uuid;$old3$, $new3$  v_otp_session_id uuid;
  v_request_id uuid;$new3$);
  v_definition := replace(v_definition, $old4$    v_request_id := nullif(p_request->>'request_id', '')::uuid;$old4$, $new4$    IF p_request ? 'otp_session_id' AND p_request->'otp_session_id' <> 'null'::jsonb
       AND jsonb_typeof(p_request->'otp_session_id') <> 'string' THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_input');
    END IF;
    v_otp_session_id := nullif(trim(coalesce(p_request->>'otp_session_id', '')), '')::uuid;
    v_request_id := nullif(p_request->>'request_id', '')::uuid;$new4$);
  v_definition := replace(v_definition, $old5$  SELECT cp.id, cp.email_discount_claimed_at
  INTO v_profile_id$old5$, $new5$  IF v_apply_email
     AND NOT public.booking_incentive_phone_ownership(
       v_otp_session_id, v_salon_id, v_client_phone, p_lock_claims
     ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'phone_verification_required');
  END IF;

  SELECT cp.id, cp.email_discount_claimed_at
  INTO v_profile_id$new5$);
  v_definition := replace(v_definition, $old6$    IF NOT FOUND OR v_voucher.salon_id <> v_salon_id$old6$, $new6$    IF (v_voucher.client_phone IS NOT NULL OR v_voucher.client_profile_id IS NOT NULL)
       AND NOT public.booking_incentive_phone_ownership(
         v_otp_session_id, v_salon_id, v_client_phone, p_lock_claims
       ) THEN
      RETURN jsonb_build_object('success', false, 'code', 'phone_verification_required');
    END IF;
    IF NOT FOUND OR v_voucher.salon_id <> v_salon_id$new6$);
  EXECUTE v_definition;
END;
$migration$;


-- resolve_public_group_sequence_quote: proof propagation without changing request/pricing fingerprints.
DO $migration$
DECLARE v_definition text;
BEGIN
  v_definition := pg_get_functiondef('public.resolve_public_group_sequence_quote(jsonb, boolean)'::regprocedure);
  IF md5(rtrim(v_definition, E' \n\r\t')) <> '7512114b189ac2af26e8c12a69aadc6e' THEN
    RAISE EXCEPTION 'R09 source drift: resolve_public_group_sequence_quote-2';
  END IF;
  v_definition := replace(v_definition, $old0$       'apply_email_discount'
$old0$, $new0$       'apply_email_discount', 'otp_session_id'
$new0$);
  v_definition := replace(v_definition, $old1$      'apply_email_discount', v_member_index = 0 AND v_apply_email_discount
$old1$, $new1$      'apply_email_discount', v_member_index = 0 AND v_apply_email_discount,
      'otp_session_id', CASE WHEN v_member_index = 0 THEN p_request->'otp_session_id' ELSE NULL END
$new1$);
  v_definition := replace(v_definition, $old2$        'code', 'member_quote_failed',$old2$, $new2$        'code', CASE WHEN v_sequence_quote->>'code' = 'phone_verification_required'
          THEN 'phone_verification_required' ELSE 'member_quote_failed' END,$new2$);
  EXECUTE v_definition;
END;
$migration$;


-- create_public_booking_sequence: proof propagation without changing request/pricing fingerprints.
DO $migration$
DECLARE v_definition text;
BEGIN
  v_definition := pg_get_functiondef('public.create_public_booking_sequence(jsonb)'::regprocedure);
  IF md5(rtrim(v_definition, E' \n\r\t')) <> '6cc220fdded22eb12835d01db41fe026' THEN
    RAISE EXCEPTION 'R09 source drift: create_public_booking_sequence-1';
  END IF;
  v_definition := replace(v_definition, $old0$  v_otp_session_id uuid;$old0$, $new0$  v_incentive_commit_at timestamptz;
  v_otp_session_id uuid;$new0$);
  v_definition := replace(v_definition, $old1$cp.phone = v_digits$old1$, $new1$cp.phone = public.canonical_phone(v_digits)$new1$);
  v_definition := replace(v_definition, $old2$  IF v_phone_otp_enabled THEN
    IF v_otp_session_id IS NULL THEN$old2$, $new2$  -- Optional verified SMS can authorize incentives/identity while booking OTP is OFF.
  v_phone_otp_enabled := v_phone_otp_enabled OR v_otp_session_id IS NOT NULL;

  IF v_phone_otp_enabled THEN
    IF v_otp_session_id IS NULL THEN$new2$);
  v_definition := replace(v_definition, $old3$    IF v_phone_otp_enabled THEN
      UPDATE public.phone_otp_sessions otp
      SET consumed_at = transaction_timestamp(),$old3$, $new3$    IF v_phone_otp_enabled THEN
      v_incentive_commit_at := clock_timestamp();
      UPDATE public.phone_otp_sessions otp
      SET consumed_at = v_incentive_commit_at,$new3$);
  v_definition := replace(v_definition, $old4$        AND otp.consumed_by_booking_id IS NULL;$old4$, $new4$        AND otp.consumed_by_booking_id IS NULL
        AND isfinite(otp.verified_at) AND isfinite(otp.expires_at)
        AND otp.verified_at <= v_incentive_commit_at AND v_incentive_commit_at < otp.expires_at;$new4$);
  v_definition := replace(v_definition, $old5$RAISE EXCEPTION 'sequence OTP consumption invariant failed';$old5$, $new5$RAISE EXCEPTION USING ERRCODE = 'NIOTP', MESSAGE = 'booking_sms_expired_before_commit';$new5$);
  v_definition := replace(v_definition, $old6$  EXCEPTION
    WHEN exclusion_violation THEN$old6$, $new6$  EXCEPTION
    WHEN SQLSTATE 'NIOTP' THEN
      RETURN jsonb_build_object('success', false, 'code', 'phone_verification_required');
    WHEN exclusion_violation THEN$new6$);
  EXECUTE v_definition;
END;
$migration$;


-- create_public_group_booking_sequences: proof propagation without changing request/pricing fingerprints.
DO $migration$
DECLARE v_definition text;
BEGIN
  v_definition := pg_get_functiondef('public.create_public_group_booking_sequences(jsonb)'::regprocedure);
  IF md5(rtrim(v_definition, E' \n\r\t')) <> '70c775d3dc8f6449582af5b523806428' THEN
    RAISE EXCEPTION 'R09 source drift: create_public_group_booking_sequences-1';
  END IF;
  v_definition := replace(v_definition, $old0$  v_otp_session_id uuid;$old0$, $new0$  v_incentive_commit_at timestamptz;
  v_otp_session_id uuid;$new0$);
  v_definition := replace(v_definition, $old1$cp.phone = v_organizer_phone$old1$, $new1$cp.phone = public.canonical_phone(v_organizer_phone)$new1$);
  v_definition := replace(v_definition, $old2$  IF v_phone_otp_enabled THEN
    IF v_otp_session_id IS NULL THEN$old2$, $new2$  -- Optional verified SMS can authorize incentives/identity while booking OTP is OFF.
  v_phone_otp_enabled := v_phone_otp_enabled OR v_otp_session_id IS NOT NULL;

  IF v_phone_otp_enabled THEN
    IF v_otp_session_id IS NULL THEN$new2$);
  v_definition := replace(v_definition, $old3$    IF v_phone_otp_enabled THEN
      UPDATE public.phone_otp_sessions otp
      SET consumed_at = transaction_timestamp(),$old3$, $new3$    IF v_phone_otp_enabled THEN
      v_incentive_commit_at := clock_timestamp();
      UPDATE public.phone_otp_sessions otp
      SET consumed_at = v_incentive_commit_at,$new3$);
  v_definition := replace(v_definition, $old4$        AND otp.consumed_by_booking_id IS NULL;$old4$, $new4$        AND otp.consumed_by_booking_id IS NULL
        AND isfinite(otp.verified_at) AND isfinite(otp.expires_at)
        AND otp.verified_at <= v_incentive_commit_at AND v_incentive_commit_at < otp.expires_at;$new4$);
  v_definition := replace(v_definition, $old5$RAISE EXCEPTION 'group sequence OTP consumption invariant failed';$old5$, $new5$RAISE EXCEPTION USING ERRCODE = 'NIOTP', MESSAGE = 'booking_sms_expired_before_commit';$new5$);
  v_definition := replace(v_definition, $old6$  EXCEPTION
    WHEN exclusion_violation THEN$old6$, $new6$  EXCEPTION
    WHEN SQLSTATE 'NIOTP' THEN
      RETURN jsonb_build_object('success', false, 'code', 'phone_verification_required');
    WHEN exclusion_violation THEN$new6$);
  v_definition := replace(v_definition, $old7$  v_quote := public.resolve_public_group_sequence_quote($old7$, $new7$  -- Preserve the existing durable request fingerprint; proof is quote authorization only.
  v_quote_request := v_quote_request || jsonb_build_object('otp_session_id', v_otp_session_id);
  v_quote := public.resolve_public_group_sequence_quote($new7$);
  EXECUTE v_definition;
END;
$migration$;


-- resolve_public_deposit_payment_material: new explicit-proof overload and legacy NULL wrapper.
DO $migration$
DECLARE v_definition text;
BEGIN
  v_definition := pg_get_functiondef('public.resolve_public_deposit_payment_material(uuid, uuid, uuid, timestamp with time zone, timestamp with time zone, uuid[], uuid, uuid, text, text, boolean, uuid, text)'::regprocedure);
  IF md5(rtrim(v_definition, E' \n\r\t')) <> 'da0a18d9bf29d5f843779636c059705f' THEN
    RAISE EXCEPTION 'R09 source drift: resolve_public_deposit_payment_material-13';
  END IF;
  v_definition := replace(v_definition, $old0$CREATE OR REPLACE FUNCTION public.resolve_public_deposit_payment_material(p_salon_id uuid, p_service_id uuid, p_staff_id uuid, p_start_time_utc timestamp with time zone, p_end_time_utc timestamp with time zone, p_addon_service_ids uuid[], p_combo_id uuid, p_voucher_id uuid, p_client_phone text, p_client_email text, p_apply_email_discount boolean, p_booking_idempotency_key uuid, p_expected_pricing_fingerprint text)$old0$, $new0$CREATE OR REPLACE FUNCTION public.resolve_public_deposit_payment_material(p_salon_id uuid, p_service_id uuid, p_staff_id uuid, p_start_time_utc timestamp with time zone, p_end_time_utc timestamp with time zone, p_addon_service_ids uuid[], p_combo_id uuid, p_voucher_id uuid, p_client_phone text, p_client_email text, p_apply_email_discount boolean, p_booking_idempotency_key uuid, p_expected_pricing_fingerprint text, p_otp_session_id uuid)$new0$);
  v_definition := replace(v_definition, $old1$  v_client record;$old1$, $new1$  v_client_known boolean := false;
  v_client record;$new1$);
  v_definition := replace(v_definition, $old2$p_client_phone,p_client_email,coalesce(p_apply_email_discount,false),false$old2$, $new2$p_client_phone,p_client_email,coalesce(p_apply_email_discount,false),false,p_otp_session_id$new2$);
  v_definition := replace(v_definition, $old3$  SELECT * INTO v_client FROM public.get_booking_client_snapshot(p_salon_id,v_phone) LIMIT 1;$old3$, $new3$  IF public.booking_incentive_phone_ownership(p_otp_session_id,p_salon_id,p_client_phone,false) THEN
    SELECT * INTO v_client FROM public.get_booking_client_snapshot(p_salon_id,v_phone) LIMIT 1;
    v_client_known := FOUND;
  ELSE
    -- A typed record is still needed for safe short-circuit-independent field access.
    SELECT false AS is_vip, 0::integer AS no_show_count, 0::integer AS visit_count INTO v_client;
  END IF;$new3$);
  v_definition := replace(v_definition, $old4$  IF FOUND AND coalesce(v_client.is_vip,false) THEN$old4$, $new4$  IF v_client_known AND coalesce(v_client.is_vip,false) THEN$new4$);
  v_definition := replace(v_definition, $old5$  ELSIF FOUND AND coalesce(v_client.no_show_count,0) > 0 THEN$old5$, $new5$  ELSIF v_client_known AND coalesce(v_client.no_show_count,0) > 0 THEN$new5$);
  v_definition := replace(v_definition, $old6$  ELSIF NOT FOUND OR coalesce(v_client.visit_count,0) <= 0 THEN$old6$, $new6$  ELSIF NOT v_client_known OR coalesce(v_client.visit_count,0) <= 0 THEN$new6$);
  EXECUTE v_definition;
END;
$migration$;
CREATE OR REPLACE FUNCTION public.resolve_public_deposit_payment_material(p_salon_id uuid, p_service_id uuid, p_staff_id uuid, p_start_time_utc timestamp with time zone, p_end_time_utc timestamp with time zone, p_addon_service_ids uuid[], p_combo_id uuid, p_voucher_id uuid, p_client_phone text, p_client_email text, p_apply_email_discount boolean, p_booking_idempotency_key uuid, p_expected_pricing_fingerprint text)
 RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path TO ''
AS $legacy$
  SELECT public.resolve_public_deposit_payment_material(p_salon_id, p_service_id, p_staff_id, p_start_time_utc, p_end_time_utc, p_addon_service_ids, p_combo_id, p_voucher_id, p_client_phone, p_client_email, p_apply_email_discount, p_booking_idempotency_key, p_expected_pricing_fingerprint, NULL::uuid);
$legacy$;
REVOKE ALL ON FUNCTION public.resolve_public_deposit_payment_material(uuid, uuid, uuid, timestamp with time zone, timestamp with time zone, uuid[], uuid, uuid, text, text, boolean, uuid, text, uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_public_deposit_payment_material(uuid, uuid, uuid, timestamp with time zone, timestamp with time zone, uuid[], uuid, uuid, text, text, boolean, uuid, text, uuid) TO service_role;


-- load_public_deposit_payment_material: new explicit-proof overload and legacy NULL wrapper.
DO $migration$
DECLARE v_definition text;
BEGIN
  v_definition := pg_get_functiondef('public.load_public_deposit_payment_material(uuid, uuid, uuid, timestamp with time zone, timestamp with time zone, uuid[], uuid, uuid, text, text, boolean, uuid, text)'::regprocedure);
  IF md5(rtrim(v_definition, E' \n\r\t')) <> '54a3e423993c6cd21e91a497d6aede15' THEN
    RAISE EXCEPTION 'R09 source drift: load_public_deposit_payment_material-13';
  END IF;
  v_definition := replace(v_definition, $old0$CREATE OR REPLACE FUNCTION public.load_public_deposit_payment_material(p_salon_id uuid, p_service_id uuid, p_staff_id uuid, p_start_time_utc timestamp with time zone, p_end_time_utc timestamp with time zone, p_addon_service_ids uuid[], p_combo_id uuid, p_voucher_id uuid, p_client_phone text, p_client_email text, p_apply_email_discount boolean, p_booking_idempotency_key uuid, p_expected_pricing_fingerprint text)$old0$, $new0$CREATE OR REPLACE FUNCTION public.load_public_deposit_payment_material(p_salon_id uuid, p_service_id uuid, p_staff_id uuid, p_start_time_utc timestamp with time zone, p_end_time_utc timestamp with time zone, p_addon_service_ids uuid[], p_combo_id uuid, p_voucher_id uuid, p_client_phone text, p_client_email text, p_apply_email_discount boolean, p_booking_idempotency_key uuid, p_expected_pricing_fingerprint text, p_otp_session_id uuid)$new0$);
  v_definition := replace(v_definition, $old1$public.resolve_public_deposit_payment_material(
    p_salon_id,p_service_id,p_staff_id,p_start_time_utc,p_end_time_utc,
    p_addon_service_ids,p_combo_id,p_voucher_id,p_client_phone,p_client_email,
    p_apply_email_discount,p_booking_idempotency_key,p_expected_pricing_fingerprint$old1$, $new1$public.resolve_public_deposit_payment_material(
    p_salon_id,p_service_id,p_staff_id,p_start_time_utc,p_end_time_utc,
    p_addon_service_ids,p_combo_id,p_voucher_id,p_client_phone,p_client_email,
    p_apply_email_discount,p_booking_idempotency_key,p_expected_pricing_fingerprint,p_otp_session_id$new1$);
  EXECUTE v_definition;
END;
$migration$;
CREATE OR REPLACE FUNCTION public.load_public_deposit_payment_material(p_salon_id uuid, p_service_id uuid, p_staff_id uuid, p_start_time_utc timestamp with time zone, p_end_time_utc timestamp with time zone, p_addon_service_ids uuid[], p_combo_id uuid, p_voucher_id uuid, p_client_phone text, p_client_email text, p_apply_email_discount boolean, p_booking_idempotency_key uuid, p_expected_pricing_fingerprint text)
 RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path TO ''
AS $legacy$
  SELECT public.load_public_deposit_payment_material(p_salon_id, p_service_id, p_staff_id, p_start_time_utc, p_end_time_utc, p_addon_service_ids, p_combo_id, p_voucher_id, p_client_phone, p_client_email, p_apply_email_discount, p_booking_idempotency_key, p_expected_pricing_fingerprint, NULL::uuid);
$legacy$;
REVOKE ALL ON FUNCTION public.load_public_deposit_payment_material(uuid, uuid, uuid, timestamp with time zone, timestamp with time zone, uuid[], uuid, uuid, text, text, boolean, uuid, text, uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.load_public_deposit_payment_material(uuid, uuid, uuid, timestamp with time zone, timestamp with time zone, uuid[], uuid, uuid, text, text, boolean, uuid, text, uuid) TO service_role;


-- claim_public_deposit_payment_operation: new explicit-proof overload and legacy NULL wrapper.
DO $migration$
DECLARE v_definition text;
BEGIN
  v_definition := pg_get_functiondef('public.claim_public_deposit_payment_operation(uuid, uuid, uuid, timestamp with time zone, timestamp with time zone, uuid[], uuid, uuid, text, text, boolean, uuid, text, uuid)'::regprocedure);
  IF md5(rtrim(v_definition, E' \n\r\t')) <> '19a7604b406588a72e357b660577c894' THEN
    RAISE EXCEPTION 'R09 source drift: claim_public_deposit_payment_operation-14';
  END IF;
  v_definition := replace(v_definition, $old0$CREATE OR REPLACE FUNCTION public.claim_public_deposit_payment_operation(p_salon_id uuid, p_service_id uuid, p_staff_id uuid, p_start_time_utc timestamp with time zone, p_end_time_utc timestamp with time zone, p_addon_service_ids uuid[], p_combo_id uuid, p_voucher_id uuid, p_client_phone text, p_client_email text, p_apply_email_discount boolean, p_booking_idempotency_key uuid, p_expected_pricing_fingerprint text, p_request_id uuid)$old0$, $new0$CREATE OR REPLACE FUNCTION public.claim_public_deposit_payment_operation(p_salon_id uuid, p_service_id uuid, p_staff_id uuid, p_start_time_utc timestamp with time zone, p_end_time_utc timestamp with time zone, p_addon_service_ids uuid[], p_combo_id uuid, p_voucher_id uuid, p_client_phone text, p_client_email text, p_apply_email_discount boolean, p_booking_idempotency_key uuid, p_expected_pricing_fingerprint text, p_request_id uuid, p_otp_session_id uuid)$new0$);
  v_definition := replace(v_definition, $old1$public.resolve_public_deposit_payment_material(
    p_salon_id,p_service_id,p_staff_id,p_start_time_utc,p_end_time_utc,
    p_addon_service_ids,p_combo_id,p_voucher_id,p_client_phone,p_client_email,
    p_apply_email_discount,p_booking_idempotency_key,p_expected_pricing_fingerprint$old1$, $new1$public.resolve_public_deposit_payment_material(
    p_salon_id,p_service_id,p_staff_id,p_start_time_utc,p_end_time_utc,
    p_addon_service_ids,p_combo_id,p_voucher_id,p_client_phone,p_client_email,
    p_apply_email_discount,p_booking_idempotency_key,p_expected_pricing_fingerprint,p_otp_session_id$new1$);
  EXECUTE v_definition;
END;
$migration$;
CREATE OR REPLACE FUNCTION public.claim_public_deposit_payment_operation(p_salon_id uuid, p_service_id uuid, p_staff_id uuid, p_start_time_utc timestamp with time zone, p_end_time_utc timestamp with time zone, p_addon_service_ids uuid[], p_combo_id uuid, p_voucher_id uuid, p_client_phone text, p_client_email text, p_apply_email_discount boolean, p_booking_idempotency_key uuid, p_expected_pricing_fingerprint text, p_request_id uuid)
 RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path TO ''
AS $legacy$
  SELECT public.claim_public_deposit_payment_operation(p_salon_id, p_service_id, p_staff_id, p_start_time_utc, p_end_time_utc, p_addon_service_ids, p_combo_id, p_voucher_id, p_client_phone, p_client_email, p_apply_email_discount, p_booking_idempotency_key, p_expected_pricing_fingerprint, p_request_id, NULL::uuid);
$legacy$;
REVOKE ALL ON FUNCTION public.claim_public_deposit_payment_operation(uuid, uuid, uuid, timestamp with time zone, timestamp with time zone, uuid[], uuid, uuid, text, text, boolean, uuid, text, uuid, uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_public_deposit_payment_operation(uuid, uuid, uuid, timestamp with time zone, timestamp with time zone, uuid[], uuid, uuid, text, text, boolean, uuid, text, uuid, uuid) TO service_role;


-- create_public_booking_with_deposit_payment: new explicit-proof overload and legacy NULL wrapper.
DO $migration$
DECLARE v_definition text;
BEGIN
  v_definition := pg_get_functiondef('public.create_public_booking_with_deposit_payment(uuid, uuid, uuid, text, text, timestamp with time zone, timestamp with time zone, text, text, uuid[], text, uuid, uuid, uuid, boolean, uuid, text, uuid, uuid, text)'::regprocedure);
  IF md5(rtrim(v_definition, E' \n\r\t')) <> '3223ef7506aa3914ad897423cba1b66c' THEN
    RAISE EXCEPTION 'R09 source drift: create_public_booking_with_deposit_payment-20';
  END IF;
  v_definition := replace(v_definition, $old0$CREATE OR REPLACE FUNCTION public.create_public_booking_with_deposit_payment(p_salon_id uuid, p_service_id uuid, p_staff_id uuid, p_client_name text, p_client_phone text, p_start_time_utc timestamp with time zone, p_end_time_utc timestamp with time zone, p_status text, p_client_notes text, p_addon_service_ids uuid[], p_client_email text, p_resource_id uuid, p_combo_id uuid, p_voucher_id uuid, p_apply_email_discount boolean, p_idempotency_key uuid, p_expected_pricing_fingerprint text, p_payment_operation_id uuid, p_payment_request_id uuid, p_expected_payment_material_fingerprint text)$old0$, $new0$CREATE OR REPLACE FUNCTION public.create_public_booking_with_deposit_payment(p_salon_id uuid, p_service_id uuid, p_staff_id uuid, p_client_name text, p_client_phone text, p_start_time_utc timestamp with time zone, p_end_time_utc timestamp with time zone, p_status text, p_client_notes text, p_addon_service_ids uuid[], p_client_email text, p_resource_id uuid, p_combo_id uuid, p_voucher_id uuid, p_apply_email_discount boolean, p_idempotency_key uuid, p_expected_pricing_fingerprint text, p_payment_operation_id uuid, p_payment_request_id uuid, p_expected_payment_material_fingerprint text, p_otp_session_id uuid)$new0$);
  v_definition := replace(v_definition, $old1$      p_expected_pricing_fingerprint
    );$old1$, $new1$      p_expected_pricing_fingerprint,p_otp_session_id
    );$new1$);
  EXECUTE v_definition;
END;
$migration$;
CREATE OR REPLACE FUNCTION public.create_public_booking_with_deposit_payment(p_salon_id uuid, p_service_id uuid, p_staff_id uuid, p_client_name text, p_client_phone text, p_start_time_utc timestamp with time zone, p_end_time_utc timestamp with time zone, p_status text, p_client_notes text, p_addon_service_ids uuid[], p_client_email text, p_resource_id uuid, p_combo_id uuid, p_voucher_id uuid, p_apply_email_discount boolean, p_idempotency_key uuid, p_expected_pricing_fingerprint text, p_payment_operation_id uuid, p_payment_request_id uuid, p_expected_payment_material_fingerprint text)
 RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path TO ''
AS $legacy$
  SELECT public.create_public_booking_with_deposit_payment(p_salon_id, p_service_id, p_staff_id, p_client_name, p_client_phone, p_start_time_utc, p_end_time_utc, p_status, p_client_notes, p_addon_service_ids, p_client_email, p_resource_id, p_combo_id, p_voucher_id, p_apply_email_discount, p_idempotency_key, p_expected_pricing_fingerprint, p_payment_operation_id, p_payment_request_id, p_expected_payment_material_fingerprint, NULL::uuid);
$legacy$;
REVOKE ALL ON FUNCTION public.create_public_booking_with_deposit_payment(uuid, uuid, uuid, text, text, timestamp with time zone, timestamp with time zone, text, text, uuid[], text, uuid, uuid, uuid, boolean, uuid, text, uuid, uuid, text, uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.create_public_booking_with_deposit_payment(uuid, uuid, uuid, text, text, timestamp with time zone, timestamp with time zone, text, text, uuid[], text, uuid, uuid, uuid, boolean, uuid, text, uuid, uuid, text, uuid) TO service_role;
