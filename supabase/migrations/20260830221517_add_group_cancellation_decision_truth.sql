-- A whole-party desk cancellation is one operational occurrence, not twelve
-- independent money decisions. Persist exactly one fee review/receipt beside
-- the atomic cancellation and keep payment dispatch outside this contract.

CREATE TABLE public.booking_group_cancellation_fee_reviews (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  group_id uuid NOT NULL,
  cancellation_request_id uuid NOT NULL,
  organizer_booking_id uuid NOT NULL REFERENCES public.bookings(id) ON DELETE RESTRICT,
  state text NOT NULL CHECK (
    state IN ('pending_review','approved_charge','waived','not_applicable')
  ),
  amount_cents integer NOT NULL CHECK (amount_cents >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  card_brand text,
  card_last4 text CHECK (card_last4 IS NULL OR card_last4 ~ '^[0-9]{4}$'),
  consent_policy_version text,
  policy_snapshot jsonb NOT NULL CHECK (jsonb_typeof(policy_snapshot) = 'object'),
  requested_by_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  requested_by_role text NOT NULL CHECK (
    requested_by_role IN ('owner','admin','senior','receptionist')
  ),
  requested_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  decided_by_user_id uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  decided_by_role text CHECK (decided_by_role IS NULL OR decided_by_role IN ('owner','admin')),
  decided_at timestamptz,
  payment_status text NOT NULL DEFAULT 'not_authorized' CHECK (
    payment_status IN ('not_authorized','dispatch_blocked')
  ),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT booking_group_cancel_fee_review_request_once
    UNIQUE (salon_id, cancellation_request_id),
  CONSTRAINT booking_group_cancel_fee_review_decision_check CHECK (
    (state = 'pending_review' AND decided_by_user_id IS NULL
      AND decided_by_role IS NULL AND decided_at IS NULL
      AND payment_status = 'not_authorized' AND amount_cents > 0)
    OR (state = 'approved_charge' AND decided_by_user_id IS NOT NULL
      AND decided_by_role IN ('owner','admin') AND decided_at IS NOT NULL
      AND payment_status = 'dispatch_blocked' AND amount_cents > 0)
    OR (state = 'waived' AND decided_by_user_id IS NOT NULL
      AND decided_by_role IN ('owner','admin') AND decided_at IS NOT NULL
      AND payment_status = 'not_authorized' AND amount_cents > 0)
    OR (state = 'not_applicable' AND decided_by_user_id IS NULL
      AND decided_by_role IS NULL AND decided_at IS NULL
      AND payment_status = 'not_authorized' AND amount_cents = 0)
  )
);

CREATE INDEX booking_group_cancel_fee_reviews_queue_idx
  ON public.booking_group_cancellation_fee_reviews (salon_id, state, requested_at DESC);

CREATE TABLE public.booking_group_cancellation_fee_approval_receipts (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  review_id uuid NOT NULL UNIQUE
    REFERENCES public.booking_group_cancellation_fee_reviews(id) ON DELETE RESTRICT,
  approval_request_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('charge','waive')),
  actor_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  actor_role text NOT NULL CHECK (actor_role IN ('owner','admin')),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  consent_policy_version text,
  receipt_fingerprint text NOT NULL CHECK (receipt_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT booking_group_cancel_fee_approval_request_once
    UNIQUE (salon_id, approval_request_id)
);

ALTER TABLE public.booking_group_cancellation_fee_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_group_cancellation_fee_reviews FORCE ROW LEVEL SECURITY;
ALTER TABLE public.booking_group_cancellation_fee_approval_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_group_cancellation_fee_approval_receipts FORCE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public.booking_group_cancellation_fee_reviews
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL PRIVILEGES ON TABLE public.booking_group_cancellation_fee_approval_receipts
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.booking_group_cancellation_fee_reviews
  TO service_role;
GRANT SELECT, INSERT ON TABLE public.booking_group_cancellation_fee_approval_receipts
  TO service_role;

CREATE POLICY "deny browser group cancellation fee reviews"
  ON public.booking_group_cancellation_fee_reviews AS RESTRICTIVE
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY "deny browser group cancellation fee receipts"
  ON public.booking_group_cancellation_fee_approval_receipts AS RESTRICTIVE
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

CREATE FUNCTION public.prevent_group_cancellation_fee_receipt_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $receipt_immutable$
BEGIN
  RAISE EXCEPTION 'group cancellation fee approval receipts are immutable'
    USING ERRCODE = 'NI001';
END;
$receipt_immutable$;

CREATE TRIGGER booking_group_cancellation_fee_receipts_immutable
BEFORE UPDATE OR DELETE ON public.booking_group_cancellation_fee_approval_receipts
FOR EACH ROW EXECUTE FUNCTION public.prevent_group_cancellation_fee_receipt_mutation();

-- Service-role-only, server-authoritative preview. The organizer's consented
-- no-show snapshot is the ceiling/source; repeated member snapshots are never
-- summed. The booked value is display-only evidence.
CREATE FUNCTION public.preview_booking_group_cancellation_for_desk(
  p_salon_id uuid,
  p_group_id uuid,
  p_actor_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO ''
AS $preview$
DECLARE
  v_actor_role text;
  v_salon public.salons%ROWTYPE;
  v_organizer public.bookings%ROWTYPE;
  v_group_size integer;
  v_earliest_start timestamptz;
  v_booked_value_cents integer;
  v_window_hours integer;
  v_notice_minutes integer;
  v_within_window boolean;
  v_has_card boolean;
  v_no_show_fee integer;
  v_fee_cents integer;
  v_policy_version text;
  v_reason text;
BEGIN
  IF NOT public.staff_action_notification_caller_is_service_role() THEN
    RETURN jsonb_build_object('success',false,'code','unauthorized');
  END IF;
  IF p_salon_id IS NULL OR p_group_id IS NULL OR p_actor_user_id IS NULL THEN
    RETURN jsonb_build_object('success',false,'code','invalid_request');
  END IF;
  SELECT m.role INTO v_actor_role
  FROM public.salon_members m
  WHERE m.salon_id = p_salon_id AND m.user_id = p_actor_user_id
    AND m.role IN ('owner','admin','senior','receptionist')
  LIMIT 1;
  IF v_actor_role IS NULL THEN
    RETURN jsonb_build_object('success',false,'code','actor_unauthorized');
  END IF;
  SELECT * INTO v_salon FROM public.salons s WHERE s.id = p_salon_id;
  SELECT * INTO v_organizer
  FROM public.bookings b
  WHERE b.salon_id = p_salon_id AND b.group_id = p_group_id
    AND b.is_group_organizer IS TRUE AND b.deleted_at IS NULL;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success',false,'code','group_not_found');
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.bookings b
    WHERE b.salon_id = p_salon_id AND b.group_id = p_group_id
      AND b.is_group_organizer IS TRUE AND b.id <> v_organizer.id
      AND b.deleted_at IS NULL
  ) THEN
    RETURN jsonb_build_object('success',false,'code','group_organizer_ambiguous');
  END IF;
  SELECT count(*)::integer,
    min(b.start_time_utc),
    coalesce(sum(coalesce(b.price_cents,0) + coalesce(b.addon_price_cents,0)),0)::integer
  INTO v_group_size, v_earliest_start, v_booked_value_cents
  FROM public.bookings b
  WHERE b.salon_id = p_salon_id AND b.group_id = p_group_id
    AND b.deleted_at IS NULL
    AND b.status IN ('pending','confirmed','in_progress');
  IF v_group_size < 1 OR v_earliest_start IS NULL THEN
    RETURN jsonb_build_object('success',false,'code','group_not_cancellable');
  END IF;

  v_window_hours := CASE
    WHEN coalesce(v_salon.self_cancel_window_hours,0) > 0
      THEN v_salon.self_cancel_window_hours ELSE 24 END;
  v_notice_minutes := floor(extract(epoch FROM (v_earliest_start - clock_timestamp())) / 60)::integer;
  v_within_window := v_notice_minutes > 0
    AND v_notice_minutes < v_window_hours * 60;
  v_no_show_fee := greatest(coalesce(v_organizer.noshow_fee_cents,0),0);
  v_fee_cents := CASE
    WHEN v_salon.self_cancel_fee_percent IS NOT NULL
      AND coalesce(v_salon.noshow_fee_percent,0) > 0
      THEN round(v_no_show_fee::numeric
        * greatest(v_salon.self_cancel_fee_percent,0)::numeric
        / v_salon.noshow_fee_percent::numeric)::integer
    ELSE v_no_show_fee
  END;
  v_policy_version := nullif(trim(coalesce(
    v_organizer.noshow_consent_meta->>'policyVersion',''
  )), '');
  v_has_card := nullif(trim(coalesce(v_organizer.noshow_card_id,'')), '') IS NOT NULL
    AND v_organizer.noshow_consent_at IS NOT NULL
    AND v_policy_version IS NOT NULL
    AND coalesce(v_organizer.noshow_charge_status,'') <> 'charged';
  v_reason := CASE
    WHEN coalesce(v_salon.self_cancel_fee_enabled,false) IS NOT TRUE THEN 'policy_disabled'
    WHEN v_notice_minutes <= 0 THEN 'appointment_started'
    WHEN NOT v_within_window THEN 'outside_fee_window'
    WHEN v_fee_cents <= 0 THEN 'fee_snapshot_missing'
    WHEN NOT v_has_card THEN 'card_or_consent_missing'
    ELSE 'owner_review_required'
  END;

  RETURN jsonb_build_object(
    'success',true,
    'code','preview_ready',
    'salon_id',p_salon_id,
    'group_id',p_group_id,
    'organizer_booking_id',v_organizer.id,
    'actor_role',v_actor_role,
    'group_size',v_group_size,
    'earliest_start_time_utc',v_earliest_start,
    'notice_minutes',v_notice_minutes,
    'window_hours',v_window_hours,
    'booked_value_cents',v_booked_value_cents,
    'fee_cents',CASE WHEN v_reason='owner_review_required' THEN v_fee_cents ELSE 0 END,
    'fee_snapshot_cents',v_fee_cents,
    'currency',coalesce(v_salon.currency_code,'CAD'),
    'has_chargeable_card',v_has_card,
    'decision_required',v_reason='owner_review_required',
    'can_waive',v_actor_role IN ('owner','admin'),
    'reason',v_reason,
    'consent_policy_version',v_policy_version,
    'card_brand',nullif(trim(coalesce(v_organizer.noshow_card_brand,'')),''),
    'card_last4',nullif(trim(coalesce(v_organizer.noshow_card_last4,'')),'')
  );
END;
$preview$;

CREATE FUNCTION public.cancel_booking_group_for_desk_with_decision_truth(
  p_salon_id uuid,
  p_group_id uuid,
  p_request_id uuid,
  p_actor_user_id uuid,
  p_fee_decision text,
  p_notify_email boolean,
  p_notify_sms boolean,
  p_notification_delay_seconds integer DEFAULT 20
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $group_cancel$
DECLARE
  v_actor_role text;
  v_channels jsonb;
  v_receipt public.staff_action_group_cancel_receipts%ROWTYPE;
  v_organizer public.bookings%ROWTYPE;
  v_active_ids uuid[];
  v_ids_json jsonb;
  v_result jsonb;
  v_fp text;
  v_event jsonb;
  v_preview jsonb;
  v_review_id uuid;
  v_review_state text;
  v_amount_cents integer;
BEGIN
  IF NOT public.staff_action_notification_caller_is_service_role() THEN
    RETURN jsonb_build_object('success',false,'code','unauthorized');
  END IF;
  IF p_salon_id IS NULL OR p_group_id IS NULL OR p_request_id IS NULL
     OR p_actor_user_id IS NULL OR p_notify_email IS NULL OR p_notify_sms IS NULL
     OR p_fee_decision NOT IN ('review','waive','not_applicable')
     OR p_notification_delay_seconds NOT BETWEEN 0 AND 120 THEN
    RETURN jsonb_build_object('success',false,'code','invalid_request');
  END IF;
  SELECT m.role INTO v_actor_role FROM public.salon_members m
  WHERE m.salon_id=p_salon_id AND m.user_id=p_actor_user_id
    AND m.role IN ('owner','admin','senior','receptionist') LIMIT 1;
  IF v_actor_role IS NULL THEN
    RETURN jsonb_build_object('success',false,'code','actor_unauthorized');
  END IF;
  v_channels := jsonb_build_object('sms',p_notify_sms,'email',p_notify_email);
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'staff-action-group-cancel:'||p_salon_id::text||':'||p_group_id::text,0));
  SELECT * INTO v_receipt FROM public.staff_action_group_cancel_receipts
  WHERE salon_id=p_salon_id AND request_id=p_request_id FOR UPDATE;
  IF FOUND THEN
    IF v_receipt.group_id IS DISTINCT FROM p_group_id
       OR v_receipt.actor_user_id IS DISTINCT FROM p_actor_user_id
       OR v_receipt.requested_channels IS DISTINCT FROM v_channels
       OR v_receipt.notification_delay_seconds IS DISTINCT FROM p_notification_delay_seconds
       OR v_receipt.result_json->>'fee_decision' IS DISTINCT FROM p_fee_decision THEN
      RETURN jsonb_build_object('success',false,'code','idempotency_mismatch');
    END IF;
    RETURN v_receipt.result_json || jsonb_build_object('idempotent',true);
  END IF;
  PERFORM 1 FROM public.bookings b
  WHERE b.salon_id=p_salon_id AND b.group_id=p_group_id
  ORDER BY b.id FOR UPDATE;
  v_preview := public.preview_booking_group_cancellation_for_desk(
    p_salon_id,p_group_id,p_actor_user_id
  );
  IF coalesce((v_preview->>'success')::boolean,false) IS NOT TRUE THEN
    RETURN v_preview;
  END IF;
  IF coalesce((v_preview->>'decision_required')::boolean,false) THEN
    IF p_fee_decision = 'not_applicable' THEN
      RETURN jsonb_build_object('success',false,'code','fee_decision_required');
    END IF;
    IF p_fee_decision = 'waive' AND v_actor_role NOT IN ('owner','admin') THEN
      RETURN jsonb_build_object('success',false,'code','fee_waive_forbidden');
    END IF;
    v_review_state := CASE WHEN p_fee_decision='waive' THEN 'waived' ELSE 'pending_review' END;
    v_amount_cents := (v_preview->>'fee_cents')::integer;
  ELSE
    v_review_state := 'not_applicable';
    v_amount_cents := 0;
  END IF;

  SELECT b.* INTO v_organizer FROM public.bookings b
  WHERE b.id=(v_preview->>'organizer_booking_id')::uuid FOR UPDATE;
  SELECT array_agg(b.id ORDER BY b.is_group_organizer DESC,b.created_at,b.id)
  INTO v_active_ids FROM public.bookings b
  WHERE b.salon_id=p_salon_id AND b.group_id=p_group_id AND b.deleted_at IS NULL
    AND b.status IN ('pending','confirmed','in_progress');
  IF coalesce(cardinality(v_active_ids),0)<1 OR NOT (v_organizer.id=ANY(v_active_ids)) THEN
    RETURN jsonb_build_object('success',false,'code','group_not_cancellable');
  END IF;
  v_ids_json := to_jsonb(v_active_ids);

  INSERT INTO public.booking_group_cancellation_fee_reviews(
    salon_id,group_id,cancellation_request_id,organizer_booking_id,state,
    amount_cents,currency,card_brand,card_last4,consent_policy_version,
    policy_snapshot,requested_by_user_id,requested_by_role,
    decided_by_user_id,decided_by_role,decided_at
  ) VALUES (
    p_salon_id,p_group_id,p_request_id,v_organizer.id,v_review_state,
    v_amount_cents,v_preview->>'currency',v_preview->>'card_brand',
    v_preview->>'card_last4',v_preview->>'consent_policy_version',
    v_preview,p_actor_user_id,v_actor_role,
    CASE WHEN v_review_state='waived' THEN p_actor_user_id ELSE NULL END,
    CASE WHEN v_review_state='waived' THEN v_actor_role ELSE NULL END,
    CASE WHEN v_review_state='waived' THEN transaction_timestamp() ELSE NULL END
  ) RETURNING id INTO v_review_id;

  -- An owner/admin who waives during the cancellation has already made the
  -- financial decision. Persist the same immutable receipt as the later queue
  -- path; the cancellation request id is the stable approval id.
  IF v_review_state = 'waived' THEN
    v_fp := encode(extensions.digest(convert_to(concat_ws('|',
      v_review_id::text,'waive',p_actor_user_id::text,v_amount_cents::text,
      v_preview->>'currency',coalesce(v_preview->>'consent_policy_version',''),
      p_request_id::text
    ),'UTF8'),'sha256'),'hex');
    INSERT INTO public.booking_group_cancellation_fee_approval_receipts(
      salon_id,review_id,approval_request_id,action,actor_user_id,actor_role,
      amount_cents,currency,consent_policy_version,receipt_fingerprint
    ) VALUES (
      p_salon_id,v_review_id,p_request_id,'waive',p_actor_user_id,v_actor_role,
      v_amount_cents,v_preview->>'currency',
      v_preview->>'consent_policy_version',v_fp
    );
  END IF;

  UPDATE public.bookings SET status='cancelled'
  WHERE salon_id=p_salon_id AND group_id=p_group_id AND id<>v_organizer.id
    AND id=ANY(v_active_ids);

  PERFORM set_config('nailiq.defer_owner_cancel_notification','1',true);
  PERFORM set_config('nailiq.v1_terminal_reason','desk_cancel',true);
  PERFORM set_config('nailiq.v1_terminal_actor_role',v_actor_role,true);
  IF p_notify_email OR p_notify_sms THEN
    PERFORM set_config('nailiq.staff_action_affected_booking_ids',v_ids_json::text,true);
    UPDATE public.bookings SET status='cancelled',
      staff_action_notification_request_id=p_request_id,
      staff_action_notification_actor_user_id=p_actor_user_id,
      staff_action_notification_actor_role=v_actor_role,
      staff_action_notification_channels=v_channels,
      staff_action_notification_delay_seconds=p_notification_delay_seconds
    WHERE id=v_organizer.id AND salon_id=p_salon_id
      AND status IN ('pending','confirmed','in_progress');
  ELSE
    UPDATE public.bookings SET status='cancelled'
    WHERE id=v_organizer.id AND salon_id=p_salon_id
      AND status IN ('pending','confirmed','in_progress');
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'atomic group organizer cancel failed' USING ERRCODE='NI002';
  END IF;
  PERFORM set_config('nailiq.defer_owner_cancel_notification','',true);
  PERFORM set_config('nailiq.v1_terminal_reason','',true);
  PERFORM set_config('nailiq.v1_terminal_actor_role','',true);

  v_event := public.inspect_staff_action_notification_event(p_salon_id,p_request_id);
  IF (p_notify_email OR p_notify_sms)
     AND coalesce((v_event->>'success')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'atomic group notification capture failed' USING ERRCODE='NI002';
  END IF;
  DELETE FROM public.customer_booking_transition_email_outbox x
  USING public.bookings b
  WHERE b.id=x.booking_id AND b.salon_id=p_salon_id AND b.group_id=p_group_id
    AND x.event_type='cancel' AND x.status IN ('awaiting_activation','suppressed')
    AND b.id=ANY(v_active_ids);

  v_result := jsonb_build_object(
    'success',true,'code','group_cancelled','idempotent',false,
    'salon_id',p_salon_id,'group_id',p_group_id,
    'organizer_booking_id',v_organizer.id,
    'cancelled_booking_ids',v_ids_json,
    'cancelled_count',cardinality(v_active_ids),
    'requested_channels',v_channels,
    'notification_delay_seconds',p_notification_delay_seconds,
    'staff_action_notification',CASE WHEN p_notify_email OR p_notify_sms THEN v_event ELSE NULL END,
    'owner_notification','queued',
    'fee_review_id',v_review_id,
    'fee_decision',CASE WHEN v_review_state='not_applicable' THEN 'not_applicable' ELSE p_fee_decision END,
    'fee_state',v_review_state,
    'fee_cents',v_amount_cents,
    'fee_currency',v_preview->>'currency'
  );
  v_fp := encode(extensions.digest(convert_to(v_result::text,'UTF8'),'sha256'),'hex');
  INSERT INTO public.staff_action_group_cancel_receipts(
    salon_id,group_id,request_id,organizer_booking_id,actor_user_id,actor_role,
    requested_channels,notification_delay_seconds,cancelled_booking_ids,
    result_json,result_fingerprint
  ) VALUES (
    p_salon_id,p_group_id,p_request_id,v_organizer.id,p_actor_user_id,v_actor_role,
    v_channels,p_notification_delay_seconds,v_ids_json,v_result,v_fp
  );
  RETURN v_result;
END;
$group_cancel$;

CREATE FUNCTION public.decide_group_cancellation_fee_review(
  p_review_id uuid,
  p_salon_id uuid,
  p_actor_user_id uuid,
  p_actor_role text,
  p_approval_request_id uuid,
  p_action text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $decide$
DECLARE
  v_member_role text;
  v_review public.booking_group_cancellation_fee_reviews%ROWTYPE;
  v_existing public.booking_group_cancellation_fee_approval_receipts%ROWTYPE;
  v_fingerprint text;
BEGIN
  IF NOT public.staff_action_notification_caller_is_service_role() THEN
    RETURN jsonb_build_object('success',false,'code','unauthorized');
  END IF;
  IF p_review_id IS NULL OR p_salon_id IS NULL OR p_actor_user_id IS NULL
     OR p_approval_request_id IS NULL OR p_action NOT IN ('charge','waive')
     OR p_actor_role NOT IN ('owner','admin') THEN
    RETURN jsonb_build_object('success',false,'code','invalid_request');
  END IF;
  SELECT m.role INTO v_member_role FROM public.salon_members m
  WHERE m.salon_id=p_salon_id AND m.user_id=p_actor_user_id
    AND m.role IN ('owner','admin') LIMIT 1;
  IF v_member_role IS NULL OR v_member_role IS DISTINCT FROM p_actor_role THEN
    RETURN jsonb_build_object('success',false,'code','actor_unauthorized');
  END IF;
  SELECT * INTO v_existing
  FROM public.booking_group_cancellation_fee_approval_receipts r
  WHERE r.salon_id=p_salon_id AND r.approval_request_id=p_approval_request_id;
  IF FOUND THEN
    IF v_existing.review_id IS DISTINCT FROM p_review_id
       OR v_existing.action IS DISTINCT FROM p_action
       OR v_existing.actor_user_id IS DISTINCT FROM p_actor_user_id THEN
      RETURN jsonb_build_object('success',false,'code','idempotency_mismatch');
    END IF;
    RETURN jsonb_build_object('success',true,'code','decision_replayed',
      'review_id',p_review_id,'state',CASE WHEN p_action='charge'
        THEN 'approved_charge' ELSE 'waived' END,
      'payment_status',CASE WHEN p_action='charge'
        THEN 'dispatch_blocked' ELSE 'not_authorized' END);
  END IF;
  SELECT * INTO v_review
  FROM public.booking_group_cancellation_fee_reviews r
  WHERE r.id=p_review_id AND r.salon_id=p_salon_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success',false,'code','review_not_found');
  END IF;
  IF v_review.state <> 'pending_review' THEN
    RETURN jsonb_build_object('success',false,'code','review_not_pending');
  END IF;
  v_fingerprint := encode(extensions.digest(convert_to(concat_ws('|',
    v_review.id::text,p_action,p_actor_user_id::text,v_review.amount_cents::text,
    v_review.currency,coalesce(v_review.consent_policy_version,''),
    p_approval_request_id::text
  ),'UTF8'),'sha256'),'hex');
  INSERT INTO public.booking_group_cancellation_fee_approval_receipts(
    salon_id,review_id,approval_request_id,action,actor_user_id,actor_role,
    amount_cents,currency,consent_policy_version,receipt_fingerprint
  ) VALUES (
    p_salon_id,p_review_id,p_approval_request_id,p_action,p_actor_user_id,
    v_member_role,v_review.amount_cents,v_review.currency,
    v_review.consent_policy_version,v_fingerprint
  );
  UPDATE public.booking_group_cancellation_fee_reviews
  SET state=CASE WHEN p_action='charge' THEN 'approved_charge' ELSE 'waived' END,
      decided_by_user_id=p_actor_user_id,decided_by_role=v_member_role,
      decided_at=transaction_timestamp(),
      payment_status=CASE WHEN p_action='charge'
        THEN 'dispatch_blocked' ELSE 'not_authorized' END,
      updated_at=transaction_timestamp()
  WHERE id=p_review_id;
  RETURN jsonb_build_object('success',true,'code','decision_recorded',
    'review_id',p_review_id,'state',CASE WHEN p_action='charge'
      THEN 'approved_charge' ELSE 'waived' END,
    'payment_status',CASE WHEN p_action='charge'
      THEN 'dispatch_blocked' ELSE 'not_authorized' END);
END;
$decide$;

REVOKE ALL ON FUNCTION public.prevent_group_cancellation_fee_receipt_mutation()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.preview_booking_group_cancellation_for_desk(uuid,uuid,uuid),
  public.cancel_booking_group_for_desk_with_decision_truth(
    uuid,uuid,uuid,uuid,text,boolean,boolean,integer
  ),
  public.decide_group_cancellation_fee_review(uuid,uuid,uuid,text,uuid,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.preview_booking_group_cancellation_for_desk(uuid,uuid,uuid),
  public.cancel_booking_group_for_desk_with_decision_truth(
    uuid,uuid,uuid,uuid,text,boolean,boolean,integer
  ),
  public.decide_group_cancellation_fee_review(uuid,uuid,uuid,text,uuid,text)
  TO service_role;
