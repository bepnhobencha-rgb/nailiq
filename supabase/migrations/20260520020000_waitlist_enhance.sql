-- Enhance booking_waitlist_entries with status + notification claim flow

ALTER TABLE booking_waitlist_entries
  ADD COLUMN IF NOT EXISTS status       text NOT NULL DEFAULT 'waiting'
    CONSTRAINT bwe_status_check
    CHECK (status IN ('waiting','notified','claimed','expired')),
  ADD COLUMN IF NOT EXISTS client_email text,
  ADD COLUMN IF NOT EXISTS notified_at  timestamptz,
  ADD COLUMN IF NOT EXISTS claimed_at   timestamptz,
  ADD COLUMN IF NOT EXISTS claim_token  uuid;

CREATE INDEX IF NOT EXISTS bwe_status_salon_idx
  ON booking_waitlist_entries (salon_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS bwe_claim_token_idx
  ON booking_waitlist_entries (claim_token)
  WHERE claim_token IS NOT NULL;

-- Atomic claim: only the first caller wins (FOR UPDATE SKIP LOCKED).
CREATE OR REPLACE FUNCTION public.claim_waitlist_slot(p_claim_token uuid)
RETURNS TABLE (id uuid, client_name text, client_phone text, client_email text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_id uuid; v_name text; v_phone text; v_email text;
BEGIN
  SELECT w.id, w.client_name, w.client_phone, w.client_email
  INTO   v_id, v_name, v_phone, v_email
  FROM   booking_waitlist_entries w
  WHERE  w.claim_token = p_claim_token
    AND  w.status      = 'notified'
    AND  w.claimed_at  IS NULL
  FOR UPDATE SKIP LOCKED;

  IF v_id IS NULL THEN RETURN; END IF;

  UPDATE booking_waitlist_entries
  SET status = 'claimed', claimed_at = now()
  WHERE id = v_id;

  RETURN QUERY SELECT v_id, v_name, v_phone, v_email;
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_waitlist_slot(uuid) TO anon, authenticated;
