\set ON_ERROR_STOP on

BEGIN;
SELECT set_config('request.jwt.claim.role', 'service_role', true);

DO $rehearsal$
DECLARE
  v_salon constant uuid := '61270000-0000-4000-8000-000000000001';
  v_service constant uuid := '61270000-0000-4000-8000-000000000002';
  v_staff constant uuid := '61270000-0000-4000-8000-000000000003';
  v_booking constant uuid := '61270000-0000-4000-8000-000000000004';
  v_result jsonb;
  v_operation uuid;
  v_attempt uuid;
  v_fp constant text := repeat('a', 64);
BEGIN
  INSERT INTO public.service_categories(slug, name_en, name_vi)
  VALUES ('wix-writeback-rehearsal', 'Wix writeback rehearsal', 'Wix writeback rehearsal');
  INSERT INTO public.salons(id, slug, name, phone, timezone, currency_code)
  VALUES (
    v_salon,
    'wix-writeback-rehearsal',
    'Wix writeback rehearsal',
    '+16045550612',
    'America/Vancouver',
    'CAD'
  );
  INSERT INTO public.services(
    id, salon_id, name, price_cents, duration_minutes, category,
    wix_service_id, wix_schedule_id
  ) VALUES (
    v_service, v_salon, 'Wix rehearsal service', 5000, 30,
    'wix-writeback-rehearsal', 'wix-service-6127', 'wix-schedule-6127'
  );
  INSERT INTO public.staff(id, salon_id, name, wix_resource_id)
  VALUES (v_staff, v_salon, 'Wix rehearsal staff', 'wix-resource-6127');
  INSERT INTO public.wix_integrations(
    salon_id, site_id, enabled, wix_location_id, wix_default_resource_id,
    wix_api_key
  ) VALUES (
    v_salon, 'wix-site-6127', true, 'wix-location-6127',
    'wix-resource-default-6127', 'not-a-provider-secret'
  );
  INSERT INTO public.bookings(
    id, salon_id, service_id, staff_id, client_name, client_phone,
    client_email, start_time_utc, end_time_utc, status, booking_channel,
    idempotency_key
  ) VALUES (
    v_booking, v_salon, v_service, v_staff, 'Private QA Name',
    '+16045550613', 'private-wix-qa@nailiq.invalid',
    date_trunc('hour', now()) + interval '2 days',
    date_trunc('hour', now()) + interval '2 days 30 minutes',
    'confirmed', 'online', v_booking
  );

  v_result := public.claim_wix_create_writeback(v_salon, v_booking);
  IF v_result ->> 'code' <> 'operation_claimed'
     OR v_result ->> 'provider_external_user_id' <> v_booking::text THEN
    RAISE EXCEPTION 'initial create claim failed: %', v_result;
  END IF;
  v_operation := (v_result ->> 'operation_id')::uuid;
  v_attempt := (v_result ->> 'attempt_token')::uuid;

  IF EXISTS (
    SELECT 1
    FROM public.wix_create_writeback_operations o
    WHERE o.id = v_operation
      AND (
        o.material::text ILIKE '%Private QA Name%'
        OR o.material::text ILIKE '%private-wix-qa%'
        OR o.material::text LIKE '%16045550613%'
        OR o.material::text ILIKE '%not-a-provider-secret%'
      )
  ) THEN
    RAISE EXCEPTION 'operation material retained PII or provider secret';
  END IF;

  v_result := public.claim_wix_create_writeback(v_salon, v_booking);
  IF v_result ->> 'code' <> 'operation_in_flight' THEN
    RAISE EXCEPTION 'parallel/replay claim was not fenced: %', v_result;
  END IF;

  v_result := public.complete_wix_create_writeback(
    v_operation, v_attempt, 'unknown', NULL, NULL, v_fp,
    'simulated_provider_response_loss'
  );
  IF v_result ->> 'code' <> 'operation_completed'
     OR v_result ->> 'status' <> 'unknown' THEN
    RAISE EXCEPTION 'ambiguous response was not persisted: %', v_result;
  END IF;
  IF (SELECT wix_booking_id FROM public.bookings WHERE id = v_booking) IS NOT NULL THEN
    RAISE EXCEPTION 'unknown outcome fabricated a Wix binding';
  END IF;

  v_result := public.claim_wix_create_writeback(v_salon, v_booking);
  IF v_result ->> 'code' <> 'reconciliation_not_due' THEN
    RAISE EXCEPTION 'unknown outcome became immediately redispatchable: %', v_result;
  END IF;

  UPDATE public.wix_create_writeback_operations
  SET next_reconcile_at = clock_timestamp() - interval '1 second'
  WHERE id = v_operation;
  v_result := public.claim_wix_create_writeback(v_salon, v_booking);
  IF v_result ->> 'code' <> 'reconciliation_claimed'
     OR v_result ->> 'status' <> 'reconciling' THEN
    RAISE EXCEPTION 'due ambiguous outcome did not become read-only reconciliation: %', v_result;
  END IF;
  v_attempt := (v_result ->> 'attempt_token')::uuid;

  -- A provider read that still sees no booking remains unknown. It does not
  -- issue or authorize a second create.
  v_result := public.complete_wix_create_writeback(
    v_operation, v_attempt, 'unknown', NULL, NULL, repeat('b', 64),
    'provider_booking_not_visible'
  );
  IF v_result ->> 'status' <> 'unknown'
     OR (SELECT attempt_count FROM public.wix_create_writeback_operations
         WHERE id = v_operation) <> 2 THEN
    RAISE EXCEPTION 'missing provider read did not remain reconciliation-only: %', v_result;
  END IF;

  UPDATE public.wix_create_writeback_operations
  SET next_reconcile_at = clock_timestamp() - interval '1 second'
  WHERE id = v_operation;
  v_result := public.claim_wix_create_writeback(v_salon, v_booking);
  IF v_result ->> 'code' <> 'reconciliation_claimed' THEN
    RAISE EXCEPTION 'second reconciliation was not claimable: %', v_result;
  END IF;
  v_attempt := (v_result ->> 'attempt_token')::uuid;
  v_result := public.complete_wix_create_writeback(
    v_operation, v_attempt, 'succeeded', 'wix-booking-6127', '9',
    repeat('c', 64), NULL
  );
  IF v_result ->> 'status' <> 'succeeded'
     OR (SELECT wix_booking_id FROM public.bookings WHERE id = v_booking)
        <> 'wix-booking-6127' THEN
    RAISE EXCEPTION 'provider reconciliation did not atomically bind: %', v_result;
  END IF;

  v_result := public.claim_wix_create_writeback(v_salon, v_booking);
  IF v_result ->> 'code' <> 'operation_succeeded'
     OR v_result ->> 'provider_booking_id' <> 'wix-booking-6127' THEN
    RAISE EXCEPTION 'successful reconciliation was not idempotent: %', v_result;
  END IF;

  -- Lifecycle response loss follows the same at-most-once contract. The DB
  -- grants a read-only reconciliation claim, never a fresh mutation claim.
  v_result := public.claim_wix_lifecycle_writeback(v_salon, v_booking, 'confirm');
  IF v_result ->> 'code' <> 'operation_claimed'
     OR v_result ->> 'target_status' <> 'CONFIRMED' THEN
    RAISE EXCEPTION 'initial lifecycle claim failed: %', v_result;
  END IF;
  v_operation := (v_result ->> 'operation_id')::uuid;
  v_attempt := (v_result ->> 'attempt_token')::uuid;
  v_result := public.complete_wix_lifecycle_writeback(
    v_operation, v_attempt, 'unknown', '9', repeat('d',64),
    'simulated_confirm_response_loss'
  );
  IF v_result ->> 'status' <> 'unknown' THEN
    RAISE EXCEPTION 'lifecycle ambiguity was not persisted: %', v_result;
  END IF;
  UPDATE public.wix_lifecycle_writeback_operations
  SET next_reconcile_at=clock_timestamp()-interval '1 second'
  WHERE id=v_operation;
  v_result := public.claim_wix_lifecycle_writeback(v_salon, v_booking, 'confirm');
  IF v_result ->> 'code' <> 'reconciliation_claimed' THEN
    RAISE EXCEPTION 'lifecycle ambiguity was redispatchable: %', v_result;
  END IF;
  v_attempt := (v_result ->> 'attempt_token')::uuid;
  v_result := public.complete_wix_lifecycle_writeback(
    v_operation, v_attempt, 'succeeded', '10', repeat('e',64), NULL
  );
  IF v_result ->> 'status' <> 'succeeded' THEN
    RAISE EXCEPTION 'lifecycle provider readback did not close receipt: %', v_result;
  END IF;

  UPDATE public.bookings SET status='cancelled' WHERE id=v_booking;
  FOREACH v_result IN ARRAY ARRAY[
    public.claim_wix_lifecycle_writeback(v_salon,v_booking,'cancel'),
    public.claim_wix_lifecycle_writeback(v_salon,v_booking,'decline')
  ] LOOP
    IF v_result ->> 'code' <> 'operation_claimed' THEN
      RAISE EXCEPTION 'cancel/decline lifecycle claim failed: %', v_result;
    END IF;
    PERFORM public.complete_wix_lifecycle_writeback(
      (v_result->>'operation_id')::uuid,
      (v_result->>'attempt_token')::uuid,
      'succeeded','11',repeat('f',64),NULL
    );
  END LOOP;

  v_result := public.record_wix_webhook_event(
    v_salon,'wix-site-6127','wix-event-6127','wix-booking-6127','confirmed',
    '2026-08-22T18:00:00Z',repeat('1',64)
  );
  IF v_result->>'code'<>'event_recorded' THEN RAISE EXCEPTION 'webhook event record failed: %',v_result; END IF;
  v_operation := (v_result->>'inbox_id')::uuid;
  v_result := public.claim_wix_webhook_event(v_operation);
  IF v_result->>'code'<>'event_claimed' THEN RAISE EXCEPTION 'webhook claim failed: %',v_result; END IF;
  v_attempt := (v_result->>'claim_token')::uuid;
  v_result := public.record_wix_webhook_event(
    v_salon,'wix-site-6127','wix-event-6127','wix-booking-6127','confirmed',
    '2026-08-22T18:00:00Z',repeat('1',64)
  );
  IF v_result->>'code'<>'event_replay' OR v_result->>'status'<>'processing' THEN RAISE EXCEPTION 'webhook replay identity failed: %',v_result; END IF;
  v_result := public.complete_wix_webhook_event(v_operation,v_attempt,'unknown',repeat('2',64),'simulated_sync_response_loss');
  IF v_result->>'status'<>'unknown' THEN RAISE EXCEPTION 'webhook unknown not durable: %',v_result; END IF;
  UPDATE public.wix_webhook_event_inbox SET next_reconcile_at=now()-interval '1 second' WHERE id=v_operation;
  v_result := public.claim_wix_webhook_event(v_operation);
  IF v_result->>'code'<>'event_claimed' THEN RAISE EXCEPTION 'webhook reconciliation claim failed: %',v_result; END IF;
  v_attempt := (v_result->>'claim_token')::uuid;
  v_result := public.complete_wix_webhook_event(v_operation,v_attempt,'processed',repeat('3',64),NULL);
  IF v_result->>'status'<>'processed' THEN RAISE EXCEPTION 'webhook completion failed: %',v_result; END IF;
  v_result := public.claim_wix_webhook_event(v_operation);
  IF v_result->>'code'<>'event_processed' THEN RAISE EXCEPTION 'processed webhook was not idempotent: %',v_result; END IF;
  v_result := public.record_wix_webhook_event(
    v_salon,'wix-site-6127','wix-event-6127','different-booking','confirmed',
    '2026-08-22T18:00:00Z',repeat('1',64)
  );
  IF v_result->>'code'<>'event_conflict' THEN RAISE EXCEPTION 'webhook identity conflict accepted: %',v_result; END IF;

  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  v_result := public.claim_wix_create_writeback(v_salon, v_booking);
  IF v_result ->> 'code' <> 'unauthorized' THEN
    RAISE EXCEPTION 'browser role claimed a provider operation: %', v_result;
  END IF;
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  IF has_table_privilege('anon', 'public.wix_create_writeback_operations', 'SELECT')
     OR has_table_privilege('authenticated', 'public.wix_create_writeback_operations', 'SELECT')
     OR has_table_privilege('service_role', 'public.wix_create_writeback_operations', 'INSERT,UPDATE,DELETE')
     OR has_table_privilege('anon', 'public.wix_lifecycle_writeback_operations', 'SELECT')
     OR has_table_privilege('authenticated', 'public.wix_lifecycle_writeback_operations', 'SELECT')
     OR has_table_privilege('service_role', 'public.wix_lifecycle_writeback_operations', 'INSERT,UPDATE,DELETE')
     OR has_table_privilege('anon', 'public.wix_webhook_event_inbox', 'SELECT')
     OR has_table_privilege('authenticated', 'public.wix_webhook_event_inbox', 'SELECT')
     OR has_table_privilege('service_role', 'public.wix_webhook_event_inbox', 'INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'Wix operation ledger grants are broader than intended';
  END IF;
END;
$rehearsal$;

ROLLBACK;

SELECT 'wix create writeback rehearsal passed' AS result;
