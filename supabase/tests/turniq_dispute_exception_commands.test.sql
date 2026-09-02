BEGIN;

DO $test$
DECLARE
  v_salon_id constant uuid := '2f000000-0000-4000-8000-000000000001';
  v_owner_id constant uuid := '2f000000-0000-4000-8000-000000000002';
  v_tech_user_id constant uuid := '2f000000-0000-4000-8000-000000000003';
  v_staff_id constant uuid := '2f000000-0000-4000-8000-000000000004';
  v_policy_id constant uuid := '2f000000-0000-4000-8000-000000000005';
  v_assignment_id constant uuid := '2f000000-0000-4000-8000-000000000006';
  v_receipt_id constant uuid := '2f000000-0000-4000-8000-000000000007';
  v_confirm_command_id constant uuid := '2f000000-0000-4000-8000-000000000008';
  v_dispute_command_id constant uuid := '2f000000-0000-4000-8000-000000000009';
  v_resolve_command_id constant uuid := '2f000000-0000-4000-8000-000000000010';
  v_device_id constant uuid := '2f000000-0000-4000-8000-000000000011';
  v_general_exception_id constant uuid := '2f000000-0000-4000-8000-000000000013';
  v_ack_command_id constant uuid := '2f000000-0000-4000-8000-000000000014';
  v_exception_resolve_command_id constant uuid := '2f000000-0000-4000-8000-000000000015';
  v_effective_date date :=
    (pg_catalog.transaction_timestamp() AT TIME ZONE 'America/Vancouver')::date;
  v_now timestamptz := pg_catalog.transaction_timestamp();
  v_result jsonb;
  v_dispute_id uuid;
  v_exception_id uuid;
  v_count integer;
BEGIN
  INSERT INTO auth.users (id, email)
  VALUES
    (v_owner_id, 'turniq-m3f-owner@example.invalid'),
    (v_tech_user_id, 'turniq-m3f-tech@example.invalid');

  INSERT INTO public.salons (
    id, slug, name, phone, timezone, feature_flags
  ) VALUES (
    v_salon_id, 'turniq-m3f-synthetic', 'TurnIQ M3F Synthetic',
    '+16045550102', 'America/Vancouver',
    '{"turniq_trust_engine_enabled": true}'::jsonb
  );

  INSERT INTO public.salon_members (salon_id, user_id, role)
  VALUES
    (v_salon_id, v_owner_id, 'owner'),
    (v_salon_id, v_tech_user_id, 'nail_tech');

  INSERT INTO public.staff (id, salon_id, name, user_id)
  VALUES (v_staff_id, v_salon_id, 'Synthetic Mai', v_tech_user_id);

  INSERT INTO public.turniq_policy_versions (
    id, salon_id, version, policy_name, business_timezone,
    effective_business_date, emergency_same_day, emergency_reason,
    created_by_user_id
  ) VALUES (
    v_policy_id, v_salon_id, 1, 'Synthetic policy', 'America/Vancouver',
    v_effective_date, true, 'Synthetic local rehearsal', v_owner_id
  );

  INSERT INTO public.turniq_assignments (
    id, salon_id, policy_version_id, customer_request_id,
    recommended_staff_id, assigned_staff_id, decision_timestamp,
    decision_fingerprint, snapshot_version, privacy_safe_explanation,
    status, confirmation_kind, confirmation_actor_user_id, confirmed_at
  ) VALUES (
    v_assignment_id, v_salon_id, v_policy_id,
    '2f000000-0000-4000-8000-000000000012', v_staff_id, v_staff_id,
    v_now, repeat('a', 64), 'm3f-synthetic',
    'Recommend Synthetic Mai: available and safe.', 'confirmed',
    'confirmed_recommendation', v_owner_id, v_now
  );

  INSERT INTO public.turniq_command_receipts (
    command_id, salon_id, policy_version_id, device_id, local_sequence,
    actor_user_id, actor_role, command_type, request_fingerprint,
    result_fingerprint, result_status, result, client_timestamp
  ) VALUES (
    v_confirm_command_id, v_salon_id, v_policy_id, v_device_id, 1,
    v_owner_id, 'owner', 'confirm', repeat('b', 64), repeat('c', 64),
    'committed', '{"ok":true}'::jsonb, v_now
  );

  INSERT INTO public.turniq_fairness_receipts (
    id, salon_id, policy_version_id, assignment_id, command_id,
    recommended_staff_id, assigned_staff_id, privacy_safe_explanation,
    fairness_band_cents, decision_fingerprint, command_fingerprint,
    actor_user_id, actor_role, assignment_outcome
  ) VALUES (
    v_receipt_id, v_salon_id, v_policy_id, v_assignment_id,
    v_confirm_command_id, v_staff_id, v_staff_id,
    'Recommend Synthetic Mai: available and safe.', 2000,
    repeat('a', 64), repeat('b', 64), v_owner_id, 'owner',
    'confirmed_recommendation'
  );

  v_result := public.create_turniq_dispute_v1(
    v_salon_id, v_policy_id, v_receipt_id, 'assignment',
    'Please review the recorded assignment.', v_dispute_command_id,
    v_device_id, 2, v_tech_user_id, 'nail_tech', repeat('d', 64), v_now
  );
  IF coalesce((v_result ->> 'ok')::boolean, false) IS NOT TRUE
     OR v_result ->> 'status' <> 'open' THEN
    RAISE EXCEPTION 'dispute result mismatch: %', v_result;
  END IF;
  v_dispute_id := (v_result ->> 'dispute_id')::uuid;
  v_exception_id := (v_result ->> 'exception_id')::uuid;

  IF NOT EXISTS (
    SELECT 1 FROM public.turniq_disputes
    WHERE id = v_dispute_id AND raised_by_staff_id = v_staff_id
      AND fairness_receipt_id = v_receipt_id AND state_version = 1
  ) OR NOT EXISTS (
    SELECT 1 FROM public.turniq_exceptions
    WHERE id = v_exception_id AND exception_type = 'staff_dispute'
      AND detail ->> 'dispute_id' = v_dispute_id::text
      AND status = 'open' AND state_version = 1
  ) THEN
    RAISE EXCEPTION 'dispute or linked exception was not committed';
  END IF;

  v_result := public.create_turniq_dispute_v1(
    v_salon_id, v_policy_id, v_receipt_id, 'assignment',
    'Please review the recorded assignment.', v_dispute_command_id,
    v_device_id, 2, v_tech_user_id, 'nail_tech', repeat('d', 64), v_now
  );
  IF coalesce((v_result ->> 'replayed')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'dispute retry did not replay: %', v_result;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.turniq_disputes
  WHERE fairness_receipt_id = v_receipt_id;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'dispute retry created duplicates: %', v_count;
  END IF;

  v_result := public.resolve_turniq_dispute_v1(
    v_salon_id, v_policy_id, v_dispute_id, 'resolved',
    'Receipt and event history reviewed with the technician.',
    v_resolve_command_id, v_device_id, 3, v_owner_id, 'owner',
    repeat('e', 64), v_now + interval '1 minute'
  );
  IF v_result ->> 'status' <> 'resolved'
     OR (v_result ->> 'state_version')::bigint <> 2 THEN
    RAISE EXCEPTION 'resolution result mismatch: %', v_result;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.turniq_disputes
    WHERE id = v_dispute_id AND status = 'resolved' AND state_version = 2
  ) OR NOT EXISTS (
    SELECT 1 FROM public.turniq_exceptions
    WHERE id = v_exception_id AND status = 'resolved' AND state_version = 2
  ) THEN
    RAISE EXCEPTION 'dispute and exception did not resolve atomically';
  END IF;

  IF (SELECT count(*) FROM public.turniq_events
      WHERE command_id IN (v_dispute_command_id, v_resolve_command_id)) <> 4 THEN
    RAISE EXCEPTION 'expected four immutable dispute/exception events';
  END IF;

  INSERT INTO public.turniq_exceptions (
    id, salon_id, policy_version_id, assignment_id, exception_type,
    privacy_safe_summary, recommended_action
  ) VALUES (
    v_general_exception_id, v_salon_id, v_policy_id, v_assignment_id,
    'appointment_risk', 'Synthetic appointment risk.',
    'Review the assignment safety.'
  );

  v_result := public.apply_turniq_exception_command_v1(
    v_salon_id, v_policy_id, v_general_exception_id,
    'acknowledge_exception', NULL, v_ack_command_id, v_device_id, 4,
    v_owner_id, 'owner', repeat('f', 64), v_now + interval '2 minutes'
  );
  IF v_result ->> 'status' <> 'acknowledged'
     OR (v_result ->> 'state_version')::bigint <> 2 THEN
    RAISE EXCEPTION 'exception acknowledge mismatch: %', v_result;
  END IF;

  v_result := public.apply_turniq_exception_command_v1(
    v_salon_id, v_policy_id, v_general_exception_id,
    'resolve_exception', 'Assignment safety was reviewed and cleared.',
    v_exception_resolve_command_id, v_device_id, 5, v_owner_id, 'owner',
    repeat('1', 64), v_now + interval '3 minutes'
  );
  IF v_result ->> 'status' <> 'resolved'
     OR (v_result ->> 'state_version')::bigint <> 3
     OR NOT EXISTS (
       SELECT 1 FROM public.turniq_events
       WHERE aggregate_id = v_general_exception_id
         AND event_type = 'exception_resolved'
         AND aggregate_version = 3
     ) THEN
    RAISE EXCEPTION 'exception resolution mismatch: %', v_result;
  END IF;

  IF has_function_privilege(
    'anon',
    'public.create_turniq_dispute_v1(uuid,uuid,uuid,text,text,uuid,uuid,bigint,uuid,text,text,timestamptz)',
    'EXECUTE'
  ) OR has_function_privilege(
    'authenticated',
    'public.resolve_turniq_dispute_v1(uuid,uuid,uuid,text,text,uuid,uuid,bigint,uuid,text,text,timestamptz)',
    'EXECUTE'
  ) OR NOT has_function_privilege(
    'service_role',
    'public.apply_turniq_exception_command_v1(uuid,uuid,uuid,text,text,uuid,uuid,bigint,uuid,text,text,timestamptz)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'M3F RPC ACL mismatch';
  END IF;
END
$test$;

ROLLBACK;
