\set ON_ERROR_STOP on

-- Local-only transactional rehearsal for the durable Square booking writeback.
-- It makes no provider request and leaves no fixture or schema change behind.
BEGIN;
SELECT set_config('request.jwt.claim.role', 'service_role', true);

DO $rehearsal$
DECLARE
  v_salon constant uuid := '86360000-0000-4000-8000-000000000001';
  v_service constant uuid := '86360000-0000-4000-8000-000000000002';
  v_staff constant uuid := '86360000-0000-4000-8000-000000000003';
  v_booking_one constant uuid := '86360000-0000-4000-8000-000000000004';
  v_booking_two constant uuid := '86360000-0000-4000-8000-000000000005';
  v_team_member constant text := 'square-team-member-8636';
  v_variation constant text := 'square-variation-8636';
  v_provider_booking constant text := 'square-booking-8636';
  v_provider_customer constant text := 'square-customer-8636';
  v_original_location constant text := 'square-location-8636';
  v_contact_one text;
  v_contact_two text;
  v_result jsonb;
  v_operation_one uuid;
  v_operation_two uuid;
  v_attempt_one uuid;
  v_attempt_two uuid;
  v_material_fingerprint_one text;
  v_material_fingerprint_two text;
BEGIN
  INSERT INTO public.service_categories(slug, name_en, name_vi)
  VALUES (
    'square-writeback-rehearsal-36000',
    'Square writeback rehearsal',
    'Square writeback rehearsal'
  );
  INSERT INTO public.salons(id, slug, name, phone, timezone, currency_code)
  VALUES (
    v_salon,
    'square-writeback-rehearsal-36000',
    'Square writeback rehearsal',
    '+16045558636',
    'America/Vancouver',
    'CAD'
  );
  INSERT INTO public.services(
    id, salon_id, name, price_cents, duration_minutes, category,
    square_catalog_item_id
  ) VALUES (
    v_service, v_salon, '101 - Signature Gel', 5500, 30,
    'square-writeback-rehearsal-36000', 'square-item-8636'
  );
  INSERT INTO public.staff(id, salon_id, name, square_team_member_id)
  VALUES (v_staff, v_salon, 'Square rehearsal staff', v_team_member);
  INSERT INTO public.square_integrations(
    salon_id, merchant_id, location_id, access_token, enabled,
    application_id, environment, sync_push_create
  ) VALUES (
    v_salon, 'square-merchant-8636', v_original_location,
    'local-rehearsal-token-never-sent', true,
    'square-application-8636', 'sandbox', true
  );
  INSERT INTO public.bookings(
    id, salon_id, service_id, staff_id, client_name, client_phone,
    client_email, start_time_utc, end_time_utc, status, booking_channel,
    idempotency_key
  ) VALUES
  (
    v_booking_one, v_salon, v_service, v_staff, 'Private Square QA One',
    '+16045558637', 'private-square-one@nailiq.invalid',
    date_trunc('hour', now()) + interval '20 days',
    date_trunc('hour', now()) + interval '20 days 30 minutes',
    'confirmed', 'online', v_booking_one
  ),
  (
    v_booking_two, v_salon, v_service, v_staff, 'Private Square QA Two',
    '+16045558638', 'private-square-two@nailiq.invalid',
    date_trunc('hour', now()) + interval '20 days 2 hours',
    date_trunc('hour', now()) + interval '20 days 2 hours 30 minutes',
    'confirmed', 'online', v_booking_two
  );

  v_contact_one := public.square_booking_writeback_contact_fingerprint(
    'Private Square QA One', '+16045558637',
    'private-square-one@nailiq.invalid'
  );
  v_contact_two := public.square_booking_writeback_contact_fingerprint(
    'Private Square QA Two', '+16045558638',
    'private-square-two@nailiq.invalid'
  );

  v_result := public.claim_square_booking_writeback(
    v_salon, v_booking_one, v_team_member, v_variation, 17,
    v_contact_one, '2024-12-18'
  );
  IF v_result ->> 'code' <> 'operation_claimed'
     OR v_result -> 'material' ->> 'service_mapping_basis' <> 'signaturegel'
     OR v_result ->> 'customer_idempotency_key'
        <> 'sqcust:' || v_booking_one::text
     OR v_result ->> 'booking_idempotency_key'
        <> 'create:' || v_booking_one::text THEN
    RAISE EXCEPTION 'initial claim or stable identity failed: %', v_result;
  END IF;
  v_operation_one := (v_result ->> 'operation_id')::uuid;
  v_attempt_one := (v_result ->> 'attempt_token')::uuid;
  v_material_fingerprint_one := v_result ->> 'material_fingerprint';

  IF EXISTS (
    SELECT 1
    FROM public.square_booking_writeback_operations o
    WHERE o.id = v_operation_one
      AND (
        row_to_json(o)::text ILIKE '%Private Square QA One%'
        OR row_to_json(o)::text ILIKE '%private-square-one%'
        OR row_to_json(o)::text LIKE '%16045558637%'
        OR row_to_json(o)::text ILIKE '%local-rehearsal-token-never-sent%'
      )
  ) THEN
    RAISE EXCEPTION 'operation row retained raw contact data or provider secret';
  END IF;

  v_result := public.claim_square_booking_writeback(
    v_salon, v_booking_one, v_team_member, v_variation, 17,
    v_contact_one, '2024-12-18'
  );
  IF v_result ->> 'code' <> 'operation_in_flight' THEN
    RAISE EXCEPTION 'parallel/replay claim was not fenced: %', v_result;
  END IF;

  v_result := public.begin_square_booking_writeback_dispatch(
    v_operation_one, v_attempt_one, v_material_fingerprint_one
  );
  IF v_result ->> 'code' <> 'dispatch_authorized'
     OR v_result ->> 'operation_id' <> v_operation_one::text
     OR v_result ->> 'attempt_token' <> v_attempt_one::text
     OR v_result ->> 'material_fingerprint' <> v_material_fingerprint_one
     OR v_result -> 'provider_material' ->> 'client_name'
        <> 'Private Square QA One'
     OR v_result -> 'provider_material' ->> 'service_mapping_basis'
        <> 'signaturegel' THEN
    RAISE EXCEPTION 'dispatch authorization contract failed: %', v_result;
  END IF;

  v_result := public.begin_square_booking_writeback_dispatch(
    v_operation_one, v_attempt_one, v_material_fingerprint_one
  );
  IF v_result ->> 'code' <> 'reconciliation_required'
     OR v_result ? 'provider_material' THEN
    RAISE EXCEPTION 'second dispatch was not permanently fenced: %', v_result;
  END IF;

  v_result := public.record_square_booking_writeback_customer(
    v_operation_one, v_attempt_one, v_provider_customer, repeat('a', 64)
  );
  IF v_result ->> 'code' <> 'customer_recorded'
     OR v_result ->> 'provider_customer_id' <> v_provider_customer THEN
    RAISE EXCEPTION 'customer receipt was not recorded: %', v_result;
  END IF;

  -- A config change after dispatch must retain the receipt but never bind it.
  UPDATE public.square_integrations
  SET location_id = 'square-location-changed-8636'
  WHERE salon_id = v_salon;
  v_result := public.complete_square_booking_writeback_success(
    v_operation_one, v_attempt_one, v_provider_booking,
    v_provider_customer, 23, repeat('b', 64)
  );
  IF v_result ->> 'code' <> 'provider_context_changed'
     OR v_result ->> 'status' <> 'unknown'
     OR v_result ->> 'provider_booking_id' <> v_provider_booking
     OR (SELECT square_booking_id FROM public.bookings
         WHERE id = v_booking_one) IS NOT NULL THEN
    RAISE EXCEPTION 'config CAS bound or lost an old-account receipt: %', v_result;
  END IF;

  UPDATE public.square_integrations
  SET location_id = v_original_location
  WHERE salon_id = v_salon;
  UPDATE public.square_booking_writeback_operations
  SET next_reconcile_at = clock_timestamp() - interval '1 second'
  WHERE id = v_operation_one;
  v_result := public.claim_square_booking_writeback_reconciliation(
    v_salon, v_booking_one
  );
  IF v_result ->> 'code' <> 'reconciliation_claimed'
     OR v_result -> 'material' ->> 'service_mapping_basis' <> 'signaturegel'
     OR v_result ->> 'provider_booking_id' <> v_provider_booking THEN
    RAISE EXCEPTION 'read-only reconciliation claim failed: %', v_result;
  END IF;
  v_attempt_one := (v_result ->> 'attempt_token')::uuid;

  v_result := public.complete_square_booking_writeback_success(
    v_operation_one, v_attempt_one, v_provider_booking,
    v_provider_customer, 23, repeat('b', 64)
  );
  IF v_result ->> 'code' <> 'operation_completed'
     OR v_result ->> 'status' <> 'succeeded'
     OR (SELECT square_booking_id FROM public.bookings
         WHERE id = v_booking_one) <> v_provider_booking THEN
    RAISE EXCEPTION 'reconciliation did not atomically bind receipt: %', v_result;
  END IF;
  v_result := public.complete_square_booking_writeback_success(
    v_operation_one, v_attempt_one, v_provider_booking,
    v_provider_customer, 23, repeat('b', 64)
  );
  IF v_result ->> 'code' <> 'completion_replay' THEN
    RAISE EXCEPTION 'exact completion replay was not idempotent: %', v_result;
  END IF;
  v_result := public.complete_square_booking_writeback_success(
    v_operation_one, v_attempt_one, 'different-square-booking-8636',
    v_provider_customer, 23, repeat('b', 64)
  );
  IF v_result ->> 'code' <> 'completion_conflict'
     OR (SELECT square_booking_id FROM public.bookings
         WHERE id = v_booking_one) <> v_provider_booking THEN
    RAISE EXCEPTION 'different provider binding did not fail closed: %', v_result;
  END IF;

  -- A local contact edit after dispatch persists ambiguity and never binds.
  v_result := public.claim_square_booking_writeback(
    v_salon, v_booking_two, v_team_member, v_variation, 17,
    v_contact_two, '2024-12-18'
  );
  IF v_result ->> 'code' <> 'operation_claimed' THEN
    RAISE EXCEPTION 'second operation claim failed: %', v_result;
  END IF;
  v_operation_two := (v_result ->> 'operation_id')::uuid;
  v_attempt_two := (v_result ->> 'attempt_token')::uuid;
  v_material_fingerprint_two := v_result ->> 'material_fingerprint';
  v_result := public.begin_square_booking_writeback_dispatch(
    v_operation_two, v_attempt_two, v_material_fingerprint_two
  );
  IF v_result ->> 'code' <> 'dispatch_authorized' THEN
    RAISE EXCEPTION 'second dispatch authorization failed: %', v_result;
  END IF;
  UPDATE public.bookings
  SET client_email = 'changed-after-dispatch@nailiq.invalid'
  WHERE id = v_booking_two;
  v_result := public.record_square_booking_writeback_customer(
    v_operation_two, v_attempt_two, 'square-customer-8636-two', repeat('c', 64)
  );
  IF v_result ->> 'code' <> 'reconciliation_required'
     OR v_result ->> 'status' <> 'unknown'
     OR (SELECT square_booking_id FROM public.bookings
         WHERE id = v_booking_two) IS NOT NULL THEN
    RAISE EXCEPTION 'post-dispatch material change was not fail-closed: %', v_result;
  END IF;
  v_result := public.claim_square_booking_writeback(
    v_salon, v_booking_two, v_team_member, v_variation, 17,
    v_contact_two, '2024-12-18'
  );
  IF v_result ->> 'code' <> 'reconciliation_required' THEN
    RAISE EXCEPTION 'unknown operation became redispatchable: %', v_result;
  END IF;
  v_result := public.mark_square_booking_writeback_unknown(
    v_operation_two, NULL, 'provider_response_unknown', repeat('d', 64),
    NULL, 'square-customer-8636-two', NULL
  );
  IF v_result ->> 'code' <> 'operation_unknown'
     OR v_result ->> 'provider_booking_id' IS NOT NULL THEN
    RAISE EXCEPTION 'nullable unknown receipt was not idempotently retained: %', v_result;
  END IF;

  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  v_result := public.claim_square_booking_writeback(
    v_salon, v_booking_two, v_team_member, v_variation, 17,
    v_contact_two, '2024-12-18'
  );
  IF v_result ->> 'code' <> 'unauthorized' THEN
    RAISE EXCEPTION 'browser role reached provider operation: %', v_result;
  END IF;
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  IF has_table_privilege(
       'anon', 'public.square_booking_writeback_operations', 'SELECT'
     )
     OR has_table_privilege(
       'authenticated', 'public.square_booking_writeback_operations', 'SELECT'
     )
     OR has_table_privilege(
       'service_role', 'public.square_booking_writeback_operations',
       'INSERT,UPDATE,DELETE'
     )
     OR NOT has_table_privilege(
       'service_role', 'public.square_booking_writeback_operations', 'SELECT'
     )
     OR has_function_privilege(
       'anon',
       'public.begin_square_booking_writeback_dispatch(uuid,uuid,text)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.complete_square_booking_writeback_success(uuid,uuid,text,text,bigint,text)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role',
       'public.claim_square_booking_writeback_reconciliation(uuid,uuid)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Square operation ledger grants are broader than intended';
  END IF;
END;
$rehearsal$;

ROLLBACK;

SELECT 'square booking writeback rehearsal passed and rolled back' AS result;
