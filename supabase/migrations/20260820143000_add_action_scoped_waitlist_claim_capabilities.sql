-- MQA-0099 adjacent closure: read-only waitlist inspection plus explicit,
-- request-bound POST claim. Additive/default-off; legacy service-role callers
-- remain compatible, while the raw legacy RPC is no longer an API capability.

ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS waitlist_offer_version bigint NOT NULL DEFAULT 0;
ALTER TABLE public.bookings DROP CONSTRAINT IF EXISTS bookings_waitlist_offer_version_check;
ALTER TABLE public.bookings ADD CONSTRAINT bookings_waitlist_offer_version_check
  CHECK(waitlist_offer_version>=0) NOT VALID;

CREATE OR REPLACE FUNCTION public.track_booking_waitlist_offer_version()
RETURNS trigger LANGUAGE plpgsql SET search_path TO '' AS $track_offer$
BEGIN
  NEW.waitlist_offer_version:=OLD.waitlist_offer_version;
  IF NEW.status IN ('cancelled','no_show') AND OLD.status IS DISTINCT FROM NEW.status THEN
    NEW.waitlist_offer_version:=OLD.waitlist_offer_version+1;
  END IF;
  RETURN NEW;
END;
$track_offer$;
DROP TRIGGER IF EXISTS track_booking_waitlist_offer_version_trigger ON public.bookings;
CREATE TRIGGER track_booking_waitlist_offer_version_trigger
  BEFORE UPDATE ON public.bookings FOR EACH ROW
  EXECUTE FUNCTION public.track_booking_waitlist_offer_version();
REVOKE ALL ON FUNCTION public.track_booking_waitlist_offer_version() FROM PUBLIC,anon,authenticated;

CREATE TABLE public.waitlist_claim_action_state (
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  waitlist_entry_id uuid NOT NULL REFERENCES public.booking_waitlist_entries(id) ON DELETE CASCADE,
  epoch bigint NOT NULL DEFAULT 1 CHECK(epoch>0),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY(waitlist_entry_id),
  UNIQUE(salon_id,waitlist_entry_id)
);

CREATE TABLE public.waitlist_claim_capabilities (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  salon_id uuid NOT NULL,
  waitlist_entry_id uuid NOT NULL,
  epoch bigint NOT NULL CHECK(epoch>0),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  consumed_at timestamptz,
  revoked_at timestamptz,
  request_id uuid,
  payload_fingerprint text CHECK(payload_fingerprint IS NULL OR payload_fingerprint~'^[0-9a-f]{64}$'),
  result_json jsonb,
  result_fingerprint text CHECK(result_fingerprint IS NULL OR result_fingerprint~'^[0-9a-f]{64}$'),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  FOREIGN KEY(salon_id,waitlist_entry_id)
    REFERENCES public.waitlist_claim_action_state(salon_id,waitlist_entry_id) ON DELETE CASCADE,
  CONSTRAINT waitlist_claim_capability_completion_check CHECK(
    (consumed_at IS NULL AND request_id IS NULL AND payload_fingerprint IS NULL
      AND result_json IS NULL AND result_fingerprint IS NULL)
    OR (consumed_at IS NOT NULL AND request_id IS NOT NULL AND payload_fingerprint IS NOT NULL
      AND result_json IS NOT NULL AND result_fingerprint IS NOT NULL)
  )
);
CREATE UNIQUE INDEX waitlist_claim_capabilities_one_active
  ON public.waitlist_claim_capabilities(salon_id,waitlist_entry_id,epoch)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;
CREATE INDEX idx_waitlist_claim_capabilities_expiry
  ON public.waitlist_claim_capabilities(expires_at,id)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

CREATE TABLE public.waitlist_claim_action_receipts (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  capability_id uuid NOT NULL REFERENCES public.waitlist_claim_capabilities(id) ON DELETE CASCADE,
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  waitlist_entry_id uuid NOT NULL REFERENCES public.booking_waitlist_entries(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  action_epoch bigint NOT NULL CHECK(action_epoch>0),
  payload_fingerprint text NOT NULL CHECK(payload_fingerprint~'^[0-9a-f]{64}$'),
  result_fingerprint text NOT NULL CHECK(result_fingerprint~'^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE(capability_id,request_id)
);

CREATE TABLE public.waitlist_offer_delivery_outbox (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  waitlist_entry_id uuid NOT NULL REFERENCES public.booking_waitlist_entries(id) ON DELETE CASCADE,
  offer_epoch bigint NOT NULL CHECK(offer_epoch>0),
  channel text NOT NULL CHECK(channel IN ('sms','email')),
  claim_capability_id uuid NOT NULL REFERENCES public.waitlist_claim_capabilities(id) ON DELETE CASCADE,
  recipient_fingerprint text CHECK(recipient_fingerprint IS NULL OR recipient_fingerprint~'^[0-9a-f]{64}$'),
  material_fingerprint text NOT NULL CHECK(material_fingerprint~'^[0-9a-f]{64}$'),
  payload_fingerprint text CHECK(payload_fingerprint IS NULL OR payload_fingerprint~'^[0-9a-f]{64}$'),
  status text NOT NULL CHECK(status IN ('pending','sending','sent','failed','unknown','suppressed')),
  attempt_token uuid,attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 1),
  provider_receipt text,error_code text,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  claimed_at timestamptz,completed_at timestamptz,updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE(waitlist_entry_id,offer_epoch,channel),
  CONSTRAINT waitlist_offer_delivery_sending_check CHECK(
    status<>'sending' OR (attempt_token IS NOT NULL AND attempt_count=1 AND claimed_at IS NOT NULL)),
  CONSTRAINT waitlist_offer_delivery_sent_receipt_check CHECK(
    status<>'sent' OR (channel='sms' AND provider_receipt~'^(SM|MM)[0-9a-fA-F]{32}$')
      OR (channel='email' AND length(provider_receipt) BETWEEN 1 AND 255
        AND provider_receipt~'^[[:graph:]]+$'))
);
CREATE INDEX idx_waitlist_offer_delivery_pending
  ON public.waitlist_offer_delivery_outbox(status,created_at,id) WHERE status='pending';

CREATE TABLE public.waitlist_offer_promotion_receipts (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  source_booking_id uuid NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  occurrence_fingerprint text NOT NULL CHECK(occurrence_fingerprint~'^[0-9a-f]{64}$'),
  result_json jsonb NOT NULL CHECK(jsonb_typeof(result_json)='object'),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE(source_booking_id,occurrence_fingerprint)
);

ALTER TABLE public.waitlist_claim_action_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.waitlist_claim_capabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.waitlist_claim_action_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.waitlist_offer_delivery_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.waitlist_offer_promotion_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.waitlist_claim_action_state,
  public.waitlist_claim_capabilities,public.waitlist_claim_action_receipts,
  public.waitlist_offer_delivery_outbox,public.waitlist_offer_promotion_receipts
  FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.waitlist_claim_action_state,
  public.waitlist_claim_capabilities,public.waitlist_claim_action_receipts,
  public.waitlist_offer_delivery_outbox,public.waitlist_offer_promotion_receipts TO service_role;
CREATE POLICY "deny direct api waitlist claim state" ON public.waitlist_claim_action_state
  AS RESTRICTIVE FOR ALL TO anon,authenticated USING(false) WITH CHECK(false);
CREATE POLICY "deny direct api waitlist claim capabilities" ON public.waitlist_claim_capabilities
  AS RESTRICTIVE FOR ALL TO anon,authenticated USING(false) WITH CHECK(false);
CREATE POLICY "deny direct api waitlist claim receipts" ON public.waitlist_claim_action_receipts
  AS RESTRICTIVE FOR ALL TO anon,authenticated USING(false) WITH CHECK(false);
CREATE POLICY "deny direct api waitlist offer delivery" ON public.waitlist_offer_delivery_outbox
  AS RESTRICTIVE FOR ALL TO anon,authenticated USING(false) WITH CHECK(false);
CREATE POLICY "deny direct api waitlist offer promotion receipts" ON public.waitlist_offer_promotion_receipts
  AS RESTRICTIVE FOR ALL TO anon,authenticated USING(false) WITH CHECK(false);

CREATE OR REPLACE FUNCTION public.ensure_waitlist_offer_delivery_outbox(
  p_salon_id uuid,p_waitlist_entry_id uuid,p_offer_epoch bigint,p_claim_capability_id uuid
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $ensure$
DECLARE v_entry public.booking_waitlist_entries%ROWTYPE; v_channel text;
  v_recipient text; v_recipient_fp text; v_material text;
  v_salon public.salons%ROWTYPE; v_service_name text; v_staff_name text; v_locale text;
BEGIN
  SELECT * INTO STRICT v_entry FROM public.booking_waitlist_entries
  WHERE id=p_waitlist_entry_id AND salon_id=p_salon_id;
  SELECT s.* INTO STRICT v_salon FROM public.salons s WHERE s.id=p_salon_id;
  v_locale:=CASE lower(trim(split_part(coalesce(nullif(v_salon.default_notification_locale,''),
    nullif(v_salon.default_language,''),'en'),'-',1))) WHEN 'vi' THEN 'vi' ELSE 'en' END;
  SELECT sv.name INTO STRICT v_service_name FROM public.services sv
  WHERE sv.id=v_entry.service_id AND sv.salon_id=p_salon_id;
  IF v_entry.offered_staff_id IS NOT NULL THEN
    SELECT st.name INTO v_staff_name FROM public.staff st
    WHERE st.id=v_entry.offered_staff_id AND st.salon_id=p_salon_id;
  END IF;
  FOREACH v_channel IN ARRAY ARRAY['sms','email'] LOOP
    v_recipient:=CASE v_channel WHEN 'sms' THEN nullif(trim(v_entry.client_phone),'')
      ELSE nullif(lower(trim(coalesce(v_entry.client_email,''))),'') END;
    v_recipient_fp:=CASE WHEN v_recipient IS NULL THEN NULL ELSE encode(extensions.digest(
      pg_catalog.convert_to(v_recipient,'UTF8'),'sha256'),'hex') END;
    v_material:=encode(extensions.digest(pg_catalog.convert_to(jsonb_build_object(
      'salon_id',p_salon_id,'waitlist_entry_id',p_waitlist_entry_id,'offer_epoch',p_offer_epoch,
      'channel',v_channel,'service_id',v_entry.service_id,'booking_date',v_entry.booking_date,
      'salon_name',v_salon.name,'salon_slug',v_salon.slug,'salon_timezone',v_salon.timezone,
      'salon_logo_url',v_salon.logo_url,'salon_phone',coalesce(nullif(v_salon.salon_phone,''),v_salon.phone),
      'sms_outbound_enabled',coalesce(v_salon.sms_outbound_enabled,false),
      'email_outbound_enabled',coalesce(v_salon.email_outbound_enabled,false),
      'locale',v_locale,'service_name',v_service_name,'staff_name',v_staff_name,
      'client_name',v_entry.client_name,'recipient_fingerprint',v_recipient_fp,
      'offered_staff_id',v_entry.offered_staff_id,'offered_start_utc',v_entry.offered_start_utc,
      'offered_end_utc',v_entry.offered_end_utc,'claim_capability_id',p_claim_capability_id
    )::text,'UTF8'),'sha256'),'hex');
    INSERT INTO public.waitlist_offer_delivery_outbox(salon_id,waitlist_entry_id,offer_epoch,
      channel,claim_capability_id,recipient_fingerprint,material_fingerprint,status,
      completed_at,error_code)
    VALUES(p_salon_id,p_waitlist_entry_id,p_offer_epoch,v_channel,p_claim_capability_id,
      v_recipient_fp,v_material,
      CASE WHEN v_recipient IS NULL THEN 'suppressed' ELSE 'pending' END,
      CASE WHEN v_recipient IS NULL THEN transaction_timestamp() END,
      CASE WHEN v_recipient IS NULL THEN 'recipient_missing' END)
    ON CONFLICT(waitlist_entry_id,offer_epoch,channel) DO UPDATE SET
      claim_capability_id=excluded.claim_capability_id,
      recipient_fingerprint=excluded.recipient_fingerprint,
      material_fingerprint=excluded.material_fingerprint,
      updated_at=transaction_timestamp()
    WHERE public.waitlist_offer_delivery_outbox.attempt_count=0
      AND public.waitlist_offer_delivery_outbox.status IN ('pending','suppressed');
  END LOOP;
END;
$ensure$;

CREATE OR REPLACE FUNCTION public.load_waitlist_offer_delivery_material(
  p_salon_id uuid,p_waitlist_entry_id uuid,p_offer_epoch bigint,p_channel text,
  p_claim_capability_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $load$
DECLARE v_row public.waitlist_offer_delivery_outbox%ROWTYPE;
  v_entry public.booking_waitlist_entries%ROWTYPE; v_recipient text;
  v_salon public.salons%ROWTYPE; v_service_name text; v_staff_name text; v_locale text;
  v_current_material text;
BEGIN
  IF p_salon_id IS NULL OR p_waitlist_entry_id IS NULL OR coalesce(p_offer_epoch,0)<1
     OR p_channel NOT IN ('sms','email') OR p_claim_capability_id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','invalid_request');
  END IF;
  SELECT * INTO v_row FROM public.waitlist_offer_delivery_outbox
  WHERE salon_id=p_salon_id AND waitlist_entry_id=p_waitlist_entry_id
    AND offer_epoch=p_offer_epoch AND channel=p_channel
    AND claim_capability_id=p_claim_capability_id;
  IF NOT FOUND OR v_row.status<>'pending' THEN
    RETURN jsonb_build_object('ok',false,'code','unavailable');
  END IF;
  SELECT * INTO STRICT v_entry FROM public.booking_waitlist_entries
  WHERE id=p_waitlist_entry_id AND salon_id=p_salon_id FOR SHARE;
  SELECT s.* INTO STRICT v_salon FROM public.salons s WHERE s.id=p_salon_id FOR SHARE;
  v_locale:=CASE lower(trim(split_part(coalesce(nullif(v_salon.default_notification_locale,''),
    nullif(v_salon.default_language,''),'en'),'-',1))) WHEN 'vi' THEN 'vi' ELSE 'en' END;
  SELECT sv.name INTO STRICT v_service_name FROM public.services sv
  WHERE sv.id=v_entry.service_id AND sv.salon_id=p_salon_id;
  IF v_entry.offered_staff_id IS NOT NULL THEN SELECT st.name INTO v_staff_name
    FROM public.staff st WHERE st.id=v_entry.offered_staff_id AND st.salon_id=p_salon_id; END IF;
  v_recipient:=CASE p_channel WHEN 'sms' THEN nullif(trim(v_entry.client_phone),'')
    ELSE nullif(lower(trim(coalesce(v_entry.client_email,''))),'') END;
  IF v_recipient IS NULL THEN RETURN jsonb_build_object('ok',false,'code','unavailable'); END IF;
  v_current_material:=encode(extensions.digest(pg_catalog.convert_to(jsonb_build_object(
    'salon_id',p_salon_id,'waitlist_entry_id',p_waitlist_entry_id,'offer_epoch',p_offer_epoch,
    'channel',p_channel,'service_id',v_entry.service_id,'booking_date',v_entry.booking_date,
    'salon_name',v_salon.name,'salon_slug',v_salon.slug,'salon_timezone',v_salon.timezone,
    'salon_logo_url',v_salon.logo_url,'salon_phone',coalesce(nullif(v_salon.salon_phone,''),v_salon.phone),
    'sms_outbound_enabled',coalesce(v_salon.sms_outbound_enabled,false),
    'email_outbound_enabled',coalesce(v_salon.email_outbound_enabled,false),
    'locale',v_locale,'service_name',v_service_name,'staff_name',v_staff_name,
    'client_name',v_entry.client_name,'recipient_fingerprint',encode(extensions.digest(
      pg_catalog.convert_to(v_recipient,'UTF8'),'sha256'),'hex'),
    'offered_staff_id',v_entry.offered_staff_id,'offered_start_utc',v_entry.offered_start_utc,
    'offered_end_utc',v_entry.offered_end_utc,'claim_capability_id',p_claim_capability_id
  )::text,'UTF8'),'sha256'),'hex');
  IF v_current_material<>v_row.material_fingerprint THEN
    RETURN jsonb_build_object('ok',false,'code','material_changed');
  END IF;
  RETURN jsonb_build_object('ok',true,'code','material_loaded',
    'material_fingerprint',v_row.material_fingerprint,
    'recipient_fingerprint',v_row.recipient_fingerprint,
    'snapshot',jsonb_build_object('salon_id',p_salon_id,'waitlist_entry_id',p_waitlist_entry_id,
      'offer_epoch',p_offer_epoch,'channel',p_channel,'claim_capability_id',p_claim_capability_id,
      'salon_name',v_salon.name,'salon_slug',v_salon.slug,'salon_timezone',v_salon.timezone,
      'salon_logo_url',v_salon.logo_url,'salon_phone',coalesce(nullif(v_salon.salon_phone,''),v_salon.phone),
      'sms_outbound_enabled',coalesce(v_salon.sms_outbound_enabled,false),
      'email_outbound_enabled',coalesce(v_salon.email_outbound_enabled,false),
      'locale',v_locale,'service_id',v_entry.service_id,'service_name',v_service_name,
      'client_name',v_entry.client_name,'recipient',v_recipient,'booking_date',v_entry.booking_date,
      'offered_staff_id',v_entry.offered_staff_id,'staff_name',v_staff_name,
      'offered_start_utc',v_entry.offered_start_utc,'offered_end_utc',v_entry.offered_end_utc));
END;
$load$;

CREATE OR REPLACE FUNCTION public.mint_waitlist_claim_capability(
  p_salon_id uuid,p_waitlist_entry_id uuid,p_min_expires_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $mint$
DECLARE
  v_entry public.booking_waitlist_entries%ROWTYPE;
  v_state public.waitlist_claim_action_state%ROWTYPE;
  v_cap public.waitlist_claim_capabilities%ROWTYPE;
  v_now timestamptz:=transaction_timestamp(); v_max timestamptz;
BEGIN
  IF p_salon_id IS NULL OR p_waitlist_entry_id IS NULL OR p_min_expires_at IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','invalid_request');
  END IF;
  SELECT * INTO v_entry FROM public.booking_waitlist_entries
  WHERE id=p_waitlist_entry_id AND salon_id=p_salon_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'code','entry_not_found'); END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'waitlist-claim:'||p_waitlist_entry_id::text,0));
  INSERT INTO public.waitlist_claim_action_state(salon_id,waitlist_entry_id)
  SELECT w.salon_id,w.id FROM public.booking_waitlist_entries w
  WHERE w.id=p_waitlist_entry_id AND w.salon_id=p_salon_id ON CONFLICT DO NOTHING;
  SELECT * INTO v_state FROM public.waitlist_claim_action_state
  WHERE salon_id=p_salon_id AND waitlist_entry_id=p_waitlist_entry_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'code','entry_not_found'); END IF;
  SELECT * INTO v_entry FROM public.booking_waitlist_entries
  WHERE id=p_waitlist_entry_id AND salon_id=p_salon_id FOR SHARE;
  IF v_entry.status<>'notified' OR v_entry.claimed_at IS NOT NULL OR v_entry.claim_token IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','claim_unavailable');
  END IF;
  v_max:=least(v_now+interval '2 hours',coalesce(v_entry.offered_start_utc,v_now+interval '2 hours'));
  IF p_min_expires_at<=v_now OR p_min_expires_at>v_max THEN
    RETURN jsonb_build_object('ok',false,'code','expiry_out_of_bounds','max_expires_at',v_max);
  END IF;
  SELECT * INTO v_cap FROM public.waitlist_claim_capabilities
  WHERE salon_id=p_salon_id AND waitlist_entry_id=p_waitlist_entry_id AND epoch=v_state.epoch
    AND consumed_at IS NULL AND revoked_at IS NULL FOR UPDATE;
  IF FOUND AND v_cap.expires_at>=p_min_expires_at THEN
    PERFORM public.ensure_waitlist_offer_delivery_outbox(
      p_salon_id,p_waitlist_entry_id,v_state.epoch,v_cap.id);
    RETURN jsonb_build_object('ok',true,'code','reused','token_id',v_cap.id,
      'epoch',v_cap.epoch,'expires_at',v_cap.expires_at);
  END IF;
  IF FOUND THEN UPDATE public.waitlist_claim_capabilities SET revoked_at=v_now,updated_at=v_now
    WHERE id=v_cap.id; END IF;
  INSERT INTO public.waitlist_claim_capabilities(salon_id,waitlist_entry_id,epoch,expires_at)
  VALUES(p_salon_id,p_waitlist_entry_id,v_state.epoch,p_min_expires_at) RETURNING * INTO v_cap;
  PERFORM public.ensure_waitlist_offer_delivery_outbox(
    p_salon_id,p_waitlist_entry_id,v_state.epoch,v_cap.id);
  RETURN jsonb_build_object('ok',true,'code','minted','token_id',v_cap.id,
    'epoch',v_cap.epoch,'expires_at',v_cap.expires_at);
END;
$mint$;

CREATE OR REPLACE FUNCTION public.promote_waitlist_for_freed_slot(
  p_salon_id uuid,p_service_id uuid,p_booking_date date,p_offered_staff_id uuid,
  p_offered_start_utc timestamptz,p_offered_end_utc timestamptz,p_window_minutes integer DEFAULT 20
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $promote_slot$
DECLARE v_entry public.booking_waitlist_entries%ROWTYPE; v_cap jsonb;
  v_now timestamptz:=transaction_timestamp(); v_window integer;
  v_expiry timestamptz; v_failure text;
BEGIN
  IF p_salon_id IS NULL OR p_service_id IS NULL OR p_booking_date IS NULL
     OR p_window_minutes IS NULL OR p_window_minutes<1 OR p_window_minutes>120
     OR ((p_offered_start_utc IS NULL)<>(p_offered_end_utc IS NULL))
     OR (p_offered_start_utc IS NOT NULL AND p_offered_end_utc<=p_offered_start_utc) THEN
    RETURN jsonb_build_object('ok',false,'code','invalid_request');
  END IF;
  v_window:=p_window_minutes;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'waitlist-offer:'||p_salon_id::text||':'||p_service_id::text||':'||p_booking_date::text,0));
  SELECT * INTO v_entry FROM public.booking_waitlist_entries w
  WHERE w.salon_id=p_salon_id AND w.service_id=p_service_id
    AND w.booking_date=p_booking_date AND w.status='waiting'
  ORDER BY w.created_at,w.id LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',true,'code','no_waiter'); END IF;
  UPDATE public.booking_waitlist_entries SET status='notified',notified_at=v_now,
    claim_token=extensions.gen_random_uuid(),offered_staff_id=CASE
      WHEN p_offered_start_utc>v_now THEN p_offered_staff_id END,
    offered_start_utc=CASE WHEN p_offered_start_utc>v_now THEN p_offered_start_utc END,
    offered_end_utc=CASE WHEN p_offered_start_utc>v_now THEN p_offered_end_utc END
  WHERE id=v_entry.id;
  v_expiry:=CASE WHEN p_offered_start_utc>v_now
    THEN least(v_now+make_interval(mins=>v_window),p_offered_start_utc)
    ELSE v_now+make_interval(mins=>v_window) END;
  BEGIN
    v_cap:=public.mint_waitlist_claim_capability(p_salon_id,v_entry.id,v_expiry);
  EXCEPTION WHEN OTHERS THEN
    v_failure:=SQLSTATE;
    v_cap:=jsonb_build_object('ok',false,'code','mint_exception');
  END;
  IF coalesce(v_cap->>'ok','false')<>'true' THEN
    UPDATE public.booking_waitlist_entries SET status='waiting',notified_at=NULL,
      claim_token=NULL,offered_staff_id=NULL,offered_start_utc=NULL,offered_end_utc=NULL
    WHERE id=v_entry.id AND status='notified' AND claimed_at IS NULL;
    RETURN jsonb_build_object('ok',false,'code','promotion_skipped',
      'reason',coalesce(v_cap->>'code',v_failure,'mint_failed'));
  END IF;
  RETURN jsonb_build_object('ok',true,'code','promoted','waitlist_entry_id',v_entry.id,
    'claim_capability_token',v_cap->>'token_id','offer_epoch',(v_cap->>'epoch')::bigint,
    'expires_at',v_cap->>'expires_at');
END;
$promote_slot$;

CREATE OR REPLACE FUNCTION public.promote_waitlist_for_booking(p_booking_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $promote_booking$
DECLARE v_booking public.bookings%ROWTYPE; v_tz text; v_result jsonb;
  v_receipt public.waitlist_offer_promotion_receipts%ROWTYPE; v_occurrence text;
BEGIN
  IF p_booking_id IS NULL THEN RETURN jsonb_build_object('ok',false,'code','invalid_request'); END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'waitlist-booking-promotion:'||p_booking_id::text,0));
  SELECT * INTO v_booking FROM public.bookings WHERE id=p_booking_id FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'code','booking_not_found'); END IF;
  IF v_booking.status NOT IN ('cancelled','no_show') THEN
    RETURN jsonb_build_object('ok',false,'code','booking_not_freed');
  END IF;
  v_occurrence:=encode(extensions.digest(pg_catalog.convert_to(jsonb_build_object(
    'booking_id',v_booking.id,'status',v_booking.status,'start_time_utc',v_booking.start_time_utc,
    'end_time_utc',v_booking.end_time_utc,'waitlist_offer_version',v_booking.waitlist_offer_version,
    'customer_transition_version',v_booking.customer_transition_version)::text,'UTF8'),'sha256'),'hex');
  SELECT * INTO v_receipt FROM public.waitlist_offer_promotion_receipts
  WHERE source_booking_id=v_booking.id AND occurrence_fingerprint=v_occurrence;
  IF FOUND THEN RETURN v_receipt.result_json||jsonb_build_object('idempotent',true); END IF;
  SELECT coalesce(nullif(trim(s.timezone),''),'America/Los_Angeles') INTO v_tz
  FROM public.salons s WHERE s.id=v_booking.salon_id;
  v_result:=public.promote_waitlist_for_freed_slot(v_booking.salon_id,v_booking.service_id,
    (v_booking.start_time_utc AT TIME ZONE v_tz)::date,
    CASE WHEN v_booking.start_time_utc>transaction_timestamp() THEN v_booking.staff_id END,
    CASE WHEN v_booking.start_time_utc>transaction_timestamp() THEN v_booking.start_time_utc END,
    CASE WHEN v_booking.start_time_utc>transaction_timestamp() THEN v_booking.end_time_utc END,20);
  v_result:=v_result||jsonb_build_object('booking_id',v_booking.id,
    'salon_id',v_booking.salon_id,'idempotent',false);
  IF v_result->>'ok'='true' THEN
    INSERT INTO public.waitlist_offer_promotion_receipts(salon_id,source_booking_id,
      occurrence_fingerprint,result_json)
    VALUES(v_booking.salon_id,v_booking.id,v_occurrence,v_result);
  END IF;
  RETURN v_result;
END;
$promote_booking$;

CREATE OR REPLACE FUNCTION public.promote_waitlist_entry(
  p_salon_id uuid,p_waitlist_entry_id uuid,p_window_minutes integer DEFAULT 20
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $promote_entry$
DECLARE v_entry public.booking_waitlist_entries%ROWTYPE; v_state public.waitlist_claim_action_state%ROWTYPE;
  v_cap public.waitlist_claim_capabilities%ROWTYPE; v_minted jsonb;
  v_now timestamptz:=transaction_timestamp(); v_expiry timestamptz;
BEGIN
  IF p_salon_id IS NULL OR p_waitlist_entry_id IS NULL OR p_window_minutes IS NULL
     OR p_window_minutes<1 OR p_window_minutes>120 THEN
    RETURN jsonb_build_object('ok',false,'code','invalid_request');
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'waitlist-claim:'||p_waitlist_entry_id::text,0));
  SELECT * INTO v_entry FROM public.booking_waitlist_entries
  WHERE id=p_waitlist_entry_id AND salon_id=p_salon_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'code','entry_not_found'); END IF;
  IF v_entry.status='notified' AND v_entry.claimed_at IS NULL AND v_entry.claim_token IS NOT NULL THEN
    SELECT * INTO v_state FROM public.waitlist_claim_action_state
    WHERE salon_id=p_salon_id AND waitlist_entry_id=p_waitlist_entry_id;
    IF FOUND THEN SELECT * INTO v_cap FROM public.waitlist_claim_capabilities
      WHERE salon_id=p_salon_id AND waitlist_entry_id=p_waitlist_entry_id AND epoch=v_state.epoch
        AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>v_now;
    END IF;
    IF v_cap.id IS NOT NULL THEN
      PERFORM public.ensure_waitlist_offer_delivery_outbox(p_salon_id,p_waitlist_entry_id,v_cap.epoch,v_cap.id);
      RETURN jsonb_build_object('ok',true,'code','promoted','salon_id',p_salon_id,
        'waitlist_entry_id',p_waitlist_entry_id,'claim_capability_token',v_cap.id,
        'offer_epoch',v_cap.epoch,'expires_at',v_cap.expires_at,'idempotent',true);
    END IF;
    RETURN jsonb_build_object('ok',false,'code','offer_state_invalid');
  END IF;
  IF v_entry.status<>'waiting' THEN RETURN jsonb_build_object('ok',false,'code','entry_unavailable'); END IF;
  UPDATE public.booking_waitlist_entries SET status='notified',notified_at=v_now,
    claim_token=extensions.gen_random_uuid() WHERE id=v_entry.id;
  v_expiry:=CASE WHEN v_entry.offered_start_utc>v_now
    THEN least(v_now+make_interval(mins=>p_window_minutes),v_entry.offered_start_utc)
    ELSE v_now+make_interval(mins=>p_window_minutes) END;
  BEGIN
    v_minted:=public.mint_waitlist_claim_capability(p_salon_id,p_waitlist_entry_id,v_expiry);
  EXCEPTION WHEN OTHERS THEN
    v_minted:=jsonb_build_object('ok',false,'code','mint_exception');
  END;
  IF v_minted->>'ok'<>'true' THEN
    UPDATE public.booking_waitlist_entries SET status='waiting',notified_at=NULL,claim_token=NULL
    WHERE id=v_entry.id AND status='notified' AND claimed_at IS NULL;
    RETURN jsonb_build_object('ok',false,'code','promotion_skipped',
      'reason',coalesce(v_minted->>'code','mint_failed'));
  END IF;
  RETURN jsonb_build_object('ok',true,'code','promoted','salon_id',p_salon_id,
    'waitlist_entry_id',p_waitlist_entry_id,'claim_capability_token',v_minted->>'token_id',
    'offer_epoch',(v_minted->>'epoch')::bigint,'expires_at',v_minted->>'expires_at','idempotent',false);
END;
$promote_entry$;

CREATE OR REPLACE FUNCTION public.advance_waitlist_offer_capabilities(p_window_minutes integer DEFAULT 20)
RETURNS SETOF jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $advance$
DECLARE v_old public.booking_waitlist_entries%ROWTYPE; v_state public.waitlist_claim_action_state%ROWTYPE;
  v_offer jsonb; v_count integer:=0; v_now timestamptz:=transaction_timestamp();
BEGIN
  IF p_window_minutes IS NULL OR p_window_minutes<1 OR p_window_minutes>120 THEN
    RETURN NEXT jsonb_build_object('ok',false,'code','invalid_request'); RETURN;
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('waitlist-advance',0));
  LOOP
    SELECT * INTO v_old FROM public.booking_waitlist_entries w
    WHERE w.status='notified' AND w.claimed_at IS NULL
      AND w.notified_at<v_now-make_interval(mins=>p_window_minutes)
    ORDER BY w.notified_at,w.id LIMIT 1 FOR UPDATE SKIP LOCKED;
    EXIT WHEN NOT FOUND OR v_count>=100;
    UPDATE public.booking_waitlist_entries SET status='expired',claim_token=NULL,
      offered_staff_id=NULL,offered_start_utc=NULL,offered_end_utc=NULL
    WHERE id=v_old.id;
    SELECT * INTO v_state FROM public.waitlist_claim_action_state
    WHERE salon_id=v_old.salon_id AND waitlist_entry_id=v_old.id FOR UPDATE;
    IF FOUND THEN
      UPDATE public.waitlist_claim_capabilities SET revoked_at=v_now,updated_at=v_now
      WHERE salon_id=v_old.salon_id AND waitlist_entry_id=v_old.id
        AND epoch=v_state.epoch AND consumed_at IS NULL AND revoked_at IS NULL;
      UPDATE public.waitlist_claim_action_state SET epoch=epoch+1,updated_at=v_now
      WHERE salon_id=v_old.salon_id AND waitlist_entry_id=v_old.id;
      UPDATE public.waitlist_offer_delivery_outbox SET
        status=CASE WHEN status='sending' THEN 'unknown' ELSE 'suppressed' END,
        error_code=CASE WHEN status='sending' THEN 'offer_expired_delivery_ambiguous'
          ELSE 'offer_expired' END,completed_at=v_now,updated_at=v_now
      WHERE waitlist_entry_id=v_old.id AND offer_epoch=v_state.epoch
        AND status IN ('pending','sending');
    END IF;
    v_offer:=public.promote_waitlist_for_freed_slot(v_old.salon_id,v_old.service_id,
      v_old.booking_date,v_old.offered_staff_id,v_old.offered_start_utc,v_old.offered_end_utc,
      p_window_minutes);
    IF v_offer->>'code'='promoted' THEN
      RETURN NEXT v_offer||jsonb_build_object('salon_id',v_old.salon_id,
        'expired_waitlist_entry_id',v_old.id);
    END IF;
    v_count:=v_count+1;
  END LOOP;
END;
$advance$;

CREATE OR REPLACE FUNCTION public.cancel_booking_by_id_with_waitlist_offer(p_booking_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $cancel_offer$
DECLARE v_booking public.bookings%ROWTYPE; v_offer jsonb;
BEGIN
  IF p_booking_id IS NULL THEN RETURN jsonb_build_object('ok',false,'code','invalid_request'); END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'waitlist-booking-promotion:'||p_booking_id::text,0));
  SELECT * INTO v_booking FROM public.bookings WHERE id=p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'code','booking_not_found'); END IF;
  IF v_booking.status NOT IN ('pending','confirmed','cancelled') THEN
    RETURN jsonb_build_object('ok',false,'code','booking_not_cancellable');
  END IF;
  IF v_booking.status<>'cancelled' THEN
    UPDATE public.bookings SET status='cancelled' WHERE id=v_booking.id RETURNING * INTO v_booking;
  END IF;
  v_offer:=public.promote_waitlist_for_booking(v_booking.id);
  RETURN jsonb_build_object('ok',true,'code','ok','booking_id',v_booking.id,
    'promoted_waitlist',CASE WHEN v_offer->>'code'='promoted' THEN v_offer END,
    'waitlist_result_code',v_offer->>'code');
END;
$cancel_offer$;

CREATE OR REPLACE FUNCTION public.cancel_booking_by_id(p_booking_id uuid)
RETURNS TABLE(ok boolean,code text,booking_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $legacy_cancel$
DECLARE v_result jsonb;
BEGIN
  v_result:=public.cancel_booking_by_id_with_waitlist_offer(p_booking_id);
  RETURN QUERY SELECT coalesce((v_result->>'ok')::boolean,false),
    coalesce(v_result->>'code','booking_not_cancellable'),
    CASE WHEN v_result->>'booking_id' IS NULL THEN NULL ELSE (v_result->>'booking_id')::uuid END;
END;
$legacy_cancel$;

CREATE OR REPLACE FUNCTION public.notify_waitlist_for_no_show(p_booking_id uuid)
RETURNS TABLE(entry_id uuid,service_name text,salon_name text,booking_date date)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $legacy_no_show$
DECLARE v_result jsonb; v_booking public.bookings%ROWTYPE; v_tz text;
BEGIN
  SELECT * INTO v_booking FROM public.bookings WHERE id=p_booking_id;
  IF NOT FOUND OR v_booking.status<>'no_show' THEN RETURN; END IF;
  v_result:=public.promote_waitlist_for_booking(p_booking_id);
  IF v_result->>'code'<>'promoted' THEN RETURN; END IF;
  SELECT coalesce(nullif(trim(s.timezone),''),'America/Los_Angeles') INTO v_tz
  FROM public.salons s WHERE s.id=v_booking.salon_id;
  RETURN QUERY SELECT (v_result->>'waitlist_entry_id')::uuid,
    (SELECT sv.name FROM public.services sv WHERE sv.id=v_booking.service_id),
    (SELECT s.name FROM public.salons s WHERE s.id=v_booking.salon_id),
    (v_booking.start_time_utc AT TIME ZONE v_tz)::date;
END;
$legacy_no_show$;

CREATE OR REPLACE FUNCTION public.inspect_waitlist_claim_capability(p_token_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO ''
AS $inspect$
DECLARE v_cap public.waitlist_claim_capabilities%ROWTYPE;
  v_state public.waitlist_claim_action_state%ROWTYPE;
  v_entry public.booking_waitlist_entries%ROWTYPE;
BEGIN
  IF p_token_id IS NULL THEN RETURN jsonb_build_object('ok',false,'code','invalid_request'); END IF;
  SELECT * INTO v_cap FROM public.waitlist_claim_capabilities WHERE id=p_token_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'code','unavailable'); END IF;
  IF v_cap.revoked_at IS NOT NULL OR v_cap.expires_at<=transaction_timestamp()
     OR v_cap.consumed_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok',false,'code','unavailable');
  END IF;
  SELECT * INTO v_state FROM public.waitlist_claim_action_state
  WHERE salon_id=v_cap.salon_id AND waitlist_entry_id=v_cap.waitlist_entry_id;
  SELECT * INTO v_entry FROM public.booking_waitlist_entries
  WHERE id=v_cap.waitlist_entry_id AND salon_id=v_cap.salon_id;
  IF NOT FOUND OR v_state.epoch<>v_cap.epoch OR v_entry.status<>'notified'
     OR v_entry.claimed_at IS NOT NULL OR v_entry.claim_token IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','unavailable');
  END IF;
  RETURN jsonb_build_object('ok',true,'code','available','expires_at',v_cap.expires_at,
    'context',jsonb_build_object('salon_id',v_cap.salon_id,
      'waitlist_entry_id',v_cap.waitlist_entry_id,'service_id',v_entry.service_id,
      'offered_staff_id',v_entry.offered_staff_id,'offered_start_utc',v_entry.offered_start_utc,
      'offered_end_utc',v_entry.offered_end_utc));
END;
$inspect$;

CREATE OR REPLACE FUNCTION public.claim_waitlist_with_management_capability(
  p_token_id uuid,p_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $claim$
DECLARE
  v_cap public.waitlist_claim_capabilities%ROWTYPE;
  v_state public.waitlist_claim_action_state%ROWTYPE;
  v_entry public.booking_waitlist_entries%ROWTYPE;
  v_legacy record; v_result jsonb; v_payload jsonb;
  v_payload_hash text; v_result_hash text; v_now timestamptz:=transaction_timestamp();
  v_lookup_entry_id uuid;
BEGIN
  IF p_token_id IS NULL OR p_request_id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','invalid_request');
  END IF;
  v_payload:=jsonb_build_object('action','waitlist_claim');
  v_payload_hash:=encode(extensions.digest(pg_catalog.convert_to(v_payload::text,'UTF8'),'sha256'),'hex');
  SELECT waitlist_entry_id INTO v_lookup_entry_id FROM public.waitlist_claim_capabilities WHERE id=p_token_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'code','unavailable'); END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'waitlist-claim:'||v_lookup_entry_id::text,0));
  SELECT * INTO v_cap FROM public.waitlist_claim_capabilities WHERE id=p_token_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'code','unavailable'); END IF;
  IF v_cap.consumed_at IS NOT NULL THEN
    IF v_cap.request_id=p_request_id AND v_cap.payload_fingerprint=v_payload_hash THEN
      RETURN v_cap.result_json||jsonb_build_object('idempotent',true);
    END IF;
    RETURN jsonb_build_object('ok',false,'code','idempotency_mismatch');
  END IF;
  IF v_cap.revoked_at IS NOT NULL OR v_cap.expires_at<=v_now THEN
    RETURN jsonb_build_object('ok',false,'code','unavailable');
  END IF;
  SELECT * INTO v_state FROM public.waitlist_claim_action_state
  WHERE salon_id=v_cap.salon_id AND waitlist_entry_id=v_cap.waitlist_entry_id FOR UPDATE;
  IF NOT FOUND OR v_state.epoch<>v_cap.epoch THEN
    RETURN jsonb_build_object('ok',false,'code','unavailable');
  END IF;
  SELECT * INTO v_entry FROM public.booking_waitlist_entries
  WHERE id=v_cap.waitlist_entry_id AND salon_id=v_cap.salon_id FOR UPDATE;
  IF NOT FOUND OR v_entry.status<>'notified' OR v_entry.claimed_at IS NOT NULL
     OR v_entry.claim_token IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','unavailable');
  END IF;
  SELECT * INTO v_legacy FROM public.claim_waitlist_slot(v_entry.claim_token) LIMIT 1;
  IF NOT FOUND THEN
    -- The legacy auto-booker deliberately restores the entry to waiting when
    -- its booking transaction cannot be authorized. Retire this offer epoch
    -- atomically so a later offer can never reuse its bearer or outbox key.
    v_result:=jsonb_build_object('ok',false,'code','unavailable','outcome','auto_book_failed',
      'salon_id',v_cap.salon_id,'waitlist_entry_id',v_cap.waitlist_entry_id,
      'action_epoch',v_cap.epoch,'idempotent',false);
    v_result_hash:=encode(extensions.digest(pg_catalog.convert_to(v_result::text,'UTF8'),'sha256'),'hex');
    UPDATE public.waitlist_claim_capabilities SET consumed_at=v_now,request_id=p_request_id,
      payload_fingerprint=v_payload_hash,result_json=v_result,result_fingerprint=v_result_hash,
      revoked_at=v_now,updated_at=v_now WHERE id=v_cap.id;
    UPDATE public.waitlist_claim_action_state SET epoch=epoch+1,updated_at=v_now
    WHERE salon_id=v_cap.salon_id AND waitlist_entry_id=v_cap.waitlist_entry_id;
    INSERT INTO public.waitlist_claim_action_receipts(capability_id,salon_id,waitlist_entry_id,
      request_id,action_epoch,payload_fingerprint,result_fingerprint)
    VALUES(v_cap.id,v_cap.salon_id,v_cap.waitlist_entry_id,p_request_id,v_cap.epoch,
      v_payload_hash,v_result_hash);
    UPDATE public.waitlist_offer_delivery_outbox SET
      status=CASE WHEN status='sending' THEN 'unknown' ELSE 'suppressed' END,
      error_code=CASE WHEN status='sending' THEN 'auto_book_failed_delivery_ambiguous'
        ELSE 'auto_book_failed' END,
      completed_at=v_now,updated_at=v_now
    WHERE waitlist_entry_id=v_cap.waitlist_entry_id AND offer_epoch=v_cap.epoch
      AND status IN ('pending','sending');
    RETURN v_result;
  END IF;
  v_result:=jsonb_build_object('ok',true,'code','claimed','outcome',
    CASE WHEN coalesce(v_legacy.auto_booked,false) THEN 'booked' ELSE 'claimed' END,
    'salon_id',v_cap.salon_id,'waitlist_entry_id',v_cap.waitlist_entry_id,
    'booking_id',v_legacy.booking_id,'booked_start_utc',v_legacy.booked_start_utc,
    'action_epoch',v_cap.epoch,'idempotent',false);
  v_result_hash:=encode(extensions.digest(pg_catalog.convert_to(v_result::text,'UTF8'),'sha256'),'hex');
  UPDATE public.waitlist_claim_capabilities SET consumed_at=v_now,request_id=p_request_id,
    payload_fingerprint=v_payload_hash,result_json=v_result,result_fingerprint=v_result_hash,
    updated_at=v_now WHERE id=v_cap.id;
  UPDATE public.waitlist_claim_action_state SET epoch=epoch+1,updated_at=v_now
  WHERE salon_id=v_cap.salon_id AND waitlist_entry_id=v_cap.waitlist_entry_id;
  INSERT INTO public.waitlist_claim_action_receipts(capability_id,salon_id,waitlist_entry_id,
    request_id,action_epoch,payload_fingerprint,result_fingerprint)
  VALUES(v_cap.id,v_cap.salon_id,v_cap.waitlist_entry_id,p_request_id,v_cap.epoch,
    v_payload_hash,v_result_hash);
  RETURN v_result;
END;
$claim$;

CREATE OR REPLACE FUNCTION public.claim_waitlist_offer_delivery(
  p_salon_id uuid,p_waitlist_entry_id uuid,p_offer_epoch bigint,p_channel text,
  p_claim_capability_id uuid,p_recipient_fingerprint text,p_material_fingerprint text,
  p_payload_fingerprint text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $delivery_claim$
DECLARE v_row public.waitlist_offer_delivery_outbox%ROWTYPE; v_token uuid;
  v_cap public.waitlist_claim_capabilities%ROWTYPE;
  v_state public.waitlist_claim_action_state%ROWTYPE;
  v_entry public.booking_waitlist_entries%ROWTYPE;
  v_loaded jsonb;
BEGIN
  IF p_salon_id IS NULL OR p_waitlist_entry_id IS NULL OR coalesce(p_offer_epoch,0)<1
     OR p_channel NOT IN ('sms','email') OR p_claim_capability_id IS NULL
     OR coalesce(p_recipient_fingerprint,'')!~'^[0-9a-f]{64}$'
     OR coalesce(p_material_fingerprint,'')!~'^[0-9a-f]{64}$'
     OR coalesce(p_payload_fingerprint,'')!~'^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('ok',false,'code','invalid_request');
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'waitlist-claim:'||p_waitlist_entry_id::text,0));
  SELECT * INTO v_row FROM public.waitlist_offer_delivery_outbox
  WHERE salon_id=p_salon_id AND waitlist_entry_id=p_waitlist_entry_id
    AND offer_epoch=p_offer_epoch AND channel=p_channel FOR UPDATE;
  IF NOT FOUND OR v_row.claim_capability_id<>p_claim_capability_id
     OR v_row.recipient_fingerprint<>p_recipient_fingerprint
     OR v_row.material_fingerprint<>p_material_fingerprint THEN
    RETURN jsonb_build_object('ok',false,'code','material_mismatch');
  END IF;
  IF v_row.status='sending' THEN RETURN jsonb_build_object('ok',false,'code','in_flight'); END IF;
  IF v_row.status IN ('sent','failed','unknown','suppressed') THEN
    RETURN jsonb_build_object('ok',false,'code','terminal','status',v_row.status,
      'provider_receipt',v_row.provider_receipt);
  END IF;
  v_loaded:=public.load_waitlist_offer_delivery_material(p_salon_id,p_waitlist_entry_id,
    p_offer_epoch,p_channel,p_claim_capability_id);
  IF v_loaded->>'code'<>'material_loaded'
     OR v_loaded->>'material_fingerprint'<>p_material_fingerprint
     OR v_loaded->>'recipient_fingerprint'<>p_recipient_fingerprint THEN
    RETURN jsonb_build_object('ok',false,'code','material_changed');
  END IF;
  SELECT * INTO v_cap FROM public.waitlist_claim_capabilities
  WHERE id=p_claim_capability_id AND salon_id=p_salon_id
    AND waitlist_entry_id=p_waitlist_entry_id;
  SELECT * INTO v_state FROM public.waitlist_claim_action_state
  WHERE salon_id=p_salon_id AND waitlist_entry_id=p_waitlist_entry_id;
  SELECT * INTO v_entry FROM public.booking_waitlist_entries
  WHERE id=p_waitlist_entry_id AND salon_id=p_salon_id;
  IF v_cap.id IS NULL OR v_state.waitlist_entry_id IS NULL OR v_entry.id IS NULL
     OR v_cap.epoch<>p_offer_epoch OR v_state.epoch<>p_offer_epoch
     OR v_cap.consumed_at IS NOT NULL OR v_cap.revoked_at IS NOT NULL
     OR v_cap.expires_at<=transaction_timestamp() OR v_entry.status<>'notified'
     OR v_entry.claimed_at IS NOT NULL OR v_entry.claim_token IS NULL THEN
    UPDATE public.waitlist_offer_delivery_outbox SET status='suppressed',
      completed_at=transaction_timestamp(),error_code='offer_unavailable',
      updated_at=transaction_timestamp() WHERE id=v_row.id;
    RETURN jsonb_build_object('ok',false,'code','offer_unavailable','status','suppressed');
  END IF;
  v_token:=extensions.gen_random_uuid();
  UPDATE public.waitlist_offer_delivery_outbox SET status='sending',attempt_token=v_token,
    attempt_count=1,payload_fingerprint=p_payload_fingerprint,claimed_at=transaction_timestamp(),
    updated_at=transaction_timestamp() WHERE id=v_row.id;
  RETURN jsonb_build_object('ok',true,'code','claimed','outbox_id',v_row.id,
    'attempt_token',v_token,'channel',v_row.channel,'offer_epoch',v_row.offer_epoch,
    'claim_capability_id',v_row.claim_capability_id,
    'material_fingerprint',v_row.material_fingerprint);
END;
$delivery_claim$;

CREATE OR REPLACE FUNCTION public.complete_waitlist_offer_delivery(
  p_outbox_id uuid,p_attempt_token uuid,p_status text,p_provider_receipt text,p_error_code text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $delivery_complete$
DECLARE v_row public.waitlist_offer_delivery_outbox%ROWTYPE; v_receipt text:=nullif(trim(coalesce(p_provider_receipt,'')),'');
BEGIN
  IF p_outbox_id IS NULL OR p_attempt_token IS NULL OR p_status NOT IN ('sent','failed','unknown','suppressed')
     OR (p_status='sent' AND v_receipt IS NULL) THEN
    RETURN jsonb_build_object('ok',false,'code','invalid_completion');
  END IF;
  SELECT * INTO v_row FROM public.waitlist_offer_delivery_outbox WHERE id=p_outbox_id FOR UPDATE;
  IF NOT FOUND OR v_row.attempt_token<>p_attempt_token THEN
    RETURN jsonb_build_object('ok',false,'code','claim_mismatch');
  END IF;
  IF p_status='sent' AND ((v_row.channel='sms' AND v_receipt!~'^(SM|MM)[0-9a-fA-F]{32}$')
      OR (v_row.channel='email' AND (length(v_receipt)>255 OR v_receipt!~'^[[:graph:]]+$'))) THEN
    RETURN jsonb_build_object('ok',false,'code','invalid_completion');
  END IF;
  IF v_row.status<>'sending' THEN
    IF v_row.status=p_status AND coalesce(v_row.provider_receipt,'')=coalesce(v_receipt,'')
       AND coalesce(v_row.error_code,'')=coalesce(nullif(trim(coalesce(p_error_code,'')),''),'') THEN
      RETURN jsonb_build_object('ok',true,'code','already_completed','status',v_row.status,
        'provider_receipt',v_row.provider_receipt);
    END IF;
    RETURN jsonb_build_object('ok',false,'code','completion_conflict');
  END IF;
  UPDATE public.waitlist_offer_delivery_outbox SET status=p_status,provider_receipt=v_receipt,
    error_code=nullif(trim(coalesce(p_error_code,'')),''),completed_at=transaction_timestamp(),
    updated_at=transaction_timestamp() WHERE id=v_row.id RETURNING * INTO v_row;
  RETURN jsonb_build_object('ok',true,'code','completed','status',v_row.status,
    'provider_receipt',v_row.provider_receipt);
END;
$delivery_complete$;

-- The legacy function is retained for existing server code only. It is no
-- longer a raw browser/API capability during the additive adoption window.
REVOKE ALL ON FUNCTION public.claim_waitlist_slot(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_waitlist_slot(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.mint_waitlist_claim_capability(uuid,uuid,timestamptz),
  public.promote_waitlist_for_freed_slot(uuid,uuid,date,uuid,timestamptz,timestamptz,integer),
  public.promote_waitlist_for_booking(uuid),
  public.promote_waitlist_entry(uuid,uuid,integer),
  public.advance_waitlist_offer_capabilities(integer),
  public.cancel_booking_by_id_with_waitlist_offer(uuid),
  public.inspect_waitlist_claim_capability(uuid),
  public.claim_waitlist_with_management_capability(uuid,uuid),
  public.ensure_waitlist_offer_delivery_outbox(uuid,uuid,bigint,uuid),
  public.load_waitlist_offer_delivery_material(uuid,uuid,bigint,text,uuid),
  public.claim_waitlist_offer_delivery(uuid,uuid,bigint,text,uuid,text,text,text),
  public.complete_waitlist_offer_delivery(uuid,uuid,text,text,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.mint_waitlist_claim_capability(uuid,uuid,timestamptz),
  public.promote_waitlist_for_booking(uuid),
  public.promote_waitlist_entry(uuid,uuid,integer),
  public.advance_waitlist_offer_capabilities(integer),
  public.cancel_booking_by_id_with_waitlist_offer(uuid),
  public.inspect_waitlist_claim_capability(uuid),
  public.claim_waitlist_with_management_capability(uuid,uuid),
  public.ensure_waitlist_offer_delivery_outbox(uuid,uuid,bigint,uuid),
  public.load_waitlist_offer_delivery_material(uuid,uuid,bigint,text,uuid),
  public.claim_waitlist_offer_delivery(uuid,uuid,bigint,text,uuid,text,text,text),
  public.complete_waitlist_offer_delivery(uuid,uuid,text,text,text)
  TO service_role;

REVOKE ALL ON FUNCTION public.cancel_booking_by_id(uuid),public.notify_waitlist_for_no_show(uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_booking_by_id(uuid),public.notify_waitlist_for_no_show(uuid)
  TO service_role;

COMMENT ON TABLE public.waitlist_claim_capabilities IS
  'Service-only, expiring waitlist claim capabilities with exact request replay.';
