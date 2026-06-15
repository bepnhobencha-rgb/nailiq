-- Full-auto waitlist backfill — claim now creates the real booking.
--
-- When the salon has feature_flags.waitlist_auto_book = true AND the entry
-- carries a concrete freed slot (offered_staff_id/start/end, set by the flip
-- RPCs), claiming the link auto-creates the booking via create_public_booking
-- (race-safe: advisory lock + bookings_no_overlap GIST exclusion). On success
-- the entry is 'claimed' and links the booking; if the slot was taken in the
-- meantime the customer is put back to 'waiting' for the next freed slot.
--
-- When the flag is off OR no concrete slot was captured, behaviour is unchanged
-- (mark 'claimed', salon follows up manually).
--
-- Backward-compatible columns id/client_name kept first so the existing
-- claim page keeps working; new columns appended.

-- Return-type (OUT params) changes → must drop first. Re-grant after (the
-- public claim page resolves the token; the booking it creates is bound to the
-- single-use secret claim_token, so anon access stays gated by that secret).
DROP FUNCTION IF EXISTS public.claim_waitlist_slot(uuid);

CREATE OR REPLACE FUNCTION public.claim_waitlist_slot(p_claim_token uuid)
 RETURNS TABLE(
   id uuid,
   client_name text,
   client_phone text,
   client_email text,
   auto_booked boolean,
   booking_id uuid,
   booked_start_utc timestamptz,
   staff_name text,
   service_name text
 )
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_e        booking_waitlist_entries%ROWTYPE;
  v_auto     boolean;
  v_price    integer;
  v_res      jsonb;
  v_bid      uuid;
BEGIN
  SELECT * INTO v_e
  FROM   booking_waitlist_entries w
  WHERE  w.claim_token = p_claim_token
    AND  w.status      = 'notified'
    AND  w.claimed_at  IS NULL
  FOR UPDATE SKIP LOCKED;

  IF v_e.id IS NULL THEN
    RETURN; -- already claimed / expired / locked by another claim
  END IF;

  v_auto := COALESCE(
    (SELECT (s.feature_flags ->> 'waitlist_auto_book')::boolean
       FROM salons s WHERE s.id = v_e.salon_id),
    false
  );

  -- ── Auto-book path ──────────────────────────────────────────────────
  IF v_auto
     AND v_e.offered_staff_id  IS NOT NULL
     AND v_e.offered_start_utc IS NOT NULL
     AND v_e.offered_end_utc   IS NOT NULL THEN

    SELECT sv.price_cents INTO v_price
    FROM services sv WHERE sv.id = v_e.service_id;

    v_res := public.create_public_booking(
      v_e.salon_id, v_e.service_id, v_e.offered_staff_id,
      v_e.client_name, v_e.client_phone,
      v_e.offered_start_utc, v_e.offered_end_utc,
      'confirmed', v_price, NULL, NULL, NULL, v_e.client_email
    );

    IF COALESCE((v_res ->> 'success')::boolean, false) THEN
      v_bid := (v_res ->> 'booking_id')::uuid;
      UPDATE booking_waitlist_entries
         SET status = 'claimed', claimed_at = now(), booked_booking_id = v_bid
       WHERE booking_waitlist_entries.id = v_e.id;

      RETURN QUERY SELECT
        v_e.id, v_e.client_name, v_e.client_phone, v_e.client_email,
        true, v_bid, v_e.offered_start_utc,
        (SELECT st.name FROM staff st WHERE st.id = v_e.offered_staff_id),
        (SELECT sv.name FROM services sv WHERE sv.id = v_e.service_id);
      RETURN;
    ELSE
      -- The freed slot was taken (or became invalid) before this claim.
      -- Put the customer back in line for the next opening; the link they
      -- hold is now spent (token cleared).
      UPDATE booking_waitlist_entries
         SET status = 'waiting', notified_at = NULL, claim_token = NULL,
             offered_staff_id = NULL, offered_start_utc = NULL, offered_end_utc = NULL
       WHERE booking_waitlist_entries.id = v_e.id;
      RETURN; -- empty → claim page shows "slot no longer available"
    END IF;
  END IF;

  -- ── Manual path (flag off or no concrete slot) — unchanged behaviour ─
  UPDATE booking_waitlist_entries
     SET status = 'claimed', claimed_at = now()
   WHERE booking_waitlist_entries.id = v_e.id;

  RETURN QUERY SELECT
    v_e.id, v_e.client_name, v_e.client_phone, v_e.client_email,
    false, NULL::uuid, NULL::timestamptz, NULL::text,
    (SELECT sv.name FROM services sv WHERE sv.id = v_e.service_id);
END;
$function$;

-- Public claim flow (page resolves the secret token).
GRANT EXECUTE ON FUNCTION public.claim_waitlist_slot(uuid) TO anon, authenticated;
