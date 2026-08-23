\set ON_ERROR_STOP on

BEGIN;
SET LOCAL request.jwt.claim.role = 'service_role';

DO $square_gift_card_rehearsal$
DECLARE
  v_salon constant uuid := '51250000-0000-4000-8000-000000000001';
  v_request constant uuid := '51250000-0000-4000-8000-000000000002';
  v_contract jsonb;
  v_resolved jsonb;
  v_claim jsonb;
  v_done jsonb;
  v_recorded jsonb;
  v_inbox jsonb;
  v_applied jsonb;
  v_create_id uuid;
  v_payment_id uuid;
  v_activate_id uuid;
  v_attempt_token uuid;
  v_fp text;
BEGIN
  INSERT INTO public.salons(id, slug, name, phone, timezone, currency_code)
  VALUES(v_salon, 'square-gift-card-reconcile-qa', 'Square Gift Card QA', '+16045550125', 'UTC', 'CAD');
  INSERT INTO public.square_integrations(
    salon_id, merchant_id, location_id, application_id, access_token,
    environment, enabled, oauth_scopes, gift_cards_sync_enabled
  ) VALUES (
    v_salon, 'merchant_gift_qa', 'location_gift_qa',
    'application_gift_qa', 'secret-not-returned', 'sandbox', true,
    ARRAY['GIFTCARDS_READ', 'GIFTCARDS_WRITE', 'PAYMENTS_WRITE'], true
  );
  INSERT INTO public.platform_settings(id) VALUES('platform') ON CONFLICT(id) DO NOTHING;
  UPDATE public.platform_settings SET square_gift_cards_platform_enabled = true WHERE id = 'platform';

  v_contract := public.square_feature_contract(v_salon, 'gift_cards');
  IF v_contract ->> 'code' <> 'ready' THEN
    RAISE EXCEPTION 'gift card contract not ready: %', v_contract;
  END IF;
  v_fp := v_contract ->> 'provider_account_fingerprint';

  v_resolved := public.resolve_square_feature_operation_material(
    v_salon, 'gift_card_create',
    pg_catalog.jsonb_build_object('source_id', 'issuance-request-1')
  );
  v_claim := public.claim_square_feature_operation(
    v_salon, v_request, 'gift_card_create',
    pg_catalog.jsonb_build_object('source_id', 'issuance-request-1'),
    v_resolved ->> 'material_fingerprint'
  );
  v_create_id := (v_claim ->> 'operation_id')::uuid;
  v_attempt_token := (v_claim ->> 'attempt_token')::uuid;
  v_done := public.complete_square_feature_operation(
    v_create_id, v_attempt_token, 'succeeded', 'gftc:card-1',
    'receipt-create-1', repeat('1', 64), NULL
  );
  IF v_done ->> 'code' <> 'operation_completed' THEN
    RAISE EXCEPTION 'simulated create receipt failed: %', v_done;
  END IF;

  v_resolved := public.resolve_square_feature_operation_material(
    v_salon, 'gift_card_payment',
    pg_catalog.jsonb_build_object(
      'source_id', 'gftc:card-1', 'parent_operation_id', v_create_id,
      'amount_cents', 5000, 'currency', 'CAD', 'order_id', 'order-1',
      'payment_source_token', 'sandbox-payment-token-never-persisted'
    )
  );
  v_claim := public.claim_square_feature_operation(
    v_salon, '51250000-0000-4000-8000-000000000003', 'gift_card_payment',
    pg_catalog.jsonb_build_object(
      'source_id', 'gftc:card-1', 'parent_operation_id', v_create_id,
      'amount_cents', 5000, 'currency', 'CAD', 'order_id', 'order-1',
      'payment_source_token', 'sandbox-payment-token-never-persisted'
    ),
    v_resolved ->> 'material_fingerprint'
  );
  v_payment_id := (v_claim ->> 'operation_id')::uuid;
  v_attempt_token := (v_claim ->> 'attempt_token')::uuid;
  v_done := public.complete_square_feature_operation(
    v_payment_id, v_attempt_token, 'succeeded', 'payment-1',
    'receipt-payment-1', repeat('2', 64), NULL
  );
  IF v_done ->> 'code' <> 'operation_completed' THEN
    RAISE EXCEPTION 'simulated payment receipt failed: %', v_done;
  END IF;

  v_resolved := public.resolve_square_feature_operation_material(
    v_salon, 'gift_card_payment',
    pg_catalog.jsonb_build_object(
      'source_id', 'gftc:different-card', 'parent_operation_id', v_create_id,
      'amount_cents', 5000, 'currency', 'CAD', 'order_id', 'order-1',
      'payment_source_token', 'sandbox-payment-token-never-persisted'
    )
  );
  IF v_resolved ->> 'code' <> 'invalid_payment_material' THEN
    RAISE EXCEPTION 'payment was not bound to the created gift card: %', v_resolved;
  END IF;
  v_resolved := public.resolve_square_feature_operation_material(
    v_salon, 'gift_card_activate',
    pg_catalog.jsonb_build_object(
      'source_id', 'gftc:card-1', 'parent_operation_id', v_payment_id,
      'amount_cents', 5000, 'currency', 'CAD', 'order_id', 'different-order',
      'line_item_uid', 'gift-card-line-1'
    )
  );
  IF v_resolved ->> 'code' <> 'payment_material_mismatch' THEN
    RAISE EXCEPTION 'activation accepted a different Square order: %', v_resolved;
  END IF;
  v_resolved := public.resolve_square_feature_operation_material(
    v_salon, 'gift_card_activate',
    pg_catalog.jsonb_build_object(
      'source_id', 'gftc:card-1', 'parent_operation_id', v_payment_id,
      'amount_cents', 5000, 'currency', 'CAD', 'order_id', 'order-1'
    )
  );
  IF v_resolved ->> 'code' <> 'payment_material_mismatch' THEN
    RAISE EXCEPTION 'activation accepted missing line-item evidence: %', v_resolved;
  END IF;

  v_resolved := public.resolve_square_feature_operation_material(
    v_salon, 'gift_card_activate',
    pg_catalog.jsonb_build_object(
      'source_id', 'gftc:card-1', 'parent_operation_id', v_payment_id,
      'amount_cents', 5000, 'currency', 'CAD', 'order_id', 'order-1',
      'line_item_uid', 'gift-card-line-1'
    )
  );
  v_claim := public.claim_square_feature_operation(
    v_salon, '51250000-0000-4000-8000-000000000004', 'gift_card_activate',
    pg_catalog.jsonb_build_object(
      'source_id', 'gftc:card-1', 'parent_operation_id', v_payment_id,
      'amount_cents', 5000, 'currency', 'CAD', 'order_id', 'order-1',
      'line_item_uid', 'gift-card-line-1'
    ),
    v_resolved ->> 'material_fingerprint'
  );
  v_activate_id := (v_claim ->> 'operation_id')::uuid;
  v_attempt_token := (v_claim ->> 'attempt_token')::uuid;
  v_done := public.complete_square_feature_operation(
    v_activate_id, v_attempt_token, 'succeeded', 'gcact:activate-1',
    'receipt-activate-1', repeat('3', 64), NULL
  );
  IF v_done ->> 'code' <> 'operation_completed' THEN
    RAISE EXCEPTION 'simulated activation receipt failed: %', v_done;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.square_feature_operations
    WHERE salon_id = v_salon
      AND material::text LIKE '%sandbox-payment-token-never-persisted%'
  ) THEN
    RAISE EXCEPTION 'raw payment source token leaked into durable material';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.square_feature_operations
    WHERE id = v_activate_id
      AND material ->> 'order_id' = 'order-1'
      AND material ->> 'line_item_uid' = 'gift-card-line-1'
  ) THEN
    RAISE EXCEPTION 'activation order-line evidence was not retained';
  END IF;

  IF public.bind_square_gift_card_issuance(
    v_salon, v_activate_id, 'gftc:card-1'
  ) ->> 'code' <> 'issuance_receipts_bound' THEN
    RAISE EXCEPTION 'exact receipt chain was not bound';
  END IF;
  IF public.bind_square_gift_card_issuance(
    v_salon, v_payment_id, 'gftc:card-1'
  ) ->> 'code' <> 'activation_receipt_required' THEN
    RAISE EXCEPTION 'payment receipt alone escaped activation gate';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.vouchers
    WHERE salon_id = v_salon AND kind = 'gift'
  ) THEN
    RAISE EXCEPTION 'receipt binding minted a NailIQ voucher';
  END IF;

  v_recorded := public.record_square_webhook_event(
    v_salon, 'webhook-card-created', 'gift_card.created',
    '2026-08-22T17:00:00Z', 'gftc:card-1',
    pg_catalog.jsonb_build_object(
      'merchant_id', 'merchant_gift_qa',
      'application_id', 'application_gift_qa',
      'environment', 'sandbox', 'api_version', '2026-07-15',
      'provider_account_fingerprint', v_fp,
      'entity', pg_catalog.jsonb_build_object(
        'id', 'gftc:card-1', 'type', 'DIGITAL', 'gan_source', 'SQUARE',
        'state', 'PENDING',
        'balance_money', pg_catalog.jsonb_build_object('amount', 0, 'currency', 'CAD'),
        'created_at', '2026-08-22T16:59:59Z'
      )
    ), repeat('4', 64)
  );
  IF v_recorded ->> 'code' <> 'event_recorded' THEN
    RAISE EXCEPTION 'gift card created webhook record failed: %', v_recorded;
  END IF;
  SELECT x INTO v_inbox FROM public.claim_square_webhook_events('gift_cards', 1) AS x;
  v_applied := public.apply_square_gift_card_webhook_event(
    (v_inbox ->> 'inbox_id')::uuid, (v_inbox ->> 'claim_token')::uuid
  );
  IF v_applied ->> 'code' <> 'gift_card_event_applied'
     OR NOT EXISTS (
       SELECT 1 FROM public.square_gift_card_mirrors
       WHERE salon_id = v_salon AND square_gift_card_id = 'gftc:card-1'
         AND state = 'PENDING' AND balance_cents = 0
         AND activation_operation_id = v_activate_id
         AND issuance_amount_cents = 5000 AND issuance_currency = 'CAD'
     ) THEN
    RAISE EXCEPTION 'created card mirror failed: %', v_applied;
  END IF;
  IF public.apply_square_gift_card_webhook_event(
    (v_inbox ->> 'inbox_id')::uuid, (v_inbox ->> 'claim_token')::uuid
  ) ->> 'code' <> 'application_replay' THEN
    RAISE EXCEPTION 'processed inbox replay failed';
  END IF;

  v_recorded := public.record_square_webhook_event(
    v_salon, 'webhook-activate', 'gift_card.activity.created',
    '2026-08-22T17:01:00Z', 'gcact:activate-1',
    pg_catalog.jsonb_build_object(
      'merchant_id', 'merchant_gift_qa',
      'application_id', 'application_gift_qa',
      'environment', 'sandbox', 'api_version', '2026-07-15',
      'provider_account_fingerprint', v_fp,
      'entity', pg_catalog.jsonb_build_object(
        'id', 'gcact:activate-1', 'type', 'ACTIVATE',
        'location_id', 'location_gift_qa', 'gift_card_id', 'gftc:card-1',
        'created_at', '2026-08-22T17:00:59Z',
        'gift_card_balance_money', pg_catalog.jsonb_build_object('amount', 5000, 'currency', 'CAD'),
        'amount_money', pg_catalog.jsonb_build_object('amount', 5000, 'currency', 'CAD'),
        'order_id', 'order-1'
      )
    ), repeat('5', 64)
  );
  SELECT x INTO v_inbox FROM public.claim_square_webhook_events('gift_cards', 1) AS x;
  v_applied := public.apply_square_gift_card_webhook_event(
    (v_inbox ->> 'inbox_id')::uuid, (v_inbox ->> 'claim_token')::uuid
  );
  IF v_applied ->> 'code' <> 'gift_card_event_applied' THEN
    RAISE EXCEPTION 'activation activity mirror failed: %', v_applied;
  END IF;

  v_recorded := public.record_square_webhook_event(
    v_salon, 'webhook-card-active', 'gift_card.updated',
    '2026-08-22T17:01:01Z', 'gftc:card-1',
    pg_catalog.jsonb_build_object(
      'merchant_id', 'merchant_gift_qa',
      'application_id', 'application_gift_qa',
      'environment', 'sandbox', 'api_version', '2026-07-15',
      'provider_account_fingerprint', v_fp,
      'entity', pg_catalog.jsonb_build_object(
        'id', 'gftc:card-1', 'type', 'DIGITAL', 'gan_source', 'SQUARE',
        'state', 'ACTIVE',
        'balance_money', pg_catalog.jsonb_build_object('amount', 5000, 'currency', 'CAD'),
        'created_at', '2026-08-22T16:59:59Z'
      )
    ), repeat('6', 64)
  );
  SELECT x INTO v_inbox FROM public.claim_square_webhook_events('gift_cards', 1) AS x;
  PERFORM public.apply_square_gift_card_webhook_event(
    (v_inbox ->> 'inbox_id')::uuid, (v_inbox ->> 'claim_token')::uuid
  );

  v_recorded := public.record_square_webhook_event(
    v_salon, 'webhook-redeem-pending', 'gift_card.activity.created',
    '2026-08-22T17:02:00Z', 'gcact:redeem-1',
    pg_catalog.jsonb_build_object(
      'merchant_id', 'merchant_gift_qa',
      'application_id', 'application_gift_qa',
      'environment', 'sandbox', 'api_version', '2026-07-15',
      'provider_account_fingerprint', v_fp,
      'entity', pg_catalog.jsonb_build_object(
        'id', 'gcact:redeem-1', 'type', 'REDEEM',
        'location_id', 'location_gift_qa', 'gift_card_id', 'gftc:card-1',
        'created_at', '2026-08-22T17:01:59Z', 'status', 'PENDING',
        'gift_card_balance_money', pg_catalog.jsonb_build_object('amount', 3750, 'currency', 'CAD'),
        'amount_money', pg_catalog.jsonb_build_object('amount', 1250, 'currency', 'CAD'),
        'payment_id', 'payment-redeem-1', 'reference_id', 'booking-ref-1'
      )
    ), repeat('7', 64)
  );
  SELECT x INTO v_inbox FROM public.claim_square_webhook_events('gift_cards', 1) AS x;
  PERFORM public.apply_square_gift_card_webhook_event(
    (v_inbox ->> 'inbox_id')::uuid, (v_inbox ->> 'claim_token')::uuid
  );

  v_recorded := public.record_square_webhook_event(
    v_salon, 'webhook-redeem-completed', 'gift_card.activity.updated',
    '2026-08-22T17:03:00Z', 'gcact:redeem-1',
    pg_catalog.jsonb_build_object(
      'merchant_id', 'merchant_gift_qa',
      'application_id', 'application_gift_qa',
      'environment', 'sandbox', 'api_version', '2026-07-15',
      'provider_account_fingerprint', v_fp,
      'entity', pg_catalog.jsonb_build_object(
        'id', 'gcact:redeem-1', 'type', 'REDEEM',
        'location_id', 'location_gift_qa', 'gift_card_id', 'gftc:card-1',
        'created_at', '2026-08-22T17:01:59Z', 'status', 'COMPLETED',
        'gift_card_balance_money', pg_catalog.jsonb_build_object('amount', 3750, 'currency', 'CAD'),
        'amount_money', pg_catalog.jsonb_build_object('amount', 1250, 'currency', 'CAD'),
        'payment_id', 'payment-redeem-1', 'reference_id', 'booking-ref-1'
      )
    ), repeat('8', 64)
  );
  SELECT x INTO v_inbox FROM public.claim_square_webhook_events('gift_cards', 1) AS x;
  PERFORM public.apply_square_gift_card_webhook_event(
    (v_inbox ->> 'inbox_id')::uuid, (v_inbox ->> 'claim_token')::uuid
  );

  v_recorded := public.record_square_webhook_event(
    v_salon, 'webhook-refund-partial', 'gift_card.activity.created',
    '2026-08-22T17:04:00Z', 'gcact:refund-1',
    pg_catalog.jsonb_build_object(
      'merchant_id', 'merchant_gift_qa',
      'application_id', 'application_gift_qa',
      'environment', 'sandbox', 'api_version', '2026-07-15',
      'provider_account_fingerprint', v_fp,
      'entity', pg_catalog.jsonb_build_object(
        'id', 'gcact:refund-1', 'type', 'REFUND',
        'location_id', 'location_gift_qa', 'gift_card_id', 'gftc:card-1',
        'created_at', '2026-08-22T17:03:59Z',
        'gift_card_balance_money', pg_catalog.jsonb_build_object('amount', 4250, 'currency', 'CAD'),
        'amount_money', pg_catalog.jsonb_build_object('amount', 500, 'currency', 'CAD'),
        'payment_id', 'payment-redeem-1', 'redeem_activity_id', 'gcact:redeem-1'
      )
    ), repeat('9', 64)
  );
  SELECT x INTO v_inbox FROM public.claim_square_webhook_events('gift_cards', 1) AS x;
  v_applied := public.apply_square_gift_card_webhook_event(
    (v_inbox ->> 'inbox_id')::uuid, (v_inbox ->> 'claim_token')::uuid
  );
  IF v_applied ->> 'code' <> 'gift_card_event_applied'
     OR (SELECT count(*) FROM public.square_gift_card_activity_mirrors
         WHERE salon_id = v_salon) <> 4
     OR (SELECT count(*) FROM public.square_gift_card_activity_mirrors
         WHERE salon_id = v_salon AND square_activity_id = 'gcact:redeem-1') <> 2
     OR NOT EXISTS (
       SELECT 1 FROM public.square_gift_card_activity_mirrors
       WHERE salon_id = v_salon AND activity_type = 'REFUND'
         AND amount_cents = 500 AND value_direction = 'increase'
         AND provider_balance_after_cents = 4250
         AND square_redeem_activity_id = 'gcact:redeem-1'
     ) OR NOT EXISTS (
       SELECT 1 FROM public.square_gift_card_mirrors
       WHERE salon_id = v_salon AND state = 'ACTIVE'
         AND balance_cents = 4250 AND currency = 'CAD'
     ) THEN
    RAISE EXCEPTION 'append-only partial redeem/refund evidence failed: %', v_applied;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.square_gift_card_mirrors
    WHERE row_to_json(square_gift_card_mirrors)::text ~* '778332|secret-not-returned'
  ) OR EXISTS (
    SELECT 1 FROM public.square_gift_card_activity_mirrors
    WHERE row_to_json(square_gift_card_activity_mirrors)::text ~* '778332|secret-not-returned'
  ) THEN
    RAISE EXCEPTION 'GAN or provider secret leaked into gift card mirror';
  END IF;

  BEGIN
    UPDATE public.square_gift_card_activity_mirrors
    SET amount_cents = 9999 WHERE salon_id = v_salon;
    RAISE EXCEPTION 'immutable activity revision was updated';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  IF NOT EXISTS (
    SELECT 1 FROM public.square_sync_cursors
    WHERE salon_id = v_salon AND feature = 'gift_cards'
      AND last_event_id = 'webhook-refund-partial'
  ) THEN
    RAISE EXCEPTION 'gift card cursor did not advance atomically';
  END IF;
END;
$square_gift_card_rehearsal$;

ROLLBACK;

SELECT 'PASS Square Gift Card receipt-bound append-only reconciliation mirror' AS result;
