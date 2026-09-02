BEGIN;

DO $test$
DECLARE
  v_salon_id constant uuid := '32000000-0000-4000-8000-000000000001';
  v_owner_id constant uuid := '32000000-0000-4000-8000-000000000002';
  v_staff_id constant uuid := '32000000-0000-4000-8000-000000000003';
  v_service_id constant uuid := '32000000-0000-4000-8000-000000000004';
  v_policy_id constant uuid := '32000000-0000-4000-8000-000000000005';
  v_shift_id constant uuid := '32000000-0000-4000-8000-000000000006';
  v_original constant uuid := '32000000-0000-4000-8000-000000000007';
  v_no_turn constant uuid := '32000000-0000-4000-8000-000000000008';
  v_yes_turn constant uuid := '32000000-0000-4000-8000-000000000009';
  v_legacy_guard constant uuid := '32000000-0000-4000-8000-000000000010';
  v_missing_rule constant uuid := '32000000-0000-4000-8000-000000000011';
  v_booking_no_turn constant uuid := '32000000-0000-4000-8000-000000000012';
  v_booking_yes_turn constant uuid := '32000000-0000-4000-8000-000000000013';
  v_booking_legacy constant uuid := '32000000-0000-4000-8000-000000000014';
  v_device_id constant uuid := '32000000-0000-4000-8000-000000000015';
  v_business_date date :=
    (pg_catalog.transaction_timestamp() AT TIME ZONE 'America/Vancouver')::date;
  v_now timestamptz := pg_catalog.transaction_timestamp();
  v_result jsonb;
  v_denied boolean := false;
  v_missing_blocked boolean := false;
BEGIN
  INSERT INTO auth.users (id, email)
  VALUES (v_owner_id, 'turniq-m3h2-owner@example.invalid');

  INSERT INTO public.salons (id, slug, name, phone, timezone, feature_flags)
  VALUES (
    v_salon_id, 'turniq-m3h2-synthetic', 'TurnIQ M3H2 Synthetic',
    '+16045550105', 'America/Vancouver',
    '{"turniq_trust_engine_enabled": true}'::jsonb
  );
  INSERT INTO public.salon_members (salon_id, user_id, role)
  VALUES (v_salon_id, v_owner_id, 'owner');
  INSERT INTO public.staff (id, salon_id, name, user_id)
  VALUES (v_staff_id, v_salon_id, 'Synthetic Mai', v_owner_id);
  INSERT INTO public.service_categories (slug, name_en, name_vi)
  VALUES ('other', 'Other', 'Khác')
  ON CONFLICT (slug) DO NOTHING;
  INSERT INTO public.services (
    id, salon_id, name, price_cents, duration_minutes, buffer_minutes
  ) VALUES (
    v_service_id, v_salon_id, 'Synthetic Repair', 7000, 30, 0
  );

  INSERT INTO public.turniq_policy_versions (
    id, salon_id, version, policy_name, business_timezone,
    effective_business_date, emergency_same_day, emergency_reason,
    created_by_user_id
  ) VALUES (
    v_policy_id, v_salon_id, 1, 'Synthetic redo policy',
    'America/Vancouver', v_business_date, true,
    'Synthetic local rehearsal', v_owner_id
  );
  INSERT INTO public.turniq_policy_redo_rules (
    salon_id, policy_version_id, category, consumes_turn,
    credits_opportunity, created_by_user_id
  ) VALUES
    (v_salon_id, v_policy_id, 'quality_issue', false, false, v_owner_id),
    (v_salon_id, v_policy_id, 'customer_damage_or_change', true, true, v_owner_id),
    (v_salon_id, v_policy_id, 'warranty_or_goodwill', false, true, v_owner_id);

  INSERT INTO public.turniq_shift_sessions (
    id, salon_id, policy_version_id, staff_id, business_date,
    checked_in_at, state, queue_position, fairness_baseline_cents,
    state_changed_at
  ) VALUES (
    v_shift_id, v_salon_id, v_policy_id, v_staff_id, v_business_date,
    v_now - interval '2 hours', 'active', 1, 0, v_now - interval '2 hours'
  );

  INSERT INTO public.bookings (
    id, salon_id, service_id, client_name, client_phone,
    start_time_utc, end_time_utc, status, price_cents, subtotal_cents,
    tax_amount_cents, schedule_model
  ) VALUES
    (v_booking_no_turn, v_salon_id, v_service_id, 'Synthetic Redo A',
      '+16045550111', v_now + interval '1 hour', v_now + interval '90 minutes',
      'pending', 7000, 7000, 350, 'single'),
    (v_booking_yes_turn, v_salon_id, v_service_id, 'Synthetic Redo B',
      '+16045550112', v_now + interval '2 hours', v_now + interval '150 minutes',
      'pending', 7000, 7000, 350, 'single'),
    (v_booking_legacy, v_salon_id, v_service_id, 'Synthetic Redo C',
      '+16045550113', v_now + interval '3 hours', v_now + interval '210 minutes',
      'pending', 7000, 7000, 350, 'single');

  INSERT INTO public.turniq_assignments (
    id, salon_id, policy_version_id, shift_session_id, customer_request_id,
    recommended_staff_id, assigned_staff_id, service_id, decision_timestamp,
    decision_fingerprint, snapshot_version, privacy_safe_explanation,
    status, confirmation_kind, confirmation_actor_user_id,
    opportunity_credit_cents, turn_consumed, confirmed_at, started_at,
    completed_at
  ) VALUES (
    v_original, v_salon_id, v_policy_id, v_shift_id,
    '32000000-0000-4000-8000-000000000020', v_staff_id, v_staff_id,
    v_service_id, v_now - interval '2 hours', repeat('a', 64), 'm3h2-original',
    'Recommend Synthetic Mai: available and qualified.', 'completed',
    'confirmed_recommendation', v_owner_id, 7000, true,
    v_now - interval '110 minutes', v_now - interval '100 minutes',
    v_now - interval '70 minutes'
  );

  INSERT INTO public.turniq_assignments (
    id, salon_id, policy_version_id, booking_id, customer_request_id,
    recommended_staff_id, service_id, decision_timestamp,
    decision_fingerprint, snapshot_version, privacy_safe_explanation,
    opportunity_credit_cents, status
  ) VALUES
    (v_no_turn, v_salon_id, v_policy_id, v_booking_no_turn,
      '32000000-0000-4000-8000-000000000021', v_staff_id, v_service_id,
      v_now, repeat('b', 64), 'm3h2-no-turn',
      'Recommend Synthetic Mai: available and qualified.', 7000, 'recommended'),
    (v_yes_turn, v_salon_id, v_policy_id, v_booking_yes_turn,
      '32000000-0000-4000-8000-000000000022', v_staff_id, v_service_id,
      v_now, repeat('c', 64), 'm3h2-yes-turn',
      'Recommend Synthetic Mai: available and qualified.', 7000, 'recommended'),
    (v_legacy_guard, v_salon_id, v_policy_id, v_booking_legacy,
      '32000000-0000-4000-8000-000000000023', v_staff_id, v_service_id,
      v_now, repeat('d', 64), 'm3h2-legacy-guard',
      'Recommend Synthetic Mai: available and qualified.', 7000, 'recommended'),
    (v_missing_rule, v_salon_id, v_policy_id, NULL,
      '32000000-0000-4000-8000-000000000024', v_staff_id, v_service_id,
      v_now, repeat('e', 64), 'm3h2-missing-rule',
      'Recommend Synthetic Mai: available and qualified.', 7000, 'recommended');

  v_result := public.apply_turniq_redo_classification_v1(
    v_salon_id, v_policy_id, v_no_turn, v_original, 'quality_issue',
    'Repair under the salon quality guarantee.',
    '32000000-0000-4000-8000-000000000030', v_device_id, 1,
    v_owner_id, 'owner', repeat('1', 64), v_now + interval '1 second'
  );
  IF (v_result ->> 'redo_consumes_turn')::boolean IS NOT FALSE
     OR (v_result ->> 'redo_credits_opportunity')::boolean IS NOT FALSE THEN
    RAISE EXCEPTION 'quality redo policy outcome mismatch: %', v_result;
  END IF;

  v_result := public.apply_turniq_redo_classification_v1(
    v_salon_id, v_policy_id, v_yes_turn, v_original,
    'customer_damage_or_change', 'Customer changed the requested shape.',
    '32000000-0000-4000-8000-000000000031', v_device_id, 2,
    v_owner_id, 'owner', repeat('2', 64), v_now + interval '1 second'
  );
  IF (v_result ->> 'redo_consumes_turn')::boolean IS NOT TRUE
     OR (v_result ->> 'redo_credits_opportunity')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'customer-change redo policy outcome mismatch: %', v_result;
  END IF;

  PERFORM public.apply_turniq_redo_classification_v1(
    v_salon_id, v_policy_id, v_legacy_guard, v_original,
    'warranty_or_goodwill', 'Manager goodwill repair.',
    '32000000-0000-4000-8000-000000000032', v_device_id, 3,
    v_owner_id, 'owner', repeat('3', 64), v_now + interval '1 second'
  );

  v_result := public.apply_turniq_redo_classification_v1(
    v_salon_id, v_policy_id, v_missing_rule, v_original, 'other',
    'An uncategorized repair needs an explicit policy rule.',
    '32000000-0000-4000-8000-000000000033', v_device_id, 4,
    v_owner_id, 'owner', repeat('4', 64), v_now + interval '1 second'
  );
  IF v_result ->> 'code' <> 'policy_configuration_required'
     OR NOT EXISTS (
       SELECT 1 FROM public.turniq_exceptions
       WHERE assignment_id = v_missing_rule
         AND exception_type = 'redo_policy_missing' AND status = 'open'
     ) OR EXISTS (
       SELECT 1 FROM public.turniq_assignments
       WHERE id = v_missing_rule AND redo_category IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'missing redo policy did not fail closed: %', v_result;
  END IF;

  BEGIN
    UPDATE public.turniq_assignments
    SET shift_session_id = v_shift_id, assigned_staff_id = v_staff_id,
        status = 'confirmed', confirmation_kind = 'confirmed_recommendation',
        confirmation_actor_user_id = v_owner_id,
        confirmed_at = v_now + interval '2 seconds', state_version = state_version + 1
    WHERE id = v_missing_rule;
  EXCEPTION WHEN SQLSTATE '55000' THEN
    v_missing_blocked := true;
  END;
  IF NOT v_missing_blocked OR NOT EXISTS (
    SELECT 1 FROM public.turniq_assignments
    WHERE id = v_missing_rule AND status = 'recommended'
  ) THEN
    RAISE EXCEPTION 'missing-policy assignment could bypass classification';
  END IF;

  UPDATE public.bookings
  SET status = 'in_progress', staff_id = v_staff_id,
      confirmed_at = v_now + interval '2 seconds',
      started_at = v_now + interval '3 seconds'
  WHERE id IN (v_booking_no_turn, v_booking_yes_turn, v_booking_legacy);
  UPDATE public.turniq_assignments
  SET shift_session_id = v_shift_id, assigned_staff_id = v_staff_id,
      status = 'in_progress', confirmation_kind = 'confirmed_recommendation',
      confirmation_actor_user_id = v_owner_id,
      confirmed_at = v_now + interval '2 seconds',
      started_at = v_now + interval '3 seconds', state_version = state_version + 1
  WHERE id IN (v_no_turn, v_yes_turn, v_legacy_guard);

  v_result := public.complete_turniq_assignment_command_v2(
    v_salon_id, v_policy_id, v_no_turn,
    '32000000-0000-4000-8000-000000000034', v_device_id, 5,
    v_owner_id, 'owner', repeat('5', 64), v_now + interval '4 seconds'
  );
  IF (v_result ->> 'turn_consumed')::boolean IS NOT FALSE
     OR (v_result ->> 'opportunity_credit_applied_cents')::integer <> 0 THEN
    RAISE EXCEPTION 'no-turn completion result mismatch: %', v_result;
  END IF;

  v_result := public.complete_turniq_assignment_command_v2(
    v_salon_id, v_policy_id, v_yes_turn,
    '32000000-0000-4000-8000-000000000035', v_device_id, 6,
    v_owner_id, 'owner', repeat('6', 64), v_now + interval '5 seconds'
  );
  IF (v_result ->> 'turn_consumed')::boolean IS NOT TRUE
     OR (v_result ->> 'opportunity_credit_applied_cents')::integer <> 7000
     OR NOT EXISTS (
       SELECT 1 FROM public.turniq_shift_sessions
       WHERE id = v_shift_id AND turns_consumed = 1
         AND service_credit_since_checkin_cents = 7000
     ) THEN
    RAISE EXCEPTION 'turn-and-credit completion mismatch: %', v_result;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.turniq_assignments
    WHERE id = v_no_turn AND status = 'completed' AND NOT turn_consumed
      AND actual_service_revenue_cents = 7000
      AND redo_category = 'quality_issue'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.turniq_assignments
    WHERE id = v_yes_turn AND status = 'completed' AND turn_consumed
      AND actual_service_revenue_cents = 7000
      AND redo_category = 'customer_damage_or_change'
  ) THEN
    RAISE EXCEPTION 'redo completion did not preserve business/fairness truth';
  END IF;

  BEGIN
    PERFORM public.apply_turniq_assignment_command_v1(
      v_salon_id, v_policy_id, v_legacy_guard, 'complete', v_staff_id, NULL,
      '32000000-0000-4000-8000-000000000036', v_device_id, 7,
      v_owner_id, 'owner', repeat('7', 64), v_now + interval '6 seconds'
    );
  EXCEPTION WHEN SQLSTATE '55000' THEN
    v_denied := true;
  END;
  IF NOT v_denied OR NOT EXISTS (
    SELECT 1 FROM public.bookings
    WHERE id = v_booking_legacy AND status = 'in_progress'
  ) THEN
    RAISE EXCEPTION 'legacy completion path did not fail closed atomically';
  END IF;

  v_result := public.complete_turniq_assignment_command_v2(
    v_salon_id, v_policy_id, v_yes_turn,
    '32000000-0000-4000-8000-000000000035', v_device_id, 6,
    v_owner_id, 'owner', repeat('6', 64), v_now + interval '5 seconds'
  );
  IF coalesce((v_result ->> 'replayed')::boolean, false) IS NOT TRUE
     OR (SELECT count(*) FROM public.turniq_command_receipts
         WHERE command_id = '32000000-0000-4000-8000-000000000035') <> 1 THEN
    RAISE EXCEPTION 'redo completion retry was not exactly-once: %', v_result;
  END IF;

  IF has_table_privilege('anon', 'public.turniq_policy_redo_rules', 'SELECT')
     OR has_table_privilege(
       'authenticated', 'public.turniq_policy_redo_rules', 'SELECT'
     )
     OR NOT has_table_privilege(
       'service_role', 'public.turniq_policy_redo_rules', 'SELECT,INSERT'
     )
     OR has_function_privilege(
       'anon',
       'public.apply_turniq_redo_classification_v1(uuid,uuid,uuid,uuid,text,text,uuid,uuid,bigint,uuid,text,text,timestamptz)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.complete_turniq_assignment_command_v2(uuid,uuid,uuid,uuid,uuid,bigint,uuid,text,text,timestamptz)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'M3H2 redo policy ACL mismatch';
  END IF;
END
$test$;

ROLLBACK;
