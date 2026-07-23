-- Customer Identity Layer — party-claim promotes a guest to a real customer.
--
-- When a group guest claims their slot with their OWN phone (the "confirm"
-- step), they should become a first-class, recognized customer: their own
-- client_profiles row (so they're greeted by name next visit), their own visit
-- credited (the derived per-salon count already follows client_phone, which the
-- claim writes), and is_party_member flipped off. Before this, a claim only
-- wrote name/phone onto the booking row — the guest was counted but never got a
-- profile, so they looked brand-new forever.
--
-- Double-count guard: resolve_client_profile bumps visit_count, so we only call
-- it when the booking still has NO client_profile_id (the first time the slot
-- gains an identity). Re-editing claim details (update_party_claim_details, or
-- a re-claim) just re-links + keeps is_party_member off — never re-bumps.

CREATE OR REPLACE FUNCTION public.claim_party_slot(
  p_token text, p_claim_id uuid, p_member_name text, p_member_phone text, p_reminder_opted_in boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_link_id    UUID;
  v_expires    TIMESTAMPTZ;
  v_claimed    TIMESTAMPTZ;
  v_booking_id UUID;
  v_digits     TEXT;
  v_existing_fk UUID;
  v_profile_id UUID;
BEGIN
  SELECT id, expires_at INTO v_link_id, v_expires FROM party_links WHERE token = p_token;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'code', 'not_found'); END IF;
  IF v_expires < now() THEN RETURN jsonb_build_object('success', false, 'code', 'expired'); END IF;

  SELECT claimed_at, booking_id INTO v_claimed, v_booking_id
    FROM party_link_claims WHERE id = p_claim_id AND party_link_id = v_link_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'code', 'claim_not_found'); END IF;
  IF v_claimed IS NOT NULL THEN RETURN jsonb_build_object('success', false, 'code', 'already_claimed'); END IF;

  UPDATE party_link_claims
     SET member_name = p_member_name, member_phone = p_member_phone,
         reminder_opted_in = p_reminder_opted_in, claimed_at = now()
   WHERE id = p_claim_id;

  IF v_booking_id IS NOT NULL THEN
    UPDATE bookings SET client_name = p_member_name, client_phone = p_member_phone WHERE id = v_booking_id;
    v_digits := regexp_replace(coalesce(public.canonical_phone(p_member_phone), ''), '\D', '', 'g');
    IF length(v_digits) >= 7 THEN
      SELECT client_profile_id INTO v_existing_fk FROM bookings WHERE id = v_booking_id;
      IF v_existing_fk IS NULL THEN
        v_profile_id := public.resolve_client_profile(p_member_phone, p_member_name, NULL, NULL);
        UPDATE bookings SET client_profile_id = v_profile_id, is_party_member = false WHERE id = v_booking_id;
      ELSE
        UPDATE bookings SET is_party_member = false WHERE id = v_booking_id;
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object('success', true);
EXCEPTION
  WHEN others THEN RETURN jsonb_build_object('success', false, 'code', 'server_error');
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_party_claim_details(
  p_token text, p_claim_id uuid, p_member_name text, p_member_phone text, p_reminder_opted_in boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_link_id    UUID;
  v_expires    TIMESTAMPTZ;
  v_claimed    TIMESTAMPTZ;
  v_booking_id UUID;
  v_digits     TEXT;
  v_existing_fk UUID;
  v_profile_id UUID;
BEGIN
  SELECT id, expires_at INTO v_link_id, v_expires FROM party_links WHERE token = p_token;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'code', 'not_found'); END IF;
  IF v_expires < now() THEN RETURN jsonb_build_object('success', false, 'code', 'expired'); END IF;

  SELECT claimed_at, booking_id INTO v_claimed, v_booking_id
    FROM party_link_claims WHERE id = p_claim_id AND party_link_id = v_link_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'code', 'claim_not_found'); END IF;
  IF v_claimed IS NULL THEN RETURN jsonb_build_object('success', false, 'code', 'not_claimed'); END IF;

  UPDATE party_link_claims
     SET member_name = p_member_name, member_phone = p_member_phone, reminder_opted_in = p_reminder_opted_in
   WHERE id = p_claim_id;

  IF v_booking_id IS NOT NULL THEN
    UPDATE bookings SET client_name = p_member_name, client_phone = p_member_phone WHERE id = v_booking_id;
    v_digits := regexp_replace(coalesce(public.canonical_phone(p_member_phone), ''), '\D', '', 'g');
    IF length(v_digits) >= 7 THEN
      SELECT client_profile_id INTO v_existing_fk FROM bookings WHERE id = v_booking_id;
      IF v_existing_fk IS NULL THEN
        v_profile_id := public.resolve_client_profile(p_member_phone, p_member_name, NULL, NULL);
        UPDATE bookings SET client_profile_id = v_profile_id, is_party_member = false WHERE id = v_booking_id;
      ELSE
        UPDATE bookings SET is_party_member = false WHERE id = v_booking_id;
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object('success', true);
EXCEPTION
  WHEN others THEN RETURN jsonb_build_object('success', false, 'code', 'server_error');
END;
$function$;
