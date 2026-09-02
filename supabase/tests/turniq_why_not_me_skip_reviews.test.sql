BEGIN;

DO $test$
DECLARE
  v_salon_id constant uuid := '30000000-0000-4000-8000-000000000001';
  v_owner_id constant uuid := '30000000-0000-4000-8000-000000000002';
  v_tech_user_id constant uuid := '30000000-0000-4000-8000-000000000003';
  v_tech_staff_id constant uuid := '30000000-0000-4000-8000-000000000004';
  v_other_user_id constant uuid := '30000000-0000-4000-8000-000000000005';
  v_other_staff_id constant uuid := '30000000-0000-4000-8000-000000000006';
  v_recommended_staff_id constant uuid := '30000000-0000-4000-8000-000000000007';
  v_policy_id constant uuid := '30000000-0000-4000-8000-000000000008';
  v_assignment_id constant uuid := '30000000-0000-4000-8000-000000000009';
  v_dispute_command_id constant uuid := '30000000-0000-4000-8000-000000000010';
  v_denied_command_id constant uuid := '30000000-0000-4000-8000-000000000011';
  v_resolve_command_id constant uuid := '30000000-0000-4000-8000-000000000012';
  v_device_id constant uuid := '30000000-0000-4000-8000-000000000013';
  v_effective_date date :=
    (pg_catalog.transaction_timestamp() AT TIME ZONE 'America/Vancouver')::date;
  v_now timestamptz := pg_catalog.transaction_timestamp();
  v_result jsonb;
  v_dispute_id uuid;
  v_exception_id uuid;
  v_count integer;
  v_denied boolean := false;
BEGIN
  INSERT INTO auth.users (id, email)
  VALUES
    (v_owner_id, 'turniq-m3g-owner@example.invalid'),
    (v_tech_user_id, 'turniq-m3g-tech@example.invalid'),
    (v_other_user_id, 'turniq-m3g-other@example.invalid');

  INSERT INTO public.salons (
    id, slug, name, phone, timezone, feature_flags
  ) VALUES (
    v_salon_id, 'turniq-m3g-synthetic', 'TurnIQ M3G Synthetic',
    '+16045550103', 'America/Vancouver',
    '{"turniq_trust_engine_enabled": true}'::jsonb
  );

  INSERT INTO public.salon_members (salon_id, user_id, role)
  VALUES
    (v_salon_id, v_owner_id, 'owner'),
    (v_salon_id, v_tech_user_id, 'nail_tech'),
    (v_salon_id, v_other_user_id, 'nail_tech');

  INSERT INTO public.staff (id, salon_id, name, user_id)
  VALUES
    (v_tech_staff_id, v_salon_id, 'Synthetic Linh', v_tech_user_id),
    (v_other_staff_id, v_salon_id, 'Synthetic Other', v_other_user_id),
    (v_recommended_staff_id, v_salon_id, 'Synthetic Mai', NULL);

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
    recommended_staff_id, decision_timestamp, decision_fingerprint,
    snapshot_version, privacy_safe_explanation, skipped_candidates, status
  ) VALUES (
    v_assignment_id, v_salon_id, v_policy_id,
    '30000000-0000-4000-8000-000000000014', v_recommended_staff_id,
    v_now, repeat('a', 64), 'm3g-synthetic',
    'Recommend Synthetic Mai: available and appointment-safe.',
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'staffId', v_tech_staff_id,
        'eligible', false,
        'reasonCodes', pg_catalog.jsonb_build_array('SKILL_MISMATCH'),
        'queuePosition', 1,
        'rank', NULL
      )
    ),
    'recommended'
  );

  v_result := public.create_turniq_skip_dispute_v1(
    v_salon_id, v_policy_id, v_assignment_id, 'skip_reason',
    'Please review my service qualification.', v_dispute_command_id,
    v_device_id, 1, v_tech_user_id, 'nail_tech', repeat('b', 64), v_now
  );
  IF coalesce((v_result ->> 'ok')::boolean, false) IS NOT TRUE
     OR v_result ->> 'status' <> 'open' THEN
    RAISE EXCEPTION 'skip review result mismatch: %', v_result;
  END IF;
  v_dispute_id := (v_result ->> 'dispute_id')::uuid;
  v_exception_id := (v_result ->> 'exception_id')::uuid;

  IF NOT EXISTS (
    SELECT 1
    FROM public.turniq_disputes
    WHERE id = v_dispute_id
      AND target_type = 'skip_decision'
      AND fairness_receipt_id IS NULL
      AND assignment_id = v_assignment_id
      AND raised_by_staff_id = v_tech_staff_id
      AND state_version = 1
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.turniq_exceptions
    WHERE id = v_exception_id
      AND exception_type = 'staff_dispute'
      AND detail ->> 'dispute_id' = v_dispute_id::text
      AND detail ->> 'target_type' = 'skip_decision'
      AND status = 'open'
      AND state_version = 1
  ) THEN
    RAISE EXCEPTION 'skip dispute or linked exception was not committed';
  END IF;

  v_result := public.create_turniq_skip_dispute_v1(
    v_salon_id, v_policy_id, v_assignment_id, 'skip_reason',
    'Please review my service qualification.', v_dispute_command_id,
    v_device_id, 1, v_tech_user_id, 'nail_tech', repeat('b', 64), v_now
  );
  IF coalesce((v_result ->> 'replayed')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'skip review retry did not replay: %', v_result;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.turniq_disputes
  WHERE assignment_id = v_assignment_id
    AND target_type = 'skip_decision';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'skip review retry created duplicates: %', v_count;
  END IF;

  BEGIN
    PERFORM public.create_turniq_skip_dispute_v1(
      v_salon_id, v_policy_id, v_assignment_id, 'skip_reason',
      'I was not in the persisted skip trace.', v_denied_command_id,
      v_device_id, 2, v_other_user_id, 'nail_tech', repeat('c', 64), v_now
    );
  EXCEPTION
    WHEN insufficient_privilege THEN
      v_denied := true;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'technician outside persisted skip trace was not denied';
  END IF;

  v_result := public.resolve_turniq_dispute_v1(
    v_salon_id, v_policy_id, v_dispute_id, 'resolved',
    'The persisted skill configuration was reviewed with the technician.',
    v_resolve_command_id, v_device_id, 3, v_owner_id, 'owner',
    repeat('d', 64), v_now + interval '1 minute'
  );
  IF v_result ->> 'status' <> 'resolved'
     OR (v_result ->> 'state_version')::bigint <> 2
     OR NOT EXISTS (
       SELECT 1 FROM public.turniq_exceptions
       WHERE id = v_exception_id AND status = 'resolved' AND state_version = 2
     ) THEN
    RAISE EXCEPTION 'skip review did not resolve atomically: %', v_result;
  END IF;

  IF (SELECT count(*) FROM public.turniq_events
      WHERE command_id IN (v_dispute_command_id, v_resolve_command_id)) <> 4 THEN
    RAISE EXCEPTION 'expected four immutable skip review events';
  END IF;

  IF has_function_privilege(
    'anon',
    'public.create_turniq_skip_dispute_v1(uuid,uuid,uuid,text,text,uuid,uuid,bigint,uuid,text,text,timestamptz)',
    'EXECUTE'
  ) OR has_function_privilege(
    'authenticated',
    'public.create_turniq_skip_dispute_v1(uuid,uuid,uuid,text,text,uuid,uuid,bigint,uuid,text,text,timestamptz)',
    'EXECUTE'
  ) OR NOT has_function_privilege(
    'service_role',
    'public.create_turniq_skip_dispute_v1(uuid,uuid,uuid,text,text,uuid,uuid,bigint,uuid,text,text,timestamptz)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'M3G RPC ACL mismatch';
  END IF;
END
$test$;

ROLLBACK;
