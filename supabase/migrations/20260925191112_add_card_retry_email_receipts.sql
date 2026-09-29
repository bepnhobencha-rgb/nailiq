-- Local-only candidate. Rollback: disable email-only action first; retain receipts
-- for reconciliation. Do not delete receipts to retry an uncertain provider call.
CREATE TABLE public.booking_card_retry_email_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id),
  booking_id uuid NOT NULL REFERENCES public.bookings(id),
  actor_id uuid NOT NULL,
  attempt_id uuid NOT NULL DEFAULT gen_random_uuid(),
  recipient_fingerprint text NOT NULL CHECK (recipient_fingerprint ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'claimed' CHECK (state IN ('claimed','accepted','unknown')),
  provider_message_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (salon_id, booking_id),
  CHECK ((state = 'accepted') = (provider_message_id IS NOT NULL)),
  CHECK (provider_message_id IS NULL OR length(btrim(provider_message_id)) BETWEEN 1 AND 256)
);
ALTER TABLE public.booking_card_retry_email_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.booking_card_retry_email_receipts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.booking_card_retry_email_receipts TO service_role;

-- Deliberately no TTL/reclaim: a crashed sender may already have delivered.
-- Authorization is checked BEFORE reading any receipt, including replays.
CREATE FUNCTION public.claim_card_retry_email(p_salon_id uuid, p_booking_id uuid,
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
    OR encode(extensions.digest(lower(btrim(b.client_email)), 'sha256'),'hex') IS DISTINCT FROM p_recipient_fingerprint
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

CREATE FUNCTION public.complete_card_retry_email(p_salon_id uuid, p_receipt_id uuid,
  p_attempt_id uuid, p_provider_message_id text) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE affected integer;
BEGIN
  UPDATE public.booking_card_retry_email_receipts
    SET state=CASE WHEN p_provider_message_id IS NULL THEN 'unknown' ELSE 'accepted' END,
      provider_message_id=p_provider_message_id, completed_at=now()
    WHERE id=p_receipt_id AND salon_id=p_salon_id AND attempt_id=p_attempt_id AND state='claimed';
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected=1;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_card_retry_email(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.complete_card_retry_email(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_card_retry_email(uuid,uuid,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_card_retry_email(uuid,uuid,uuid,text) TO service_role;
