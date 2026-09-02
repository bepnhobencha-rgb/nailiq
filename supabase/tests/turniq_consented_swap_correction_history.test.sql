BEGIN;

DO $test$
DECLARE
  v_salon constant uuid := '33000000-0000-4000-8000-000000000001';
  v_owner constant uuid := '33000000-0000-4000-8000-000000000002';
  v_tech_a_user constant uuid := '33000000-0000-4000-8000-000000000003';
  v_tech_b_user constant uuid := '33000000-0000-4000-8000-000000000004';
  v_staff_a constant uuid := '33000000-0000-4000-8000-000000000005';
  v_staff_b constant uuid := '33000000-0000-4000-8000-000000000006';
  v_service constant uuid := '33000000-0000-4000-8000-000000000007';
  v_policy constant uuid := '33000000-0000-4000-8000-000000000008';
  v_shift_a constant uuid := '33000000-0000-4000-8000-000000000009';
  v_shift_b constant uuid := '33000000-0000-4000-8000-000000000010';
  v_swap_booking constant uuid := '33000000-0000-4000-8000-000000000011';
  v_swap_assignment constant uuid := '33000000-0000-4000-8000-000000000012';
  v_swap_receipt constant uuid := '33000000-0000-4000-8000-000000000013';
  v_swap_confirm_receipt constant uuid := '33000000-0000-4000-8000-000000000014';
  v_correction_booking constant uuid := '33000000-0000-4000-8000-000000000015';
  v_correction_assignment constant uuid := '33000000-0000-4000-8000-000000000016';
  v_correction_receipt constant uuid := '33000000-0000-4000-8000-000000000017';
  v_correction_confirm_receipt constant uuid := '33000000-0000-4000-8000-000000000018';
  v_device constant uuid := '33000000-0000-4000-8000-000000000019';
  v_business_date date :=
    (pg_catalog.transaction_timestamp() AT TIME ZONE 'America/Vancouver')::date;
  v_now timestamptz := pg_catalog.transaction_timestamp();
  v_swap_id uuid;
  v_result jsonb;
  v_blocked boolean := false;
  v_denied boolean := false;
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    (v_owner, 'turniq-m3h3-owner@example.invalid'),
    (v_tech_a_user, 'turniq-m3h3-a@example.invalid'),
    (v_tech_b_user, 'turniq-m3h3-b@example.invalid');
  INSERT INTO public.salons (id, slug, name, phone, timezone, feature_flags)
  VALUES (
    v_salon, 'turniq-m3h3-synthetic', 'TurnIQ M3H3 Synthetic',
    '+16045550106', 'America/Vancouver',
    '{"turniq_trust_engine_enabled": true}'::jsonb
  );
  INSERT INTO public.salon_members (salon_id, user_id, role) VALUES
    (v_salon, v_owner, 'owner'),
    (v_salon, v_tech_a_user, 'nail_tech'),
    (v_salon, v_tech_b_user, 'nail_tech');
  INSERT INTO public.staff (id, salon_id, name, user_id) VALUES
    (v_staff_a, v_salon, 'Synthetic Mai', v_tech_a_user),
    (v_staff_b, v_salon, 'Synthetic Lan', v_tech_b_user);
  INSERT INTO public.service_categories (slug, name_en, name_vi)
  VALUES ('other', 'Other', 'Khác')
  ON CONFLICT (slug) DO NOTHING;
  INSERT INTO public.services (
    id, salon_id, name, price_cents, duration_minutes, buffer_minutes
  ) VALUES (v_service, v_salon, 'Synthetic Classic', 7000, 30, 0);
  INSERT INTO public.turniq_policy_versions (
    id, salon_id, version, policy_name, business_timezone,
    effective_business_date, emergency_same_day, emergency_reason,
    created_by_user_id
  ) VALUES (
    v_policy, v_salon, 1, 'Synthetic swap policy', 'America/Vancouver',
    v_business_date, true, 'Synthetic local rehearsal', v_owner
  );
  INSERT INTO public.turniq_shift_sessions (
    id, salon_id, policy_version_id, staff_id, business_date, checked_in_at,
    state, queue_position, fairness_baseline_cents,
    service_credit_since_checkin_cents, turns_consumed, state_changed_at
  ) VALUES
    (v_shift_a, v_salon, v_policy, v_staff_a, v_business_date,
      v_now - interval '3 hours', 'active', 1, 0, 7000, 1,
      v_now - interval '3 hours'),
    (v_shift_b, v_salon, v_policy, v_staff_b, v_business_date,
      v_now - interval '3 hours', 'active', 2, 0, 0, 0,
      v_now - interval '3 hours');

  INSERT INTO public.bookings (
    id, salon_id, service_id, staff_id, client_name, client_phone,
    start_time_utc, end_time_utc, status, price_cents, subtotal_cents,
    tax_amount_cents, schedule_model, confirmed_at, started_at
  ) VALUES
    (v_swap_booking, v_salon, v_service, v_staff_a, 'Synthetic Swap',
      '+16045550121', v_now + interval '1 hour', v_now + interval '90 minutes',
      'confirmed', 7000, 7000, 350, 'single', v_now - interval '5 minutes', NULL),
    (v_correction_booking, v_salon, v_service, v_staff_a,
      'Synthetic Correction', '+16045550122', v_now - interval '2 hours',
      v_now - interval '90 minutes', 'completed', 7000, 7000, 350, 'single',
      v_now - interval '150 minutes', v_now - interval '140 minutes');

  INSERT INTO public.turniq_command_receipts (
    command_id, salon_id, policy_version_id, device_id, local_sequence,
    actor_user_id, actor_role, command_type, request_fingerprint,
    result_fingerprint, result_status, result, client_timestamp
  ) VALUES
    (v_swap_confirm_receipt, v_salon, v_policy, v_device, 90, v_owner,
      'owner', 'confirm', repeat('1', 64), repeat('2', 64), 'committed',
      '{}'::jsonb, v_now - interval '5 minutes'),
    (v_correction_confirm_receipt, v_salon, v_policy, v_device, 91, v_owner,
      'owner', 'confirm', repeat('3', 64), repeat('4', 64), 'committed',
      '{}'::jsonb, v_now - interval '150 minutes');

  INSERT INTO public.turniq_assignments (
    id, salon_id, policy_version_id, shift_session_id, booking_id,
    customer_request_id, recommended_staff_id, assigned_staff_id, service_id,
    decision_timestamp, decision_fingerprint, snapshot_version,
    privacy_safe_explanation, status, confirmation_kind,
    confirmation_actor_user_id, opportunity_credit_cents, turn_consumed,
    confirmed_at, started_at, completed_at, actual_service_revenue_cents,
    actual_tax_cents
  ) VALUES
    (v_swap_assignment, v_salon, v_policy, v_shift_a, v_swap_booking,
      '33000000-0000-4000-8000-000000000020', v_staff_a, v_staff_a, v_service,
      v_now - interval '10 minutes', repeat('a', 64), 'm3h3-swap',
      'Recommend Synthetic Mai: available and qualified.', 'confirmed',
      'confirmed_recommendation', v_owner, 7000, false,
      v_now - interval '5 minutes', NULL, NULL, NULL, NULL),
    (v_correction_assignment, v_salon, v_policy, v_shift_a,
      v_correction_booking, '33000000-0000-4000-8000-000000000021',
      v_staff_a, v_staff_a, v_service, v_now - interval '3 hours',
      repeat('b', 64), 'm3h3-correction',
      'Recommend Synthetic Mai: available and qualified.', 'completed',
      'confirmed_recommendation', v_owner, 7000, true,
      v_now - interval '150 minutes', v_now - interval '140 minutes',
      v_now - interval '100 minutes', 7000, 350);

  INSERT INTO public.turniq_fairness_receipts (
    id, salon_id, policy_version_id, assignment_id, command_id,
    recommended_staff_id, assigned_staff_id, service_id,
    privacy_safe_explanation, fairness_band_cents, decision_fingerprint,
    command_fingerprint, actor_user_id, actor_role, assignment_outcome
  ) VALUES
    (v_swap_receipt, v_salon, v_policy, v_swap_assignment,
      v_swap_confirm_receipt, v_staff_a, v_staff_a, v_service,
      'Recommend Synthetic Mai: available and qualified.', 2000,
      repeat('a', 64), repeat('1', 64), v_owner, 'owner',
      'confirmed_recommendation'),
    (v_correction_receipt, v_salon, v_policy, v_correction_assignment,
      v_correction_confirm_receipt, v_staff_a, v_staff_a, v_service,
      'Recommend Synthetic Mai: available and qualified.', 2000,
      repeat('b', 64), repeat('3', 64), v_owner, 'owner',
      'confirmed_recommendation');

  v_result := public.apply_turniq_swap_command_v1(
    v_salon, v_policy, v_swap_assignment, NULL, 'request_swap', v_staff_b,
    NULL, 'Mai and Lan agreed to exchange this customer before service.',
    '33000000-0000-4000-8000-000000000030', v_device, 1, v_owner, 'owner',
    repeat('5', 64), v_now
  );
  v_swap_id := (v_result ->> 'swap_id')::uuid;
  IF v_result ->> 'status' <> 'pending_consents' THEN
    RAISE EXCEPTION 'swap request did not await consent: %', v_result;
  END IF;

  BEGIN
    UPDATE public.turniq_assignments
    SET status = 'in_progress', started_at = v_now + interval '1 second',
        state_version = state_version + 1
    WHERE id = v_swap_assignment;
  EXCEPTION WHEN SQLSTATE '55000' THEN
    v_blocked := true;
  END;
  IF NOT v_blocked OR NOT EXISTS (
    SELECT 1 FROM public.turniq_assignments
    WHERE id = v_swap_assignment AND status = 'confirmed'
  ) THEN
    RAISE EXCEPTION 'pending swap did not block service start atomically';
  END IF;

  BEGIN
    PERFORM public.apply_turniq_swap_command_v1(
      v_salon, v_policy, NULL, v_swap_id, 'consent_swap', NULL, 'accepted',
      NULL, '33000000-0000-4000-8000-000000000031', v_device, 2,
      v_owner, 'owner', repeat('6', 64), v_now + interval '1 second'
    );
  EXCEPTION WHEN SQLSTATE '42501' THEN
    v_denied := true;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'owner consented on behalf of technicians';
  END IF;

  PERFORM public.apply_turniq_swap_command_v1(
    v_salon, v_policy, NULL, v_swap_id, 'consent_swap', NULL, 'accepted',
    NULL, '33000000-0000-4000-8000-000000000032', v_device, 3,
    v_tech_a_user, 'nail_tech', repeat('7', 64), v_now + interval '2 seconds'
  );
  v_result := public.apply_turniq_swap_command_v1(
    v_salon, v_policy, NULL, v_swap_id, 'consent_swap', NULL, 'accepted',
    NULL, '33000000-0000-4000-8000-000000000033', v_device, 4,
    v_tech_b_user, 'nail_tech', repeat('8', 64), v_now + interval '3 seconds'
  );
  IF v_result ->> 'status' <> 'ready' THEN
    RAISE EXCEPTION 'two consents did not ready the swap: %', v_result;
  END IF;

  v_result := public.apply_turniq_swap_command_v1(
    v_salon, v_policy, NULL, v_swap_id, 'confirm_swap', NULL, NULL, NULL,
    '33000000-0000-4000-8000-000000000034', v_device, 5,
    v_owner, 'owner', repeat('9', 64), v_now + interval '4 seconds'
  );
  IF v_result ->> 'status' <> 'applied'
     OR NOT EXISTS (
       SELECT 1 FROM public.turniq_assignments
       WHERE id = v_swap_assignment AND assigned_staff_id = v_staff_b
         AND shift_session_id = v_shift_b AND status = 'confirmed'
     ) OR NOT EXISTS (
       SELECT 1 FROM public.bookings
       WHERE id = v_swap_booking AND staff_id = v_staff_b
         AND status = 'confirmed'
     ) OR NOT EXISTS (
       SELECT 1 FROM public.turniq_fairness_receipts
       WHERE id = v_swap_receipt AND assigned_staff_id = v_staff_a
     ) THEN
    RAISE EXCEPTION 'swap did not transfer current truth and preserve receipt: %',
      v_result;
  END IF;

  v_result := public.apply_turniq_assignment_correction_v1(
    v_salon, v_policy, v_correction_assignment, v_staff_b,
    'wrong_technician', 'Lan performed the completed service; Mai was recorded.',
    '33000000-0000-4000-8000-000000000035', v_device, 6,
    v_owner, 'owner', repeat('c', 64), v_now + interval '5 seconds'
  );
  IF (v_result ->> 'turn_moved')::boolean IS NOT TRUE
     OR (v_result ->> 'opportunity_credit_moved_cents')::integer <> 7000
     OR NOT EXISTS (
       SELECT 1 FROM public.turniq_shift_sessions
       WHERE id = v_shift_a AND turns_consumed = 0
         AND service_credit_since_checkin_cents = 0
     ) OR NOT EXISTS (
       SELECT 1 FROM public.turniq_shift_sessions
       WHERE id = v_shift_b AND turns_consumed = 1
         AND service_credit_since_checkin_cents = 7000
     ) OR NOT EXISTS (
       SELECT 1 FROM public.turniq_assignments
       WHERE id = v_correction_assignment AND assigned_staff_id = v_staff_b
         AND shift_session_id = v_shift_b AND actual_service_revenue_cents = 7000
     ) OR NOT EXISTS (
       SELECT 1 FROM public.turniq_fairness_receipts
       WHERE id = v_correction_receipt AND assigned_staff_id = v_staff_a
     ) OR NOT EXISTS (
       SELECT 1 FROM public.turniq_assignment_corrections
       WHERE assignment_id = v_correction_assignment
         AND previous_staff_id = v_staff_a AND actual_staff_id = v_staff_b
         AND turn_moved AND opportunity_credit_moved_cents = 7000
     ) THEN
    RAISE EXCEPTION 'correction truth transfer mismatch: %', v_result;
  END IF;

  v_result := public.apply_turniq_assignment_correction_v1(
    v_salon, v_policy, v_correction_assignment, v_staff_b,
    'wrong_technician', 'Lan performed the completed service; Mai was recorded.',
    '33000000-0000-4000-8000-000000000035', v_device, 6,
    v_owner, 'owner', repeat('c', 64), v_now + interval '5 seconds'
  );
  IF coalesce((v_result ->> 'replayed')::boolean, false) IS NOT TRUE
     OR (SELECT count(*) FROM public.turniq_assignment_corrections
         WHERE assignment_id = v_correction_assignment) <> 1 THEN
    RAISE EXCEPTION 'correction retry was not exactly once: %', v_result;
  END IF;

  IF has_table_privilege('anon', 'public.turniq_assignment_swaps', 'SELECT')
     OR has_table_privilege(
       'authenticated', 'public.turniq_assignment_corrections', 'SELECT'
     ) OR NOT has_table_privilege(
       'service_role', 'public.turniq_assignment_swaps', 'SELECT,INSERT,UPDATE'
     ) OR has_function_privilege(
       'anon',
       'public.apply_turniq_swap_command_v1(uuid,uuid,uuid,uuid,text,uuid,text,text,uuid,uuid,bigint,uuid,text,text,timestamptz)',
       'EXECUTE'
     ) OR has_function_privilege(
       'authenticated',
       'public.apply_turniq_assignment_correction_v1(uuid,uuid,uuid,uuid,text,text,uuid,uuid,bigint,uuid,text,text,timestamptz)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'M3H3 swap/correction ACL mismatch';
  END IF;
END
$test$;

ROLLBACK;
