-- Group member RSVP: per-member attendance tracking + slot unclaim on decline.
-- Enables per-member SMS with personal RSVP link; when member declines, their
-- slot reopens on the party link so organizer can invite a replacement.

-- ── 1. Attendance status on bookings ─────────────────────────────────────────
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS attendance_status TEXT
    CHECK (attendance_status IN ('pending', 'confirmed', 'declined'));

-- ── 2. Decline metadata on party_link_claims ─────────────────────────────────
ALTER TABLE party_link_claims
  ADD COLUMN IF NOT EXISTS declined_at              TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS suggested_name           TEXT,
  ADD COLUMN IF NOT EXISTS suggested_phone          TEXT,
  ADD COLUMN IF NOT EXISTS organizer_notified_at    TIMESTAMPTZ;

-- ── 3. RPC: confirm_party_member ─────────────────────────────────────────────
-- Called when member taps "I'll be there" from their personal RSVP link.
CREATE OR REPLACE FUNCTION public.confirm_party_member(
  p_booking_id UUID,
  p_token      TEXT    -- booking_reminder_tokens.id
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row RECORD;
BEGIN
  SELECT booking_id, expires_at
    INTO v_row
    FROM booking_reminder_tokens
   WHERE id = p_token::uuid;

  IF NOT FOUND                           THEN RETURN jsonb_build_object('ok', false, 'code', 'not_found');   END IF;
  IF v_row.booking_id != p_booking_id    THEN RETURN jsonb_build_object('ok', false, 'code', 'mismatch');    END IF;
  IF v_row.expires_at  < now()           THEN RETURN jsonb_build_object('ok', false, 'code', 'expired');     END IF;

  UPDATE bookings SET attendance_status = 'confirmed' WHERE id = p_booking_id;

  RETURN jsonb_build_object('ok', true);
EXCEPTION WHEN others THEN
  RETURN jsonb_build_object('ok', false, 'code', 'server_error');
END;
$$;

-- ── 4. RPC: decline_party_member ─────────────────────────────────────────────
-- Called when member taps "I can't make it".
-- Marks booking as declined AND resets party_link_claims so the slot shows
-- as unclaimed again — organizer can then share the party link to a replacement.
CREATE OR REPLACE FUNCTION public.decline_party_member(
  p_booking_id      UUID,
  p_token           TEXT,    -- booking_reminder_tokens.id
  p_suggested_name  TEXT    DEFAULT NULL,
  p_suggested_phone TEXT    DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row RECORD;
BEGIN
  SELECT booking_id, expires_at
    INTO v_row
    FROM booking_reminder_tokens
   WHERE id = p_token::uuid;

  IF NOT FOUND                           THEN RETURN jsonb_build_object('ok', false, 'code', 'not_found');   END IF;
  IF v_row.booking_id != p_booking_id    THEN RETURN jsonb_build_object('ok', false, 'code', 'mismatch');    END IF;
  IF v_row.expires_at  < now()           THEN RETURN jsonb_build_object('ok', false, 'code', 'expired');     END IF;

  -- Mark booking declined
  UPDATE bookings SET attendance_status = 'declined' WHERE id = p_booking_id;

  -- Re-open slot on party link (reset claim → replacement can claim it)
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
