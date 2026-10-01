-- Additive function hotfix. No data backfill, feature activation or outbound work.
-- An offer is not a reservation: revalidate canonical capacity at claim time.
-- Rollback: use reviewed pre-migration function snapshots, not the folded
-- baseline or its historical grants. Preserve empty search_path and qualify
-- legacy public objects; never restore search_path=public on this definer.
-- See docs/qa/waitlist-function-rollback-local-2026-10-01.md for the fenced
-- rehearsal and snapshot/ACL/data-preservation requirements.
-- Also restore the preceding 14-argument create_public_booking definition when
-- rolling back the cross-engine lock-order patch below; do not alter its ACL.
-- Do not reverse already committed bookings or receipts during code rollback.

-- Legacy public create must join the canonical writer's phone -> capacity ->
-- salon/resource order before it acquires physical occupancy locks. Otherwise
-- it can hold a resource while waiting for the claim's salon FK lock, and the
-- claim can hold that salon while waiting for the same resource. Preserve the
-- entire pricing/auth/OTP contract and existing function grants. Abort on drift.
DO $claim_lock_order$
DECLARE v_target regprocedure; v_def text; v_anchor text; v_lock text;
BEGIN
  v_target:=pg_catalog.to_regprocedure(
    'public.create_public_booking(uuid,uuid,uuid,text,text,timestamptz,timestamptz,text,integer,text,uuid,integer,text,uuid)');
  IF v_target IS NULL THEN RAISE EXCEPTION 'Waitlist legacy capacity lock target missing'; END IF;
  v_def:=pg_catalog.pg_get_functiondef(v_target);
  v_anchor:=E'  WHERE cp.phone = v_digits\n  FOR UPDATE;\n\n  v_quote := public.resolve_public_booking_pricing(';
  IF (length(v_def)-length(replace(v_def,v_anchor,'')))/length(v_anchor)<>1 THEN
    RAISE EXCEPTION 'Waitlist legacy capacity lock anchor mismatch';
  END IF;
  v_lock:=E'  WHERE cp.phone = v_digits\n  FOR UPDATE;\n\n'
    ||E'  -- Coordinate with canonical sequence and waitlist claim before occupancy.\n'
    ||E'  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(\n'
    ||E'    ''booking-sequence-capacity:'' || p_salon_id::text, 0));\n\n'
    ||'  v_quote := public.resolve_public_booking_pricing(';
  EXECUTE replace(v_def,v_anchor,v_lock);
END;
$claim_lock_order$;

CREATE OR REPLACE FUNCTION public.claim_waitlist_slot(p_claim_token uuid)
RETURNS TABLE(id uuid,client_name text,client_phone text,client_email text,
  auto_booked boolean,booking_id uuid,booked_start_utc timestamptz,staff_name text,service_name text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
  v_e public.booking_waitlist_entries%ROWTYPE;
  v_auto boolean;
  v_price integer;
  v_res jsonb;
  v_bid uuid;
  v_timezone text;
  v_local_start timestamp;
  v_duration integer;
  v_prep integer;
  v_buffer integer;
  v_capacity text;
  v_request jsonb;
  v_quote jsonb;
  v_intent_valid boolean;
BEGIN
  SELECT * INTO v_e FROM public.booking_waitlist_entries w
  WHERE w.claim_token=p_claim_token AND w.status='notified' AND w.claimed_at IS NULL
  FOR UPDATE SKIP LOCKED;
  IF v_e.id IS NULL THEN RETURN; END IF;

  -- Match the canonical writer's phone -> capacity -> salon order. Acquiring
  -- FOR SHARE here and upgrading inside the writer can deadlock two claims.
  PERFORM public.lock_booking_crm_phones(ARRAY[v_e.client_phone]);
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'booking-sequence-capacity:'||v_e.salon_id::text,0));
  SELECT coalesce((s.feature_flags->>'waitlist_auto_book')::boolean,false),s.timezone
  INTO v_auto,v_timezone FROM public.salons s WHERE s.id=v_e.salon_id FOR UPDATE;
  IF v_auto AND v_e.offered_staff_id IS NOT NULL
     AND v_e.offered_start_utc IS NOT NULL AND v_e.offered_end_utc IS NOT NULL THEN
    -- Keep salon/catalog reads stable until this same transaction creates the
    -- booking. The existing booking engine still performs staff/resource locks
    -- and exclusion checks against competing writers after this preflight.
    SELECT sv.price_cents,sv.duration_minutes,sv.prep_minutes,sv.buffer_minutes INTO v_price,v_duration,v_prep,v_buffer
    FROM public.services sv WHERE sv.id=v_e.service_id AND sv.salon_id=v_e.salon_id
      AND sv.deleted_at IS NULL AND NOT sv.is_addon FOR SHARE;
    v_capacity:='availability_unverified';
    -- An old offer does not authorize a partial booking or a changed requested
    -- technician. Legacy empty intent remains supported for one individual;
    -- richer intent must describe exactly the one service this writer can book.
    -- Preserve the original intent/source on rejection; never silently strip
    -- add-ons, group members or scheduling constraints to make a claim succeed.
    v_intent_valid:=v_e.request_kind='individual' AND v_e.party_size=1
      AND (v_e.staff_id IS NULL OR v_e.staff_id=v_e.offered_staff_id)
      AND (v_e.intent_json='{}'::jsonb OR (
        v_e.intent_json - ARRAY['serviceIds','staffPreference','source']='{}'::jsonb
        AND v_e.intent_json->'serviceIds'=pg_catalog.jsonb_build_array(v_e.service_id::text)
        AND (NOT (v_e.intent_json ? 'staffPreference') OR
          v_e.intent_json->>'staffPreference' IS NOT DISTINCT FROM coalesce(v_e.staff_id::text,'any'))
        AND (NOT (v_e.intent_json ? 'source') OR
          v_e.intent_json->>'source' IS NOT DISTINCT FROM v_e.source)
      ));
    IF v_intent_valid IS TRUE AND v_duration>0 AND v_prep>=0 AND v_buffer>=0 AND v_timezone IS NOT NULL
       AND EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names tz WHERE tz.name=v_timezone)
       AND v_e.offered_end_utc=v_e.offered_start_utc+pg_catalog.make_interval(mins=>v_duration) THEN
      v_local_start:=v_e.offered_start_utc AT TIME ZONE v_timezone;
      IF pg_catalog.date_trunc('minute',v_local_start)=v_local_start
         AND v_local_start::date=v_e.booking_date
         AND (v_local_start AT TIME ZONE v_timezone)=v_e.offered_start_utc
         -- This writer accepts a same-business-day offer. A changed catalog
         -- buffer/prep must not wrap into a different date and appear earlier
         -- than closing when capacity compares local clock minutes.
         AND ((v_e.offered_start_utc-pg_catalog.make_interval(mins=>v_prep)) AT TIME ZONE v_timezone)::date=v_e.booking_date
         AND ((v_e.offered_end_utc+pg_catalog.make_interval(mins=>v_buffer)) AT TIME ZONE v_timezone)::date=v_e.booking_date
         AND (nullif(pg_catalog.btrim(v_e.preferred_slot_label),'') IS NULL OR
           upper(pg_catalog.regexp_replace(pg_catalog.btrim(v_e.preferred_slot_label),'[[:space:]]+',' ','g'))
             =pg_catalog.to_char(v_local_start,'FMHH12:MI AM')) THEN
        SELECT outcome INTO v_capacity FROM public.evaluate_individual_waitlist_capacity(
          v_e.salon_id,v_e.service_id,v_e.offered_staff_id,v_e.booking_date,
          pg_catalog.to_char(v_local_start,'FMHH12:MI AM')) LIMIT 1;
      END IF;
    END IF;
    IF v_capacity IS DISTINCT FROM 'slot_available' THEN
      -- The action-scoped wrapper records this rejection and retires the offer
      -- epoch atomically. Retrying cannot consume a second receipt or rebook.
      UPDATE public.booking_waitlist_entries SET status='waiting',notified_at=NULL,claim_token=NULL,
        offered_staff_id=NULL,offered_start_utc=NULL,offered_end_utc=NULL WHERE booking_waitlist_entries.id=v_e.id;
      RETURN;
    END IF;
    IF v_prep>0 THEN
      -- A legacy single booking cannot represent occupancy before customer
      -- arrival. Reuse the canonical segment writer rather than moving the
      -- customer's time or inventing financial/occupancy snapshots. This keeps
      -- existing rollout, OTP, health acknowledgement and payment gates intact.
      -- If that contract is not authorized/ready, fail closed: no legacy fallback.
      v_request:=pg_catalog.jsonb_build_object('contract_version',1,
        'salon_id',v_e.salon_id,'request_id',v_e.claim_token,
        'requested_start_time_utc',v_e.offered_start_utc,'same_staff_for_all',false,
        'apply_email_discount',false,'customer',pg_catalog.jsonb_build_object(
          'name',v_e.client_name,'phone',v_e.client_phone,'email',v_e.client_email),
        'lines',pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'line_id',v_e.id,'position',0,'service_id',v_e.service_id,
          'staff_preference',v_e.offered_staff_id,'addon_service_ids','[]'::jsonb)));
      v_quote:=public.resolve_booking_sequence_pricing_and_schedule(v_request,false);
      IF coalesce((v_quote->>'success')::boolean,false) THEN
        v_res:=public.create_public_booking_sequence(v_request||pg_catalog.jsonb_build_object(
          'expected_pricing_fingerprint',v_quote->>'pricing_fingerprint'));
      ELSE
        v_res:=v_quote;
      END IF;
    ELSE
      v_res:=public.create_public_booking(v_e.salon_id,v_e.service_id,v_e.offered_staff_id,
        v_e.client_name,v_e.client_phone,v_e.offered_start_utc,v_e.offered_end_utc,
        'confirmed',v_price,NULL,NULL,NULL,v_e.client_email);
    END IF;
    IF coalesce((v_res->>'success')::boolean,false) THEN
      v_bid:=(v_res->>'booking_id')::uuid;
      UPDATE public.booking_waitlist_entries SET status='claimed',claimed_at=now(),booked_booking_id=v_bid
      WHERE booking_waitlist_entries.id=v_e.id;
      RETURN QUERY SELECT v_e.id,v_e.client_name,v_e.client_phone,v_e.client_email,true,v_bid,v_e.offered_start_utc,
        (SELECT st.name FROM public.staff st WHERE st.id=v_e.offered_staff_id),
        (SELECT sv.name FROM public.services sv WHERE sv.id=v_e.service_id);
      RETURN;
    ELSE
      UPDATE public.booking_waitlist_entries SET status='waiting',notified_at=NULL,claim_token=NULL,
        offered_staff_id=NULL,offered_start_utc=NULL,offered_end_utc=NULL WHERE booking_waitlist_entries.id=v_e.id;
      RETURN;
    END IF;
  END IF;
  -- Preserve the existing manual-interest acknowledgement; it does not book or
  -- reserve a slot and must not be labelled as a confirmed booking by callers.
  UPDATE public.booking_waitlist_entries SET status='claimed',claimed_at=now() WHERE booking_waitlist_entries.id=v_e.id;
  RETURN QUERY SELECT v_e.id,v_e.client_name,v_e.client_phone,v_e.client_email,false,NULL::uuid,
    NULL::timestamptz,NULL::text,(SELECT sv.name FROM public.services sv WHERE sv.id=v_e.service_id);
END;
$function$;
REVOKE ALL ON FUNCTION public.claim_waitlist_slot(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_waitlist_slot(uuid) TO service_role;
