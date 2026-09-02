BEGIN;

DO $test$
DECLARE
  v_salon_id constant uuid := '31000000-0000-4000-8000-000000000001';
  v_owner_id constant uuid := '31000000-0000-4000-8000-000000000002';
  v_tech_user_id constant uuid := '31000000-0000-4000-8000-000000000003';
  v_staff_unapproved constant uuid := '31000000-0000-4000-8000-000000000004';
  v_staff_emergency constant uuid := '31000000-0000-4000-8000-000000000005';
  v_staff_declined constant uuid := '31000000-0000-4000-8000-000000000006';
  v_policy_id constant uuid := '31000000-0000-4000-8000-000000000007';
  v_assignment_unapproved constant uuid := '31000000-0000-4000-8000-000000000008';
  v_assignment_emergency constant uuid := '31000000-0000-4000-8000-000000000009';
  v_assignment_declined constant uuid := '31000000-0000-4000-8000-000000000010';
  v_command_unapproved constant uuid := '31000000-0000-4000-8000-000000000011';
  v_command_emergency constant uuid := '31000000-0000-4000-8000-000000000012';
  v_command_declined constant uuid := '31000000-0000-4000-8000-000000000013';
  v_command_denied constant uuid := '31000000-0000-4000-8000-000000000014';
  v_device_id constant uuid := '31000000-0000-4000-8000-000000000015';
  v_business_date date :=
    (pg_catalog.transaction_timestamp() AT TIME ZONE 'America/Vancouver')::date;
  v_now timestamptz := pg_catalog.transaction_timestamp();
  v_result jsonb;
  v_denied boolean := false;
BEGIN
  INSERT INTO auth.users (id, email)
  VALUES
    (v_owner_id, 'turniq-m3h-owner@example.invalid'),
    (v_tech_user_id, 'turniq-m3h-tech@example.invalid');

  INSERT INTO public.salons (
    id, slug, name, phone, timezone, feature_flags
  ) VALUES (
    v_salon_id, 'turniq-m3h-synthetic', 'TurnIQ M3H Synthetic',
    '+16045550104', 'America/Vancouver',
    '{"turniq_trust_engine_enabled": true}'::jsonb
  );

  INSERT INTO public.salon_members (salon_id, user_id, role)
  VALUES
    (v_salon_id, v_owner_id, 'owner'),
    (v_salon_id, v_tech_user_id, 'nail_tech');

  INSERT INTO public.staff (id, salon_id, name, user_id)
  VALUES
    (v_staff_unapproved, v_salon_id, 'Synthetic Unapproved', v_tech_user_id),
    (v_staff_emergency, v_salon_id, 'Synthetic Emergency', NULL),
    (v_staff_declined, v_salon_id, 'Synthetic Declined', NULL);

  INSERT INTO public.turniq_policy_versions (
    id, salon_id, version, policy_name, business_timezone,
    effective_business_date, emergency_same_day, emergency_reason,
    created_by_user_id
  ) VALUES (
    v_policy_id, v_salon_id, 1, 'Synthetic refusal policy',
    'America/Vancouver', v_business_date, true,
    'Synthetic local rehearsal', v_owner_id
  );

  INSERT INTO public.turniq_shift_sessions (
    salon_id, policy_version_id, staff_id, business_date, checked_in_at,
    state, queue_position, fairness_baseline_cents, state_changed_at
  ) VALUES
    (v_salon_id, v_policy_id, v_staff_unapproved, v_business_date,
      v_now - interval '3 hours', 'active', 1, 0, v_now - interval '3 hours'),
    (v_salon_id, v_policy_id, v_staff_emergency, v_business_date,
      v_now - interval '2 hours', 'active', 2, 0, v_now - interval '2 hours'),
    (v_salon_id, v_policy_id, v_staff_declined, v_business_date,
      v_now - interval '1 hour', 'active', 3, 0, v_now - interval '1 hour');

  INSERT INTO public.turniq_assignments (
    id, salon_id, policy_version_id, customer_request_id,
    recommended_staff_id, decision_timestamp, decision_fingerprint,
    snapshot_version, privacy_safe_explanation, status
  ) VALUES
    (v_assignment_unapproved, v_salon_id, v_policy_id,
      '31000000-0000-4000-8000-000000000016', v_staff_unapproved,
      v_now, repeat('a', 64), 'm3h-unapproved',
      'Recommend Synthetic Unapproved: available and qualified.', 'recommended'),
    (v_assignment_emergency, v_salon_id, v_policy_id,
      '31000000-0000-4000-8000-000000000017', v_staff_emergency,
      v_now, repeat('b', 64), 'm3h-emergency',
      'Recommend Synthetic Emergency: available and qualified.', 'recommended'),
    (v_assignment_declined, v_salon_id, v_policy_id,
      '31000000-0000-4000-8000-000000000018', v_staff_declined,
      v_now, repeat('c', 64), 'm3h-declined',
      'Recommend Synthetic Declined: available and qualified.', 'recommended');

  v_result := public.apply_turniq_refusal_command_v1(
    v_salon_id, v_policy_id, v_assignment_unapproved,
    'unapproved_refusal', 'Technician declined an eligible customer.',
    v_command_unapproved, v_device_id, 1, v_owner_id, 'owner',
    repeat('d', 64), v_now + interval '1 second'
  );
  IF v_result ->> 'refusal_outcome' <> 'moved_to_queue_end'
     OR (v_result ->> 'queue_position')::integer <> 4
     OR NOT EXISTS (
       SELECT 1 FROM public.turniq_shift_sessions
       WHERE staff_id = v_staff_unapproved
         AND queue_position = 4 AND state = 'active'
     ) THEN
    RAISE EXCEPTION 'unapproved refusal did not move only to queue end: %', v_result;
  END IF;

  v_result := public.apply_turniq_refusal_command_v1(
    v_salon_id, v_policy_id, v_assignment_emergency,
    'illness_emergency', 'Approved illness; pause assignments safely.',
    v_command_emergency, v_device_id, 2, v_owner_id, 'owner',
    repeat('e', 64), v_now + interval '2 seconds'
  );
  IF v_result ->> 'refusal_outcome' <> 'no_penalty_temporary_hold'
     OR (v_result ->> 'queue_position')::integer <> 2
     OR v_result ->> 'shift_state' <> 'temporary_hold'
     OR NOT EXISTS (
       SELECT 1 FROM public.turniq_shift_sessions
       WHERE staff_id = v_staff_emergency
         AND queue_position = 2 AND state = 'temporary_hold'
         AND hold_reason = 'Approved illness; pause assignments safely.'
     ) THEN
    RAISE EXCEPTION 'approved emergency did not preserve position on hold: %', v_result;
  END IF;

  v_result := public.apply_turniq_refusal_command_v1(
    v_salon_id, v_policy_id, v_assignment_declined,
    'customer_declined', 'Customer chose not to use the recommendation.',
    v_command_declined, v_device_id, 3, v_owner_id, 'owner',
    repeat('f', 64), v_now + interval '3 seconds'
  );
  IF v_result ->> 'refusal_outcome' <> 'no_penalty'
     OR (v_result ->> 'queue_position')::integer <> 3
     OR v_result ->> 'shift_state' <> 'active'
     OR NOT EXISTS (
       SELECT 1 FROM public.turniq_shift_sessions
       WHERE staff_id = v_staff_declined
         AND queue_position = 3 AND state = 'active' AND state_version = 1
     ) THEN
    RAISE EXCEPTION 'customer decline penalized technician: %', v_result;
  END IF;

  v_result := public.apply_turniq_refusal_command_v1(
    v_salon_id, v_policy_id, v_assignment_declined,
    'customer_declined', 'Customer chose not to use the recommendation.',
    v_command_declined, v_device_id, 3, v_owner_id, 'owner',
    repeat('f', 64), v_now + interval '3 seconds'
  );
  IF coalesce((v_result ->> 'replayed')::boolean, false) IS NOT TRUE
     OR (SELECT count(*) FROM public.turniq_command_receipts
         WHERE command_id = v_command_declined) <> 1 THEN
    RAISE EXCEPTION 'refusal retry was not exactly-once: %', v_result;
  END IF;

  BEGIN
    PERFORM public.apply_turniq_refusal_command_v1(
      v_salon_id, v_policy_id, v_assignment_declined,
      'unapproved_refusal', 'Self-classification must not be allowed.',
      v_command_denied, v_device_id, 4, v_tech_user_id, 'nail_tech',
      repeat('1', 64), v_now + interval '4 seconds'
    );
  EXCEPTION
    WHEN insufficient_privilege THEN v_denied := true;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'technician could classify own refusal';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.turniq_assignments
    WHERE id = v_assignment_unapproved
      AND status = 'rejected'
      AND refusal_category = 'unapproved_refusal'
      AND refusal_outcome = 'moved_to_queue_end'
      AND refusal_actor_user_id = v_owner_id
  ) OR NOT EXISTS (
    SELECT 1 FROM public.turniq_assignments
    WHERE id = v_assignment_emergency
      AND refusal_category = 'illness_emergency'
      AND refusal_outcome = 'no_penalty_temporary_hold'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.turniq_assignments
    WHERE id = v_assignment_declined
      AND refusal_category = 'customer_declined'
      AND refusal_outcome = 'no_penalty'
  ) THEN
    RAISE EXCEPTION 'refusal truth was not persisted on assignments';
  END IF;

  IF (SELECT count(*) FROM public.turniq_events
      WHERE command_id IN (
        v_command_unapproved, v_command_emergency, v_command_declined
      )) <> 5 THEN
    RAISE EXCEPTION 'expected five refusal assignment/shift events';
  END IF;

  IF has_function_privilege(
    'anon',
    'public.apply_turniq_refusal_command_v1(uuid,uuid,uuid,text,text,uuid,uuid,bigint,uuid,text,text,timestamptz)',
    'EXECUTE'
  ) OR has_function_privilege(
    'authenticated',
    'public.apply_turniq_refusal_command_v1(uuid,uuid,uuid,text,text,uuid,uuid,bigint,uuid,text,text,timestamptz)',
    'EXECUTE'
  ) OR NOT has_function_privilege(
    'service_role',
    'public.apply_turniq_refusal_command_v1(uuid,uuid,uuid,text,text,uuid,uuid,bigint,uuid,text,text,timestamptz)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'M3H1 refusal RPC ACL mismatch';
  END IF;
END
$test$;

ROLLBACK;
