-- Phase 4.5 — Smart Party Claim Upgrade
--
-- Changes in this migration:
--   1. organizer_name / organizer_phone columns on party_links
--      so the Party Link page and dashboard can show who organised.
--   2. claim_party_slot upgrade: also propagates the member's real
--      name + phone to bookings.client_name so the receptionist
--      calendar shows a real name after claiming (Part B).
--   3. update_party_claim_details RPC: lets a member edit their
--      name, phone, and reminder preference after claiming (Part C).
--   4. party_link_change_requests table: stores guest change
--      requests (service swap, staff preference, note) that salon
--      staff review from the dashboard (Part D).

-- ─── 1. organizer info on party_links ────────────────────────────

ALTER TABLE party_links
  ADD COLUMN IF NOT EXISTS organizer_name  TEXT,
  ADD COLUMN IF NOT EXISTS organizer_phone TEXT;

-- ─── 2. claim_party_slot upgrade ─────────────────────────────────
-- Part B: propagates member name/phone to bookings table so the
-- receptionist calendar shows the real guest name after claiming.

CREATE OR REPLACE FUNCTION public.claim_party_slot(
  p_token             TEXT,
  p_claim_id          UUID,
  p_member_name       TEXT,
  p_member_phone      TEXT,
  p_reminder_opted_in BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_link_id    UUID;
  v_expires    TIMESTAMPTZ;
  v_claimed    TIMESTAMPTZ;
  v_booking_id UUID;
BEGIN
  -- 1. Resolve + expiry check
  SELECT id, expires_at
    INTO v_link_id, v_expires
    FROM party_links
   WHERE token = p_token;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'not_found');
  END IF;

  IF v_expires < now() THEN
    RETURN jsonb_build_object('success', false, 'code', 'expired');
  END IF;

  -- 2. Lock the claim row for this link
  SELECT claimed_at, booking_id
    INTO v_claimed, v_booking_id
    FROM party_link_claims
   WHERE id = p_claim_id
     AND party_link_id = v_link_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'claim_not_found');
  END IF;

  IF v_claimed IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'already_claimed');
  END IF;

  -- 3. Claim it
  UPDATE party_link_claims
     SET member_name       = p_member_name,
         member_phone      = p_member_phone,
         reminder_opted_in = p_reminder_opted_in,
         claimed_at        = now()
   WHERE id = p_claim_id;

  -- 4. Propagate real name to bookings so the calendar is updated (Part B)
  IF v_booking_id IS NOT NULL THEN
    UPDATE bookings
       SET client_name  = p_member_name,
           client_phone = p_member_phone
     WHERE id = v_booking_id;
  END IF;

  RETURN jsonb_build_object('success', true);
EXCEPTION
  WHEN others THEN
    RETURN jsonb_build_object('success', false, 'code', 'server_error');
END;
$$;

-- ─── 3. update_party_claim_details RPC (Part C) ───────────────────
-- Allows a member who has already claimed their slot to update their
-- name, phone, and reminder preference.  The updated name is also
-- written back to bookings.client_name so the dashboard stays in sync.

CREATE OR REPLACE FUNCTION public.update_party_claim_details(
  p_token             TEXT,
  p_claim_id          UUID,
  p_member_name       TEXT,
  p_member_phone      TEXT,
  p_reminder_opted_in BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_link_id    UUID;
  v_expires    TIMESTAMPTZ;
  v_claimed    TIMESTAMPTZ;
  v_booking_id UUID;
BEGIN
  -- 1. Resolve token + expiry
  SELECT id, expires_at
    INTO v_link_id, v_expires
    FROM party_links
   WHERE token = p_token;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'not_found');
  END IF;

  IF v_expires < now() THEN
    RETURN jsonb_build_object('success', false, 'code', 'expired');
  END IF;

  -- 2. Lock claim row
  SELECT claimed_at, booking_id
    INTO v_claimed, v_booking_id
    FROM party_link_claims
   WHERE id = p_claim_id
     AND party_link_id = v_link_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'claim_not_found');
  END IF;

  IF v_claimed IS NULL THEN
    -- Can only edit a slot that has already been claimed
    RETURN jsonb_build_object('success', false, 'code', 'not_claimed');
  END IF;

  -- 3. Update party_link_claims
  UPDATE party_link_claims
     SET member_name       = p_member_name,
         member_phone      = p_member_phone,
         reminder_opted_in = p_reminder_opted_in
   WHERE id = p_claim_id;

  -- 4. Propagate to bookings
  IF v_booking_id IS NOT NULL THEN
    UPDATE bookings
       SET client_name  = p_member_name,
           client_phone = p_member_phone
     WHERE id = v_booking_id;
  END IF;

  RETURN jsonb_build_object('success', true);
EXCEPTION
  WHEN others THEN
    RETURN jsonb_build_object('success', false, 'code', 'server_error');
END;
$$;

-- ─── 4. party_link_change_requests table (Part D) ─────────────────
-- Stores change requests submitted by guests from the Party Link page.
-- Salon staff review and act on these from the dashboard.
--
-- Design notes:
--   • claim_id links to the specific party_link_claims row so the
--     dashboard knows which guest submitted the request.
--   • requested_service_id and requested_staff_id are optional; a
--     'note' type request has neither.
--   • status starts as 'pending'; salon updates to approved/declined.
--   • Phone numbers are never stored here (use claim_id join instead).

CREATE TABLE IF NOT EXISTS party_link_change_requests (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  party_link_id        UUID        NOT NULL REFERENCES party_links(id)      ON DELETE CASCADE,
  booking_id           UUID        NOT NULL REFERENCES bookings(id)          ON DELETE CASCADE,
  claim_id             UUID                 REFERENCES party_link_claims(id) ON DELETE SET NULL,
  request_type         TEXT        NOT NULL
                                   CHECK (request_type IN ('service_change', 'staff_preference', 'note')),
  requested_service_id UUID                 REFERENCES services(id)          ON DELETE SET NULL,
  requested_staff_id   UUID                 REFERENCES staff(id)             ON DELETE SET NULL,
  note                 TEXT,
  status               TEXT        NOT NULL DEFAULT 'pending'
                                   CHECK (status IN ('pending', 'auto_applied', 'approved', 'declined')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_plcr_party_link ON party_link_change_requests(party_link_id);
CREATE INDEX IF NOT EXISTS idx_plcr_booking    ON party_link_change_requests(booking_id);
CREATE INDEX IF NOT EXISTS idx_plcr_status     ON party_link_change_requests(status)
  WHERE status = 'pending';

ALTER TABLE party_link_change_requests ENABLE ROW LEVEL SECURITY;

-- Anon can INSERT (server action validates token + claim ownership)
CREATE POLICY "anon_insert_party_change_requests"
  ON party_link_change_requests FOR INSERT
  WITH CHECK (true);

-- Anon can SELECT (for optimistic UI after submission)
CREATE POLICY "anon_select_party_change_requests"
  ON party_link_change_requests FOR SELECT
  USING (true);
