BEGIN;

DO $test$
DECLARE
  v_salon constant uuid := '64000000-0000-4000-8000-000000000001';
  v_owner constant uuid := '64000000-0000-4000-8000-000000000002';
  v_staff_a constant uuid := '64000000-0000-4000-8000-000000000003';
  v_staff_b constant uuid := '64000000-0000-4000-8000-000000000004';
  v_service_a constant uuid := '64000000-0000-4000-8000-000000000005';
  v_service_b constant uuid := '64000000-0000-4000-8000-000000000006';
  v_resource_a constant uuid := '64000000-0000-4000-8000-000000000007';
  v_resource_b constant uuid := '64000000-0000-4000-8000-000000000008';
  v_policy constant uuid := '64000000-0000-4000-8000-000000000009';
  v_shift_a constant uuid := '64000000-0000-4000-8000-000000000010';
  v_shift_b constant uuid := '64000000-0000-4000-8000-000000000011';
  v_device constant uuid := '64000000-0000-4000-8000-000000000012';
  v_booking_parallel constant uuid := '64000000-0000-4000-8000-000000000013';
  v_segment_parallel_a constant uuid := '64000000-0000-4000-8000-000000000014';
  v_segment_parallel_b constant uuid := '64000000-0000-4000-8000-000000000015';
  v_booking_sequential constant uuid := '64000000-0000-4000-8000-000000000016';
  v_segment_sequential_a constant uuid := '64000000-0000-4000-8000-000000000017';
  v_segment_sequential_b constant uuid := '64000000-0000-4000-8000-000000000018';
  v_business_date date :=
    (transaction_timestamp() AT TIME ZONE 'America/Vancouver')::date;
  v_start timestamptz :=
    ((transaction_timestamp() AT TIME ZONE 'America/Vancouver')::date
      + time '15:00') AT TIME ZONE 'America/Vancouver';
  v_now timestamptz := transaction_timestamp();
  v_segments jsonb;
  v_trace jsonb;
  v_result jsonb;
  v_plan uuid;
  v_assignment_a uuid;
  v_assignment_b uuid;
  v_performer_a uuid;
  v_performer_b uuid;
  v_failed boolean := false;
BEGIN
  INSERT INTO auth.users (id, email)
  VALUES (v_owner, 'turniq-m4r-owner@example.invalid');
  INSERT INTO public.salons (
    id, slug, name, phone, timezone, feature_flags, staff_capability_mode,
    resources_enabled
  ) VALUES (
    v_salon, 'turniq-m4r-synthetic', 'TurnIQ M4R Synthetic',
    '+16045550640', 'America/Vancouver',
    '{"turniq_trust_engine_enabled": true}'::jsonb, 'whitelist', true
  );
  INSERT INTO public.salon_members (salon_id, user_id, role)
  VALUES (v_salon, v_owner, 'owner');
  INSERT INTO public.turniq_rollout_controls (
    salon_id, stage, state_version, changed_by_user_id, reason
  ) VALUES (
    v_salon, 'supervised', 1, v_owner, 'Synthetic M4R local rehearsal'
  );
  INSERT INTO public.staff (id, salon_id, name) VALUES
    (v_staff_a, v_salon, 'Synthetic Mai'),
    (v_staff_b, v_salon, 'Synthetic Lan');
  INSERT INTO public.service_categories (slug, name_en, name_vi)
  VALUES ('other', 'Other', 'Khác') ON CONFLICT (slug) DO NOTHING;
  INSERT INTO public.services (
    id, salon_id, name, price_cents, duration_minutes, buffer_minutes,
    resource_requirement_mode, required_resource_kinds
  ) VALUES
    (v_service_a, v_salon, 'Synthetic Manicure', 5000, 30, 0,
      'specific', ARRAY['chair']::text[]),
    (v_service_b, v_salon, 'Synthetic Pedicure', 7000, 30, 0,
      'specific', ARRAY['chair']::text[]);
  INSERT INTO public.salon_resources (id, salon_id, name, kind) VALUES
    (v_resource_a, v_salon, 'Synthetic Chair A', 'chair'),
    (v_resource_b, v_salon, 'Synthetic Chair B', 'chair');
  INSERT INTO public.service_parallel_policies (
    salon_id, service_a_id, service_b_id, resource_mode
  ) VALUES (v_salon, v_service_a, v_service_b, 'distinct');
  INSERT INTO public.staff_services (staff_id, service_id) VALUES
    (v_staff_a, v_service_a), (v_staff_a, v_service_b),
    (v_staff_b, v_service_a), (v_staff_b, v_service_b);
  INSERT INTO public.turniq_policy_versions (
    id, salon_id, version, policy_name, business_timezone,
    effective_business_date, emergency_same_day, emergency_reason,
    created_by_user_id
  ) VALUES (
    v_policy, v_salon, 1, 'Synthetic handoff policy', 'America/Vancouver',
    v_business_date, true, 'Synthetic local rehearsal', v_owner
  );
  INSERT INTO public.turniq_shift_sessions (
    id, salon_id, policy_version_id, staff_id, business_date, checked_in_at,
    state, queue_position, state_changed_at
  ) VALUES
    (v_shift_a, v_salon, v_policy, v_staff_a, v_business_date,
      v_now - interval '2 hours', 'active', 1, v_now - interval '2 hours'),
    (v_shift_b, v_salon, v_policy, v_staff_b, v_business_date,
      v_now - interval '2 hours', 'active', 2, v_now - interval '2 hours');

  INSERT INTO public.bookings (
    id, salon_id, service_id, client_name, client_phone, start_time_utc,
    end_time_utc, status, price_cents, original_price_cents, subtotal_cents,
    tax_amount_cents, schedule_model, sequence_version
  ) VALUES (
    v_booking_parallel, v_salon, v_service_a, 'Synthetic Parallel Guest',
    '+16045550641', v_start, v_start + interval '30 minutes', 'pending',
    12000, 12000, 12000, 600, 'segments_v1', 1
  );
  INSERT INTO public.booking_service_segments (
    id, booking_id, salon_id, position, line_id, service_id, staff_id,
    resource_id, customer_start_utc, customer_end_utc, occupied_start_utc,
    occupied_end_utc, prep_minutes, service_duration_minutes,
    sequential_addon_minutes, trailing_buffer_minutes, service_name,
    staff_name, original_service_price_cents, service_pre_voucher_cents,
    addon_pre_voucher_cents, service_price_cents, addon_price_cents,
    subtotal_cents, tax_cents, total_cents, reservation_status
  ) VALUES
    (v_segment_parallel_a, v_booking_parallel, v_salon, 0,
      '64000000-0000-4000-8000-000000000101', v_service_a, v_staff_a,
      v_resource_a, v_start, v_start + interval '30 minutes', v_start,
      v_start + interval '30 minutes', 0, 30, 0, 0, 'Synthetic Manicure',
      'Synthetic Mai', 5000, 5000, 0, 5000, 0, 5000, 250, 5250, 'pending'),
    (v_segment_parallel_b, v_booking_parallel, v_salon, 1,
      '64000000-0000-4000-8000-000000000102', v_service_b, v_staff_b,
      v_resource_b, v_start, v_start + interval '30 minutes', v_start,
      v_start + interval '30 minutes', 0, 30, 0, 0, 'Synthetic Pedicure',
      'Synthetic Lan', 7000, 7000, 0, 7000, 0, 7000, 350, 7350, 'pending');

  v_segments := jsonb_build_array(
    jsonb_build_object(
      'segmentId', v_segment_parallel_a, 'serviceId', v_service_a,
      'recommendedStaffId', v_staff_a, 'shiftSessionId', v_shift_a,
      'resourceId', v_resource_a, 'startsAt', v_start,
      'releasesAt', v_start + interval '30 minutes',
      'opportunityCreditCents', 5000, 'requestedFallback', false
    ),
    jsonb_build_object(
      'segmentId', v_segment_parallel_b, 'serviceId', v_service_b,
      'recommendedStaffId', v_staff_b, 'shiftSessionId', v_shift_b,
      'resourceId', v_resource_b, 'startsAt', v_start,
      'releasesAt', v_start + interval '30 minutes',
      'opportunityCreditCents', 7000, 'requestedFallback', false
    )
  );
  v_trace := jsonb_build_array(
    jsonb_build_object('segmentId', v_segment_parallel_a, 'staffId', v_staff_a,
      'eligible', true, 'reasonCodes', jsonb_build_array('ELIGIBLE')),
    jsonb_build_object('segmentId', v_segment_parallel_a, 'staffId', v_staff_b,
      'eligible', false, 'reasonCodes', jsonb_build_array('QUEUE_POSITION')),
    jsonb_build_object('segmentId', v_segment_parallel_b, 'staffId', v_staff_b,
      'eligible', true, 'reasonCodes', jsonb_build_array('ELIGIBLE'))
  );

  v_result := public.record_turniq_handoff_plan_v1(
    v_salon, v_policy, v_booking_parallel,
    '64000000-0000-4000-8000-000000000020', v_now, repeat('a', 64),
    'm4r-parallel-v1',
    'Recommend Mai and Lan: both are qualified and appointment-safe.',
    '{"requestedFallbackCount":0,"fairnessTierCost":0}'::jsonb,
    v_trace, v_segments,
    '64000000-0000-4000-8000-000000000021', v_device, 1,
    v_owner, 'owner', repeat('b', 64), v_now
  );
  v_plan := (v_result ->> 'handoff_plan_id')::uuid;
  SELECT hp.assignment_id, hp.id INTO v_assignment_a, v_performer_a
  FROM public.turniq_handoff_performers hp
  WHERE hp.handoff_plan_id = v_plan AND hp.proposed_staff_id = v_staff_a;
  SELECT hp.assignment_id, hp.id INTO v_assignment_b, v_performer_b
  FROM public.turniq_handoff_performers hp
  WHERE hp.handoff_plan_id = v_plan AND hp.proposed_staff_id = v_staff_b;
  IF v_result ->> 'status' <> 'recommended'
     OR (SELECT count(*) FROM public.turniq_handoff_plan_items
         WHERE handoff_plan_id = v_plan) <> 2
     OR (SELECT count(*) FROM public.turniq_assignments
         WHERE handoff_plan_id = v_plan AND status = 'recommended') <> 2
     OR (SELECT status FROM public.bookings WHERE id = v_booking_parallel) <> 'pending' THEN
    RAISE EXCEPTION 'handoff recommendation mutated booking or missed ledger: %', v_result;
  END IF;

  v_result := public.record_turniq_handoff_plan_v1(
    v_salon, v_policy, v_booking_parallel,
    '64000000-0000-4000-8000-000000000020', v_now, repeat('a', 64),
    'm4r-parallel-v1',
    'Recommend Mai and Lan: both are qualified and appointment-safe.',
    '{"requestedFallbackCount":0,"fairnessTierCost":0}'::jsonb,
    v_trace, v_segments,
    '64000000-0000-4000-8000-000000000021', v_device, 1,
    v_owner, 'owner', repeat('b', 64), v_now
  );
  IF coalesce((v_result ->> 'replayed')::boolean, false) IS NOT TRUE
     OR (SELECT count(*) FROM public.turniq_handoff_plans
         WHERE booking_id = v_booking_parallel) <> 1 THEN
    RAISE EXCEPTION 'handoff recommendation was not exactly once: %', v_result;
  END IF;

  v_result := public.confirm_turniq_handoff_plan_v1(
    v_salon, v_policy, v_plan, NULL,
    '64000000-0000-4000-8000-000000000022', v_device, 2,
    v_owner, 'owner', repeat('c', 64), v_now + interval '1 second'
  );
  IF v_result ->> 'status' <> 'confirmed'
     OR jsonb_array_length(v_result -> 'fairness_receipts') <> 2
     OR (SELECT count(*) FROM public.turniq_fairness_receipts
         WHERE command_id = '64000000-0000-4000-8000-000000000022') <> 2
     OR EXISTS (
       SELECT 1 FROM public.turniq_fairness_receipts
       WHERE command_id = '64000000-0000-4000-8000-000000000022'
         AND jsonb_array_length(handoff_detail -> 'segments') <> 1
     ) THEN
    RAISE EXCEPTION 'handoff confirmation receipt truth mismatch: %', v_result;
  END IF;
  v_result := public.confirm_turniq_handoff_plan_v1(
    v_salon, v_policy, v_plan, NULL,
    '64000000-0000-4000-8000-000000000022', v_device, 2,
    v_owner, 'owner', repeat('c', 64), v_now + interval '1 second'
  );
  IF coalesce((v_result ->> 'replayed')::boolean, false) IS NOT TRUE
     OR jsonb_array_length(v_result -> 'fairness_receipts') <> 2 THEN
    RAISE EXCEPTION 'handoff confirmation replay lost receipts: %', v_result;
  END IF;

  PERFORM public.apply_turniq_handoff_performer_command_v1(
    v_salon, v_policy, v_plan, v_performer_a, 'start',
    '64000000-0000-4000-8000-000000000023', v_device, 3,
    v_owner, 'owner', repeat('d', 64), v_now + interval '2 seconds'
  );
  PERFORM public.apply_turniq_handoff_performer_command_v1(
    v_salon, v_policy, v_plan, v_performer_b, 'start',
    '64000000-0000-4000-8000-000000000024', v_device, 4,
    v_owner, 'owner', repeat('e', 64), v_now + interval '2 seconds'
  );
  v_result := public.apply_turniq_handoff_performer_command_v1(
    v_salon, v_policy, v_plan, v_performer_a, 'complete',
    '64000000-0000-4000-8000-000000000025', v_device, 5,
    v_owner, 'owner', repeat('f', 64), v_now + interval '3 seconds'
  );
  IF (SELECT status FROM public.bookings WHERE id = v_booking_parallel) <> 'in_progress'
     OR (SELECT turns_consumed FROM public.turniq_shift_sessions
         WHERE id = v_shift_a) <> 1 THEN
    RAISE EXCEPTION 'first performer incorrectly completed parent booking';
  END IF;
  v_result := public.apply_turniq_handoff_performer_command_v1(
    v_salon, v_policy, v_plan, v_performer_a, 'complete',
    '64000000-0000-4000-8000-000000000025', v_device, 5,
    v_owner, 'owner', repeat('f', 64), v_now + interval '3 seconds'
  );
  IF coalesce((v_result ->> 'replayed')::boolean, false) IS NOT TRUE
     OR (SELECT turns_consumed FROM public.turniq_shift_sessions
         WHERE id = v_shift_a) <> 1 THEN
    RAISE EXCEPTION 'complete replay duplicated a turn: %', v_result;
  END IF;
  PERFORM public.apply_turniq_handoff_performer_command_v1(
    v_salon, v_policy, v_plan, v_performer_b, 'complete',
    '64000000-0000-4000-8000-000000000026', v_device, 6,
    v_owner, 'owner', repeat('0', 64), v_now + interval '3 seconds'
  );
  IF (SELECT status FROM public.bookings WHERE id = v_booking_parallel) <> 'completed'
     OR (SELECT status FROM public.turniq_handoff_plans WHERE id = v_plan) <> 'completed'
     OR (SELECT turns_consumed FROM public.turniq_shift_sessions
         WHERE id = v_shift_a) <> 1
     OR (SELECT turns_consumed FROM public.turniq_shift_sessions
         WHERE id = v_shift_b) <> 1
     OR (SELECT service_credit_since_checkin_cents
         FROM public.turniq_shift_sessions WHERE id = v_shift_a) <> 5000
     OR (SELECT service_credit_since_checkin_cents
         FROM public.turniq_shift_sessions WHERE id = v_shift_b) <> 7000
     OR (SELECT count(*) FROM public.turniq_assignments
         WHERE handoff_plan_id = v_plan AND turn_consumed) <> 2 THEN
    RAISE EXCEPTION 'parallel handoff did not settle exact turn/credit truth';
  END IF;

  -- A sequential two-service booking by one technician consumes one turn.
  INSERT INTO public.bookings (
    id, salon_id, service_id, client_name, client_phone, start_time_utc,
    end_time_utc, status, price_cents, original_price_cents, subtotal_cents,
    tax_amount_cents, schedule_model, sequence_version
  ) VALUES (
    v_booking_sequential, v_salon, v_service_a, 'Synthetic Sequential Guest',
    '+16045550642', v_start + interval '2 hours', v_start + interval '3 hours',
    'pending', 12000, 12000, 12000, 600, 'segments_v1', 1
  );
  INSERT INTO public.booking_service_segments (
    id, booking_id, salon_id, position, line_id, service_id, staff_id,
    resource_id, customer_start_utc, customer_end_utc, occupied_start_utc,
    occupied_end_utc, prep_minutes, service_duration_minutes,
    sequential_addon_minutes, trailing_buffer_minutes, service_name,
    staff_name, original_service_price_cents, service_pre_voucher_cents,
    addon_pre_voucher_cents, service_price_cents, addon_price_cents,
    subtotal_cents, tax_cents, total_cents, reservation_status
  ) VALUES
    (v_segment_sequential_a, v_booking_sequential, v_salon, 0,
      '64000000-0000-4000-8000-000000000103', v_service_a, v_staff_a,
      v_resource_a, v_start + interval '2 hours', v_start + interval '150 minutes',
      v_start + interval '2 hours', v_start + interval '150 minutes',
      0, 30, 0, 0, 'Synthetic Manicure', 'Synthetic Mai',
      5000, 5000, 0, 5000, 0, 5000, 250, 5250, 'pending'),
    (v_segment_sequential_b, v_booking_sequential, v_salon, 1,
      '64000000-0000-4000-8000-000000000104', v_service_b, v_staff_a,
      v_resource_a, v_start + interval '150 minutes', v_start + interval '3 hours',
      v_start + interval '150 minutes', v_start + interval '3 hours',
      0, 30, 0, 0, 'Synthetic Pedicure', 'Synthetic Mai',
      7000, 7000, 0, 7000, 0, 7000, 350, 7350, 'pending');
  v_segments := jsonb_build_array(
    jsonb_build_object(
      'segmentId', v_segment_sequential_a, 'serviceId', v_service_a,
      'recommendedStaffId', v_staff_a, 'shiftSessionId', v_shift_a,
      'resourceId', v_resource_a, 'startsAt', v_start + interval '2 hours',
      'releasesAt', v_start + interval '150 minutes',
      'opportunityCreditCents', 5000, 'requestedFallback', false
    ),
    jsonb_build_object(
      'segmentId', v_segment_sequential_b, 'serviceId', v_service_b,
      'recommendedStaffId', v_staff_a, 'shiftSessionId', v_shift_a,
      'resourceId', v_resource_a, 'startsAt', v_start + interval '150 minutes',
      'releasesAt', v_start + interval '3 hours',
      'opportunityCreditCents', 7000, 'requestedFallback', false
    )
  );
  v_trace := jsonb_build_array(
    jsonb_build_object('segmentId', v_segment_sequential_a, 'staffId', v_staff_a,
      'eligible', true, 'reasonCodes', jsonb_build_array('ELIGIBLE')),
    jsonb_build_object('segmentId', v_segment_sequential_b, 'staffId', v_staff_a,
      'eligible', true, 'reasonCodes', jsonb_build_array('ELIGIBLE'))
  );

  -- The ledger must never silently rewrite an already committed segment staff.
  v_failed := false;
  BEGIN
    PERFORM public.record_turniq_handoff_plan_v1(
      v_salon, v_policy, v_booking_sequential,
      '64000000-0000-4000-8000-000000000030', v_now, repeat('1', 64),
      'm4r-sequential-v1', 'Synthetic sequential recommendation.', '{}'::jsonb,
      v_trace,
      jsonb_set(v_segments, '{0,recommendedStaffId}', to_jsonb(v_staff_b::text)),
      '64000000-0000-4000-8000-000000000031', v_device, 7,
      v_owner, 'owner', repeat('2', 64), v_now
    );
  EXCEPTION WHEN SQLSTATE '55000' THEN
    v_failed := true;
  END;
  IF NOT v_failed OR EXISTS (
    SELECT 1 FROM public.turniq_handoff_plans WHERE booking_id = v_booking_sequential
  ) THEN
    RAISE EXCEPTION 'handoff recommendation silently rewrote committed segment staff';
  END IF;

  v_result := public.record_turniq_handoff_plan_v1(
    v_salon, v_policy, v_booking_sequential,
    '64000000-0000-4000-8000-000000000032', v_now, repeat('3', 64),
    'm4r-sequential-v1', 'Synthetic sequential recommendation.', '{}'::jsonb,
    v_trace, v_segments,
    '64000000-0000-4000-8000-000000000033', v_device, 7,
    v_owner, 'owner', repeat('4', 64), v_now
  );
  v_plan := (v_result ->> 'handoff_plan_id')::uuid;
  SELECT hp.id INTO v_performer_a FROM public.turniq_handoff_performers hp
  WHERE hp.handoff_plan_id = v_plan;
  IF (SELECT count(*) FROM public.turniq_assignments
      WHERE handoff_plan_id = v_plan) <> 1
     OR (SELECT opportunity_credit_cents FROM public.turniq_handoff_performers
         WHERE id = v_performer_a) <> 12000 THEN
    RAISE EXCEPTION 'sequential performer aggregation is incorrect';
  END IF;
  PERFORM public.confirm_turniq_handoff_plan_v1(
    v_salon, v_policy, v_plan, NULL,
    '64000000-0000-4000-8000-000000000034', v_device, 8,
    v_owner, 'owner', repeat('5', 64), v_now + interval '1 second'
  );
  PERFORM public.apply_turniq_handoff_performer_command_v1(
    v_salon, v_policy, v_plan, v_performer_a, 'start',
    '64000000-0000-4000-8000-000000000035', v_device, 9,
    v_owner, 'owner', repeat('6', 64), v_now + interval '2 seconds'
  );
  PERFORM public.apply_turniq_handoff_performer_command_v1(
    v_salon, v_policy, v_plan, v_performer_a, 'complete',
    '64000000-0000-4000-8000-000000000036', v_device, 10,
    v_owner, 'owner', repeat('7', 64), v_now + interval '3 seconds'
  );
  IF (SELECT turns_consumed FROM public.turniq_shift_sessions
      WHERE id = v_shift_a) <> 2
     OR (SELECT service_credit_since_checkin_cents
         FROM public.turniq_shift_sessions WHERE id = v_shift_a) <> 17000
     OR (SELECT count(*) FROM public.turniq_fairness_receipts fr
         JOIN public.turniq_assignments a ON a.id = fr.assignment_id
         WHERE a.handoff_plan_id = v_plan) <> 1
     OR (SELECT jsonb_array_length(fr.handoff_detail -> 'segments')
         FROM public.turniq_fairness_receipts fr
         JOIN public.turniq_assignments a ON a.id = fr.assignment_id
         WHERE a.handoff_plan_id = v_plan) <> 2 THEN
    RAISE EXCEPTION 'sequential handoff consumed more than one turn or lost credit';
  END IF;

  IF has_table_privilege('anon', 'public.turniq_handoff_plans', 'SELECT')
     OR has_table_privilege('authenticated', 'public.turniq_handoff_performers', 'SELECT')
     OR has_table_privilege('authenticated', 'public.turniq_handoff_plan_items', 'INSERT')
     OR has_function_privilege(
       'authenticated',
       'public.confirm_turniq_handoff_plan_v1(uuid,uuid,uuid,text,uuid,uuid,bigint,uuid,text,text,timestamptz)',
       'EXECUTE'
     ) OR NOT has_function_privilege(
       'service_role',
       'public.confirm_turniq_handoff_plan_v1(uuid,uuid,uuid,text,uuid,uuid,bigint,uuid,text,text,timestamptz)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'TurnIQ M4R ACL boundary is unsafe';
  END IF;

  UPDATE public.turniq_rollout_controls
  SET stage = 'shadow', state_version = 2,
      reason = 'Synthetic mutation gate rehearsal', changed_at = v_now
  WHERE salon_id = v_salon;
  v_failed := false;
  BEGIN
    PERFORM public.assert_turniq_supervised_online_v1(v_salon);
  EXCEPTION WHEN SQLSTATE '42501' THEN
    v_failed := true;
  END;
  IF NOT v_failed THEN
    RAISE EXCEPTION 'TurnIQ handoff mutation was allowed in shadow stage';
  END IF;
END
$test$;

ROLLBACK;
