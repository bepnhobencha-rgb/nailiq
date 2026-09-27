-- Fresh-install compatibility: service_role need not have USAGE on the
-- extensions schema merely to compare a recipient fingerprint. PostgreSQL's
-- built-in SHA-256 yields the same hex digest of the normalized UTF-8 email.
-- Rollback: replace this function body with the previously approved version
-- only after verifying the target project's extensions schema ACL. Keep all
-- receipt rows and the one-shot delivery boundary unchanged.
CREATE OR REPLACE FUNCTION public.claim_card_retry_email(p_salon_id uuid, p_booking_id uuid,
  p_actor_id uuid, p_recipient_fingerprint text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE b public.bookings%ROWTYPE; r public.booking_card_retry_email_receipts%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.salon_members WHERE salon_id=p_salon_id
    AND user_id=p_actor_id AND role IN ('owner','admin','senior','receptionist')) THEN
    RETURN jsonb_build_object('state','forbidden');
  END IF;
  SELECT * INTO b FROM public.bookings WHERE id=p_booking_id AND salon_id=p_salon_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('state','invalid_booking'); END IF;
  IF b.deleted_at IS NOT NULL OR coalesce(b.status,'') NOT IN ('pending','confirmed')
    OR b.start_time_utc IS NULL OR b.start_time_utc <= now()
    OR b.noshow_card_required IS DISTINCT FROM true OR b.noshow_card_id IS NOT NULL
    OR coalesce(b.card_protection_status,'') NOT IN ('awaiting_card','retry_required')
    OR b.client_email IS NULL OR b.client_email NOT LIKE '%@%'
    OR pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.lower(pg_catalog.btrim(b.client_email)), 'UTF8')), 'hex')
      IS DISTINCT FROM p_recipient_fingerprint
    OR NOT EXISTS (SELECT 1 FROM public.salons WHERE id=p_salon_id
      AND noshow_protection_enabled IS TRUE AND email_links_enabled IS DISTINCT FROM false) THEN
    RETURN jsonb_build_object('state','invalid_booking');
  END IF;
  INSERT INTO public.booking_card_retry_email_receipts(salon_id,booking_id,actor_id,recipient_fingerprint)
    VALUES(p_salon_id,p_booking_id,p_actor_id,p_recipient_fingerprint)
    ON CONFLICT (salon_id,booking_id) DO NOTHING RETURNING * INTO r;
  IF NOT FOUND THEN
    SELECT * INTO r FROM public.booking_card_retry_email_receipts
      WHERE salon_id=p_salon_id AND booking_id=p_booking_id;
    RETURN jsonb_build_object('state', CASE WHEN r.state='accepted' THEN 'already_accepted' ELSE 'blocked' END);
  END IF;
  RETURN jsonb_build_object('state','claimed','id',r.id,'attempt_id',r.attempt_id);
END;
$$;

REVOKE ALL ON FUNCTION public.claim_card_retry_email(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_card_retry_email(uuid,uuid,uuid,text) TO service_role;
