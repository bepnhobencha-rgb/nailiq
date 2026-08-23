\set ON_ERROR_STOP on

BEGIN;
SELECT set_config('request.jwt.claim.role', 'service_role', true);

DO $rehearsal$
DECLARE
  v_salon uuid := '23011500-0000-4000-8000-000000000001';
  v_service uuid := '23011500-0000-4000-8000-000000000002';
  v_staff uuid := '23011500-0000-4000-8000-000000000003';
  v_sandbox_operation uuid := '23011500-0000-4000-8000-000000000010';
  v_production_operation uuid := '23011500-0000-4000-8000-000000000020';
  v_stripe_operation uuid := '23011500-0000-4000-8000-000000000030';
  v_booking_intent uuid := '23011500-0000-4000-8000-000000000011';
  v_start timestamptz := date_trunc('hour', now()) + interval '2 days';
  v_end timestamptz := date_trunc('hour', now()) + interval '2 days 30 minutes';
  v_provider jsonb;
  v_material jsonb;
  v_material_fp text;
  v_account_fp text;
  v_due jsonb;
BEGIN
  IF has_function_privilege(
    'anon',
    'public.discover_due_public_square_deposit_reconciliations(text,integer)',
    'EXECUTE'
  ) OR has_function_privilege(
    'authenticated',
    'public.discover_due_public_square_deposit_reconciliations(text,integer)',
    'EXECUTE'
  ) OR NOT has_function_privilege(
    'service_role',
    'public.discover_due_public_square_deposit_reconciliations(text,integer)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'dedicated Square discovery grants are not service-role-only';
  END IF;

  BEGIN
    PERFORM * FROM public.discover_due_public_square_deposit_reconciliations('staging', 1);
    RAISE EXCEPTION 'invalid environment was accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    NULL;
  END;

  INSERT INTO public.service_categories(slug, name_en, name_vi)
  VALUES (
    'public-square-deposit-reconciliation-rehearsal',
    'Public Square deposit reconciliation rehearsal',
    'Public Square deposit reconciliation rehearsal'
  );
  INSERT INTO public.salons(id, slug, name, phone, timezone, currency_code)
  VALUES (
    v_salon,
    'public-square-deposit-reconciliation-rehearsal',
    'Public Square deposit reconciliation rehearsal',
    '+16045550115',
    'UTC',
    'CAD'
  );
  INSERT INTO public.services(id, salon_id, name, price_cents, duration_minutes, category)
  VALUES (
    v_service,
    v_salon,
    'Square reconciliation rehearsal service',
    5000,
    30,
    'public-square-deposit-reconciliation-rehearsal'
  );
  INSERT INTO public.staff(id, salon_id, name, status, deleted_at)
  VALUES (v_staff, v_salon, 'Square reconciliation rehearsal staff', 'active', NULL);

  v_account_fp := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to('square:merchant-sandbox:location-sandbox:sandbox', 'UTF8'),
      'sha256'
    ),
    'hex'
  );
  v_provider := pg_catalog.jsonb_build_object(
    'provider_account_id', 'merchant-sandbox',
    'provider_location_id', 'location-sandbox',
    'provider_application_id', 'sandbox-app-1',
    'provider_environment', 'sandbox',
    'currency', 'CAD',
    'amount_cents', 1000,
    'booking_intent_reference', v_booking_intent,
    'pricing_fingerprint', repeat('a', 64)
  );
  v_material := pg_catalog.jsonb_build_object(
    'salon_id', v_salon,
    'service_id', v_service,
    'staff_id', v_staff,
    'start_time_utc', v_start,
    'end_time_utc', v_end,
    'booking_idempotency_key', v_booking_intent,
    'pricing_fingerprint', repeat('a', 64),
    'client_phone_fingerprint', repeat('b', 64),
    'provider', 'square',
    'provider_account_fingerprint', v_account_fp,
    'amount_cents', 1000,
    'currency', 'CAD',
    'deposit_reason', 'qa',
    'provider_material', v_provider
  );
  v_material_fp := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(v_material::text, 'UTF8'), 'sha256'),
    'hex'
  );

  INSERT INTO public.booking_payment_operations(
    id, salon_id, request_id, operation_kind, provider,
    provider_account_fingerprint, amount_cents, currency,
    material_fingerprint, material_json, provider_material, delivery_mode,
    booking_intent_idempotency_key, pricing_fingerprint, service_id, staff_id,
    start_time_utc, end_time_utc, client_phone_fingerprint,
    provider_idempotency_key, status, failure_disposition, error_code,
    attempt_count, next_reconcile_at
  ) VALUES (
    v_sandbox_operation, v_salon, gen_random_uuid(), 'deposit_charge', 'square',
    v_account_fp, 1000, 'CAD', v_material_fp, v_material, v_provider,
    'public_customer_present', v_booking_intent, repeat('a', 64), v_service, v_staff,
    v_start, v_end, repeat('b', 64), 'nq:' || v_sandbox_operation::text,
    'unknown', 'ambiguous', 'provider_outcome_ambiguous', 1, now() - interval '1 second'
  );

  v_booking_intent := '23011500-0000-4000-8000-000000000021';
  v_account_fp := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to('square:merchant-production:location-production:production', 'UTF8'),
      'sha256'
    ),
    'hex'
  );
  v_provider := v_provider || pg_catalog.jsonb_build_object(
    'provider_account_id', 'merchant-production',
    'provider_location_id', 'location-production',
    'provider_application_id', 'production-app-1',
    'provider_environment', 'production',
    'booking_intent_reference', v_booking_intent
  );
  v_material := v_material || pg_catalog.jsonb_build_object(
    'booking_idempotency_key', v_booking_intent,
    'provider_account_fingerprint', v_account_fp,
    'provider_material', v_provider
  );
  v_material_fp := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(v_material::text, 'UTF8'), 'sha256'),
    'hex'
  );
  INSERT INTO public.booking_payment_operations(
    id, salon_id, request_id, operation_kind, provider,
    provider_account_fingerprint, amount_cents, currency,
    material_fingerprint, material_json, provider_material, delivery_mode,
    booking_intent_idempotency_key, pricing_fingerprint, service_id, staff_id,
    start_time_utc, end_time_utc, client_phone_fingerprint,
    provider_idempotency_key, status, failure_disposition, error_code,
    attempt_count, next_reconcile_at
  ) VALUES (
    v_production_operation, v_salon, gen_random_uuid(), 'deposit_charge', 'square',
    v_account_fp, 1000, 'CAD', v_material_fp, v_material, v_provider,
    'public_customer_present', v_booking_intent, repeat('a', 64), v_service, v_staff,
    v_start, v_end, repeat('b', 64), 'nq:' || v_production_operation::text,
    'unknown', 'ambiguous', 'provider_outcome_ambiguous', 1, now() - interval '1 second'
  );

  INSERT INTO public.booking_payment_operations(
    id, salon_id, request_id, operation_kind, provider,
    provider_account_fingerprint, amount_cents, currency,
    material_fingerprint, material_json, provider_material,
    booking_intent_idempotency_key, pricing_fingerprint, service_id, staff_id,
    start_time_utc, end_time_utc, client_phone_fingerprint,
    provider_idempotency_key, status, failure_disposition, error_code,
    attempt_count, next_reconcile_at
  ) VALUES (
    v_stripe_operation, v_salon, gen_random_uuid(), 'deposit_charge', 'stripe',
    repeat('c', 64), 1000, 'CAD', repeat('d', 64), '{}'::jsonb, '{}'::jsonb,
    gen_random_uuid(), repeat('e', 64), v_service, v_staff, v_start, v_end,
    repeat('f', 64), 'nq:' || v_stripe_operation::text,
    'unknown', 'ambiguous', 'provider_outcome_ambiguous', 1, now() - interval '1 second'
  );

  SELECT x INTO v_due
  FROM public.discover_due_public_square_deposit_reconciliations('sandbox', 10) x;
  IF v_due ->> 'operation_id' <> v_sandbox_operation::text
     OR v_due ->> 'attempt_count' <> '2'
     OR nullif(v_due ->> 'operation_created_at', '') IS NULL
     OR v_due -> 'provider_material' ->> 'provider_environment' <> 'sandbox' THEN
    RAISE EXCEPTION 'sandbox discovery did not claim the exact row: %', v_due;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.discover_due_public_square_deposit_reconciliations('sandbox', 10)
  ) THEN
    RAISE EXCEPTION 'active Square reconciliation lease was reclaimed';
  END IF;

  SELECT x INTO v_due FROM public.discover_due_booking_payment_reconciliations(10) x;
  IF v_due ->> 'operation_id' <> v_stripe_operation::text THEN
    RAISE EXCEPTION 'generic discovery did not preserve its non-Square path: %', v_due;
  END IF;
  IF (SELECT attempt_count FROM public.booking_payment_operations
      WHERE id = v_production_operation) <> 1 THEN
    RAISE EXCEPTION 'generic discovery consumed a gated public Square attempt';
  END IF;
END
$rehearsal$;

ROLLBACK;
