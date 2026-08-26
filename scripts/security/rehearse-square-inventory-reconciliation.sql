\set ON_ERROR_STOP on

-- Disposable local-only MQA-0127 acceptance. No provider call is made and the
-- transaction rolls back all fixtures and platform-flag changes.
BEGIN;
SET LOCAL request.jwt.claim.role = 'service_role';

DO $square_inventory_rehearsal$
DECLARE
  v_salon constant uuid := '51270000-0000-4000-8000-000000000001';
  v_owner constant uuid := '51270000-0000-4000-8000-000000000002';
  v_request constant uuid := '51270000-0000-4000-8000-000000000003';
  v_operation_id uuid;
  v_attempt_token uuid;
  v_contract jsonb;
  v_resolved jsonb;
  v_claim jsonb;
  v_done jsonb;
  v_applied jsonb;
  v_recorded jsonb;
  v_inbox jsonb;
  v_fingerprint text;
  v_mapping_id uuid;
  v_variation_id uuid;
  v_service_count bigint;
BEGIN
  INSERT INTO auth.users(id, email, created_at)
  VALUES(v_owner, 'square-inventory-owner@nailiq.invalid', now());
  INSERT INTO public.salons(id, slug, name, phone, timezone, currency_code)
  VALUES(v_salon, 'square-inventory-reconcile-qa', 'Square Inventory QA', '+16045550127', 'UTC', 'CAD');
  INSERT INTO public.salon_members(salon_id, user_id, role)
  VALUES(v_salon, v_owner, 'owner');
  SELECT count(*) INTO v_service_count FROM public.services WHERE salon_id = v_salon;

  INSERT INTO public.square_integrations(
    salon_id, merchant_id, location_id, application_id, access_token,
    environment, enabled, oauth_scopes, inventory_sync_enabled
  ) VALUES (
    v_salon, 'merchant_inventory_qa', 'location_inventory_qa',
    'application_inventory_qa', 'secret-not-returned', 'sandbox', true,
    ARRAY['INVENTORY_READ', 'INVENTORY_WRITE', 'ITEMS_READ'], true
  );
  INSERT INTO public.platform_settings(id) VALUES('platform') ON CONFLICT(id) DO NOTHING;
  UPDATE public.platform_settings SET square_inventory_platform_enabled = true WHERE id = 'platform';

  v_contract := public.square_feature_contract(v_salon, 'inventory');
  IF v_contract ->> 'code' <> 'ready' THEN
    RAISE EXCEPTION 'inventory contract not ready: %', v_contract;
  END IF;
  v_fingerprint := v_contract ->> 'provider_account_fingerprint';

  v_resolved := public.resolve_square_feature_operation_material(
    v_salon, 'inventory_catalog_variation_load',
    pg_catalog.jsonb_build_object('source_id', 'catalog-page-1')
  );
  v_claim := public.claim_square_feature_operation(
    v_salon, v_request, 'inventory_catalog_variation_load',
    pg_catalog.jsonb_build_object('source_id', 'catalog-page-1'),
    v_resolved ->> 'material_fingerprint'
  );
  v_operation_id := (v_claim ->> 'operation_id')::uuid;
  v_attempt_token := (v_claim ->> 'attempt_token')::uuid;
  v_done := public.complete_square_feature_operation(
    v_operation_id, v_attempt_token, 'succeeded', 'catalog-search-page-1',
    'catalog-receipt-1', repeat('1', 64), NULL
  );
  IF v_done ->> 'code' <> 'operation_completed' THEN
    RAISE EXCEPTION 'catalog receipt simulation failed: %', v_done;
  END IF;

  v_applied := public.apply_square_inventory_catalog_page(
    v_salon, v_operation_id, '2026-08-22T17:00:00Z',
    'cursor-page-2', '2026-08-22T16:00:00Z',
    pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'id', 'variation-polish-red', 'item_id', 'item-polish', 'version', 1,
      'product_type', 'REGULAR', 'item_name', 'Retail Polish',
      'variation_name', 'Red', 'sku', 'POLISH-RED', 'is_deleted', false,
      'track_inventory', true, 'present_at_bound_location', true,
      'updated_at', '2026-08-22T16:59:58Z'
    )), repeat('1', 64)
  );
  IF v_applied ->> 'code' <> 'catalog_page_applied' THEN
    RAISE EXCEPTION 'catalog page did not apply: %', v_applied;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.square_inventory_catalog_sync_state
    WHERE salon_id = v_salon AND active_catalog_cursor = 'cursor-page-2'
      AND active_catalog_begin_time = '2026-08-22T16:00:00Z'::timestamptz
  ) THEN
    RAISE EXCEPTION 'catalog continuation cursor was not persisted';
  END IF;

  SELECT id INTO v_variation_id
  FROM public.square_inventory_catalog_variation_mirrors
  WHERE salon_id = v_salon AND square_catalog_variation_id = 'variation-polish-red';
  SELECT id INTO v_mapping_id
  FROM public.square_inventory_retail_mappings
  WHERE salon_id = v_salon AND catalog_variation_mirror_id = v_variation_id;
  IF v_mapping_id IS NULL OR EXISTS (
    SELECT 1 FROM public.square_inventory_retail_mappings
    WHERE id = v_mapping_id AND status <> 'pending'
  ) THEN
    RAISE EXCEPTION 'provider sync auto-confirmed or omitted manual mapping';
  END IF;
  IF (SELECT count(*) FROM public.services WHERE salon_id = v_salon) <> v_service_count THEN
    RAISE EXCEPTION 'inventory catalog sync mutated salon services';
  END IF;

  -- A webhook older than the latest provider cursor must not create false work.
  v_recorded := public.record_square_webhook_event(
    v_salon, 'catalog-old', 'catalog.version.updated', '2026-08-22T16:59:31Z',
    'merchant_inventory_qa',
    pg_catalog.jsonb_build_object(
      'merchant_id', 'merchant_inventory_qa',
      'application_id', 'application_inventory_qa',
      'environment', 'sandbox', 'api_version', '2026-07-15',
      'provider_account_fingerprint', v_fingerprint,
      'catalog_updated_at', '2026-08-22T16:59:30Z'
    ), repeat('3', 64)
  );
  SELECT x INTO v_inbox FROM public.claim_square_webhook_events('inventory', 1) AS x;
  v_applied := public.apply_square_inventory_webhook_event(
    (v_inbox ->> 'inbox_id')::uuid, (v_inbox ->> 'claim_token')::uuid
  );
  IF v_applied ->> 'code' <> 'inventory_event_applied' OR EXISTS (
    SELECT 1 FROM public.square_inventory_catalog_sync_state
    WHERE salon_id = v_salon AND refresh_required
  ) THEN
    RAISE EXCEPTION 'stale catalog webhook created false refresh work: %', v_applied;
  END IF;

  -- A current count is accepted only for the tenant-bound Square location.
  v_recorded := public.record_square_webhook_event(
    v_salon, 'inventory-count-1', 'inventory.count.updated', '2026-08-22T17:01:00Z',
    'inventory-count-1',
    pg_catalog.jsonb_build_object(
      'merchant_id', 'merchant_inventory_qa',
      'application_id', 'application_inventory_qa',
      'environment', 'sandbox', 'api_version', '2026-07-15',
      'provider_account_fingerprint', v_fingerprint,
      'counts', pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'catalog_object_id', 'variation-polish-red',
          'catalog_object_type', 'ITEM_VARIATION',
          'location_id', 'location_inventory_qa', 'quantity', '12.50000',
          'state', 'IN_STOCK', 'calculated_at', '2026-08-22T17:00:59Z'
        ),
        pg_catalog.jsonb_build_object(
          'catalog_object_id', 'variation-polish-red',
          'catalog_object_type', 'ITEM_VARIATION',
          'location_id', 'location_inventory_qa', 'quantity', '2',
          'state', 'SOLD', 'calculated_at', '2026-08-22T17:00:59Z'
        )
      )
    ), repeat('4', 64)
  );
  SELECT x INTO v_inbox FROM public.claim_square_webhook_events('inventory', 1) AS x;
  v_applied := public.apply_square_inventory_webhook_event(
    (v_inbox ->> 'inbox_id')::uuid, (v_inbox ->> 'claim_token')::uuid
  );
  IF v_applied ->> 'code' <> 'inventory_event_applied'
     OR (v_applied ->> 'rows_applied')::integer <> 2
     OR NOT EXISTS (
       SELECT 1 FROM public.square_inventory_count_mirrors
       WHERE salon_id = v_salon AND square_catalog_variation_id = 'variation-polish-red'
         AND square_location_id = 'location_inventory_qa'
         AND inventory_state = 'IN_STOCK' AND quantity = 12.5
     )
     OR (SELECT count(*) FROM public.square_inventory_count_event_mirrors
         WHERE salon_id = v_salon) <> 2 THEN
    RAISE EXCEPTION 'inventory count snapshot/ledger failed: %', v_applied;
  END IF;
  IF public.apply_square_inventory_webhook_event(
    (v_inbox ->> 'inbox_id')::uuid, (v_inbox ->> 'claim_token')::uuid
  ) ->> 'code' <> 'application_replay' THEN
    RAISE EXCEPTION 'processed inventory inbox did not replay';
  END IF;

  -- A newer catalog marker must stay pending until a provider latest_time
  -- receipt at or after the marker is applied.
  v_recorded := public.record_square_webhook_event(
    v_salon, 'catalog-new', 'catalog.version.updated', '2026-08-22T17:02:01Z',
    'merchant_inventory_qa',
    pg_catalog.jsonb_build_object(
      'merchant_id', 'merchant_inventory_qa',
      'application_id', 'application_inventory_qa',
      'environment', 'sandbox', 'api_version', '2026-07-15',
      'provider_account_fingerprint', v_fingerprint,
      'catalog_updated_at', '2026-08-22T17:02:00Z'
    ), repeat('5', 64)
  );
  SELECT x INTO v_inbox FROM public.claim_square_webhook_events('inventory', 1) AS x;
  PERFORM public.apply_square_inventory_webhook_event(
    (v_inbox ->> 'inbox_id')::uuid, (v_inbox ->> 'claim_token')::uuid
  );
  IF NOT EXISTS (
    SELECT 1 FROM public.square_inventory_catalog_sync_state
    WHERE salon_id = v_salon AND refresh_required
      AND refresh_required_since = '2026-08-22T17:02:00Z'
  ) THEN
    RAISE EXCEPTION 'new catalog marker was not retained';
  END IF;
END;
$square_inventory_rehearsal$;

-- Only an authenticated owner/admin can make the manual retail decision.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claim.sub', '51270000-0000-4000-8000-000000000002', true);

DO $mapping_decision$
DECLARE
  v_result jsonb;
  v_variation_id uuid;
BEGIN
  SELECT id INTO v_variation_id
  FROM public.square_inventory_catalog_variation_mirrors
  WHERE salon_id = '51270000-0000-4000-8000-000000000001'
    AND square_catalog_variation_id = 'variation-polish-red';
  v_result := public.confirm_square_inventory_retail_mapping(
    '51270000-0000-4000-8000-000000000001', v_variation_id, 'confirmed'
  );
  IF v_result ->> 'code' <> 'mapping_decided' OR v_result ->> 'status' <> 'confirmed' THEN
    RAISE EXCEPTION 'owner mapping decision failed: %', v_result;
  END IF;
  BEGIN
    UPDATE public.square_inventory_retail_mappings SET status = 'rejected'
    WHERE id = (v_result ->> 'mapping_id')::uuid;
    RAISE EXCEPTION 'authenticated direct mapping update escaped RPC';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  IF public.confirm_square_inventory_retail_mapping(
    '51270000-0000-4000-8000-000000000001', v_variation_id, 'confirmed'
  ) ->> 'code' <> 'decision_replay' THEN
    RAISE EXCEPTION 'same owner decision did not replay';
  END IF;
END;
$mapping_decision$;

RESET ROLE;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT set_config('request.jwt.claim.sub', '', true);

DO $final_boundary$
DECLARE
  v_operation_id uuid;
  v_result jsonb;
BEGIN
  SELECT id INTO v_operation_id
  FROM public.square_feature_operations
  WHERE salon_id = '51270000-0000-4000-8000-000000000001'
    AND operation_kind = 'inventory_catalog_variation_load'
    AND status = 'succeeded';
  v_result := public.apply_square_inventory_catalog_page(
    '51270000-0000-4000-8000-000000000001', v_operation_id,
    '2026-08-22T17:03:00Z',
    NULL, NULL,
    '[]'::jsonb, repeat('1', 64)
  );
  IF v_result ->> 'code' <> 'catalog_page_applied' OR EXISTS (
    SELECT 1 FROM public.square_inventory_catalog_sync_state
    WHERE salon_id = '51270000-0000-4000-8000-000000000001'
      AND (refresh_required OR active_catalog_cursor IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'Square latest_time receipt did not clear catalog marker: %', v_result;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.square_inventory_retail_mappings
    WHERE salon_id = '51270000-0000-4000-8000-000000000001'
      AND status = 'confirmed' AND decided_by_user_id IS NULL
  ) THEN
    RAISE EXCEPTION 'confirmed mapping lacks salon decision evidence';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.square_inventory_retail_mappings
    WHERE salon_id = '51270000-0000-4000-8000-000000000001'
      AND status = 'confirmed'
  ) THEN
    RAISE EXCEPTION 'provider refresh overwrote the owner mapping decision';
  END IF;
  IF (SELECT square_inventory_platform_enabled FROM public.platform_settings WHERE id = 'platform') IS NOT TRUE THEN
    RAISE EXCEPTION 'fixture unexpectedly disabled inventory before rollback';
  END IF;
END;
$final_boundary$;

ROLLBACK;

SELECT 'square inventory reconciliation rehearsal passed' AS result;
