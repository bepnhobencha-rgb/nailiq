\set ON_ERROR_STOP on

DO $$
DECLARE v_def text;
BEGIN
  SELECT pg_get_constraintdef(oid,true) INTO v_def FROM pg_constraint
  WHERE conrelid='public.bookings'::regclass AND conname='bookings_no_overlap' AND contype='x';
  IF v_def IS NULL OR v_def NOT LIKE '%salon_id WITH =%staff_id WITH =%tstzrange(start_time_utc, end_time_utc%WITH &&%'
     OR v_def NOT LIKE '%schedule_model = ''single''%' THEN
    RAISE EXCEPTION 'single-booking staff exclusion drifted: %',v_def;
  END IF;
  SELECT pg_get_constraintdef(oid,true) INTO v_def FROM pg_constraint
  WHERE conrelid='public.bookings'::regclass AND conname='bookings_resource_no_overlap' AND contype='x';
  IF v_def IS NULL OR v_def NOT LIKE '%salon_id WITH =%resource_id WITH =%tstzrange(start_time_utc, end_time_utc%WITH &&%'
     OR v_def NOT LIKE '%resource_id IS NOT NULL%' THEN
    RAISE EXCEPTION 'single-booking resource exclusion drifted: %',v_def;
  END IF;
  SELECT pg_get_constraintdef(oid,true) INTO v_def FROM pg_constraint
  WHERE conrelid='public.booking_service_segments'::regclass
    AND conname='booking_service_segments_staff_no_overlap' AND contype='x';
  IF v_def IS NULL OR v_def NOT LIKE '%salon_id WITH =%staff_id WITH =%tstzrange(occupied_start_utc, occupied_end_utc%WITH &&%' THEN
    RAISE EXCEPTION 'sequence staff exclusion drifted: %',v_def;
  END IF;
  SELECT pg_get_constraintdef(oid,true) INTO v_def FROM pg_constraint
  WHERE conrelid='public.booking_service_segments'::regclass
    AND conname='booking_service_segments_resource_no_overlap' AND contype='x';
  IF v_def IS NULL OR v_def NOT LIKE '%salon_id WITH =%resource_id WITH =%tstzrange(occupied_start_utc, occupied_end_utc%WITH &&%' THEN
    RAISE EXCEPTION 'sequence resource exclusion drifted: %',v_def;
  END IF;

  IF NOT EXISTS(
    SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='bookings'
      AND indexname='idx_bookings_public_idempotency_once'
      AND indexdef LIKE 'CREATE UNIQUE INDEX%salon_id, idempotency_key%'
  ) OR NOT EXISTS(
    SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='bookings'
      AND indexname='idx_bookings_group_idempotency_once'
      AND indexdef LIKE 'CREATE UNIQUE INDEX%salon_id, idempotency_key%'
  ) OR NOT EXISTS(
    SELECT 1 FROM pg_constraint WHERE conrelid='public.booking_service_segments'::regclass
      AND conname='booking_service_segments_booking_id_line_id_key' AND contype='u'
  ) THEN
    RAISE EXCEPTION 'booking idempotency/segment uniqueness contract drifted';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='create_public_booking' AND pg_get_function_identity_arguments(p.oid) LIKE '%p_expected_pricing_fingerprint text';
  IF v_def NOT LIKE '%pg_advisory_xact_lock%' OR v_def NOT LIKE '%public-booking-idempotency:%'
     OR v_def NOT LIKE '%WHEN exclusion_violation THEN%' OR v_def NOT LIKE '%slot_conflict%' THEN
    RAISE EXCEPTION 'single create idempotency/overlap handling drifted';
  END IF;
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='create_group_bookings';
  IF v_def NOT LIKE '%pg_advisory_xact_lock%' OR v_def NOT LIKE '%group-booking-idempotency:%'
     OR v_def NOT LIKE '%WHEN exclusion_violation THEN%' THEN
    RAISE EXCEPTION 'group create idempotency/overlap handling drifted';
  END IF;
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='create_public_booking_sequence';
  IF v_def NOT LIKE '%pg_advisory_xact_lock%' OR v_def NOT LIKE '%booking-sequence-idempotency:%'
     OR v_def NOT LIKE '%WHEN exclusion_violation THEN%' THEN
    RAISE EXCEPTION 'sequence create idempotency/overlap handling drifted';
  END IF;
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='create_public_booking_for_desk_with_staff_notification';
  IF v_def NOT LIKE '%public.create_public_booking(%' OR v_def NOT LIKE '%p_idempotency_key%'
     OR v_def NOT LIKE '%idempotency_mismatch%' THEN
    RAISE EXCEPTION 'desk wrapper no longer delegates to canonical idempotent create';
  END IF;
END $$;

SELECT 'PASS no-duplicate appointment constraint/idempotency boundary' AS result;
