\set ON_ERROR_STOP on

BEGIN;

DO $rehearsal$
DECLARE
  v_salon_id uuid := gen_random_uuid();
  v_service_id uuid := gen_random_uuid();
  v_booking_id uuid := gen_random_uuid();
  v_group_peer_id uuid := gen_random_uuid();
  v_group_id uuid := gen_random_uuid();
  v_category_slug text := 'qa-' || replace(gen_random_uuid()::text, '-', '');
  v_undo_decision_id uuid := gen_random_uuid();
  v_commit_decision_id uuid := gen_random_uuid();
  v_result jsonb;
  v_lease jsonb;
  v_lease_token uuid;
  v_count integer;
BEGIN
  INSERT INTO public.salons (id, slug, name, phone)
  VALUES (
    v_salon_id,
    'qa-no-show-' || replace(v_salon_id::text, '-', ''),
    'QA No-show Safety',
    '+16045550101'
  );
  INSERT INTO public.service_categories (slug, name_en, name_vi)
  VALUES (v_category_slug, 'QA synthetic', 'QA synthetic');
  INSERT INTO public.services (
    id, salon_id, name, price_cents, duration_minutes, category
  ) VALUES (
    v_service_id, v_salon_id, 'QA synthetic service', 2500, 30,
    v_category_slug
  );
  INSERT INTO public.bookings (
    id, salon_id, service_id, client_name, client_phone,
    start_time_utc, end_time_utc, status, group_id, group_size,
    is_party_member, booking_channel
  ) VALUES
    (
      v_booking_id, v_salon_id, v_service_id, 'QA Guest One', '+16045550102',
      clock_timestamp() - interval '2 hours',
      clock_timestamp() - interval '90 minutes',
      'confirmed', v_group_id, 2, true, 'desk'
    ),
    (
      v_group_peer_id, v_salon_id, v_service_id, 'QA Guest Two', '+16045550103',
      clock_timestamp() - interval '2 hours',
      clock_timestamp() - interval '90 minutes',
      'confirmed', v_group_id, 2, true, 'desk'
    );

  v_result := public.begin_booking_no_show_v1(
    v_undo_decision_id, v_booking_id, v_salon_id, NULL, 'demo_cookie'
  );
  IF v_result ->> 'code' <> 'decision_started'
     OR v_result ->> 'scope' <> 'booking_member' THEN
    RAISE EXCEPTION 'begin receipt failed: %', v_result;
  END IF;
  IF (SELECT status FROM public.bookings WHERE id = v_booking_id) <> 'confirmed' THEN
    RAISE EXCEPTION 'pending decision changed booking status';
  END IF;
  IF (SELECT commit_after - requested_at
        FROM public.booking_no_show_decisions
       WHERE id = v_undo_decision_id) < interval '60 seconds' THEN
    RAISE EXCEPTION 'undo window shorter than 60 seconds';
  END IF;

  v_result := public.undo_booking_no_show_v1(
    v_undo_decision_id, v_salon_id, NULL, 'demo_cookie'
  );
  IF v_result ->> 'code' <> 'decision_undone'
     OR (SELECT status FROM public.bookings WHERE id = v_booking_id) <> 'confirmed' THEN
    RAISE EXCEPTION 'undo did not preserve booking: %', v_result;
  END IF;

  v_result := public.begin_booking_no_show_v1(
    v_commit_decision_id, v_booking_id, v_salon_id, NULL, 'demo_cookie'
  );
  IF v_result ->> 'code' <> 'decision_started' THEN
    RAISE EXCEPTION 'second begin failed: %', v_result;
  END IF;
  UPDATE public.booking_no_show_decisions
     SET requested_at = clock_timestamp() - interval '61 seconds',
         commit_after = clock_timestamp() - interval '1 second',
         effects_next_attempt_at = clock_timestamp() - interval '1 second'
   WHERE id = v_commit_decision_id;

  SELECT value INTO v_result
    FROM public.finalize_due_booking_no_shows_v1(
      v_commit_decision_id, 1, v_salon_id
    ) AS value;
  IF v_result ->> 'code' <> 'decision_committed' THEN
    RAISE EXCEPTION 'finalize failed: %', v_result;
  END IF;
  IF (SELECT status FROM public.bookings WHERE id = v_booking_id) <> 'no_show'
     OR (SELECT status FROM public.bookings WHERE id = v_group_peer_id) <> 'confirmed' THEN
    RAISE EXCEPTION 'booking-member group scope failed';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.booking_payment_operations
     WHERE booking_id = v_booking_id
       AND operation_kind IN (
         'noshow_charge', 'noshow_refund',
         'late_cancel_charge', 'late_cancel_refund'
       )
  ) THEN
    RAISE EXCEPTION 'money operation was created';
  END IF;

  SELECT value INTO v_lease
    FROM public.claim_booking_no_show_effects_v1(
      v_commit_decision_id, 1, v_salon_id
    ) AS value;
  IF v_lease ->> 'code' <> 'effects_leased'
     OR v_lease ->> 'occurrence_key' <> v_commit_decision_id::text
     OR v_lease ->> 'customer_notification' <> 'suppressed_v1' THEN
    RAISE EXCEPTION 'effects lease failed: %', v_lease;
  END IF;
  v_lease_token := (v_lease ->> 'lease_token')::uuid;
  SELECT count(*) INTO v_count
    FROM public.claim_booking_no_show_effects_v1(
      v_commit_decision_id, 1, v_salon_id
    );
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'active effects lease was claimed twice';
  END IF;

  v_result := public.complete_booking_no_show_effects_v1(
    v_commit_decision_id,
    v_lease_token,
    'completed',
    'completed',
    NULL
  );
  IF v_result ->> 'effects_state' <> 'completed'
     OR v_result ->> 'customer_effect_status' <> 'suppressed_v1' THEN
    RAISE EXCEPTION 'effects completion failed: %', v_result;
  END IF;
END
$rehearsal$;

ROLLBACK;

SELECT jsonb_build_object(
  'ok', true,
  'code', 'no_show_safety_rehearsal_passed',
  'data_persisted', false,
  'provider_called', false,
  'notification_sent', false
) AS rehearsal_result;
