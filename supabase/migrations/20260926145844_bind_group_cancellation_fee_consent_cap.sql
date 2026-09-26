-- Bound NEW group fee claims to recorded consent and the scoped cancellation value.
-- No historical receipt rewrite, provider dispatch, policy enablement, or automatic fee.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.preview_booking_group_cancellation_for_desk(
  p_salon_id uuid,
  p_group_id uuid,
  p_actor_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO ''
AS $preview_group$
DECLARE
  v_actor_role text;
  v_salon public.salons%ROWTYPE;
  v_organizer public.bookings%ROWTYPE;
  v_group_size integer;
  v_earliest_start timestamptz;
  v_booked_value_cents integer;
  v_window_hours integer;
  v_notice_minutes integer;
  v_short_notice boolean;
  v_grace_ends_at timestamptz;
  v_grace_active boolean;
  v_within_window boolean;
  v_has_card boolean;
  v_no_show_fee integer;
  v_no_show_percent integer;
  v_late_percent integer;
  v_fee_cents numeric;
  v_consent_fee numeric;
  v_basis numeric;
  v_cap numeric;
  v_scope text;
  v_currency text;
  v_consent_valid boolean;
  v_binding_valid boolean;
  v_context jsonb;
  v_receipt public.booking_card_save_operations%ROWTYPE;
  v_guard jsonb;
  v_policy_version text;
  v_reason text;
BEGIN
  IF NOT public.staff_action_notification_caller_is_service_role() THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  IF p_salon_id IS NULL OR p_group_id IS NULL OR p_actor_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_request');
  END IF;
  SELECT m.role INTO v_actor_role
  FROM public.salon_members m
  WHERE m.salon_id = p_salon_id AND m.user_id = p_actor_user_id
    AND m.role IN ('owner', 'admin', 'senior', 'receptionist')
  LIMIT 1;
  IF v_actor_role IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'actor_unauthorized');
  END IF;
  SELECT * INTO v_salon FROM public.salons s WHERE s.id = p_salon_id;
  SELECT * INTO v_organizer
  FROM public.bookings b
  WHERE b.salon_id = p_salon_id AND b.group_id = p_group_id
    AND b.is_group_organizer IS TRUE AND b.deleted_at IS NULL;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'group_not_found');
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.bookings b
    WHERE b.salon_id = p_salon_id AND b.group_id = p_group_id
      AND b.is_group_organizer IS TRUE AND b.id <> v_organizer.id
      AND b.deleted_at IS NULL
  ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'group_organizer_ambiguous');
  END IF;
  SELECT count(*)::integer,
    min(b.start_time_utc),
    coalesce(sum(coalesce(b.price_cents, 0) + coalesce(b.addon_price_cents, 0)), 0)::integer
  INTO v_group_size, v_earliest_start, v_booked_value_cents
  FROM public.bookings b
  WHERE b.salon_id = p_salon_id AND b.group_id = p_group_id
    AND b.deleted_at IS NULL
    AND b.status IN ('pending', 'confirmed', 'in_progress');
  IF v_group_size < 1 OR v_earliest_start IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'group_not_cancellable');
  END IF;

  v_window_hours := CASE
    WHEN coalesce(v_salon.self_cancel_window_hours, 0) > 0
      THEN v_salon.self_cancel_window_hours
    ELSE 24
  END;
  v_notice_minutes := floor(extract(epoch FROM (
    v_earliest_start - clock_timestamp()
  )) / 60)::integer;
  v_short_notice := v_earliest_start > v_organizer.created_at
    AND v_earliest_start <= v_organizer.created_at
      + make_interval(hours => v_window_hours);
  v_grace_ends_at := CASE WHEN v_short_notice
    THEN v_organizer.created_at + interval '15 minutes'
    ELSE NULL
  END;
  v_grace_active := v_grace_ends_at IS NOT NULL
    AND clock_timestamp() <= v_grace_ends_at;
  v_within_window := v_notice_minutes > 0
    AND v_notice_minutes < v_window_hours * 60
    AND NOT v_grace_active;
  v_no_show_fee := greatest(coalesce(v_organizer.noshow_fee_cents, 0), 0);
  v_no_show_percent := greatest(coalesce(v_salon.noshow_fee_percent, 0), 0);
  v_late_percent := least(20, greatest(0, coalesce(
    v_salon.self_cancel_fee_percent, v_salon.noshow_fee_percent, 0
  )));
  v_fee_cents := CASE WHEN v_no_show_percent > 0
    THEN round(v_no_show_fee::numeric * v_late_percent::numeric
      / v_no_show_percent::numeric)
    ELSE 0
  END;
  v_policy_version := nullif(trim(coalesce(
    v_organizer.noshow_consent_meta->>'policyVersion', ''
  )), '');
  -- Consent is an upper bound, never an invitation to reprice an old booking
  -- from today's no-show denominator. Preserve the candidate; reject inflation.
  v_currency := upper(coalesce(nullif(trim(v_salon.currency_code), ''), 'CAD'));
  v_scope := v_organizer.noshow_consent_meta->>'scope';
  v_consent_valid := coalesce(jsonb_typeof(v_organizer.noshow_consent_meta->'feeCents')='number'
    AND (v_organizer.noshow_consent_meta->>'feeCents') ~ '^[0-9]{1,10}$'
    AND v_scope IN ('whole_party','booking_member')
    AND v_organizer.noshow_consent_meta->>'currency'=v_currency
    AND v_currency ~ '^[A-Z]{3}$'
    AND v_policy_version ~ '^nsp_[0-9a-f]{64}$', false);
  IF v_consent_valid THEN
    v_consent_fee := (v_organizer.noshow_consent_meta->>'feeCents')::numeric;
    v_consent_valid := v_consent_fee BETWEEN 1 AND 2147483647
      AND v_consent_fee=v_no_show_fee;
  END IF;
  v_basis := CASE WHEN v_scope='whole_party' THEN v_booked_value_cents
    WHEN v_scope='booking_member' AND v_organizer.status IN ('pending','confirmed','in_progress')
      THEN greatest(0,coalesce(v_organizer.price_cents,0)+coalesce(v_organizer.addon_price_cents,0))
    ELSE 0 END;
  v_cap := least(coalesce(v_consent_fee,0),v_no_show_fee,
    floor(v_basis*v_late_percent/100));
  v_context := public.booking_payment_provider_context(p_salon_id,'late_cancel_charge');
  SELECT * INTO v_receipt FROM public.booking_card_save_operations
    WHERE salon_id=p_salon_id AND booking_id=v_organizer.id AND mode='save_card'
    ORDER BY created_at DESC,delivery_sequence DESC,id DESC LIMIT 1;
  v_binding_valid := coalesce(v_context->>'success'='true'
    AND v_receipt.provider=v_context->>'provider'
    AND v_receipt.status='succeeded'
    AND (v_receipt.provider<>'square' OR (
      v_receipt.expected_customer_id=v_organizer.noshow_customer_id
      AND v_receipt.expected_merchant_id=v_context->'provider_material'->>'provider_account_id'
      AND v_receipt.expected_environment=v_context->'provider_material'->>'provider_environment'
    )),false);
  v_guard := jsonb_build_object(
    'version',1,'scope',v_scope,'consent_fee_cents',v_consent_fee,
    'stored_fee_cents',v_no_show_fee,'basis_cents',v_basis,'cap_cents',v_cap,
    'fee_percent',v_late_percent,'currency',v_currency,
    'consent_at',v_organizer.noshow_consent_at,
    'consent_fingerprint',encode(extensions.digest(convert_to(v_organizer.noshow_consent_meta::text,'UTF8'),'sha256'),'hex'),
    'card_fingerprint',encode(extensions.digest(convert_to(v_organizer.noshow_card_id,'UTF8'),'sha256'),'hex'),
    'customer_fingerprint',encode(extensions.digest(convert_to(v_organizer.noshow_customer_id,'UTF8'),'sha256'),'hex'),
    'receipt_id',v_receipt.id,'receipt_fingerprint',v_receipt.completion_fingerprint,
    'provider',v_context->>'provider','provider_account_fingerprint',v_context->>'provider_account_fingerprint'
  );
  v_has_card := public.booking_card_protection_state(v_organizer)='saved' AND nullif(trim(coalesce(v_organizer.noshow_card_id, '')), '') IS NOT NULL
    AND nullif(trim(coalesce(v_organizer.noshow_customer_id, '')), '') IS NOT NULL
    AND v_organizer.noshow_consent_at IS NOT NULL
    AND v_policy_version IS NOT NULL
    AND v_fee_cents > 0
    AND coalesce(v_organizer.noshow_charge_status, '') <> 'charged';
  v_reason := CASE
    WHEN coalesce(v_salon.self_cancel_fee_enabled, false) IS NOT TRUE
      THEN 'policy_disabled'
    WHEN v_notice_minutes <= 0 THEN 'appointment_started'
    WHEN v_grace_active THEN 'short_notice_grace_active'
    WHEN NOT v_within_window THEN 'outside_fee_window'
    WHEN v_fee_cents <= 0 THEN 'fee_snapshot_missing'
    WHEN NOT v_consent_valid THEN 'group_fee_consent_invalid'
    WHEN NOT v_has_card THEN 'card_or_consent_missing'
    WHEN NOT v_binding_valid THEN 'group_fee_provider_binding_changed'
    WHEN v_fee_cents > v_cap OR v_fee_cents > 2147483647 THEN 'group_fee_amount_exceeds_cap'
    ELSE 'owner_review_required'
  END;

  RETURN jsonb_build_object(
    'success', true,
    'code', 'preview_ready',
    'salon_id', p_salon_id,
    'group_id', p_group_id,
    'organizer_booking_id', v_organizer.id,
    'actor_role', v_actor_role,
    'group_size', v_group_size,
    'earliest_start_time_utc', v_earliest_start,
    'notice_minutes', v_notice_minutes,
    'window_hours', v_window_hours,
    'short_notice_booking', v_short_notice,
    'grace_active', v_grace_active,
    'grace_ends_at', v_grace_ends_at,
    'booked_value_cents', v_booked_value_cents,
    'fee_cents', CASE WHEN v_reason = 'owner_review_required'
      THEN v_fee_cents ELSE 0 END,
    'fee_snapshot_cents', v_fee_cents,
    'fee_guard',v_guard,
    'fee_percent', v_late_percent,
    'max_fee_percent', 20,
    'currency', upper(coalesce(nullif(trim(v_salon.currency_code), ''), 'CAD')),
    'has_chargeable_card', v_has_card,
    'decision_required', v_reason = 'owner_review_required',
    'can_waive', v_actor_role IN ('owner', 'admin'),
    'reason', v_reason,
    'consent_policy_version', v_policy_version,
    'card_brand', nullif(trim(coalesce(v_organizer.noshow_card_brand, '')), ''),
    'card_last4', nullif(trim(coalesce(v_organizer.noshow_card_last4, '')), '')
  );
END;
$preview_group$;


DO $patch$
DECLARE v_def text; v_anchor text;
BEGIN
  SELECT pg_get_functiondef('public.claim_approved_cancellation_fee_payment(text,uuid,uuid,uuid,text)'::regprocedure) INTO v_def;
  IF position('''provider_request_reference'', v_booking_id::text' IN v_def)=0 THEN
    RAISE EXCEPTION 'group consent cap requires durable provider reference migration';
  END IF;
  v_anchor := '  v_receipt_ok boolean := false;';
  IF (length(v_def)-length(replace(v_def,v_anchor,'')))/length(v_anchor)<>1 THEN RAISE EXCEPTION 'claim declaration anchor mismatch'; END IF;
  v_def:=replace(v_def,v_anchor,v_anchor||E'\n  v_group_guard jsonb;\n  v_group_card_receipt public.booking_card_save_operations%ROWTYPE;');
  v_anchor := $anchor$  v_context := public.booking_payment_provider_context(
    p_salon_id, 'late_cancel_charge'
  );$anchor$;
  IF (length(v_def)-length(replace(v_def,v_anchor,'')))/length(v_anchor)<>1 THEN RAISE EXCEPTION 'claim context anchor mismatch'; END IF;
  v_def:=replace(v_def,v_anchor,$newguard$  -- NEW operations only. Existing outcomes above retain their exact immutable
  -- request and reconciliation path, even when current policy has changed.
  IF p_review_kind='group' THEN
    v_group_guard := v_group.policy_snapshot->'fee_guard';
    IF coalesce(v_group_guard->>'version','')<>'1'
      OR v_group.policy_snapshot->>'salon_id' IS DISTINCT FROM p_salon_id::text
      OR v_group.policy_snapshot->>'group_id' IS DISTINCT FROM v_group.group_id::text
      OR v_group.policy_snapshot->>'organizer_booking_id' IS DISTINCT FROM v_booking.id::text
      OR v_group.policy_snapshot->>'decision_required' IS DISTINCT FROM 'true'
      OR v_group.policy_snapshot->>'reason' IS DISTINCT FROM 'owner_review_required'
      OR v_group.policy_snapshot->>'fee_cents' IS DISTINCT FROM v_amount::text
      OR v_group.policy_snapshot->>'currency' IS DISTINCT FROM v_currency
      OR v_group.policy_snapshot->>'consent_policy_version' IS DISTINCT FROM v_policy_version
      OR coalesce(v_group_guard->>'scope','') NOT IN ('whole_party','booking_member')
      OR v_group_guard->>'currency' IS DISTINCT FROM v_currency
      OR EXISTS (SELECT 1 FROM unnest(ARRAY['consent_fee_cents','stored_fee_cents','basis_cents','cap_cents','fee_percent']) k
        WHERE jsonb_typeof(v_group_guard->k) IS DISTINCT FROM 'number'
          OR coalesce(v_group_guard->>k,'') !~ '^[0-9]{1,10}$')
      OR EXISTS (SELECT 1 FROM unnest(ARRAY['consent_fingerprint','card_fingerprint','customer_fingerprint','receipt_fingerprint','provider_account_fingerprint']) k
        WHERE coalesce(v_group_guard->>k,'') !~ '^[0-9a-f]{64}$')
    THEN RETURN jsonb_build_object('success',false,'code','group_fee_snapshot_invalid'); END IF;
    IF v_group_guard->>'consent_fingerprint' IS DISTINCT FROM encode(extensions.digest(convert_to(v_booking.noshow_consent_meta::text,'UTF8'),'sha256'),'hex')
      OR v_group_guard->'consent_at' IS DISTINCT FROM to_jsonb(v_booking.noshow_consent_at)
      OR v_group_guard->>'card_fingerprint' IS DISTINCT FROM encode(extensions.digest(convert_to(v_booking.noshow_card_id,'UTF8'),'sha256'),'hex')
      OR v_group_guard->>'customer_fingerprint' IS DISTINCT FROM encode(extensions.digest(convert_to(v_booking.noshow_customer_id,'UTF8'),'sha256'),'hex')
      OR v_group_guard->>'scope' IS DISTINCT FROM v_booking.noshow_consent_meta->>'scope'
      OR v_group_guard->>'currency' IS DISTINCT FROM v_booking.noshow_consent_meta->>'currency'
      OR v_group_guard->>'consent_fee_cents' IS DISTINCT FROM v_booking.noshow_consent_meta->>'feeCents'
      OR v_policy_version IS DISTINCT FROM v_booking.noshow_consent_meta->>'policyVersion'
      OR v_group_guard->>'stored_fee_cents' IS DISTINCT FROM v_booking.noshow_fee_cents::text
    THEN RETURN jsonb_build_object('success',false,'code','group_fee_consent_changed'); END IF;
    IF (v_group_guard->>'fee_percent')::numeric NOT BETWEEN 1 AND 20
      OR (v_group_guard->>'consent_fee_cents')::numeric NOT BETWEEN 1 AND 2147483647
      OR (v_group_guard->>'stored_fee_cents')::numeric<>(v_group_guard->>'consent_fee_cents')::numeric
      OR (v_group_guard->>'basis_cents')::numeric NOT BETWEEN 1 AND 2147483647
      OR (v_group_guard->>'cap_cents')::numeric <> least(
        (v_group_guard->>'consent_fee_cents')::numeric,
        (v_group_guard->>'stored_fee_cents')::numeric,
        floor((v_group_guard->>'basis_cents')::numeric*(v_group_guard->>'fee_percent')::numeric/100))
      OR v_amount>(v_group_guard->>'cap_cents')::numeric
      OR v_group.policy_snapshot->>'fee_percent' IS DISTINCT FROM v_group_guard->>'fee_percent'
      OR v_group.policy_snapshot->>'max_fee_percent' IS DISTINCT FROM '20'
    THEN RETURN jsonb_build_object('success',false,'code','group_fee_amount_exceeds_cap'); END IF;
    SELECT * INTO v_group_card_receipt FROM public.booking_card_save_operations
      WHERE salon_id=p_salon_id AND booking_id=v_booking.id AND mode='save_card'
      ORDER BY created_at DESC,delivery_sequence DESC,id DESC LIMIT 1;
    IF v_group_guard->>'receipt_id' IS DISTINCT FROM v_group_card_receipt.id::text
      OR v_group_guard->>'receipt_fingerprint' IS DISTINCT FROM v_group_card_receipt.completion_fingerprint
    THEN RETURN jsonb_build_object('success',false,'code','group_fee_consent_changed'); END IF;
  END IF;

$newguard$||v_anchor);
  v_anchor := $anchor$  v_provider_material := v_context->'provider_material' || jsonb_build_object($anchor$;
  IF (length(v_def)-length(replace(v_def,v_anchor,'')))/length(v_anchor)<>1 THEN RAISE EXCEPTION 'claim material anchor mismatch'; END IF;
  v_def:=replace(v_def,v_anchor,$newbinding$  IF p_review_kind='group' AND (
    v_group_guard->>'provider' IS DISTINCT FROM v_context->>'provider'
    OR v_group_guard->>'provider_account_fingerprint' IS DISTINCT FROM v_context->>'provider_account_fingerprint'
    OR v_group_card_receipt.provider IS DISTINCT FROM v_context->>'provider'
    OR (v_group_card_receipt.provider='square' AND (
      v_group_card_receipt.expected_customer_id IS DISTINCT FROM v_booking.noshow_customer_id
      OR v_group_card_receipt.expected_merchant_id IS DISTINCT FROM v_context->'provider_material'->>'provider_account_id'
      OR v_group_card_receipt.expected_environment IS DISTINCT FROM v_context->'provider_material'->>'provider_environment'
    ))
  ) THEN RETURN jsonb_build_object('success',false,'code','group_fee_provider_binding_changed'); END IF;
$newbinding$||v_anchor);
  EXECUTE v_def;

  SELECT pg_get_functiondef('public.cancel_booking_group_for_desk_with_decision_truth(uuid,uuid,uuid,uuid,text,boolean,boolean,integer)'::regprocedure) INTO v_def;
  v_anchor := $anchor$    'fee_currency',v_preview->>'currency'$anchor$;
  IF (length(v_def)-length(replace(v_def,v_anchor,'')))/length(v_anchor)<>1 THEN RAISE EXCEPTION 'group cancellation result anchor mismatch'; END IF;
  v_def:=replace(v_def,v_anchor,$newreason$    'fee_reason',v_preview->>'reason',
$newreason$||v_anchor);
  EXECUTE v_def;
END;
$patch$;

REVOKE ALL ON FUNCTION public.preview_booking_group_cancellation_for_desk(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.preview_booking_group_cancellation_for_desk(uuid,uuid,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.claim_approved_cancellation_fee_payment(text,uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_approved_cancellation_fee_payment(text,uuid,uuid,uuid,text) TO service_role;
REVOKE ALL ON FUNCTION public.cancel_booking_group_for_desk_with_decision_truth(uuid,uuid,uuid,uuid,text,boolean,boolean,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_booking_group_for_desk_with_decision_truth(uuid,uuid,uuid,uuid,text,boolean,boolean,integer) TO service_role;

COMMIT;
