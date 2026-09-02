BEGIN;

DO $test$
DECLARE
  v_salon_id constant uuid := '10000000-0000-4000-8000-000000000001';
  v_user_id constant uuid := '10000000-0000-4000-8000-000000000002';
  v_staff_id constant uuid := '10000000-0000-4000-8000-000000000003';
  v_policy_id constant uuid := '10000000-0000-4000-8000-000000000004';
  v_old_shift_id constant uuid := '10000000-0000-4000-8000-000000000005';
  v_command_id constant uuid := '10000000-0000-4000-8000-000000000006';
  v_device_id constant uuid := '10000000-0000-4000-8000-000000000007';
  v_duplicate_command_id constant uuid := '10000000-0000-4000-8000-000000000008';
  v_effective_date date :=
    (pg_catalog.transaction_timestamp() AT TIME ZONE 'America/Vancouver')::date;
  v_next_day_at timestamptz;
  v_result jsonb;
  v_new_shift_id uuid;
  v_count integer;
BEGIN
  v_next_day_at := ((v_effective_date + 1)::timestamp + interval '20 hours') AT TIME ZONE 'UTC';

  INSERT INTO auth.users (id, email)
  VALUES (v_user_id, 'turniq-m3e@example.invalid');

  INSERT INTO public.salons (
    id, slug, name, phone, timezone, feature_flags
  ) VALUES (
    v_salon_id,
    'turniq-m3e-rollover',
    'TurnIQ M3E Synthetic',
    '+16045550101',
    'America/Vancouver',
    '{"turniq_trust_engine_enabled": true}'::jsonb
  );

  INSERT INTO public.salon_members (salon_id, user_id, role)
  VALUES (v_salon_id, v_user_id, 'nail_tech');

  INSERT INTO public.staff (id, salon_id, name, user_id)
  VALUES (v_staff_id, v_salon_id, 'Synthetic Mai', v_user_id);

  INSERT INTO public.turniq_policy_versions (
    id, salon_id, version, policy_name, business_timezone,
    effective_business_date, emergency_same_day, emergency_reason,
    created_by_user_id
  ) VALUES (
    v_policy_id, v_salon_id, 1, 'Synthetic policy', 'America/Vancouver',
    v_effective_date, true, 'Synthetic local rehearsal', v_user_id
  );

  INSERT INTO public.turniq_shift_sessions (
    id, salon_id, policy_version_id, staff_id, business_date,
    checked_in_at, state, queue_position, state_changed_at
  ) VALUES (
    v_old_shift_id, v_salon_id, v_policy_id, v_staff_id, v_effective_date,
    (v_effective_date::timestamp + interval '16 hours') AT TIME ZONE 'UTC',
    'active', 1,
    (v_effective_date::timestamp + interval '16 hours') AT TIME ZONE 'UTC'
  );

  v_result := public.apply_turniq_shift_command_v1(
    v_salon_id,
    v_policy_id,
    v_staff_id,
    'check_in',
    NULL,
    v_command_id,
    v_device_id,
    1,
    v_user_id,
    'nail_tech',
    repeat('a', 64),
    v_next_day_at
  );

  IF coalesce((v_result ->> 'ok')::boolean, false) IS NOT TRUE
     OR (v_result ->> 'business_date')::date <> v_effective_date + 1
     OR v_result ->> 'state' <> 'active'
     OR (v_result ->> 'queue_position')::integer <> 1 THEN
    RAISE EXCEPTION 'new-day check-in result mismatch: %', v_result;
  END IF;
  v_new_shift_id := (v_result ->> 'shift_session_id')::uuid;

  SELECT count(*) INTO v_count
  FROM public.turniq_shift_sessions
  WHERE salon_id = v_salon_id;
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'expected two durable shifts, found %', v_count;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.turniq_shift_sessions
    WHERE id = v_old_shift_id
      AND state = 'checked_out'
      AND checked_out_at = v_next_day_at
      AND state_version = 2
  ) THEN
    RAISE EXCEPTION 'earlier open shift was not closed atomically';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.turniq_events
    WHERE aggregate_id = v_old_shift_id
      AND event_type = 'shift_business_day_closed'
      AND policy_version_id = v_policy_id
      AND command_id IS NULL
  ) THEN
    RAISE EXCEPTION 'rollover event is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.turniq_events
    WHERE aggregate_id = v_new_shift_id
      AND event_type = 'shift_checked_in'
      AND command_id = v_command_id
  ) THEN
    RAISE EXCEPTION 'new check-in event is missing';
  END IF;

  v_result := public.apply_turniq_shift_command_v1(
    v_salon_id,
    v_policy_id,
    v_staff_id,
    'check_in',
    NULL,
    v_command_id,
    v_device_id,
    1,
    v_user_id,
    'nail_tech',
    repeat('a', 64),
    v_next_day_at
  );
  IF coalesce((v_result ->> 'replayed')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'retry did not return the committed receipt: %', v_result;
  END IF;

  BEGIN
    PERFORM public.apply_turniq_shift_command_v1(
      v_salon_id,
      v_policy_id,
      v_staff_id,
      'check_in',
      NULL,
      v_duplicate_command_id,
      v_device_id,
      2,
      v_user_id,
      'nail_tech',
      repeat('b', 64),
      v_next_day_at + interval '1 minute'
    );
    RAISE EXCEPTION 'same-day duplicate check-in unexpectedly succeeded';
  EXCEPTION
    WHEN SQLSTATE '55000' THEN
      NULL;
  END;

  SELECT count(*) INTO v_count
  FROM public.turniq_shift_sessions
  WHERE salon_id = v_salon_id;
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'retry or duplicate created extra shifts: %', v_count;
  END IF;

  IF has_function_privilege(
    'anon',
    'public.apply_turniq_shift_command_v1(uuid,uuid,uuid,text,text,uuid,uuid,bigint,uuid,text,text,timestamptz)',
    'EXECUTE'
  ) OR has_function_privilege(
    'authenticated',
    'public.apply_turniq_shift_command_v1(uuid,uuid,uuid,text,text,uuid,uuid,bigint,uuid,text,text,timestamptz)',
    'EXECUTE'
  ) OR NOT has_function_privilege(
    'service_role',
    'public.apply_turniq_shift_command_v1(uuid,uuid,uuid,text,text,uuid,uuid,bigint,uuid,text,text,timestamptz)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'shift RPC ACL mismatch';
  END IF;
END
$test$;

ROLLBACK;
