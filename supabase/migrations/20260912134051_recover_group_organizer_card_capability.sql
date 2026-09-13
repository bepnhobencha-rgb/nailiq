-- Exact committed-group receipt recovery, service-role only. No provider mutations.
CREATE OR REPLACE FUNCTION public.exchange_public_booking_card_management_capability(
  p_salon_id uuid,p_booking_id uuid,p_idempotency_key uuid,
  p_pricing_fingerprint text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $exchange$
DECLARE v_booking public.bookings%ROWTYPE; v_now timestamptz:=transaction_timestamp();
  v_expiry timestamptz; v_result jsonb;
BEGIN
  IF p_salon_id IS NULL OR p_booking_id IS NULL OR p_idempotency_key IS NULL
     OR coalesce(p_pricing_fingerprint,'')!~'^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('ok',false,'code','invalid_request');
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'public-booking-idempotency:'||p_salon_id::text||':'||p_idempotency_key::text,0));
  -- Same create-group lock namespace; exchange never invokes the group writer.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'group-booking-idempotency:'||p_salon_id::text||':'||p_idempotency_key::text,0));
  SELECT * INTO v_booking FROM public.bookings
  WHERE id=p_booking_id AND salon_id=p_salon_id AND idempotency_key=p_idempotency_key
    AND public_booking_pricing_fingerprint=p_pricing_fingerprint
    AND pg_catalog.jsonb_typeof(public_booking_pricing_snapshot)='object'
    AND recovered_from_booking_id IS NULL AND deleted_at IS NULL
    AND status='confirmed'
  FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'code','create_binding_invalid'); END IF;
  IF v_booking.group_id IS NOT NULL THEN
    -- Only the canonical organizer receipt grants organizer_own card management.
    -- A member ID, even with the organizer's create key, must never qualify.
    IF v_booking.is_group_organizer IS NOT TRUE
       OR coalesce(v_booking.public_booking_request_fingerprint,'') !~ '^[0-9a-f]{64}$'
       OR v_booking.public_booking_pricing_snapshot->>'group_id' IS DISTINCT FROM v_booking.group_id::text
       OR v_booking.public_booking_pricing_snapshot->>'pricing_fingerprint' IS DISTINCT FROM p_pricing_fingerprint
       OR pg_catalog.jsonb_typeof(v_booking.public_booking_pricing_snapshot->'booking_ids') IS DISTINCT FROM 'array' THEN
      RETURN jsonb_build_object('ok',false,'code','create_binding_invalid');
    END IF;
    IF pg_catalog.jsonb_array_length(v_booking.public_booking_pricing_snapshot->'booking_ids') < 2
       OR pg_catalog.jsonb_array_length(v_booking.public_booking_pricing_snapshot->'booking_ids') IS DISTINCT FROM v_booking.group_size
       OR v_booking.public_booking_pricing_snapshot->'booking_ids'->>0 IS DISTINCT FROM v_booking.id::text
       OR (SELECT count(DISTINCT m.id) FROM public.bookings m
           JOIN pg_catalog.jsonb_array_elements_text(v_booking.public_booking_pricing_snapshot->'booking_ids') ids(id)
             ON m.id::text=ids.id
           WHERE m.salon_id=p_salon_id AND m.group_id=v_booking.group_id)
          <> pg_catalog.jsonb_array_length(v_booking.public_booking_pricing_snapshot->'booking_ids') THEN
      RETURN jsonb_build_object('ok',false,'code','create_binding_invalid');
    END IF;
  END IF;
  v_expiry:=least(v_booking.created_at+interval '30 minutes',
    coalesce(v_booking.start_time_utc,v_booking.created_at+interval '30 minutes'));
  IF v_booking.status='cancelled' OR v_expiry<=v_now THEN
    RETURN jsonb_build_object('ok',false,'code','exchange_expired');
  END IF;
  v_result:=public.mint_booking_management_capability(
    p_salon_id,p_booking_id,'card_manage',v_expiry);
  IF coalesce(v_result->>'ok','false')<>'true' THEN RETURN v_result; END IF;
  RETURN v_result||jsonb_build_object('code','exchanged','booking_id',p_booking_id);
END;
$exchange$;

REVOKE ALL ON FUNCTION public.exchange_public_booking_card_management_capability(
  uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.exchange_public_booking_card_management_capability(
  uuid,uuid,uuid,text) TO service_role;
