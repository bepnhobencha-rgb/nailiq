-- Smart Booking Verification (replaces Two-phase SMS tracking)
-- Adds risk-based verification columns + RPC functions

-- ─── Salons: verification mode + thresholds ────────────────────────────────

ALTER TABLE public.salons
  ADD COLUMN IF NOT EXISTS booking_verification_mode text NOT NULL DEFAULT 'never'
    CHECK (booking_verification_mode IN ('auto','always_otp','always_deposit','deposit_first','never')),
  ADD COLUMN IF NOT EXISTS verification_risk_threshold_otp smallint NOT NULL DEFAULT 30
    CHECK (verification_risk_threshold_otp BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS verification_risk_threshold_deposit smallint NOT NULL DEFAULT 70
    CHECK (verification_risk_threshold_deposit BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS deposit_default_amount_cents int;

COMMENT ON COLUMN public.salons.booking_verification_mode IS
  'auto=smart risk-based, always_otp=force OTP, always_deposit=force deposit, deposit_first=deposit then OTP, never=no friction';
COMMENT ON COLUMN public.salons.verification_risk_threshold_otp IS
  'In auto mode: risk >= this triggers optional OTP (default 30)';
COMMENT ON COLUMN public.salons.verification_risk_threshold_deposit IS
  'In auto mode: risk >= this triggers required deposit (default 70)';

-- ─── Bookings: verification + SMS tracking ────────────────────────────────

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS verification_method text
    CHECK (verification_method IS NULL OR verification_method IN ('none','otp','deposit','both','vip_skip')),
  ADD COLUMN IF NOT EXISTS verification_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS otp_session_id uuid REFERENCES public.phone_otp_sessions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS sms_confirmation_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS sms_confirmation_failed_at timestamptz,
  ADD COLUMN IF NOT EXISTS sms_confirmation_error text;

COMMENT ON COLUMN public.bookings.verification_method IS
  'none=trusted/skipped, otp=phone verified, deposit=paid, vip_skip=VIP bypass';
COMMENT ON COLUMN public.bookings.sms_confirmation_sent_at IS
  'When Twilio accepted the confirmation SMS. NULL = not yet sent or failed.';

CREATE INDEX IF NOT EXISTS idx_bookings_sms_failed
  ON public.bookings(salon_id, created_at DESC)
  WHERE sms_confirmation_failed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bookings_pending_unverified
  ON public.bookings(created_at)
  WHERE status = 'pending' AND verification_method IS NULL;

-- ─── compute_no_show_risk ─────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.compute_no_show_risk(
  p_no_show_count int,
  p_visit_count   int,
  p_subtotal_cents int
) RETURNS int
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_score int := 30; -- baseline: new customer
BEGIN
  -- No-show history is the strongest signal
  IF    p_no_show_count >= 3 THEN v_score := v_score + 40;
  ELSIF p_no_show_count  = 2 THEN v_score := v_score + 30;
  ELSIF p_no_show_count  = 1 THEN v_score := v_score + 20;
  END IF;

  -- Visit count reduces risk (returning customers are safer)
  IF    p_visit_count  = 0  THEN v_score := v_score + 15;
  ELSIF p_visit_count >= 10 THEN v_score := v_score - 25;
  ELSIF p_visit_count >=  5 THEN v_score := v_score - 15;
  ELSIF p_visit_count >=  2 THEN v_score := v_score -  5;
  END IF;

  -- High-value bookings: customers less likely to no-show on expensive services
  IF p_subtotal_cents >= 15000 THEN v_score := v_score - 10; END IF;

  RETURN greatest(0, least(100, v_score));
END;
$$;

-- ─── determine_booking_verification ──────────────────────────────────────

CREATE OR REPLACE FUNCTION public.determine_booking_verification(
  p_salon_id       uuid,
  p_client_phone   text,
  p_service_ids    uuid[],
  p_subtotal_cents int
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_salon  record;
  v_client record;
  v_risk   int;
  v_deposit_amount_cents int := 0;
  v_action text;
BEGIN
  SELECT booking_verification_mode,
         verification_risk_threshold_otp,
         verification_risk_threshold_deposit,
         deposit_required,
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

  -- Look up client profile (may not exist for new customers)
  SELECT is_vip,
         coalesce(visit_count, 0)    AS visit_count,
         coalesce(no_show_count, 0)  AS no_show_count
  INTO v_client
  FROM client_profiles
  WHERE phone = p_client_phone AND salon_id = p_salon_id;

  -- VIP bypass
  IF FOUND AND v_client.is_vip = true THEN
    RETURN jsonb_build_object('action', 'none', 'reason', 'vip_skip', 'risk_score', 0);
  END IF;

  -- Trusted returning customer (5+ visits, no no-shows)
  IF FOUND AND coalesce(v_client.visit_count, 0) >= 5
           AND coalesce(v_client.no_show_count, 0) = 0 THEN
    RETURN jsonb_build_object('action', 'none', 'reason', 'trusted_returning', 'risk_score', 0);
  END IF;

  -- Compute risk score
  v_risk := public.compute_no_show_risk(
    coalesce(CASE WHEN FOUND THEN v_client.no_show_count ELSE 0 END, 0),
    coalesce(CASE WHEN FOUND THEN v_client.visit_count   ELSE 0 END, 0),
    p_subtotal_cents
  );

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
        -- High risk: deposit for high-value bookings, OTP otherwise
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
        ELSE                         'salon_policy'
      END
  );
END;
$$;

-- ─── confirm_booking_with_otp ─────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.confirm_booking_with_otp(
  p_booking_id    uuid,
  p_otp_session_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session record;
  v_booking record;
BEGIN
  -- Verify OTP session: not yet consumed, not expired
  SELECT * INTO v_session
  FROM phone_otp_sessions
  WHERE id = p_otp_session_id
    AND consumed_at IS NULL
    AND expires_at > now();

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'otp_invalid_or_expired');
  END IF;

  -- Verify booking phone matches OTP phone
  SELECT * INTO v_booking
  FROM bookings
  WHERE id = p_booking_id
    AND client_phone = v_session.phone;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'phone_mismatch');
  END IF;

  -- Mark session consumed
  UPDATE phone_otp_sessions
  SET consumed_at = now()
  WHERE id = p_otp_session_id;

  -- Update booking: confirmed + verification recorded
  UPDATE bookings
  SET status                    = 'confirmed',
      verification_method       = 'otp',
      verification_completed_at = now(),
      otp_session_id            = p_otp_session_id,
      confirmed_at              = now()
  WHERE id = p_booking_id;

  -- Audit trail
  INSERT INTO booking_events(booking_id, salon_id, event_type, payload)
  VALUES (
    p_booking_id,
    v_booking.salon_id,
    'verified_via_otp',
    jsonb_build_object('otp_session_id', p_otp_session_id)
  );

  RETURN jsonb_build_object('ok', true, 'booking_id', p_booking_id);
END;
$$;
