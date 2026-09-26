BEGIN;
SET LOCAL lock_timeout = '5s';

-- A replacement is a new identity and booking. Never repurpose a saved card or
-- resurrect a terminal row. The original keeps its capacity until accept commits.
CREATE TABLE public.group_slot_replacements (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id),
  group_id uuid NOT NULL,
  original_booking_id uuid NOT NULL REFERENCES public.bookings(id),
  replacement_booking_id uuid UNIQUE REFERENCES public.bookings(id),
  capability_id uuid NOT NULL REFERENCES public.booking_management_capabilities(id),
  create_request_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[0-9a-f]{64}$'),
  original_version bigint NOT NULL,
  slot_fingerprint text NOT NULL CHECK(slot_fingerprint ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','revoked')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  accepted_at timestamptz,
  accept_request_id uuid,
  accept_payload_hash text,
  consent_version text,
  UNIQUE(capability_id,create_request_id),
  CHECK((status='accepted' AND replacement_booking_id IS NOT NULL AND accepted_at IS NOT NULL
    AND accept_request_id IS NOT NULL AND accept_payload_hash ~ '^[0-9a-f]{64}$'
    AND consent_version='same-slot-replacement-v1') OR
    (status<>'accepted' AND replacement_booking_id IS NULL AND accepted_at IS NULL
    AND accept_request_id IS NULL AND accept_payload_hash IS NULL AND consent_version IS NULL))
);
CREATE UNIQUE INDEX group_slot_replacements_one_pending ON public.group_slot_replacements(original_booking_id) WHERE status='pending';
CREATE INDEX group_slot_replacements_roster ON public.group_slot_replacements(salon_id,group_id,created_at);
CREATE INDEX group_slot_replacements_capability ON public.group_slot_replacements(capability_id);
ALTER TABLE public.group_slot_replacements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_slot_replacements FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.group_slot_replacements FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.group_slot_replacements TO service_role;

CREATE TABLE public.group_slot_replacement_revocations (
  capability_id uuid NOT NULL REFERENCES public.booking_management_capabilities(id),
  request_id uuid NOT NULL,
  replacement_id uuid REFERENCES public.group_slot_replacements(id),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY(capability_id,request_id)
);
CREATE INDEX group_slot_replacement_revocations_target ON public.group_slot_replacement_revocations(replacement_id);
ALTER TABLE public.group_slot_replacement_revocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_slot_replacement_revocations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.group_slot_replacement_revocations FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.group_slot_replacement_revocations TO service_role;

CREATE FUNCTION public.group_slot_replacement_fingerprint(p_booking public.bookings) RETURNS text
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT encode(extensions.digest(pg_catalog.convert_to(jsonb_build_object(
 'salon',p_booking.salon_id,'group',p_booking.group_id,'service',p_booking.service_id,
 'staff',p_booking.staff_id,'resource',p_booking.resource_id,'start',p_booking.start_time_utc,
 'end',p_booking.end_time_utc,'price',p_booking.price_cents,'subtotal',p_booking.subtotal_cents,
 'tax',p_booking.tax_amount_cents,'status',p_booking.status,
 'attendance',p_booking.attendance_status,'name',p_booking.client_name,'phone',p_booking.client_phone,
 'email',p_booking.client_email,'profile',p_booking.client_profile_id,'version',p_booking.customer_transition_version)::text,'UTF8'),'sha256'),'hex');
$$;

-- Conservative first release: deposits/card protection need a separate fresh
-- customer authorization flow. Fail closed instead of transferring obligations.
CREATE FUNCTION public.group_slot_replacement_eligible(p_booking public.bookings) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce(p_booking.status='confirmed' AND p_booking.attendance_status='confirmed'
 AND p_booking.group_id IS NOT NULL AND p_booking.is_group_organizer IS NOT TRUE
 AND p_booking.deleted_at IS NULL AND p_booking.start_time_utc>transaction_timestamp()
 AND p_booking.end_time_utc>p_booking.start_time_utc AND p_booking.staff_id IS NOT NULL
 AND p_booking.schedule_model='single' AND p_booking.service_combo_id IS NULL
 AND p_booking.addon_service_id IS NULL AND p_booking.promo_id IS NULL
 AND p_booking.price_cents>=0 AND p_booking.square_booking_id IS NULL AND p_booking.wix_booking_id IS NULL
 AND p_booking.noshow_card_required IS FALSE AND p_booking.noshow_card_id IS NULL
 AND p_booking.noshow_customer_id IS NULL AND p_booking.noshow_consent_at IS NULL
 AND p_booking.deposit_required IS FALSE AND p_booking.deposit_status='not_required'
 AND p_booking.deposit_hold IS FALSE AND p_booking.square_payment_id IS NULL
 AND p_booking.stripe_payment_intent_id IS NULL
 AND NOT EXISTS(SELECT 1 FROM public.group_slot_replacements r WHERE r.replacement_booking_id=p_booking.id AND r.status='accepted')
 AND NOT EXISTS(SELECT 1 FROM public.booking_payment_operations p WHERE p.booking_id=p_booking.id)
 AND NOT EXISTS(SELECT 1 FROM public.booking_card_save_operations p WHERE p.booking_id=p_booking.id)
 AND EXISTS(SELECT 1 FROM public.salons s WHERE s.id=p_booking.salon_id
   AND s.feature_flags->'group_slot_recovery_v1'='true'::jsonb
   AND s.noshow_protection_enabled IS NOT TRUE
   AND s.booking_verification_mode='never'
      AND public.public_salon_accepts_new_bookings(s.id)),false);
$$;

CREATE FUNCTION public.inspect_group_slot_recovery(p_capability_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE c public.booking_management_capabilities; b public.bookings; r public.group_slot_replacements; s public.salons; v jsonb;
BEGIN
 SELECT * INTO c FROM public.booking_management_capabilities WHERE id=p_capability_id AND action='cancel' AND scope_kind='member_own';
 IF NOT FOUND OR c.expires_at<=transaction_timestamp() THEN RETURN jsonb_build_object('ok',false,'code','unavailable'); END IF;
 SELECT * INTO s FROM public.salons WHERE id=c.salon_id AND feature_flags->'group_slot_recovery_v1'='true'::jsonb;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'code','feature_disabled'); END IF;
 SELECT * INTO r FROM public.group_slot_replacements WHERE capability_id=c.id ORDER BY created_at DESC,id DESC LIMIT 1;
 IF r.status='accepted' THEN RETURN jsonb_build_object('ok',true,'state','accepted','eligible',false,'reason',NULL,'expires_at',r.expires_at,'timezone',s.timezone); END IF;
 v:=public.inspect_booking_management_capability(c.id,'cancel');
 IF (v->>'ok') IS DISTINCT FROM 'true' THEN RETURN jsonb_build_object('ok',false,'code','unavailable'); END IF;
 SELECT * INTO b FROM public.bookings WHERE id=c.booking_id AND salon_id=c.salon_id;
 RETURN jsonb_build_object('ok',true,'state',CASE WHEN public.group_slot_replacement_eligible(b) THEN
 CASE WHEN r.status='pending' AND r.expires_at>transaction_timestamp() AND r.slot_fingerprint=public.group_slot_replacement_fingerprint(b) THEN 'pending' ELSE 'available' END ELSE 'unavailable' END,
 'eligible',public.group_slot_replacement_eligible(b),'reason',CASE WHEN public.group_slot_replacement_eligible(b) THEN NULL WHEN b.noshow_card_required OR s.noshow_protection_enabled THEN 'card_protection_required' ELSE 'contact_salon' END,
 'expires_at',CASE WHEN r.status='pending' THEN r.expires_at ELSE NULL END,'timezone',s.timezone);
END;
$$;

CREATE FUNCTION public.start_group_slot_replacement(p_capability_id uuid,p_request_id uuid,p_token_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE c public.booking_management_capabilities; b public.bookings; r public.group_slot_replacements; g uuid; v jsonb;
BEGIN
 IF p_request_id IS NULL OR p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN RETURN jsonb_build_object('ok',false,'code','invalid_input'); END IF;
 SELECT b0.group_id INTO g FROM public.booking_management_capabilities c0 JOIN public.bookings b0 ON b0.id=c0.booking_id AND b0.salon_id=c0.salon_id
 WHERE c0.id=p_capability_id AND c0.action='cancel' AND c0.scope_kind='member_own';
 IF g IS NULL THEN RETURN jsonb_build_object('ok',false,'code','unavailable'); END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('booking-management-group:'||g::text,0));
 SELECT * INTO c FROM public.booking_management_capabilities WHERE id=p_capability_id FOR UPDATE;
 v:=public.inspect_booking_management_capability(c.id,'cancel');
 IF (v->>'ok') IS DISTINCT FROM 'true' THEN RETURN jsonb_build_object('ok',false,'code','unavailable'); END IF;
 SELECT * INTO b FROM public.bookings WHERE id=c.booking_id AND salon_id=c.salon_id FOR UPDATE;
 IF NOT public.group_slot_replacement_eligible(b) THEN RETURN jsonb_build_object('ok',false,'code',CASE WHEN b.noshow_card_required OR EXISTS(SELECT 1 FROM public.salons WHERE id=b.salon_id AND noshow_protection_enabled) THEN 'card_protection_required' ELSE 'contact_salon' END); END IF;
 SELECT * INTO r FROM public.group_slot_replacements WHERE capability_id=c.id AND create_request_id=p_request_id;
 IF FOUND THEN
   IF r.status='pending' AND r.expires_at>transaction_timestamp() AND r.token_hash=p_token_hash THEN
     RETURN jsonb_build_object('ok',true,'expires_at',r.expires_at,'idempotent',true);
   END IF;
   RETURN jsonb_build_object('ok',false,'code','request_expired');
 END IF;
 UPDATE public.group_slot_replacements SET status='revoked' WHERE original_booking_id=b.id AND status='pending';
 INSERT INTO public.group_slot_replacements(salon_id,group_id,original_booking_id,capability_id,create_request_id,token_hash,original_version,slot_fingerprint,expires_at)
 VALUES(b.salon_id,b.group_id,b.id,c.id,p_request_id,p_token_hash,b.customer_transition_version,public.group_slot_replacement_fingerprint(b),
 least(c.expires_at,b.start_time_utc,transaction_timestamp()+interval '24 hours')) RETURNING * INTO r;
 RETURN jsonb_build_object('ok',true,'expires_at',r.expires_at,'idempotent',false);
END;
$$;

CREATE FUNCTION public.revoke_group_slot_replacement(p_capability_id uuid,p_request_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE c public.booking_management_capabilities; g uuid; v jsonb; target uuid;
BEGIN
 IF p_request_id IS NULL THEN RETURN jsonb_build_object('ok',false,'code','invalid_input'); END IF;
 SELECT b.group_id INTO g FROM public.booking_management_capabilities c0 JOIN public.bookings b ON b.id=c0.booking_id AND b.salon_id=c0.salon_id
 WHERE c0.id=p_capability_id AND c0.action='cancel' AND c0.scope_kind='member_own';
 IF g IS NULL THEN RETURN jsonb_build_object('ok',false,'code','unavailable'); END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('booking-management-group:'||g::text,0));
 SELECT * INTO c FROM public.booking_management_capabilities WHERE id=p_capability_id FOR UPDATE;
 v:=public.inspect_booking_management_capability(c.id,'cancel');
 IF (v->>'ok') IS DISTINCT FROM 'true' OR NOT EXISTS(SELECT 1 FROM public.salons WHERE id=c.salon_id AND feature_flags->'group_slot_recovery_v1'='true'::jsonb)
 THEN RETURN jsonb_build_object('ok',false,'code','unavailable'); END IF;
 IF EXISTS(SELECT 1 FROM public.group_slot_replacement_revocations WHERE capability_id=c.id AND request_id=p_request_id) THEN RETURN jsonb_build_object('ok',true); END IF;
 SELECT id INTO target FROM public.group_slot_replacements WHERE original_booking_id=c.booking_id AND capability_id=c.id AND status='pending';
 INSERT INTO public.group_slot_replacement_revocations(capability_id,request_id,replacement_id) VALUES(c.id,p_request_id,target);
 UPDATE public.group_slot_replacements SET status='revoked' WHERE id=target;
 RETURN jsonb_build_object('ok',true);
END;
$$;

CREATE FUNCTION public.inspect_group_slot_replacement(p_token_hash text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE r public.group_slot_replacements; b public.bookings; s public.salons;
BEGIN
 SELECT * INTO r FROM public.group_slot_replacements WHERE token_hash=p_token_hash AND status IN ('pending','accepted') AND expires_at>transaction_timestamp();
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'code','unavailable'); END IF;
 SELECT * INTO s FROM public.salons WHERE id=r.salon_id AND feature_flags->'group_slot_recovery_v1'='true'::jsonb;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'code','feature_disabled'); END IF;
 SELECT * INTO b FROM public.bookings WHERE id=r.original_booking_id AND salon_id=r.salon_id AND group_id=r.group_id;
 IF r.status='pending' AND (NOT public.group_slot_replacement_eligible(b) OR public.group_slot_replacement_fingerprint(b)<>r.slot_fingerprint
 OR (public.inspect_booking_management_capability(r.capability_id,'cancel')->>'ok') IS DISTINCT FROM 'true')
 THEN RETURN jsonb_build_object('ok',false,'code','unavailable'); END IF;
 RETURN jsonb_build_object('ok',true,'state',CASE WHEN r.status='accepted' THEN 'accepted' ELSE 'available' END,
 'salon_name',s.name,'service_name',(SELECT name FROM public.services WHERE id=b.service_id AND salon_id=b.salon_id),
 'start_time_utc',b.start_time_utc,'end_time_utc',b.end_time_utc,'timezone',s.timezone,
 'currency',upper(coalesce(s.currency_code,'CAD')),'price_cents',b.price_cents,'expires_at',r.expires_at,'requires_card',false);
END;
$$;

CREATE FUNCTION public.accept_group_slot_replacement(p_token_hash text,p_request_id uuid,p_name text,p_phone text,p_consent boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r public.group_slot_replacements; b public.bookings; n public.bookings; h text; v jsonb; g uuid;
BEGIN
 IF p_request_id IS NULL OR p_consent IS DISTINCT FROM true OR p_name IS NULL OR length(trim(p_name)) NOT BETWEEN 1 AND 100
 OR p_name ~ '[<>{}=&;[:cntrl:]]' OR p_phone IS NULL OR p_phone !~ '^[1-9][0-9]{7,14}$'
 THEN RETURN jsonb_build_object('ok',false,'code','invalid_input'); END IF;
 SELECT group_id INTO g FROM public.group_slot_replacements WHERE token_hash=p_token_hash;
 IF g IS NULL THEN RETURN jsonb_build_object('ok',false,'code','unavailable'); END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('booking-management-group:'||g::text,0));
 SELECT * INTO r FROM public.group_slot_replacements WHERE token_hash=p_token_hash FOR UPDATE;
 IF NOT EXISTS(SELECT 1 FROM public.salons WHERE id=r.salon_id AND feature_flags->'group_slot_recovery_v1'='true'::jsonb)
 THEN RETURN jsonb_build_object('ok',false,'code','feature_disabled'); END IF;
 h:=encode(extensions.digest(pg_catalog.convert_to(jsonb_build_array(trim(p_name),p_phone,'same-slot-replacement-v1')::text,'UTF8'),'sha256'),'hex');
 IF r.status='accepted' THEN
   IF r.accept_request_id=p_request_id AND r.accept_payload_hash=h THEN RETURN jsonb_build_object('ok',true,'state','accepted','idempotent',true); END IF;
   RETURN jsonb_build_object('ok',false,'code','already_accepted');
 END IF;
 IF r.status<>'pending' OR r.expires_at<=transaction_timestamp() THEN RETURN jsonb_build_object('ok',false,'code','unavailable'); END IF;
 -- Same lock order as existing member management mutations.
 PERFORM 1 FROM public.booking_management_capabilities WHERE id=r.capability_id FOR UPDATE;
 v:=public.inspect_booking_management_capability(r.capability_id,'cancel');
 IF (v->>'ok') IS DISTINCT FROM 'true' THEN RETURN jsonb_build_object('ok',false,'code','unavailable'); END IF;
 SELECT * INTO b FROM public.bookings WHERE id=r.original_booking_id AND salon_id=r.salon_id AND group_id=r.group_id FOR UPDATE;
 IF NOT FOUND OR NOT public.group_slot_replacement_eligible(b) OR public.group_slot_replacement_fingerprint(b)<>r.slot_fingerprint
 THEN RETURN jsonb_build_object('ok',false,'code','slot_changed'); END IF;
 -- A different person must receive the slot. No inherited profile or consent.
 IF EXISTS(SELECT 1 FROM public.bookings WHERE salon_id=b.salon_id AND group_id=b.group_id AND client_phone=p_phone AND status IN ('pending','confirmed') AND deleted_at IS NULL) THEN RETURN jsonb_build_object('ok',false,'code','different_guest_required'); END IF;
 BEGIN
   PERFORM pg_catalog.set_config('nailiq.v1_terminal_reason','group_slot_replaced',true);
   UPDATE public.bookings SET status='cancelled',attendance_status='declined',customer_transition_email_requested=false WHERE id=b.id;
   INSERT INTO public.bookings(salon_id,service_id,staff_id,resource_id,client_name,client_phone,start_time_utc,end_time_utc,status,
     price_cents,subtotal_cents,tax_amount_cents,source,booking_channel,group_id,group_size,is_party_member,is_group_organizer,
     attendance_status,confirmed_at,wave_number,seat_together,client_locale)
   VALUES(b.salon_id,b.service_id,b.staff_id,b.resource_id,trim(p_name),p_phone,b.start_time_utc,b.end_time_utc,'confirmed',
     b.price_cents,b.subtotal_cents,b.tax_amount_cents,'appointment','online',b.group_id,b.group_size,true,false,
     'confirmed',transaction_timestamp(),b.wave_number,b.seat_together,b.client_locale) RETURNING * INTO n;
   -- Existing resource and staff guards may reject a slot whose setup changed.
   IF n.resource_id IS DISTINCT FROM b.resource_id OR n.staff_id IS DISTINCT FROM b.staff_id THEN
     RAISE EXCEPTION 'replacement slot changed' USING ERRCODE='P0001';
   END IF;
   UPDATE public.group_slot_replacements SET status='accepted',replacement_booking_id=n.id,accepted_at=transaction_timestamp(),
     accept_request_id=p_request_id,accept_payload_hash=h,consent_version='same-slot-replacement-v1' WHERE id=r.id;
   UPDATE public.booking_management_capabilities SET revoked_at=transaction_timestamp(),revoke_reason='booking_cancelled'
     WHERE booking_id=b.id AND consumed_at IS NULL AND revoked_at IS NULL;
   INSERT INTO public.booking_events(booking_id,salon_id,actor_role,event_type,payload)
     VALUES(b.id,b.salon_id,'customer','group_slot_replaced',jsonb_build_object('replacement_booking_id',n.id,'replacement_id',r.id,'fee_collected',false,'fee_authority','not_granted'));
 EXCEPTION WHEN exclusion_violation OR check_violation OR foreign_key_violation OR raise_exception THEN
   RETURN jsonb_build_object('ok',false,'code','slot_changed');
 END;
 RETURN jsonb_build_object('ok',true,'state','accepted','idempotent',false);
END;
$$;

REVOKE ALL ON FUNCTION public.group_slot_replacement_fingerprint(public.bookings),public.group_slot_replacement_eligible(public.bookings) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.inspect_group_slot_recovery(uuid),public.start_group_slot_replacement(uuid,uuid,text),public.revoke_group_slot_replacement(uuid,uuid),public.inspect_group_slot_replacement(text),public.accept_group_slot_replacement(text,uuid,text,text,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inspect_group_slot_recovery(uuid),public.start_group_slot_replacement(uuid,uuid,text),public.revoke_group_slot_replacement(uuid,uuid),public.inspect_group_slot_replacement(text),public.accept_group_slot_replacement(text,uuid,text,text,boolean) TO service_role;
CREATE FUNCTION public.group_slot_is_replaced_original(p_salon_id uuid,p_booking_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM public.group_slot_replacements r
 JOIN public.bookings original ON original.id=r.original_booking_id AND original.salon_id=r.salon_id AND original.group_id=r.group_id
 JOIN public.bookings replacement ON replacement.id=r.replacement_booking_id AND replacement.salon_id=r.salon_id AND replacement.group_id=r.group_id
 WHERE r.salon_id=p_salon_id AND r.original_booking_id=p_booking_id AND r.status='accepted' AND original.status='cancelled');
$$;
REVOKE ALL ON FUNCTION public.group_slot_is_replaced_original(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

-- Keep ordinary terminal-member behavior. Exclude only originals for which an
-- accepted receipt proves a distinct replacement in this exact tenant/group.
DO $patch$
DECLARE def text; anchor text; replacement text; n integer;
BEGIN
 SELECT pg_get_functiondef('public.booking_management_current_group_material(uuid,uuid)'::regprocedure) INTO def;
 anchor:='WHERE b.salon_id=p_salon_id AND b.group_id=p_group_id';
 IF (length(def)-length(replace(def,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'group material anchor mismatch'; END IF;
 replacement:=anchor||' AND NOT public.group_slot_is_replaced_original(b.salon_id,b.id)';
 EXECUTE replace(def,anchor,replacement);
 SELECT pg_get_functiondef('public.booking_management_apply_group(uuid,uuid,text,jsonb)'::regprocedure) INTO def;
 anchor:='b.group_id=v_cap.group_id';
 n:=(length(def)-length(replace(def,anchor,'')))/length(anchor);
 IF n<>6 THEN RAISE EXCEPTION 'group mutation anchor mismatch: %',n; END IF;
 replacement:=anchor||' AND NOT public.group_slot_is_replaced_original(b.salon_id,b.id)';
 EXECUTE replace(def,anchor,replacement);
 SELECT pg_get_functiondef('public.update_party_booking_contact(uuid,uuid,text,text)'::regprocedure) INTO def;
 anchor:='  v_phone:=public.canonical_phone(p_member_phone);';
 IF (length(def)-length(replace(def,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'party contact anchor mismatch'; END IF;
 replacement:=E'  IF public.group_slot_is_replaced_original(p_salon_id,p_booking_id) THEN RETURN jsonb_build_object(''success'',false,''code'',''not_found''); END IF;\n'||anchor;
 EXECUTE replace(def,anchor,replacement);
END;
$patch$;

COMMIT;
