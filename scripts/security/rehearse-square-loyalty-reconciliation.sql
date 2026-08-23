\set ON_ERROR_STOP on

BEGIN;
SET LOCAL request.jwt.claim.role = 'service_role';

DO $square_loyalty_rehearsal$
DECLARE
  v_salon constant uuid := '51241000-0000-4000-8000-000000000001';
  v_request constant uuid := '51241000-0000-4000-8000-000000000002';
  v_subject constant text := repeat('1', 64);
  v_contract jsonb;
  v_resolved jsonb;
  v_claim jsonb;
  v_done jsonb;
  v_recorded jsonb;
  v_inbox jsonb;
  v_applied jsonb;
  v_operation_id uuid;
  v_attempt_token uuid;
  v_inbox_id uuid;
  v_claim_token uuid;
  v_fp text;
BEGIN
  INSERT INTO public.salons(id, slug, name, phone, timezone, currency_code)
  VALUES(v_salon, 'square-loyalty-reconcile-qa', 'Square Loyalty QA', '+16045550125', 'UTC', 'CAD');
  INSERT INTO public.square_integrations(
    salon_id, merchant_id, location_id, application_id, access_token,
    environment, enabled, oauth_scopes, loyalty_sync_enabled
  ) VALUES (
    v_salon, 'merchant_loyalty_qa', 'location_loyalty_qa',
    'application_loyalty_qa', 'secret-not-returned', 'sandbox', true,
    ARRAY['LOYALTY_READ', 'LOYALTY_WRITE'], true
  );
  INSERT INTO public.platform_settings(id) VALUES('platform') ON CONFLICT(id) DO NOTHING;
  UPDATE public.platform_settings SET square_loyalty_platform_enabled = true WHERE id = 'platform';

  v_contract := public.square_feature_contract(v_salon, 'loyalty');
  IF v_contract ->> 'code' <> 'ready' THEN
    RAISE EXCEPTION 'loyalty contract not ready: %', v_contract;
  END IF;
  v_fp := v_contract ->> 'provider_account_fingerprint';

  v_resolved := public.resolve_square_feature_operation_material(
    v_salon, 'loyalty_account_create',
    pg_catalog.jsonb_build_object('source_id', v_subject)
  );
  v_claim := public.claim_square_feature_operation(
    v_salon, v_request, 'loyalty_account_create',
    pg_catalog.jsonb_build_object('source_id', v_subject),
    v_resolved ->> 'material_fingerprint'
  );
  v_operation_id := (v_claim ->> 'operation_id')::uuid;
  v_attempt_token := (v_claim ->> 'attempt_token')::uuid;
  v_done := public.complete_square_feature_operation(
    v_operation_id, v_attempt_token, 'succeeded', 'account-1', 'receipt-account-1',
    repeat('2', 64), NULL
  );
  IF v_done ->> 'code' <> 'operation_completed' THEN
    RAISE EXCEPTION 'simulated receipt completion failed: %', v_done;
  END IF;
  IF public.bind_square_loyalty_subject(
    v_salon, v_operation_id, 'account-1', v_subject
  ) ->> 'code' <> 'subject_bound' THEN
    RAISE EXCEPTION 'PII-free subject binding failed';
  END IF;
  IF public.bind_square_loyalty_subject(
    v_salon, v_operation_id, 'account-1', repeat('3', 64)
  ) ->> 'code' <> 'provider_receipt_binding_required' THEN
    RAISE EXCEPTION 'changed subject escaped receipt binding';
  END IF;

  v_recorded := public.record_square_webhook_event(
    v_salon, 'webhook-account-1', 'loyalty.account.created',
    '2026-08-22T15:00:00Z', 'account-1',
    pg_catalog.jsonb_build_object(
      'merchant_id', 'merchant_loyalty_qa',
      'application_id', 'application_loyalty_qa',
      'environment', 'sandbox', 'api_version', '2026-07-15',
      'provider_account_fingerprint', v_fp,
      'entity', pg_catalog.jsonb_build_object(
        'id', 'account-1', 'program_id', 'program-1',
        'balance', 12, 'lifetime_points', 44,
        'updated_at', '2026-08-22T14:59:59Z'
      )
    ), repeat('4', 64)
  );
  IF v_recorded ->> 'code' <> 'event_recorded' THEN
    RAISE EXCEPTION 'account webhook record failed: %', v_recorded;
  END IF;
  SELECT x INTO v_inbox FROM public.claim_square_webhook_events('loyalty', 1) AS x;
  v_inbox_id := (v_inbox ->> 'inbox_id')::uuid;
  v_claim_token := (v_inbox ->> 'claim_token')::uuid;
  v_applied := public.apply_square_loyalty_webhook_event(v_inbox_id, v_claim_token);
  IF v_applied ->> 'code' <> 'loyalty_event_applied'
     OR NOT EXISTS (
       SELECT 1 FROM public.square_loyalty_account_mirrors
       WHERE salon_id = v_salon AND square_account_id = 'account-1'
         AND subject_fingerprint = v_subject AND balance = 12
         AND lifetime_points = 44 AND state = 'active'
     ) THEN
    RAISE EXCEPTION 'account mirror application failed: %', v_applied;
  END IF;
  IF public.apply_square_loyalty_webhook_event(v_inbox_id, v_claim_token)
       ->> 'code' <> 'application_replay' THEN
    RAISE EXCEPTION 'processed inbox replay failed';
  END IF;

  v_recorded := public.record_square_webhook_event(
    v_salon, 'webhook-event-earn', 'loyalty.event.created',
    '2026-08-22T15:01:00Z', 'event-earn',
    pg_catalog.jsonb_build_object(
      'merchant_id', 'merchant_loyalty_qa',
      'application_id', 'application_loyalty_qa',
      'environment', 'sandbox', 'api_version', '2026-07-15',
      'provider_account_fingerprint', v_fp,
      'entity', pg_catalog.jsonb_build_object(
        'id', 'event-earn', 'type', 'ACCUMULATE_POINTS',
        'loyalty_account_id', 'account-1', 'program_id', 'program-1',
        'created_at', '2026-08-22T15:00:59Z', 'points_delta', 12,
        'order_id', 'order-1', 'location_id', 'location_loyalty_qa',
        'source', 'LOYALTY_API'
      )
    ), repeat('5', 64)
  );
  SELECT x INTO v_inbox FROM public.claim_square_webhook_events('loyalty', 1) AS x;
  v_applied := public.apply_square_loyalty_webhook_event(
    (v_inbox ->> 'inbox_id')::uuid, (v_inbox ->> 'claim_token')::uuid
  );
  IF v_applied ->> 'code' <> 'loyalty_event_applied'
     OR NOT EXISTS (
       SELECT 1 FROM public.square_loyalty_event_mirrors
       WHERE salon_id = v_salon AND square_event_id = 'event-earn'
         AND points_delta = 12 AND square_order_id = 'order-1'
     ) THEN
    RAISE EXCEPTION 'earn event mirror failed: %', v_applied;
  END IF;

  v_recorded := public.record_square_webhook_event(
    v_salon, 'webhook-event-reward', 'loyalty.event.created',
    '2026-08-22T15:02:00Z', 'event-reward',
    pg_catalog.jsonb_build_object(
      'merchant_id', 'merchant_loyalty_qa',
      'application_id', 'application_loyalty_qa',
      'environment', 'sandbox', 'api_version', '2026-07-15',
      'provider_account_fingerprint', v_fp,
      'entity', pg_catalog.jsonb_build_object(
        'id', 'event-reward', 'type', 'CREATE_REWARD',
        'loyalty_account_id', 'account-1', 'program_id', 'program-1',
        'created_at', '2026-08-22T15:01:59Z', 'points_delta', -10,
        'reward_id', 'reward-1', 'location_id', 'location_loyalty_qa',
        'source', 'LOYALTY_API'
      )
    ), repeat('6', 64)
  );
  SELECT x INTO v_inbox FROM public.claim_square_webhook_events('loyalty', 1) AS x;
  v_applied := public.apply_square_loyalty_webhook_event(
    (v_inbox ->> 'inbox_id')::uuid, (v_inbox ->> 'claim_token')::uuid
  );
  IF v_applied ->> 'code' <> 'loyalty_event_applied'
     OR NOT EXISTS (
       SELECT 1 FROM public.square_loyalty_reward_mirrors
       WHERE salon_id = v_salon AND square_reward_id = 'reward-1'
         AND status = 'issued' AND points_effect = -10
     ) THEN
    RAISE EXCEPTION 'reward mirror failed: %', v_applied;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.square_loyalty_account_mirrors
    WHERE row_to_json(square_loyalty_account_mirrors)::text ~* 'phone|secret-not-returned'
  ) OR EXISTS (
    SELECT 1 FROM public.square_loyalty_event_mirrors
    WHERE row_to_json(square_loyalty_event_mirrors)::text ~* 'phone|secret-not-returned'
  ) THEN
    RAISE EXCEPTION 'PII or provider secret leaked into loyalty mirror';
  END IF;

  BEGIN
    UPDATE public.square_loyalty_event_mirrors
    SET points_delta = 99 WHERE salon_id = v_salon;
    RAISE EXCEPTION 'immutable provider event was updated';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  IF NOT EXISTS (
    SELECT 1 FROM public.square_sync_cursors
    WHERE salon_id = v_salon AND feature = 'loyalty'
      AND last_event_id = 'webhook-event-reward'
  ) THEN
    RAISE EXCEPTION 'loyalty cursor did not advance atomically';
  END IF;
END;
$square_loyalty_rehearsal$;

ROLLBACK;

SELECT 'PASS Square loyalty account/event/reward reconciliation mirror' AS result;
