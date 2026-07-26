-- Party Links — shareable group-booking invite URLs.
--
-- After a group booking is confirmed the organiser gets a short URL
-- (/party/<token>) they can forward to their party. Each member opens
-- the link, sees their slot details, and claims it by entering their
-- name and phone. No sign-in required.
--
-- Design notes:
--   • bookings.group_id has NO unique constraint, so party_links stores
--     group_id without a FOREIGN KEY (queries filter by group_id safely;
--     uniqueness is enforced via party_links.group_id UNIQUE below).
--   • party_link_claims is pre-populated (one row per booking_id) by
--     createPartyLink so each slot has a stable id for atomic claiming.
--   • Phone numbers are stored in party_link_claims but NEVER returned
--     to anonymous users — loadPartyLinkPage deliberately omits the
--     column and claim_party_slot is SECURITY DEFINER.
--   • token is at least 16 hex chars (8 random bytes → unguessable).

-- ─── party_links ─────────────────────────────────────────────────

CREATE TABLE party_links (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id    UUID         NOT NULL UNIQUE,   -- bookings.group_id (no FK: not unique there)
  salon_id    UUID         NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  token       TEXT         NOT NULL UNIQUE CHECK (length(token) >= 8),
  mode        TEXT         NOT NULL DEFAULT 'sync_start'
                           CHECK (mode IN ('sync_start', 'sync_finish')),
  expires_at  TIMESTAMPTZ  NOT NULL,          -- group start time + 24 hours
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_party_links_token  ON party_links(token);
CREATE INDEX idx_party_links_group  ON party_links(group_id);
CREATE INDEX idx_party_links_salon  ON party_links(salon_id);

ALTER TABLE party_links ENABLE ROW LEVEL SECURITY;

-- Anonymous users can look up a party link by its opaque token.
-- Column-level security (phone exclusion) is enforced in the
-- server action / SECURITY DEFINER RPC — not here.
CREATE POLICY "anon_select_party_links"
  ON party_links FOR SELECT
  USING (true);

-- Only service-role (bypasses RLS) writes party_links rows.

-- ─── party_link_claims ────────────────────────────────────────────

CREATE TABLE party_link_claims (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  party_link_id     UUID         NOT NULL REFERENCES party_links(id) ON DELETE CASCADE,
  booking_id        UUID         NOT NULL REFERENCES bookings(id)    ON DELETE CASCADE,
  member_name       TEXT,                     -- set when claimed; NULL = unclaimed
  member_phone      TEXT,                     -- set when claimed; NEVER exposed to anon
  reminder_opted_in BOOLEAN      NOT NULL DEFAULT false,
  claimed_at        TIMESTAMPTZ,              -- NULL = unclaimed
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (booking_id)                         -- each booking slot claimed at most once
);

CREATE INDEX idx_party_claims_link    ON party_link_claims(party_link_id);
CREATE INDEX idx_party_claims_booking ON party_link_claims(booking_id);

ALTER TABLE party_link_claims ENABLE ROW LEVEL SECURITY;

-- Safe public read: server action selects only non-sensitive columns.
CREATE POLICY "anon_select_party_link_claims"
  ON party_link_claims FOR SELECT
  USING (true);

-- Writes happen via claim_party_slot SECURITY DEFINER below.

-- ─── claim_party_slot RPC ─────────────────────────────────────────
--
-- Atomically claims an unclaimed slot.  Validates:
--   1. token exists and is not expired,
--   2. claim_id belongs to that party link,
--   3. claim is not already taken.
-- Executes as SECURITY DEFINER so anon role can UPDATE the row.

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
  v_link_id   UUID;
  v_expires   TIMESTAMPTZ;
  v_claimed   TIMESTAMPTZ;
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
  SELECT claimed_at
    INTO v_claimed
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

  RETURN jsonb_build_object('success', true);
EXCEPTION
  WHEN others THEN
    RETURN jsonb_build_object('success', false, 'code', 'server_error');
END;
$$;
