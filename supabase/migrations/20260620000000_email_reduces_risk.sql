-- Factor email presence into booking verification risk score.
-- A customer with no email can only receive OTP via SMS; if SMS is unreliable
-- (e.g. A2P 10DLC not yet registered), they may be unable to verify at all.
-- Adding +10 risk when no email is provided nudges the system to ask for email
-- earlier (via nudge UI) and makes the email field feel valuable to the customer.
--
-- Also looks up email from client_profiles for returning customers who already
-- have one on file, so they aren't penalised even if the Info step is skipped.

CREATE OR REPLACE FUNCTION public.determine_booking_verification(
  p_salon_id       uuid,
  p_client_phone   text,
  p_service_ids    uuid[],
  p_subtotal_cents int,
  p_has_email      boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_salon  record;
  v_client record;
  v_risk   int;
  v_has_email boolean;
  v_deposit_amount_cents int := 0;
  v_action text;
BEGIN
  SELECT booking_verification_mode,
         verification_risk_threshold_otp,
         verification_risk_threshold_deposit,
         deposit_high_value_cents,
         deposit_default_amount_cents
  INTO v_salon
  FROM salons
  WHERE id = p_salon_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('action', 'none', 'reason', 'salon_not_found', 'risk_score', 0);
  END IF;

  -- Mode 'never' → skip immediately
  IF v_salon.booking_verification_mode = 'never' THEN
    RETURN jsonb_build_object('action', 'none', 'reason', 'mode_never', 'risk_score', 0);
  END IF;

  -- Look up client profile by phone
  SELECT is_vip,
         coalesce(visit_count, 0)   AS visit_count,
         coalesce(no_show_count, 0) AS no_show_count,
         phone_verified_at,
         email
  INTO v_client
  FROM client_profiles
  WHERE phone = p_client_phone;

  -- Email: accept from the booking form OR from the stored profile
  v_has_email := p_has_email OR (FOUND AND v_client.email IS NOT NULL AND v_client.email <> '');

  -- VIP bypass
  IF FOUND AND v_client.is_vip = true THEN
    RETURN jsonb_build_object('action', 'none', 'reason', 'vip_skip', 'risk_score', 0);
  END IF;

  -- Trusted returning customer (5+ visits, no no-shows)
  IF FOUND AND coalesce(v_client.visit_count, 0) >= 5
           AND coalesce(v_client.no_show_count, 0) = 0 THEN
    RETURN jsonb_build_object('action', 'none', 'reason', 'trusted_returning', 'risk_score', 0);
  END IF;

  -- "Verify once, trust": phone already passed OTP, no no-show, not stale
  IF FOUND AND v_client.phone_verified_at IS NOT NULL
           AND coalesce(v_client.no_show_count, 0) = 0
           AND v_client.phone_verified_at > now() - interval '12 months' THEN
    RETURN jsonb_build_object('action', 'none', 'reason', 'phone_already_verified', 'risk_score', 0);
  END IF;

  -- Compute base risk score
  v_risk := public.compute_no_show_risk(
    coalesce(CASE WHEN FOUND THEN v_client.no_show_count ELSE 0 END, 0),
    coalesce(CASE WHEN FOUND THEN v_client.visit_count   ELSE 0 END, 0),
    p_subtotal_cents
  );

  -- No email = higher risk: SMS is the only OTP channel, which may be unreliable
  IF NOT v_has_email THEN
    v_risk := least(100, v_risk + 10);
  END IF;

  -- Apply mode
  CASE v_salon.booking_verification_mode

    WHEN 'always_otp' THEN
      v_action := 'otp_required';

    WHEN 'always_deposit' THEN
      v_action := 'deposit_required';
      v_deposit_amount_cents := coalesce(
        v_salon.deposit_default_amount_cents,
        p_subtotal_cents * 30 / 100
      );

    WHEN 'deposit_first' THEN
      IF v_risk >= v_salon.verification_risk_threshold_otp THEN
        v_action := 'deposit_or_otp';
        v_deposit_amount_cents := coalesce(
          v_salon.deposit_default_amount_cents,
          p_subtotal_cents * 30 / 100
        );
      ELSE
        v_action := 'none';
      END IF;

    ELSE -- 'auto'
      IF v_risk < v_salon.verification_risk_threshold_otp THEN
        v_action := 'none';
      ELSIF v_risk < v_salon.verification_risk_threshold_deposit THEN
        v_action := 'otp_optional';
      ELSE
        IF p_subtotal_cents >= coalesce(v_salon.deposit_high_value_cents, 5000) THEN
          v_action := 'deposit_required';
          v_deposit_amount_cents := coalesce(
            v_salon.deposit_default_amount_cents,
            p_subtotal_cents * 30 / 100
          );
        ELSE
          v_action := 'otp_required';
        END IF;
      END IF;
  END CASE;

  RETURN jsonb_build_object(
    'action',               v_action,
    'risk_score',           v_risk,
    'deposit_amount_cents', v_deposit_amount_cents,
    'reason',
      CASE v_action
        WHEN 'none'             THEN 'low_risk_or_trusted'
        WHEN 'otp_optional'     THEN 'medium_risk'
        WHEN 'otp_required'     THEN 'high_risk_no_deposit'
        WHEN 'deposit_required' THEN 'high_risk_high_value'
        WHEN 'deposit_or_otp'   THEN 'customer_choice'
        ELSE                          'salon_policy'
      END
  );
END;
$$;
