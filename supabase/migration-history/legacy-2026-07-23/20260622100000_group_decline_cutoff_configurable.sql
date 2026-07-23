-- Configurable group decline cutoff: salon owner sets how many hours before
-- the appointment members can self-serve decline. Past that window, Minh handles.

ALTER TABLE salons
  ADD COLUMN IF NOT EXISTS group_decline_cutoff_hours INT NOT NULL DEFAULT 2
    CHECK (group_decline_cutoff_hours >= 0 AND group_decline_cutoff_hours <= 72);

-- Re-create RPC to read cutoff from salon instead of hardcoding
CREATE OR REPLACE FUNCTION public.decline_party_member(
  p_booking_id      UUID,
  p_token           TEXT,
  p_suggested_name  TEXT DEFAULT NULL,
  p_suggested_phone TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_token_row RECORD;
  v_booking   RECORD;
BEGIN
  -- 1. Validate token
  SELECT booking_id, expires_at
    INTO v_token_row
    FROM booking_reminder_tokens
   WHERE id = p_token::uuid;

  IF NOT FOUND                               THEN RETURN jsonb_build_object('ok', false, 'code', 'not_found'); END IF;
  IF v_token_row.booking_id != p_booking_id  THEN RETURN jsonb_build_object('ok', false, 'code', 'mismatch'); END IF;
  IF v_token_row.expires_at  < now()         THEN RETURN jsonb_build_object('ok', false, 'code', 'expired');  END IF;

  -- 2. Get booking start_at + salon's configured cutoff in one join
  SELECT b.start_at, COALESCE(s.group_decline_cutoff_hours, 2) AS cutoff
    INTO v_booking
    FROM bookings b
    JOIN salons   s ON s.id = b.salon_id
   WHERE b.id = p_booking_id;

  -- 3. Cutoff check → return too_late so the client routes to Minh flow
  IF v_booking.start_at < (now() + (v_booking.cutoff || ' hours')::interval) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'too_late', 'cutoff_hours', v_booking.cutoff);
  END IF;

  -- 4. Self-serve decline
  UPDATE bookings SET attendance_status = 'declined' WHERE id = p_booking_id;

  UPDATE party_link_claims
     SET member_name       = NULL,
         member_phone      = NULL,
         reminder_opted_in = false,
         claimed_at        = NULL,
         declined_at       = now(),
         suggested_name    = p_suggested_name,
         suggested_phone   = p_suggested_phone
   WHERE booking_id = p_booking_id;

  RETURN jsonb_build_object('ok', true);
EXCEPTION WHEN others THEN
  RETURN jsonb_build_object('ok', false, 'code', 'server_error');
END;
$$;
