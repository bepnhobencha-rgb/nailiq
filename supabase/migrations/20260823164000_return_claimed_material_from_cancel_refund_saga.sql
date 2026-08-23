-- MQA-0126: the cancel/refund saga used to return v_loaded->'material'.
-- resolve_booking_payment_operation_material() returns the material fields at
-- the top level, so that lookup was always NULL.  The refund was durably
-- claimed and the booking cancelled, but the application correctly refused to
-- dispatch a provider call without parseable DB-owned material.  Return the
-- exact immutable material receipt emitted by claim_booking_payment_operation.

CREATE OR REPLACE FUNCTION public.cancel_booking_with_deposit_refund_saga(
  p_salon_id uuid,
  p_booking_id uuid,
  p_saga_request_id uuid,
  p_refund_amount_cents integer,
  p_notify_email boolean DEFAULT false,
  p_notification_not_before timestamptz DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
  v_saga public.booking_cancel_deposit_refund_sagas%ROWTYPE;
  v_booking public.bookings%ROWTYPE;
  v_loaded jsonb;
  v_claim jsonb;
  v_cancel jsonb;
  v_waitlist jsonb;
  v_transition bigint;
  v_result jsonb;
BEGIN
  IF p_salon_id IS NULL OR p_booking_id IS NULL OR p_saga_request_id IS NULL
     OR p_refund_amount_cents IS NULL OR p_refund_amount_cents<=0
     OR (coalesce(p_notify_email,false) AND p_notification_not_before IS NULL) THEN
    RETURN jsonb_build_object('success',false,'code','invalid_input');
  END IF;

  -- A committed intent remains replayable before mutable booking-state checks.
  SELECT * INTO v_saga FROM public.booking_cancel_deposit_refund_sagas
    WHERE salon_id=p_salon_id AND request_id=p_saga_request_id FOR UPDATE;
  IF FOUND THEN
    IF v_saga.booking_id IS DISTINCT FROM p_booking_id
       OR v_saga.requested_amount_cents IS DISTINCT FROM p_refund_amount_cents THEN
      RETURN jsonb_build_object('success',false,'code','saga_conflict');
    END IF;
    RETURN public.inspect_booking_cancel_deposit_refund_saga(
      p_salon_id,p_booking_id,p_saga_request_id
    );
  END IF;

  SELECT * INTO v_booking FROM public.bookings
    WHERE id=p_booking_id AND salon_id=p_salon_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','booking_not_found'); END IF;
  -- Recheck after the booking lock so a concurrent same-request winner is an
  -- exact replay rather than a false booking_not_cancellable response.
  SELECT * INTO v_saga FROM public.booking_cancel_deposit_refund_sagas
    WHERE salon_id=p_salon_id AND request_id=p_saga_request_id FOR UPDATE;
  IF FOUND THEN
    IF v_saga.booking_id IS DISTINCT FROM p_booking_id
       OR v_saga.requested_amount_cents IS DISTINCT FROM p_refund_amount_cents THEN
      RETURN jsonb_build_object('success',false,'code','saga_conflict');
    END IF;
    RETURN public.inspect_booking_cancel_deposit_refund_saga(
      p_salon_id,p_booking_id,p_saga_request_id
    );
  END IF;
  IF v_booking.status NOT IN ('pending','confirmed','in_progress')
     OR v_booking.deleted_at IS NOT NULL OR v_booking.group_id IS NOT NULL THEN
    RETURN jsonb_build_object('success',false,'code','booking_not_cancellable');
  END IF;

  v_loaded:=public.resolve_booking_payment_operation_material(
    p_salon_id,p_booking_id,'deposit_refund',p_refund_amount_cents,true,NULL
  );
  IF coalesce((v_loaded->>'success')::boolean,false) IS NOT TRUE THEN RETURN v_loaded; END IF;
  v_claim:=public.claim_booking_payment_operation(
    p_salon_id,p_booking_id,p_saga_request_id,'deposit_refund',
    p_refund_amount_cents,v_loaded->>'material_fingerprint'
  );
  IF v_claim->>'code'<>'claimed' THEN
    RETURN jsonb_build_object('success',false,'code','refund_reservation_failed','refund',v_claim);
  END IF;

  UPDATE public.bookings SET status='cancelled',
    customer_transition_email_requested=coalesce(p_notify_email,false),
    customer_transition_email_not_before=CASE WHEN coalesce(p_notify_email,false)
      THEN greatest(now(),p_notification_not_before) ELSE NULL END
    WHERE id=p_booking_id AND salon_id=p_salon_id
      AND status=v_booking.status
    RETURNING customer_transition_version INTO v_transition;
  IF NOT FOUND OR v_transition IS NULL OR v_transition<=0 THEN
    RAISE EXCEPTION 'atomic cancellation transition failed' USING ERRCODE='NI002';
  END IF;
  -- Provider work stays outside this short transaction.  The exact waitlist
  -- capability and payment claim are returned for post-commit dispatch.
  v_waitlist:=public.promote_waitlist_for_booking(p_booking_id);
  v_cancel:=jsonb_build_object(
    'status','cancelled','previous_status',v_booking.status,
    'customer_transition_version',v_transition,
    'previous_start_time_utc',v_booking.start_time_utc,
    'service_id',v_booking.service_id,'staff_id',v_booking.staff_id,
    'promoted_waitlist',CASE WHEN v_waitlist->>'code'='promoted' THEN v_waitlist END,
    'waitlist_result_code',v_waitlist->>'code'
  );
  v_result:=jsonb_build_object(
    'cancellation',v_cancel,'refund_status','sending',
    'refund_operation_id',v_claim->>'operation_id',
    'refund_material_fingerprint',v_loaded->>'material_fingerprint'
  );
  INSERT INTO public.booking_cancel_deposit_refund_sagas(
    salon_id,booking_id,request_id,requested_amount_cents,refund_operation_id,
    refund_material_fingerprint,status,cancellation_transition_version,
    cancellation_result,result_json
  ) VALUES (
    p_salon_id,p_booking_id,p_saga_request_id,p_refund_amount_cents,
    (v_claim->>'operation_id')::uuid,v_loaded->>'material_fingerprint',
    'refund_claimed',v_transition,v_cancel,v_result
  ) RETURNING * INTO v_saga;
  RETURN jsonb_build_object(
    'success',true,'code','cancelled_refund_claimed','idempotent',false,
    'saga_id',v_saga.id,'saga_request_id',p_saga_request_id,
    'saga_status',v_saga.status,'salon_id',p_salon_id,'booking_id',p_booking_id,
    'cancellation_transition_version',v_transition,'cancellation_result',v_cancel,
    'refund_operation_id',v_claim->>'operation_id','refund_status','sending',
    'refund_amount_cents',p_refund_amount_cents,
    'refund_material_fingerprint',v_loaded->>'material_fingerprint',
    'refund_material',v_claim->'material','provider_material',v_loaded->'provider_material',
    'provider_idempotency_key',v_claim->>'provider_idempotency_key',
    'attempt_token',v_claim->>'attempt_token','lease_expires_at',v_claim->>'lease_expires_at'
  );
END
$function$;

REVOKE ALL ON FUNCTION public.cancel_booking_with_deposit_refund_saga(
  uuid,uuid,uuid,integer,boolean,timestamptz
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_booking_with_deposit_refund_saga(
  uuid,uuid,uuid,integer,boolean,timestamptz
) TO service_role;

COMMENT ON FUNCTION public.cancel_booking_with_deposit_refund_saga(
  uuid,uuid,uuid,integer,boolean,timestamptz
) IS 'Atomically reserves a bounded deposit refund before cancellation and returns the exact claimed material for provider dispatch and replay.';
