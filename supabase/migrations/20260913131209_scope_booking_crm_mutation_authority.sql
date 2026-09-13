-- Declared booking contact is not authority to mutate global phone-keyed CRM.
-- The preceding incentive migration owns SMS-gated value claims. This change
-- keeps booking contact available while requiring SMS or an authenticated desk
-- actor for the separately durable profile association.

CREATE FUNCTION public.lock_booking_crm_phones(p_phones text[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE v_phone text;
BEGIN
  IF coalesce(cardinality(p_phones),0)>20 THEN RAISE EXCEPTION 'crm_phone_limit'; END IF;
  FOR v_phone IN
    SELECT DISTINCT regexp_replace(coalesce(public.canonical_phone(phone),''),'\D','','g')
    FROM unnest(p_phones) phone
    WHERE length(regexp_replace(coalesce(public.canonical_phone(phone),''),'\D','','g'))>=7
    ORDER BY 1
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('public-booking-client:'||v_phone,0));
  END LOOP;
  PERFORM cp.id FROM public.client_profiles cp WHERE cp.phone IN (
    SELECT regexp_replace(coalesce(public.canonical_phone(phone),''),'\D','','g') FROM unnest(p_phones) phone
  ) ORDER BY cp.phone FOR UPDATE;
END;$function$;
REVOKE ALL ON FUNCTION public.lock_booking_crm_phones(text[]) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.attach_desk_booking_client_profiles(
  p_salon_id uuid,p_booking_ids uuid[],p_actor_user_id uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE v_booking public.bookings%ROWTYPE; v_profile_id uuid; v_phones text[]; v_phone text;
BEGIN
  IF NOT public.staff_action_notification_caller_is_service_role() OR p_actor_user_id IS NULL
    OR NOT EXISTS(SELECT 1 FROM public.salon_members sm WHERE sm.salon_id=p_salon_id
      AND sm.user_id=p_actor_user_id AND sm.role IN ('owner','admin','senior','receptionist')) THEN
    RAISE EXCEPTION 'crm_actor_unauthorized' USING ERRCODE='42501';
  END IF;
  IF coalesce(cardinality(p_booking_ids),0) NOT BETWEEN 1 AND 20
    OR (SELECT count(DISTINCT id) FROM unnest(p_booking_ids) id)<>cardinality(p_booking_ids)
    OR (SELECT count(*) FROM public.bookings b WHERE b.id=ANY(p_booking_ids) AND b.salon_id=p_salon_id)<>cardinality(p_booking_ids) THEN
    RAISE EXCEPTION 'crm_booking_binding_invalid';
  END IF;
  SELECT array_agg(public.canonical_phone(b.client_phone)) INTO v_phones
    FROM public.bookings b WHERE b.id=ANY(p_booking_ids) AND b.salon_id=p_salon_id;
  PERFORM public.lock_booking_crm_phones(v_phones);
  FOR v_booking IN SELECT b.* FROM public.bookings b WHERE b.id=ANY(p_booking_ids)
    AND b.salon_id=p_salon_id ORDER BY b.id FOR UPDATE
  LOOP
    v_phone:=public.canonical_phone(v_booking.client_phone);
    IF v_phone IS NOT NULL AND NOT(v_phone=ANY(v_phones)) THEN RAISE EXCEPTION 'crm_contact_changed'; END IF;
    IF length(regexp_replace(coalesce(v_phone,''),'\D','','g'))<7 THEN CONTINUE; END IF;
    IF v_booking.client_profile_id IS NULL THEN
      v_profile_id:=public.resolve_client_profile(v_booking.client_phone,v_booking.client_name,v_booking.client_email,v_booking.staff_id);
      IF v_profile_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.client_profiles cp WHERE cp.id=v_profile_id
        AND cp.deleted_at IS NULL AND public.canonical_phone(cp.phone)=v_phone) THEN
        RAISE EXCEPTION 'crm_profile_mismatch';
      END IF;
      UPDATE public.bookings SET client_profile_id=v_profile_id WHERE id=v_booking.id AND salon_id=p_salon_id;
    ELSIF NOT EXISTS(SELECT 1 FROM public.client_profiles cp WHERE cp.id=v_booking.client_profile_id
      AND cp.deleted_at IS NULL AND public.canonical_phone(cp.phone)=v_phone) THEN
      RAISE EXCEPTION 'crm_profile_mismatch';
    END IF;
  END LOOP;
END;$function$;
REVOKE ALL ON FUNCTION public.attach_desk_booking_client_profiles(uuid,uuid[],uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.finalize_public_booking_profile(
  p_booking_id uuid,p_otp_session_id uuid DEFAULT NULL,p_marketing_consent boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE
  v_now timestamptz:=clock_timestamp(); v_booking public.bookings%ROWTYPE;
  v_session public.phone_otp_sessions%ROWTYPE; v_phone text; v_profile_id uuid;
  v_phone_owner boolean:=false; v_linked boolean:=false; v_consumed_binding boolean:=false;
BEGIN
  SELECT b.* INTO v_booking FROM public.bookings b WHERE b.id=p_booking_id
    AND b.created_at>=v_now-interval '10 minutes' AND b.status IN ('pending','confirmed');
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','invalid_booking'); END IF;
  v_phone:=public.canonical_phone(v_booking.client_phone);
  SELECT EXISTS(SELECT 1 FROM public.phone_otp_sessions s WHERE s.id=p_otp_session_id
    AND s.verified_channel='sms' AND s.salon_id=v_booking.salon_id
    AND public.canonical_phone(s.phone)=v_phone) INTO v_phone_owner;
  -- Match create's phone/profile-first lock order. Re-read booking contact
  -- after waiting; a concurrent Party edit cannot move this proof to a phone.
  IF v_phone_owner THEN PERFORM public.lock_booking_crm_phones(ARRAY[v_phone]); END IF;
  SELECT b.* INTO v_booking FROM public.bookings b WHERE b.id=p_booking_id
    AND b.created_at>=clock_timestamp()-interval '10 minutes' AND b.status IN ('pending','confirmed') FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','invalid_booking'); END IF;
  IF public.canonical_phone(v_booking.client_phone) IS DISTINCT FROM v_phone THEN
    RETURN jsonb_build_object('success',false,'code','contact_changed');
  END IF;
  IF p_otp_session_id IS NOT NULL THEN
    SELECT s.* INTO v_session FROM public.phone_otp_sessions s WHERE s.id=p_otp_session_id FOR UPDATE;
    v_now:=clock_timestamp();
    IF NOT FOUND OR v_session.salon_id IS DISTINCT FROM v_booking.salon_id
      OR public.canonical_phone(v_session.phone) IS DISTINCT FROM v_phone
      OR v_session.verified_channel NOT IN ('sms','email','staff_attested','demo')
      OR (v_session.verified_channel='sms') IS DISTINCT FROM v_phone_owner
      OR v_session.verified_at IS NULL OR NOT isfinite(v_session.verified_at)
      OR v_session.expires_at IS NULL OR NOT isfinite(v_session.expires_at)
      OR v_session.verified_at>v_now OR v_session.expires_at<=v_session.verified_at
      OR (v_booking.otp_session_id IS NOT NULL AND v_booking.otp_session_id<>v_session.id) THEN
      RETURN jsonb_build_object('success',false,'code','invalid_otp_session');
    END IF;
    v_consumed_binding:=v_session.consumed_at IS NOT NULL AND isfinite(v_session.consumed_at)
      AND v_session.consumed_by_booking_id=v_booking.id AND v_booking.otp_session_id=v_session.id
      AND v_session.consumed_at>=v_session.verified_at AND v_session.consumed_at<v_session.expires_at
      AND v_session.consumed_at<=v_now;
    IF NOT coalesce(v_consumed_binding,false) AND NOT(v_session.consumed_at IS NULL
      AND v_session.consumed_by_booking_id IS NULL AND v_session.expires_at>v_now) THEN
      RETURN jsonb_build_object('success',false,'code','invalid_otp_session');
    END IF;
  END IF;
  -- Non-phone challenges may finish a booking with NULL CRM FK. Neither an
  -- email proof nor a marketing checkbox creates/refreshes a phone profile.
  IF v_phone_owner THEN
    v_profile_id:=v_booking.client_profile_id;
    IF v_profile_id IS NULL THEN
      v_profile_id:=public.resolve_client_profile(v_booking.client_phone,v_booking.client_name,v_booking.client_email,v_booking.staff_id);
      IF v_profile_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.client_profiles cp WHERE cp.id=v_profile_id
        AND cp.deleted_at IS NULL AND public.canonical_phone(cp.phone)=v_phone) THEN
        RAISE EXCEPTION 'crm_profile_mismatch';
      END IF;
      UPDATE public.bookings SET client_profile_id=v_profile_id WHERE id=v_booking.id;
      v_linked:=true;
    ELSIF NOT EXISTS(SELECT 1 FROM public.client_profiles cp WHERE cp.id=v_profile_id
      AND cp.deleted_at IS NULL AND public.canonical_phone(cp.phone)=v_phone) THEN
      RETURN jsonb_build_object('success',false,'code','profile_mismatch');
    END IF;
    UPDATE public.client_profiles cp SET
      phone_verified_at=CASE WHEN cp.phone_verified_at IS NULL OR cp.phone_verified_at<v_session.verified_at
        THEN v_session.verified_at ELSE cp.phone_verified_at END,
      marketing_consent_at=CASE WHEN p_marketing_consent THEN coalesce(cp.marketing_consent_at,v_now) ELSE cp.marketing_consent_at END
    WHERE cp.id=v_profile_id AND (cp.phone_verified_at IS NULL OR cp.phone_verified_at<v_session.verified_at
      OR (p_marketing_consent AND cp.marketing_consent_at IS NULL));
  END IF;
  IF p_otp_session_id IS NOT NULL THEN
    v_now:=clock_timestamp();
    IF NOT coalesce(v_consumed_binding,false) AND v_session.expires_at<=v_now THEN
      -- Roll back the complete finalizer subtransaction, including CRM writes,
      -- if proof expires during any work after the first wall-clock check.
      RAISE EXCEPTION 'crm_otp_expired_at_consumption';
    END IF;
    UPDATE public.bookings SET verification_method=CASE WHEN verification_method IN ('deposit','both') THEN 'both' ELSE 'otp' END,
      verification_completed_at=coalesce(verification_completed_at,v_session.verified_at),otp_session_id=v_session.id
      WHERE id=v_booking.id;
    UPDATE public.phone_otp_sessions SET consumed_at=coalesce(consumed_at,v_now),consumed_by_booking_id=v_booking.id WHERE id=v_session.id;
  END IF;
  RETURN jsonb_build_object('success',true,'otp_stamped',p_otp_session_id IS NOT NULL,
    'profile_linked',v_linked,'marketing_consent_stamped',p_marketing_consent AND v_phone_owner);
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM='crm_otp_expired_at_consumption' THEN
    RETURN jsonb_build_object('success',false,'code','invalid_otp_session');
  END IF;
  RAISE;
END;$function$;
REVOKE ALL ON FUNCTION public.finalize_public_booking_profile(uuid,uuid,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_public_booking_profile(uuid,uuid,boolean) TO anon,service_role;

-- The shared low-level single engine receives declared contact only. Leave
-- its booking/price/resource/idempotency behavior intact and defer CRM writes.
DO $migration$
DECLARE v_target regprocedure; v_def text; v_old text;
BEGIN
  v_target:=to_regprocedure('public.create_public_booking_unlimited_14(uuid,uuid,uuid,text,text,timestamptz,timestamptz,text,integer,text,uuid,integer,text,uuid)');
  IF v_target IS NULL THEN RAISE EXCEPTION 'CRM single engine missing'; END IF;
  v_def:=pg_get_functiondef(v_target);
  v_old:='v_profile_id := public.resolve_client_profile(v_digits, p_client_name, v_email, p_staff_id);';
  IF (length(v_def)-length(replace(v_def,v_old,'')))/length(v_old)<>1 THEN RAISE EXCEPTION 'CRM single resolver anchor mismatch'; END IF;
  v_def:=replace(v_def,v_old,'v_profile_id := NULL; -- Declared contact has no phone CRM authority.');
  EXECUTE v_def;
END;$migration$;

-- Cross-engine lock order: sequence policy/resource reads can lock the salon
-- before reaching their pricing claim. Canonical and desk create already lock
-- phones first. Take the same sorted phone/profile locks before any sequence
-- capacity, salon, or resource lock so these paths cannot wait in a cycle.
DO $crm_lock_order$
DECLARE v_target regprocedure; v_def text; v_old text; v_new text;
BEGIN
  v_target:=to_regprocedure('public.resolve_booking_sequence_pricing_and_schedule(jsonb,boolean)');
  IF v_target IS NULL THEN RAISE EXCEPTION 'CRM sequence pricing lock target missing'; END IF;
  v_def:=pg_get_functiondef(v_target);
  v_old:='  -- Preserve the card-safe sequence payment policy introduced after the';
  IF (length(v_def)-length(replace(v_def,v_old,'')))/length(v_old)<>1 THEN RAISE EXCEPTION 'CRM sequence early lock anchor mismatch'; END IF;
  v_new:=E'  IF p_lock_claims THEN\n    PERFORM public.lock_booking_crm_phones(ARRAY[v_client_phone]);\n  END IF;\n'||v_old;
  EXECUTE replace(v_def,v_old,v_new);

  v_target:=to_regprocedure('public.resolve_public_group_sequence_quote(jsonb,boolean)');
  IF v_target IS NULL THEN RAISE EXCEPTION 'CRM group sequence pricing lock target missing'; END IF;
  v_def:=pg_get_functiondef(v_target);
  v_old:=E'  IF p_lock_claims THEN\n    PERFORM pg_catalog.pg_advisory_xact_lock(\n      pg_catalog.hashtextextended(\n        ''group-sequence-capacity:'' || v_salon_id::text,';
  IF (length(v_def)-length(replace(v_def,v_old,'')))/length(v_old)<>1 THEN RAISE EXCEPTION 'CRM group sequence early lock anchor mismatch'; END IF;
  v_new:=E'  IF p_lock_claims THEN\n    PERFORM public.lock_booking_crm_phones(ARRAY(\n      SELECT CASE WHEN member.ordinality=1 THEN v_organizer_phone\n        ELSE member.value->''customer''->>''phone'' END\n      FROM pg_catalog.jsonb_array_elements(v_members) WITH ORDINALITY member(value,ordinality)\n    ));\n  END IF;\n'||v_old;
  EXECUTE replace(v_def,v_old,v_new);
END;$crm_lock_order$;

-- These engines already validate and lock their typed OTP inside the atomic
-- create transaction. Only the organizer's exact SMS phone is CRM authority.
DO $migration$
DECLARE v_name text; v_def text; v_old text; v_new text;
BEGIN
  v_name:='public.create_public_booking_sequence(jsonb)';
  IF to_regprocedure(v_name) IS NULL THEN RAISE EXCEPTION 'CRM sequence engine missing'; END IF;
  v_def:=pg_get_functiondef(to_regprocedure(v_name));
  v_old:=E'  v_profile_id := public.resolve_client_profile(\n    v_digits,\n    trim(v_customer->>''name''),\n    v_email,\n    (v_first->>''staff_id'')::uuid\n  );\n\n  BEGIN';
  IF (length(v_def)-length(replace(v_def,v_old,'')))/length(v_old)<>1 THEN RAISE EXCEPTION 'CRM sequence resolver anchor mismatch'; END IF;
  v_new:=E'  v_profile_id := NULL;\n  BEGIN\n    IF public.booking_incentive_phone_ownership(v_otp_session_id,v_salon_id,v_digits,false) THEN\n      v_profile_id := public.resolve_client_profile(v_digits,trim(v_customer->>''name''),v_email,(v_first->>''staff_id'')::uuid);\n    END IF;';
  v_def:=replace(v_def,v_old,v_new);
  EXECUTE v_def;

  v_name:='public.create_public_group_booking_sequences(jsonb)';
  IF to_regprocedure(v_name) IS NULL THEN RAISE EXCEPTION 'CRM group sequence engine missing'; END IF;
  v_def:=pg_get_functiondef(to_regprocedure(v_name));
  v_old:=E'      IF v_member_phone IS NOT NULL THEN\n        v_profile_id := public.resolve_client_profile(';
  IF (length(v_def)-length(replace(v_def,v_old,'')))/length(v_old)<>1 THEN RAISE EXCEPTION 'CRM group sequence resolver anchor mismatch'; END IF;
  v_new:=E'      IF v_member_index=0 AND v_member_phone IS NOT NULL\n        AND public.booking_incentive_phone_ownership(v_otp_session_id,v_salon_id,v_member_phone,false) THEN\n        v_profile_id := public.resolve_client_profile(';
  v_def:=replace(v_def,v_old,v_new);
  v_old:='v_profile_id IS NULL, v_member_index = 0,';
  IF (length(v_def)-length(replace(v_def,v_old,'')))/length(v_old)<>1 THEN RAISE EXCEPTION 'CRM group sequence contact flag anchor mismatch'; END IF;
  v_def:=replace(v_def,v_old,'v_member_phone IS NULL, v_member_index = 0,');
  EXECUTE v_def;
END;$migration$;

-- Missing authority to link CRM does not make a named contact an unclaimed
-- Party placeholder. The first migration owns this overload's SMS resolver.
DO $migration$
DECLARE v_target regprocedure; v_def text; v_old text;
BEGIN
  v_target:=to_regprocedure('public.create_group_bookings(uuid,jsonb,uuid,text,text,boolean,uuid,text,uuid)');
  IF v_target IS NULL THEN RAISE EXCEPTION 'CRM SMS group engine missing'; END IF;
  v_def:=pg_get_functiondef(v_target);
  v_old:=E'        v_profile_id IS NULL,\n        v_member_index = 0,';
  IF (length(v_def)-length(replace(v_def,v_old,'')))/length(v_old)=1 THEN
    v_def:=replace(v_def,v_old,E'        v_member_phone IS NULL,\n        v_member_index = 0,');
    EXECUTE v_def;
  ELSE
    -- The reviewed preceding migration may already carry this correction.
    -- Accept only that exact known shape; no broad drift tolerance.
    v_old:=E'        v_member_phone IS NULL,\n        v_member_index = 0,';
    IF (length(v_def)-length(replace(v_def,v_old,'')))/length(v_old)<>1
      OR strpos(v_def,'v_profile_id IS NULL,')>0 THEN RAISE EXCEPTION 'CRM group contact flag anchor mismatch'; END IF;
  END IF;
END;$migration$;

-- Desk single create already has an explicit authenticated actor contract,
-- including when the actor selects no notifications. Link within that same
-- transaction, after the canonical create, once per booking FK.
DO $migration$
DECLARE v_target regprocedure; v_def text; v_old text;
BEGIN
  v_target:=to_regprocedure('public.create_public_booking_for_desk_with_staff_notification(uuid,uuid,uuid,text,text,timestamptz,timestamptz,text,text,uuid[],text,uuid,uuid,uuid,boolean,uuid,text,uuid,boolean,boolean,integer)');
  IF v_target IS NULL THEN RAISE EXCEPTION 'CRM desk single wrapper missing'; END IF;
  v_def:=pg_get_functiondef(v_target);
  v_old:='  v_channels:=jsonb_build_object(''sms'',p_notify_sms,''email'',p_notify_email);';
  IF (length(v_def)-length(replace(v_def,v_old,'')))/length(v_old)<>1 THEN RAISE EXCEPTION 'CRM desk single lock anchor mismatch'; END IF;
  v_def:=replace(v_def,v_old,E'  PERFORM public.lock_booking_crm_phones(ARRAY[p_client_phone]);\n'||v_old);
  v_old:='  v_booking_id:=nullif(v_result->>''booking_id'','''')::uuid;';
  IF (length(v_def)-length(replace(v_def,v_old,'')))/length(v_old)<>1 THEN RAISE EXCEPTION 'CRM desk single attach anchor mismatch'; END IF;
  v_def:=replace(v_def,v_old,v_old||E'\n  PERFORM public.attach_desk_booking_client_profiles(p_salon_id,ARRAY[v_booking_id],p_actor_user_id);');
  EXECUTE v_def;
END;$migration$;

CREATE FUNCTION public.create_group_bookings_for_desk(
  p_salon_id uuid,p_bookings jsonb,p_voucher_id uuid,p_client_phone text,p_client_email text,
  p_apply_email_discount boolean,p_group_idempotency_key uuid,p_expected_pricing_fingerprint text,p_actor_user_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE v_result jsonb; v_booking_ids uuid[]; v_phones text[];
BEGIN
  IF NOT public.staff_action_notification_caller_is_service_role() OR p_actor_user_id IS NULL
    OR NOT EXISTS(SELECT 1 FROM public.salon_members sm WHERE sm.salon_id=p_salon_id
      AND sm.user_id=p_actor_user_id AND sm.role IN ('owner','admin','senior','receptionist')) THEN
    RETURN jsonb_build_object('success',false,'code','actor_unauthorized');
  END IF;
  -- The current authenticated desk contract advertises neither voucher nor
  -- phone incentive. Do not manufacture SMS authority for an internal actor.
  IF p_apply_email_discount IS DISTINCT FROM false OR p_voucher_id IS NOT NULL
    OR jsonb_typeof(p_bookings) IS DISTINCT FROM 'array' OR jsonb_array_length(p_bookings) NOT BETWEEN 2 AND 20 THEN
    RETURN jsonb_build_object('success',false,'code','invalid_input');
  END IF;
  SELECT array_agg(CASE WHEN n=1 THEN p_client_phone ELSE item->>'client_phone' END)
    INTO v_phones FROM jsonb_array_elements(p_bookings) WITH ORDINALITY x(item,n);
  PERFORM public.lock_booking_crm_phones(v_phones);
  v_result:=public.create_group_bookings(p_salon_id,p_bookings,p_voucher_id,p_client_phone,p_client_email,
    p_apply_email_discount,p_group_idempotency_key,p_expected_pricing_fingerprint);
  IF v_result->>'success' IS DISTINCT FROM 'true' THEN RETURN v_result; END IF;
  SELECT array_agg((id#>>'{}')::uuid) INTO v_booking_ids FROM jsonb_array_elements(v_result->'booking_ids') id;
  PERFORM public.attach_desk_booking_client_profiles(p_salon_id,v_booking_ids,p_actor_user_id);
  RETURN v_result;
END;$function$;
REVOKE ALL ON FUNCTION public.create_group_bookings_for_desk(uuid,jsonb,uuid,text,text,boolean,uuid,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.create_group_bookings_for_desk(uuid,jsonb,uuid,text,text,boolean,uuid,text,uuid) TO service_role;

CREATE FUNCTION public.claim_party_slot_for_desk(
  p_token text,p_claim_id uuid,p_member_name text,p_member_phone text,p_reminder_opted_in boolean,
  p_salon_id uuid,p_actor_user_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE v_booking_id uuid; v_old_phone text; v_result jsonb;
BEGIN
  IF NOT public.staff_action_notification_caller_is_service_role() OR p_actor_user_id IS NULL
    OR NOT EXISTS(SELECT 1 FROM public.salon_members sm WHERE sm.salon_id=p_salon_id
      AND sm.user_id=p_actor_user_id AND sm.role IN ('owner','admin','senior','receptionist')) THEN
    RETURN jsonb_build_object('success',false,'code','actor_unauthorized');
  END IF;
  SELECT c.booking_id,b.client_phone INTO v_booking_id,v_old_phone FROM public.party_link_claims c
    JOIN public.party_links l ON l.id=c.party_link_id AND l.salon_id=p_salon_id AND l.token=p_token
    JOIN public.bookings b ON b.id=c.booking_id AND b.salon_id=p_salon_id WHERE c.id=p_claim_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','not_found'); END IF;
  PERFORM public.lock_booking_crm_phones(ARRAY[v_old_phone,p_member_phone]);
  v_result:=public.claim_party_slot(p_token,p_claim_id,p_member_name,p_member_phone,p_reminder_opted_in);
  IF v_result->>'success' IS DISTINCT FROM 'true' THEN RETURN v_result; END IF;
  PERFORM public.attach_desk_booking_client_profiles(p_salon_id,ARRAY[v_booking_id],p_actor_user_id);
  RETURN v_result;
END;$function$;
REVOKE ALL ON FUNCTION public.claim_party_slot_for_desk(text,uuid,text,text,boolean,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_party_slot_for_desk(text,uuid,text,text,boolean,uuid,uuid) TO service_role;

-- Party contact capabilities may edit the reserved guest contact. They do not
-- authorize phone-owned CRM, and cannot silently transfer a bound card receipt.
CREATE FUNCTION public.update_party_booking_contact(
  p_booking_id uuid,p_salon_id uuid,p_member_name text,p_member_phone text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE v_booking public.bookings%ROWTYPE; v_group_id uuid; v_changed boolean; v_phone text; v_keep_profile boolean;
BEGIN
  SELECT b.* INTO v_booking FROM public.bookings b WHERE b.id=p_booking_id AND b.salon_id=p_salon_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','claim_not_found'); END IF;
  v_group_id:=v_booking.group_id;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(CASE WHEN v_group_id IS NULL
    THEN 'booking-management:'||v_booking.id::text ELSE 'booking-management-group:'||v_group_id::text END,0));
  SELECT b.* INTO v_booking FROM public.bookings b WHERE b.id=p_booking_id AND b.salon_id=p_salon_id FOR UPDATE;
  IF NOT FOUND OR v_booking.group_id IS DISTINCT FROM v_group_id THEN RETURN jsonb_build_object('success',false,'code','claim_not_found'); END IF;
  v_phone:=public.canonical_phone(p_member_phone);
  v_changed:=public.canonical_phone(v_booking.client_phone) IS DISTINCT FROM v_phone;
  IF v_changed AND (v_booking.noshow_card_id IS NOT NULL OR v_booking.noshow_customer_id IS NOT NULL
    OR EXISTS(SELECT 1 FROM public.booking_card_save_operations op WHERE op.booking_id=v_booking.id
      AND op.salon_id=p_salon_id AND op.status IN ('sending','unknown'))) THEN
    RETURN jsonb_build_object('success',false,'code','contact_change_requires_card_review');
  END IF;
  v_keep_profile:=NOT v_changed AND EXISTS(SELECT 1 FROM public.client_profiles cp
    WHERE cp.id=v_booking.client_profile_id AND cp.deleted_at IS NULL AND public.canonical_phone(cp.phone)=v_phone);
  UPDATE public.bookings SET client_name=p_member_name,client_phone=p_member_phone,
    client_profile_id=CASE WHEN v_keep_profile THEN client_profile_id ELSE NULL END,
    is_party_member=CASE WHEN length(regexp_replace(coalesce(v_phone,''),'\D','','g'))>=7 THEN false ELSE is_party_member END,
    otp_session_id=CASE WHEN v_changed THEN NULL ELSE otp_session_id END,
    verification_method=CASE WHEN v_changed AND verification_method='otp' THEN NULL
      WHEN v_changed AND verification_method='both' THEN 'deposit' ELSE verification_method END,
    verification_completed_at=CASE WHEN v_changed AND verification_method='otp' THEN NULL ELSE verification_completed_at END
  WHERE id=v_booking.id AND salon_id=p_salon_id;
  RETURN jsonb_build_object('success',true);
END;$function$;
REVOKE ALL ON FUNCTION public.update_party_booking_contact(uuid,uuid,text,text) FROM PUBLIC,anon,authenticated,service_role;

DO $migration$
DECLARE v_name text; v_target regprocedure; v_def text; v_old text; v_new text; v_start integer; v_end integer;
BEGIN
  FOREACH v_name IN ARRAY ARRAY['claim_party_slot','update_party_claim_details'] LOOP
    v_target:=to_regprocedure('public.'||v_name||'(text,uuid,text,text,boolean)');
    IF v_target IS NULL THEN RAISE EXCEPTION 'CRM party function missing: %',v_name; END IF;
    v_def:=pg_get_functiondef(v_target);
    v_old:='  v_profile_id UUID;';
    IF (length(v_def)-length(replace(v_def,v_old,'')))/length(v_old)<>1 THEN RAISE EXCEPTION 'CRM party declaration mismatch: %',v_name; END IF;
    v_def:=replace(v_def,v_old,v_old||E'\n  v_salon_id UUID;\n  v_contact_result jsonb;');
    v_old:='SELECT id, expires_at INTO v_link_id, v_expires FROM party_links WHERE token = p_token;';
    IF (length(v_def)-length(replace(v_def,v_old,'')))/length(v_old)<>1 THEN RAISE EXCEPTION 'CRM party salon anchor mismatch: %',v_name; END IF;
    v_def:=replace(v_def,v_old,'SELECT id, expires_at, salon_id INTO v_link_id, v_expires, v_salon_id FROM party_links WHERE token = p_token;');
    v_old:='  UPDATE party_link_claims'; v_start:=strpos(v_def,v_old);
    v_end:=strpos(v_def,E'\n  RETURN jsonb_build_object(''success'', true);');
    IF v_start=0 OR v_end<=v_start OR strpos(substr(v_def,v_start,v_end-v_start),'public.resolve_client_profile(')=0 THEN
      RAISE EXCEPTION 'CRM party mutation block mismatch: %',v_name;
    END IF;
    v_old:=substr(v_def,v_start,v_end-v_start);
    v_new:=E'  IF v_booking_id IS NOT NULL THEN\n    v_contact_result:=public.update_party_booking_contact(v_booking_id,v_salon_id,p_member_name,p_member_phone);\n    IF v_contact_result->>''success'' IS DISTINCT FROM ''true'' THEN RETURN v_contact_result; END IF;\n  END IF;\n  UPDATE party_link_claims SET member_name=p_member_name,member_phone=p_member_phone,\n    reminder_opted_in=p_reminder_opted_in'||CASE WHEN v_name='claim_party_slot' THEN ',claimed_at=now()' ELSE '' END||E'\n  WHERE id=p_claim_id;\n';
    v_def:=replace(v_def,v_old,v_new);
    EXECUTE v_def;
  END LOOP;
END;$migration$;
