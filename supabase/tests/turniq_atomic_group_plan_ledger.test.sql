BEGIN;

DO $test$
DECLARE
  v_salon constant uuid := '34000000-0000-4000-8000-000000000001';
  v_owner constant uuid := '34000000-0000-4000-8000-000000000002';
  v_staff_a constant uuid := '34000000-0000-4000-8000-000000000003';
  v_staff_b constant uuid := '34000000-0000-4000-8000-000000000004';
  v_service constant uuid := '34000000-0000-4000-8000-000000000005';
  v_policy constant uuid := '34000000-0000-4000-8000-000000000006';
  v_shift_a constant uuid := '34000000-0000-4000-8000-000000000007';
  v_shift_b constant uuid := '34000000-0000-4000-8000-000000000008';
  v_resource_a constant uuid := '34000000-0000-4000-8000-000000000050';
  v_resource_b constant uuid := '34000000-0000-4000-8000-000000000051';
  v_group constant uuid := '34000000-0000-4000-8000-000000000009';
  v_booking_a constant uuid := '34000000-0000-4000-8000-000000000010';
  v_booking_b constant uuid := '34000000-0000-4000-8000-000000000011';
  v_device constant uuid := '34000000-0000-4000-8000-000000000012';
  v_recommend_cmd constant uuid := '34000000-0000-4000-8000-000000000013';
  v_confirm_cmd constant uuid := '34000000-0000-4000-8000-000000000014';
  v_stale_group constant uuid := '34000000-0000-4000-8000-000000000040';
  v_stale_booking_a constant uuid := '34000000-0000-4000-8000-000000000041';
  v_stale_booking_b constant uuid := '34000000-0000-4000-8000-000000000042';
  v_business_date date :=
    (transaction_timestamp() AT TIME ZONE 'America/Vancouver')::date;
  v_start timestamptz :=
    ((transaction_timestamp() AT TIME ZONE 'America/Vancouver')::date
      + time '15:00') AT TIME ZONE 'America/Vancouver';
  v_now timestamptz := transaction_timestamp();
  v_items jsonb;
  v_result jsonb;
  v_plan uuid;
  v_failed boolean := false;
BEGIN
  INSERT INTO auth.users (id, email)
  VALUES (v_owner, 'turniq-m4b-owner@example.invalid');
  INSERT INTO public.salons (
    id, slug, name, phone, timezone, feature_flags, staff_capability_mode
  )
  VALUES (
    v_salon, 'turniq-m4b-synthetic', 'TurnIQ M4B Synthetic',
    '+16045550141', 'America/Vancouver',
    '{"turniq_trust_engine_enabled": true}'::jsonb, 'whitelist'
  );
  INSERT INTO public.salon_members (salon_id, user_id, role)
  VALUES (v_salon, v_owner, 'owner');
  INSERT INTO public.staff (id, salon_id, name) VALUES
    (v_staff_a, v_salon, 'Synthetic Mai'),
    (v_staff_b, v_salon, 'Synthetic Lan');
  INSERT INTO public.service_categories (slug, name_en, name_vi)
  VALUES ('other', 'Other', 'Khác')
  ON CONFLICT (slug) DO NOTHING;
  INSERT INTO public.services (
    id, salon_id, name, price_cents, duration_minutes, buffer_minutes,
    resource_requirement_mode, required_resource_kinds
  ) VALUES (
    v_service, v_salon, 'Synthetic Classic', 7000, 30, 0, 'specific',
    ARRAY['chair']::text[]
  );
  INSERT INTO public.salon_resources (id, salon_id, name, kind) VALUES
    (v_resource_a, v_salon, 'Synthetic Chair A', 'chair'),
    (v_resource_b, v_salon, 'Synthetic Chair B', 'chair');
  INSERT INTO public.staff_services (staff_id, service_id) VALUES
    (v_staff_a, v_service), (v_staff_b, v_service);
  INSERT INTO public.turniq_policy_versions (
    id, salon_id, version, policy_name, business_timezone,
    effective_business_date, emergency_same_day, emergency_reason,
    created_by_user_id
  ) VALUES (
    v_policy, v_salon, 1, 'Synthetic group policy', 'America/Vancouver',
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
    end_time_utc, status, price_cents, subtotal_cents, tax_amount_cents,
    group_id, group_size, is_party_member, schedule_model
  ) VALUES
    (v_booking_a, v_salon, v_service, 'Synthetic Group A', '+16045550142',
      v_start, v_start + interval '30 minutes', 'pending', 7000, 7000, 350,
      v_group, 2, true, 'single'),
    (v_booking_b, v_salon, v_service, 'Synthetic Group B', '+16045550143',
      v_start, v_start + interval '30 minutes', 'pending', 7000, 7000, 350,
      v_group, 2, true, 'single');

  v_items := jsonb_build_array(
    jsonb_build_object(
      'taskRef', 'guest-1', 'bookingId', v_booking_a,
      'customerRequestId', '34000000-0000-4000-8000-000000000020',
      'recommendedStaffId', v_staff_a, 'resourceId', v_resource_a,
      'startsAt', v_start,
      'safeEndAt', v_start + interval '30 minutes', 'waitMinutes', 0,
      'eligibleCandidates', '[]'::jsonb, 'skippedCandidates', '[]'::jsonb,
      'internalDecisionTrace', '{"objective":"feasible-first"}'::jsonb
    ),
    jsonb_build_object(
      'taskRef', 'guest-2', 'bookingId', v_booking_b,
      'customerRequestId', '34000000-0000-4000-8000-000000000021',
      'recommendedStaffId', v_staff_b, 'resourceId', v_resource_b,
      'startsAt', v_start,
      'safeEndAt', v_start + interval '30 minutes', 'waitMinutes', 0,
      'eligibleCandidates', '[]'::jsonb, 'skippedCandidates', '[]'::jsonb,
      'internalDecisionTrace', '{"objective":"feasible-first"}'::jsonb
    )
  );

  v_result := public.record_turniq_group_plan_v1(
    v_salon, v_policy, v_group, v_now, repeat('a', 64), 'm4b-test-v1',
    'Recommend Mai and Lan: both are qualified and appointment-safe.',
    '{"feasible":true,"fairnessCost":0}'::jsonb,
    '{"minMinutes":0,"maxMinutes":5}'::jsonb, v_items,
    v_recommend_cmd, v_device, 1, v_owner, 'owner', repeat('b', 64), v_now
  );
  v_plan := (v_result ->> 'group_plan_id')::uuid;
  IF v_result ->> 'status' <> 'recommended'
     OR (SELECT count(*) FROM public.turniq_group_plan_items
         WHERE group_plan_id = v_plan) <> 2
     OR (SELECT count(*) FROM public.turniq_assignments
         WHERE assignment_group_id = v_plan AND status = 'recommended') <> 2
     OR EXISTS (SELECT 1 FROM public.bookings
                WHERE group_id = v_group AND staff_id IS NOT NULL) THEN
    RAISE EXCEPTION 'group recommendation mutated bookings or missed ledger: %',
      v_result;
  END IF;

  v_result := public.record_turniq_group_plan_v1(
    v_salon, v_policy, v_group, v_now, repeat('a', 64), 'm4b-test-v1',
    'Recommend Mai and Lan: both are qualified and appointment-safe.',
    '{"feasible":true,"fairnessCost":0}'::jsonb,
    '{"minMinutes":0,"maxMinutes":5}'::jsonb, v_items,
    v_recommend_cmd, v_device, 1, v_owner, 'owner', repeat('b', 64), v_now
  );
  IF coalesce((v_result ->> 'replayed')::boolean, false) IS NOT TRUE
     OR (SELECT count(*) FROM public.turniq_group_plans
         WHERE booking_group_id = v_group) <> 1 THEN
    RAISE EXCEPTION 'group recommendation retry was not exactly once: %', v_result;
  END IF;

  v_result := public.confirm_turniq_group_plan_v1(
    v_salon, v_policy, v_plan, NULL, v_confirm_cmd, v_device, 2,
    v_owner, 'owner', repeat('c', 64), v_now + interval '1 second'
  );
  IF v_result ->> 'status' <> 'confirmed'
     OR (SELECT count(*) FROM public.bookings
         WHERE group_id = v_group AND status = 'confirmed'
           AND staff_id IS NOT NULL AND resource_id IS NOT NULL) <> 2
     OR (SELECT count(*) FROM public.turniq_assignments
         WHERE assignment_group_id = v_plan AND status = 'confirmed') <> 2
     OR (SELECT count(*) FROM public.turniq_fairness_receipts
         WHERE command_id = v_confirm_cmd) <> 2
     OR (SELECT count(*) FROM public.turniq_events
         WHERE aggregate_type = 'group_plan' AND aggregate_id = v_plan) <> 2 THEN
    RAISE EXCEPTION 'atomic group confirmation truth mismatch: %', v_result;
  END IF;

  v_result := public.confirm_turniq_group_plan_v1(
    v_salon, v_policy, v_plan, NULL, v_confirm_cmd, v_device, 2,
    v_owner, 'owner', repeat('c', 64), v_now + interval '1 second'
  );
  IF coalesce((v_result ->> 'replayed')::boolean, false) IS NOT TRUE
     OR (SELECT count(*) FROM public.turniq_fairness_receipts
         WHERE command_id = v_confirm_cmd) <> 2 THEN
    RAISE EXCEPTION 'group confirmation retry duplicated evidence: %', v_result;
  END IF;

  BEGIN
    PERFORM public.confirm_turniq_group_plan_v1(
      v_salon, v_policy, v_plan, NULL,
      '34000000-0000-4000-8000-000000000030', v_device, 3,
      v_owner, 'owner', repeat('d', 64), v_now + interval '2 seconds'
    );
  EXCEPTION WHEN SQLSTATE '55000' THEN
    v_failed := true;
  END;
  IF NOT v_failed THEN
    RAISE EXCEPTION 'second confirmation command bypassed terminal plan state';
  END IF;

  INSERT INTO public.bookings (
    id, salon_id, service_id, client_name, client_phone, start_time_utc,
    end_time_utc, status, price_cents, subtotal_cents, tax_amount_cents,
    group_id, group_size, is_party_member, schedule_model
  ) VALUES
    (v_stale_booking_a, v_salon, v_service, 'Synthetic Stale A', '+16045550144',
      v_start + interval '1 hour', v_start + interval '90 minutes', 'pending',
      7000, 7000, 350, v_stale_group, 2, true, 'single'),
    (v_stale_booking_b, v_salon, v_service, 'Synthetic Stale B', '+16045550145',
      v_start + interval '1 hour', v_start + interval '90 minutes', 'pending',
      7000, 7000, 350, v_stale_group, 2, true, 'single');
  v_items := jsonb_build_array(
    jsonb_build_object(
      'taskRef', 'stale-1', 'bookingId', v_stale_booking_a,
      'customerRequestId', '34000000-0000-4000-8000-000000000043',
      'recommendedStaffId', v_staff_a, 'startsAt', v_start + interval '1 hour',
      'safeEndAt', v_start + interval '90 minutes',
      'eligibleCandidates', '[]'::jsonb, 'skippedCandidates', '[]'::jsonb,
      'internalDecisionTrace', '{}'::jsonb
    ),
    jsonb_build_object(
      'taskRef', 'stale-2', 'bookingId', v_stale_booking_b,
      'customerRequestId', '34000000-0000-4000-8000-000000000044',
      'recommendedStaffId', v_staff_b, 'startsAt', v_start + interval '1 hour',
      'safeEndAt', v_start + interval '90 minutes',
      'eligibleCandidates', '[]'::jsonb, 'skippedCandidates', '[]'::jsonb,
      'internalDecisionTrace', '{}'::jsonb
    )
  );
  v_result := public.record_turniq_group_plan_v1(
    v_salon, v_policy, v_stale_group, v_now, repeat('e', 64), 'm4b-stale-v1',
    'Recommend a feasible synthetic group.', '{"feasible":true}'::jsonb,
    '{"minMinutes":0,"maxMinutes":5}'::jsonb, v_items,
    '34000000-0000-4000-8000-000000000045', v_device, 4, v_owner,
    'owner', repeat('f', 64), v_now
  );
  v_plan := (v_result ->> 'group_plan_id')::uuid;
  DELETE FROM public.staff_services
  WHERE staff_id = v_staff_b AND service_id = v_service;
  v_failed := false;
  BEGIN
    PERFORM public.confirm_turniq_group_plan_v1(
      v_salon, v_policy, v_plan, NULL,
      '34000000-0000-4000-8000-000000000046', v_device, 5,
      v_owner, 'owner', repeat('0', 64), v_now + interval '3 seconds'
    );
  EXCEPTION WHEN SQLSTATE '55000' THEN
    v_failed := true;
  END;
  IF NOT v_failed
     OR EXISTS (SELECT 1 FROM public.bookings
                WHERE group_id = v_stale_group AND staff_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.turniq_assignments
                WHERE assignment_group_id = v_plan AND status <> 'recommended')
     OR EXISTS (SELECT 1 FROM public.turniq_fairness_receipts
                WHERE assignment_id IN (
                  SELECT assignment_id FROM public.turniq_group_plan_items
                  WHERE group_plan_id = v_plan
                )) THEN
    RAISE EXCEPTION 'stale member did not roll back the whole group';
  END IF;

  IF has_table_privilege('anon', 'public.turniq_group_plans', 'SELECT')
     OR has_table_privilege('authenticated', 'public.turniq_group_plans', 'SELECT')
     OR has_table_privilege('authenticated', 'public.turniq_group_plan_items', 'INSERT')
     OR has_function_privilege(
       'authenticated',
       'public.confirm_turniq_group_plan_v1(uuid,uuid,uuid,text,uuid,uuid,bigint,uuid,text,text,timestamptz)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role',
       'public.confirm_turniq_group_plan_v1(uuid,uuid,uuid,text,uuid,uuid,bigint,uuid,text,text,timestamptz)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'TurnIQ M4B ACL boundary is unsafe';
  END IF;
END
$test$;

ROLLBACK;
