-- MQA-0127: fail-closed Square retail inventory reconciliation.
-- Square remains the source of truth. This migration performs no provider
-- call, enables no capability, maps no service/ingredient/bundle, and never
-- turns a catalog variation into a confirmed NailIQ retail mapping without an
-- owner/admin decision derived from auth.uid().

CREATE TABLE public.square_inventory_catalog_variation_mirrors (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  provider_account_fingerprint text NOT NULL
    CHECK (provider_account_fingerprint ~ '^[0-9a-f]{64}$'),
  square_catalog_variation_id text NOT NULL
    CHECK (length(square_catalog_variation_id) BETWEEN 1 AND 255
      AND square_catalog_variation_id !~ '[[:cntrl:]]'),
  square_catalog_item_id text NOT NULL
    CHECK (length(square_catalog_item_id) BETWEEN 1 AND 255
      AND square_catalog_item_id !~ '[[:cntrl:]]'),
  provider_version bigint NOT NULL CHECK (provider_version >= 0),
  product_type text NOT NULL CHECK (product_type = 'REGULAR'),
  item_name text NOT NULL CHECK (length(item_name) BETWEEN 1 AND 500 AND item_name !~ '[[:cntrl:]]'),
  variation_name text NOT NULL CHECK (length(variation_name) BETWEEN 1 AND 500 AND variation_name !~ '[[:cntrl:]]'),
  sku text CHECK (sku IS NULL OR (length(sku) BETWEEN 1 AND 255 AND sku !~ '[[:cntrl:]]')),
  is_deleted boolean NOT NULL,
  track_inventory boolean NOT NULL,
  present_at_bound_location boolean NOT NULL,
  square_updated_at timestamptz NOT NULL,
  provider_latest_time timestamptz NOT NULL,
  material_fingerprint text NOT NULL CHECK (material_fingerprint ~ '^[0-9a-f]{64}$'),
  source_operation_id uuid NOT NULL
    REFERENCES public.square_feature_operations(id) ON DELETE RESTRICT,
  first_synced_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  last_synced_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (salon_id, provider_account_fingerprint, square_catalog_variation_id),
  UNIQUE (salon_id, id)
);

CREATE INDEX square_inventory_catalog_item_idx
  ON public.square_inventory_catalog_variation_mirrors (
    salon_id, provider_account_fingerprint, square_catalog_item_id
  );
CREATE INDEX square_inventory_catalog_source_operation_idx
  ON public.square_inventory_catalog_variation_mirrors (source_operation_id);

CREATE TABLE public.square_inventory_retail_mappings (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  salon_id uuid NOT NULL,
  catalog_variation_mirror_id uuid NOT NULL,
  square_location_id text NOT NULL
    CHECK (length(square_location_id) BETWEEN 1 AND 255 AND square_location_id !~ '[[:cntrl:]]'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'rejected')),
  decided_by_user_id uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (salon_id, catalog_variation_mirror_id, square_location_id),
  FOREIGN KEY (salon_id, catalog_variation_mirror_id)
    REFERENCES public.square_inventory_catalog_variation_mirrors(salon_id, id) ON DELETE CASCADE,
  CONSTRAINT square_inventory_mapping_decision_complete CHECK (
    (status = 'pending' AND decided_by_user_id IS NULL AND decided_at IS NULL)
    OR (status IN ('confirmed', 'rejected') AND decided_by_user_id IS NOT NULL AND decided_at IS NOT NULL)
  )
);

CREATE INDEX square_inventory_retail_mapping_variation_fk_idx
  ON public.square_inventory_retail_mappings (salon_id, catalog_variation_mirror_id);
CREATE INDEX square_inventory_retail_mapping_actor_fk_idx
  ON public.square_inventory_retail_mappings (decided_by_user_id)
  WHERE decided_by_user_id IS NOT NULL;

CREATE TABLE public.square_inventory_count_event_mirrors (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  inbox_id uuid NOT NULL REFERENCES public.square_webhook_inbox(id) ON DELETE RESTRICT,
  event_sequence smallint NOT NULL CHECK (event_sequence BETWEEN 1 AND 100),
  provider_account_fingerprint text NOT NULL
    CHECK (provider_account_fingerprint ~ '^[0-9a-f]{64}$'),
  webhook_event_id text NOT NULL
    CHECK (length(webhook_event_id) BETWEEN 1 AND 255 AND webhook_event_id !~ '[[:cntrl:]]'),
  square_catalog_variation_id text NOT NULL
    CHECK (length(square_catalog_variation_id) BETWEEN 1 AND 255
      AND square_catalog_variation_id !~ '[[:cntrl:]]'),
  square_location_id text NOT NULL
    CHECK (length(square_location_id) BETWEEN 1 AND 255 AND square_location_id !~ '[[:cntrl:]]'),
  inventory_state text NOT NULL CHECK (inventory_state IN (
    'CUSTOM','IN_STOCK','SOLD','RETURNED_BY_CUSTOMER','RESERVED_FOR_SALE',
    'SOLD_ONLINE','ORDERED_FROM_VENDOR','RECEIVED_FROM_VENDOR','IN_TRANSIT_TO',
    'IN_TRANSIT','NONE','WASTE','UNLINKED_RETURN','UNTRACKED','COMPOSED',
    'DECOMPOSED','SUPPORTED_BY_NEWER_VERSION'
  )),
  quantity numeric(17,5) NOT NULL CHECK (quantity BETWEEN -999999999999 AND 999999999999),
  calculated_at timestamptz NOT NULL,
  webhook_occurred_at timestamptz NOT NULL,
  payload_fingerprint text NOT NULL CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (inbox_id, event_sequence),
  UNIQUE (provider_account_fingerprint, webhook_event_id, event_sequence)
);

CREATE INDEX square_inventory_count_event_history_idx
  ON public.square_inventory_count_event_mirrors (
    salon_id, square_location_id, square_catalog_variation_id,
    inventory_state, calculated_at DESC
  );

CREATE TABLE public.square_inventory_count_mirrors (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  provider_account_fingerprint text NOT NULL
    CHECK (provider_account_fingerprint ~ '^[0-9a-f]{64}$'),
  square_catalog_variation_id text NOT NULL
    CHECK (length(square_catalog_variation_id) BETWEEN 1 AND 255
      AND square_catalog_variation_id !~ '[[:cntrl:]]'),
  square_location_id text NOT NULL
    CHECK (length(square_location_id) BETWEEN 1 AND 255 AND square_location_id !~ '[[:cntrl:]]'),
  inventory_state text NOT NULL CHECK (inventory_state IN (
    'CUSTOM','IN_STOCK','SOLD','RETURNED_BY_CUSTOMER','RESERVED_FOR_SALE',
    'SOLD_ONLINE','ORDERED_FROM_VENDOR','RECEIVED_FROM_VENDOR','IN_TRANSIT_TO',
    'IN_TRANSIT','NONE','WASTE','UNLINKED_RETURN','UNTRACKED','COMPOSED',
    'DECOMPOSED','SUPPORTED_BY_NEWER_VERSION'
  )),
  quantity numeric(17,5) NOT NULL CHECK (quantity BETWEEN -999999999999 AND 999999999999),
  calculated_at timestamptz NOT NULL,
  last_event_at timestamptz NOT NULL,
  last_event_id text NOT NULL
    CHECK (length(last_event_id) BETWEEN 1 AND 255 AND last_event_id !~ '[[:cntrl:]]'),
  source_event_mirror_id uuid NOT NULL
    REFERENCES public.square_inventory_count_event_mirrors(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (
    salon_id, provider_account_fingerprint, square_catalog_variation_id,
    square_location_id, inventory_state
  )
);

CREATE INDEX square_inventory_count_source_event_idx
  ON public.square_inventory_count_mirrors (source_event_mirror_id);
CREATE INDEX square_inventory_count_location_idx
  ON public.square_inventory_count_mirrors (
    salon_id, square_location_id, square_catalog_variation_id
  );

CREATE TABLE public.square_inventory_catalog_sync_state (
  salon_id uuid PRIMARY KEY REFERENCES public.salons(id) ON DELETE CASCADE,
  provider_account_fingerprint text NOT NULL
    CHECK (provider_account_fingerprint ~ '^[0-9a-f]{64}$'),
  square_location_id text NOT NULL
    CHECK (length(square_location_id) BETWEEN 1 AND 255 AND square_location_id !~ '[[:cntrl:]]'),
  refresh_required boolean NOT NULL DEFAULT false,
  refresh_required_since timestamptz,
  last_provider_latest_time timestamptz,
  active_catalog_begin_time timestamptz,
  active_catalog_cursor text CHECK (
    active_catalog_cursor IS NULL OR (
      length(active_catalog_cursor) BETWEEN 1 AND 2048
      AND active_catalog_cursor !~ '[[:cntrl:]]'
    )
  ),
  last_catalog_operation_id uuid REFERENCES public.square_feature_operations(id) ON DELETE RESTRICT,
  last_catalog_receipt_id text
    CHECK (last_catalog_receipt_id IS NULL OR (
      length(last_catalog_receipt_id) BETWEEN 1 AND 255 AND last_catalog_receipt_id !~ '[[:cntrl:]]'
    )),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT square_inventory_refresh_shape CHECK (
    (refresh_required AND refresh_required_since IS NOT NULL)
    OR (NOT refresh_required)
  ),
  CONSTRAINT square_inventory_catalog_receipt_shape CHECK (
    (last_catalog_operation_id IS NULL AND last_catalog_receipt_id IS NULL AND last_provider_latest_time IS NULL)
    OR (last_catalog_operation_id IS NOT NULL AND last_catalog_receipt_id IS NOT NULL AND last_provider_latest_time IS NOT NULL)
  )
);

CREATE INDEX square_inventory_catalog_sync_operation_idx
  ON public.square_inventory_catalog_sync_state (last_catalog_operation_id)
  WHERE last_catalog_operation_id IS NOT NULL;

ALTER TABLE public.square_inventory_catalog_variation_mirrors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.square_inventory_catalog_variation_mirrors FORCE ROW LEVEL SECURITY;
ALTER TABLE public.square_inventory_retail_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.square_inventory_retail_mappings FORCE ROW LEVEL SECURITY;
ALTER TABLE public.square_inventory_count_event_mirrors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.square_inventory_count_event_mirrors FORCE ROW LEVEL SECURITY;
ALTER TABLE public.square_inventory_count_mirrors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.square_inventory_count_mirrors FORCE ROW LEVEL SECURITY;
ALTER TABLE public.square_inventory_catalog_sync_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.square_inventory_catalog_sync_state FORCE ROW LEVEL SECURITY;

REVOKE ALL ON public.square_inventory_catalog_variation_mirrors,
  public.square_inventory_retail_mappings,
  public.square_inventory_count_event_mirrors,
  public.square_inventory_count_mirrors,
  public.square_inventory_catalog_sync_state
FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT ON public.square_inventory_catalog_variation_mirrors,
  public.square_inventory_retail_mappings,
  public.square_inventory_count_event_mirrors,
  public.square_inventory_count_mirrors,
  public.square_inventory_catalog_sync_state
TO service_role;
GRANT SELECT ON public.square_inventory_catalog_variation_mirrors,
  public.square_inventory_retail_mappings,
  public.square_inventory_count_mirrors
TO authenticated;

CREATE POLICY "inventory managers read catalog variations"
  ON public.square_inventory_catalog_variation_mirrors
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.salon_members AS m
    WHERE m.salon_id = square_inventory_catalog_variation_mirrors.salon_id
      AND m.user_id = (SELECT auth.uid()) AND m.role IN ('owner', 'admin')
  ));

CREATE POLICY "inventory managers read retail mappings"
  ON public.square_inventory_retail_mappings
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.salon_members AS m
    WHERE m.salon_id = square_inventory_retail_mappings.salon_id
      AND m.user_id = (SELECT auth.uid()) AND m.role IN ('owner', 'admin')
  ));

CREATE POLICY "inventory managers read counts"
  ON public.square_inventory_count_mirrors
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.salon_members AS m
    WHERE m.salon_id = square_inventory_count_mirrors.salon_id
      AND m.user_id = (SELECT auth.uid()) AND m.role IN ('owner', 'admin')
  ));

CREATE OR REPLACE FUNCTION public.reject_square_inventory_count_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $reject_square_inventory_count_event_mutation$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '42501',
    MESSAGE = 'Square inventory count event mirrors are immutable';
END;
$reject_square_inventory_count_event_mutation$;

REVOKE ALL ON FUNCTION public.reject_square_inventory_count_event_mutation()
FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER reject_square_inventory_count_event_mutation
  BEFORE UPDATE OR DELETE ON public.square_inventory_count_event_mirrors
  FOR EACH ROW EXECUTE FUNCTION public.reject_square_inventory_count_event_mutation();

CREATE OR REPLACE FUNCTION public.confirm_square_inventory_retail_mapping(
  p_salon_id uuid,
  p_catalog_variation_mirror_id uuid,
  p_decision text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $confirm_square_inventory_retail_mapping$
DECLARE
  v_actor uuid := (SELECT auth.uid());
  v_mapping public.square_inventory_retail_mappings%ROWTYPE;
  v_variation public.square_inventory_catalog_variation_mirrors%ROWTYPE;
BEGIN
  IF v_actor IS NULL OR p_decision NOT IN ('confirmed', 'rejected') THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.salon_members AS m
    WHERE m.salon_id = p_salon_id AND m.user_id = v_actor
      AND m.role IN ('owner', 'admin')
  ) THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;

  SELECT * INTO v_variation
  FROM public.square_inventory_catalog_variation_mirrors
  WHERE id = p_catalog_variation_mirror_id AND salon_id = p_salon_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'variation_not_found');
  END IF;
  IF v_variation.is_deleted OR NOT v_variation.track_inventory
     OR NOT v_variation.present_at_bound_location OR v_variation.product_type <> 'REGULAR' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'variation_not_retail_inventory');
  END IF;

  SELECT * INTO v_mapping
  FROM public.square_inventory_retail_mappings
  WHERE salon_id = p_salon_id AND catalog_variation_mirror_id = p_catalog_variation_mirror_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'mapping_not_found');
  END IF;
  IF v_mapping.status = p_decision THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', true, 'code', 'decision_replay', 'mapping_id', v_mapping.id,
      'status', v_mapping.status
    );
  END IF;
  IF v_mapping.status <> 'pending' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'decision_conflict');
  END IF;

  UPDATE public.square_inventory_retail_mappings
  SET status = p_decision, decided_by_user_id = v_actor,
      decided_at = transaction_timestamp(), updated_at = transaction_timestamp()
  WHERE id = v_mapping.id
  RETURNING * INTO v_mapping;
  RETURN pg_catalog.jsonb_build_object(
    'success', true, 'code', 'mapping_decided', 'mapping_id', v_mapping.id,
    'status', v_mapping.status
  );
END;
$confirm_square_inventory_retail_mapping$;

REVOKE ALL ON FUNCTION public.confirm_square_inventory_retail_mapping(uuid, uuid, text)
FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.confirm_square_inventory_retail_mapping(uuid, uuid, text)
TO authenticated;

CREATE OR REPLACE FUNCTION public.apply_square_inventory_catalog_page(
  p_salon_id uuid,
  p_operation_id uuid,
  p_provider_latest_time timestamptz,
  p_next_cursor text,
  p_scan_begin_time timestamptz,
  p_variations jsonb,
  p_payload_fingerprint text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $apply_square_inventory_catalog_page$
DECLARE
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', ''
  );
  v_operation public.square_feature_operations%ROWTYPE;
  v_contract jsonb;
  v_row jsonb;
  v_existing public.square_inventory_catalog_variation_mirrors%ROWTYPE;
  v_mirror_id uuid;
  v_row_fingerprint text;
  v_applied integer := 0;
  v_skipped integer := 0;
BEGIN
  IF v_role <> 'service_role' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  IF p_provider_latest_time IS NULL OR p_payload_fingerprint !~ '^[0-9a-f]{64}$'
     OR (p_next_cursor IS NOT NULL AND (
       length(p_next_cursor) NOT BETWEEN 1 AND 2048 OR p_next_cursor ~ '[[:cntrl:]]'
     ))
     OR pg_catalog.jsonb_typeof(p_variations) <> 'array'
     OR pg_catalog.jsonb_array_length(p_variations) > 100 THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_catalog_page');
  END IF;

  SELECT * INTO v_operation FROM public.square_feature_operations
  WHERE id = p_operation_id AND salon_id = p_salon_id
    AND feature = 'inventory' AND operation_kind = 'inventory_catalog_variation_load'
    AND status = 'succeeded' AND provider_receipt_id IS NOT NULL
    AND result_fingerprint IS NOT NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'catalog_receipt_required');
  END IF;
  IF v_operation.result_fingerprint <> p_payload_fingerprint THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'provider_payload_mismatch');
  END IF;
  v_contract := public.square_feature_contract(p_salon_id, 'inventory');
  IF v_contract ->> 'code' <> 'ready'
     OR v_contract ->> 'provider_account_fingerprint' <> v_operation.provider_account_fingerprint THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'integration_contract_changed');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_salon_id::text || ':square_inventory_catalog', 0)
  );

  FOR v_row IN SELECT value FROM pg_catalog.jsonb_array_elements(p_variations)
  LOOP
    IF pg_catalog.jsonb_typeof(v_row) <> 'object'
       OR EXISTS (
         SELECT 1 FROM pg_catalog.jsonb_object_keys(v_row) AS k(key)
         WHERE k.key NOT IN (
           'id','item_id','version','product_type','item_name','variation_name','sku',
           'is_deleted','track_inventory','present_at_bound_location','updated_at'
         )
       )
       OR v_row ->> 'id' IS NULL OR length(v_row ->> 'id') NOT BETWEEN 1 AND 255
       OR (v_row ->> 'id') ~ '[[:cntrl:]]'
       OR v_row ->> 'item_id' IS NULL OR length(v_row ->> 'item_id') NOT BETWEEN 1 AND 255
       OR (v_row ->> 'item_id') ~ '[[:cntrl:]]'
       OR v_row ->> 'product_type' <> 'REGULAR'
       OR v_row ->> 'version' !~ '^[0-9]{1,19}$'
       OR v_row ->> 'item_name' IS NULL OR length(v_row ->> 'item_name') NOT BETWEEN 1 AND 500
       OR (v_row ->> 'item_name') ~ '[[:cntrl:]]'
       OR v_row ->> 'variation_name' IS NULL OR length(v_row ->> 'variation_name') NOT BETWEEN 1 AND 500
       OR (v_row ->> 'variation_name') ~ '[[:cntrl:]]'
       OR (v_row ? 'sku' AND v_row -> 'sku' <> 'null'::jsonb AND (
         length(v_row ->> 'sku') NOT BETWEEN 1 AND 255 OR (v_row ->> 'sku') ~ '[[:cntrl:]]'
       ))
       OR pg_catalog.jsonb_typeof(v_row -> 'is_deleted') <> 'boolean'
       OR pg_catalog.jsonb_typeof(v_row -> 'track_inventory') <> 'boolean'
       OR pg_catalog.jsonb_typeof(v_row -> 'present_at_bound_location') <> 'boolean'
       OR v_row ->> 'updated_at' IS NULL THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_catalog_variation');
    END IF;
    BEGIN
      PERFORM (v_row ->> 'version')::bigint;
      PERFORM (v_row ->> 'updated_at')::timestamptz;
    EXCEPTION WHEN numeric_value_out_of_range OR datetime_field_overflow OR invalid_datetime_format THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_catalog_variation');
    END;

    v_row_fingerprint := encode(
      extensions.digest(pg_catalog.convert_to(v_row::text, 'UTF8'), 'sha256'), 'hex'
    );
    SELECT * INTO v_existing
    FROM public.square_inventory_catalog_variation_mirrors
    WHERE salon_id = p_salon_id
      AND provider_account_fingerprint = v_operation.provider_account_fingerprint
      AND square_catalog_variation_id = v_row ->> 'id'
    FOR UPDATE;

    IF FOUND AND v_existing.provider_version > (v_row ->> 'version')::bigint THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;
    IF FOUND AND v_existing.provider_version = (v_row ->> 'version')::bigint
       AND v_existing.material_fingerprint <> v_row_fingerprint THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'catalog_version_conflict');
    END IF;

    INSERT INTO public.square_inventory_catalog_variation_mirrors(
      salon_id, provider_account_fingerprint, square_catalog_variation_id,
      square_catalog_item_id, provider_version, product_type, item_name,
      variation_name, sku, is_deleted, track_inventory, present_at_bound_location,
      square_updated_at, provider_latest_time, material_fingerprint, source_operation_id
    ) VALUES (
      p_salon_id, v_operation.provider_account_fingerprint, v_row ->> 'id',
      v_row ->> 'item_id', (v_row ->> 'version')::bigint, 'REGULAR',
      v_row ->> 'item_name', v_row ->> 'variation_name', nullif(v_row ->> 'sku', ''),
      (v_row ->> 'is_deleted')::boolean, (v_row ->> 'track_inventory')::boolean,
      (v_row ->> 'present_at_bound_location')::boolean,
      (v_row ->> 'updated_at')::timestamptz, p_provider_latest_time,
      v_row_fingerprint, p_operation_id
    )
    ON CONFLICT (salon_id, provider_account_fingerprint, square_catalog_variation_id)
    DO UPDATE SET
      square_catalog_item_id = EXCLUDED.square_catalog_item_id,
      provider_version = EXCLUDED.provider_version,
      product_type = EXCLUDED.product_type,
      item_name = EXCLUDED.item_name,
      variation_name = EXCLUDED.variation_name,
      sku = EXCLUDED.sku,
      is_deleted = EXCLUDED.is_deleted,
      track_inventory = EXCLUDED.track_inventory,
      present_at_bound_location = EXCLUDED.present_at_bound_location,
      square_updated_at = EXCLUDED.square_updated_at,
      provider_latest_time = GREATEST(
        square_inventory_catalog_variation_mirrors.provider_latest_time,
        EXCLUDED.provider_latest_time
      ),
      material_fingerprint = EXCLUDED.material_fingerprint,
      source_operation_id = EXCLUDED.source_operation_id,
      last_synced_at = transaction_timestamp()
    RETURNING id INTO v_mirror_id;

    IF NOT (v_row ->> 'is_deleted')::boolean
       AND (v_row ->> 'track_inventory')::boolean
       AND (v_row ->> 'present_at_bound_location')::boolean THEN
      INSERT INTO public.square_inventory_retail_mappings(
        salon_id, catalog_variation_mirror_id, square_location_id
      ) VALUES (p_salon_id, v_mirror_id, v_contract ->> 'location_id')
      ON CONFLICT (salon_id, catalog_variation_mirror_id, square_location_id) DO NOTHING;
    END IF;
    v_applied := v_applied + 1;
  END LOOP;

  INSERT INTO public.square_inventory_catalog_sync_state(
    salon_id, provider_account_fingerprint, square_location_id,
    refresh_required, refresh_required_since, last_provider_latest_time,
    active_catalog_begin_time, active_catalog_cursor,
    last_catalog_operation_id, last_catalog_receipt_id
  ) VALUES (
    p_salon_id, v_operation.provider_account_fingerprint, v_contract ->> 'location_id',
    false, NULL, p_provider_latest_time,
    CASE WHEN p_next_cursor IS NULL THEN NULL ELSE p_scan_begin_time END,
    p_next_cursor, p_operation_id, v_operation.provider_receipt_id
  )
  ON CONFLICT (salon_id) DO UPDATE SET
    provider_account_fingerprint = EXCLUDED.provider_account_fingerprint,
    square_location_id = EXCLUDED.square_location_id,
    last_provider_latest_time = GREATEST(
      square_inventory_catalog_sync_state.last_provider_latest_time,
      EXCLUDED.last_provider_latest_time
    ),
    active_catalog_begin_time = CASE
      WHEN square_inventory_catalog_sync_state.last_provider_latest_time IS NULL
        OR EXCLUDED.last_provider_latest_time >= square_inventory_catalog_sync_state.last_provider_latest_time
      THEN EXCLUDED.active_catalog_begin_time
      ELSE square_inventory_catalog_sync_state.active_catalog_begin_time
    END,
    active_catalog_cursor = CASE
      WHEN square_inventory_catalog_sync_state.last_provider_latest_time IS NULL
        OR EXCLUDED.last_provider_latest_time >= square_inventory_catalog_sync_state.last_provider_latest_time
      THEN EXCLUDED.active_catalog_cursor
      ELSE square_inventory_catalog_sync_state.active_catalog_cursor
    END,
    last_catalog_operation_id = CASE
      WHEN square_inventory_catalog_sync_state.last_provider_latest_time IS NULL
        OR EXCLUDED.last_provider_latest_time >= square_inventory_catalog_sync_state.last_provider_latest_time
      THEN EXCLUDED.last_catalog_operation_id
      ELSE square_inventory_catalog_sync_state.last_catalog_operation_id
    END,
    last_catalog_receipt_id = CASE
      WHEN square_inventory_catalog_sync_state.last_provider_latest_time IS NULL
        OR EXCLUDED.last_provider_latest_time >= square_inventory_catalog_sync_state.last_provider_latest_time
      THEN EXCLUDED.last_catalog_receipt_id
      ELSE square_inventory_catalog_sync_state.last_catalog_receipt_id
    END,
    refresh_required = CASE
      WHEN square_inventory_catalog_sync_state.refresh_required_since IS NULL THEN false
      WHEN EXCLUDED.last_provider_latest_time >= square_inventory_catalog_sync_state.refresh_required_since THEN false
      ELSE true
    END,
    refresh_required_since = CASE
      WHEN square_inventory_catalog_sync_state.refresh_required_since IS NULL THEN NULL
      WHEN EXCLUDED.last_provider_latest_time >= square_inventory_catalog_sync_state.refresh_required_since THEN NULL
      ELSE square_inventory_catalog_sync_state.refresh_required_since
    END,
    updated_at = transaction_timestamp();

  INSERT INTO public.square_sync_cursors(
    salon_id, feature, provider_account_fingerprint, opaque_cursor
  ) VALUES (
    p_salon_id, 'inventory', v_operation.provider_account_fingerprint,
    p_provider_latest_time::text
  )
  ON CONFLICT (salon_id, feature) DO UPDATE SET
    provider_account_fingerprint = EXCLUDED.provider_account_fingerprint,
    opaque_cursor = CASE
      WHEN square_sync_cursors.opaque_cursor IS NULL
        OR EXCLUDED.opaque_cursor::timestamptz >= square_sync_cursors.opaque_cursor::timestamptz
      THEN EXCLUDED.opaque_cursor ELSE square_sync_cursors.opaque_cursor
    END,
    updated_at = transaction_timestamp();

  RETURN pg_catalog.jsonb_build_object(
    'success', true, 'code', 'catalog_page_applied',
    'applied', v_applied, 'stale_skipped', v_skipped,
    'provider_latest_time', p_provider_latest_time
  );
END;
$apply_square_inventory_catalog_page$;

REVOKE ALL ON FUNCTION public.apply_square_inventory_catalog_page(
  uuid, uuid, timestamptz, text, timestamptz, jsonb, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_square_inventory_catalog_page(
  uuid, uuid, timestamptz, text, timestamptz, jsonb, text
) TO service_role;

CREATE OR REPLACE FUNCTION public.reconcile_stale_square_inventory_catalog_operations(
  p_limit integer DEFAULT 25
)
RETURNS SETOF jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $reconcile_stale_square_inventory_catalog_operations$
DECLARE
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', ''
  );
  v_operation public.square_feature_operations%ROWTYPE;
BEGIN
  IF v_role <> 'service_role' OR p_limit NOT BETWEEN 1 AND 100 THEN
    RETURN;
  END IF;
  FOR v_operation IN
    SELECT * FROM public.square_feature_operations
    WHERE feature = 'inventory'
      AND operation_kind = 'inventory_catalog_variation_load'
      AND (
        (status = 'sending' AND lease_expires_at <= clock_timestamp())
        OR status = 'pending_provider'
        OR (status = 'reconciling' AND lease_expires_at <= clock_timestamp())
      )
    ORDER BY created_at
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  LOOP
    UPDATE public.square_feature_operations
    SET status = 'reconciling', attempt_token = gen_random_uuid(),
      attempt_count = attempt_count + 1,
      lease_expires_at = clock_timestamp() + interval '5 minutes',
      error_code = 'provider_read_retry_safe', updated_at = clock_timestamp()
    WHERE id = v_operation.id
    RETURNING * INTO v_operation;
    RETURN NEXT jsonb_build_object(
      'success', true, 'code', 'reconciliation_claimed',
      'salon_id', v_operation.salon_id,
      'operation_id', v_operation.id,
      'attempt_token', v_operation.attempt_token,
      'material', v_operation.material,
      'material_fingerprint', v_operation.material_fingerprint
    );
  END LOOP;
END;
$reconcile_stale_square_inventory_catalog_operations$;

REVOKE ALL ON FUNCTION public.reconcile_stale_square_inventory_catalog_operations(integer)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_stale_square_inventory_catalog_operations(integer)
TO service_role;

CREATE OR REPLACE FUNCTION public.apply_square_inventory_webhook_event(
  p_inbox_id uuid,
  p_claim_token uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $apply_square_inventory_webhook_event$
DECLARE
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', ''
  );
  v_inbox public.square_webhook_inbox%ROWTYPE;
  v_contract jsonb;
  v_count jsonb;
  v_event_sequence integer;
  v_event_mirror_id uuid;
  v_result_fingerprint text;
  v_catalog_updated_at timestamptz;
  v_applied integer := 0;
BEGIN
  IF v_role <> 'service_role' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  SELECT * INTO v_inbox FROM public.square_webhook_inbox
  WHERE id = p_inbox_id FOR UPDATE;
  IF NOT FOUND OR v_inbox.feature <> 'inventory' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'inventory_event_not_found');
  END IF;
  IF v_inbox.status = 'processed' THEN
    RETURN pg_catalog.jsonb_build_object('success', true, 'code', 'application_replay');
  END IF;
  IF v_inbox.status <> 'processing' OR v_inbox.claim_token IS DISTINCT FROM p_claim_token THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'claim_mismatch');
  END IF;
  v_contract := public.square_feature_contract(v_inbox.salon_id, 'inventory');
  IF v_contract ->> 'code' <> 'ready'
     OR v_contract ->> 'provider_account_fingerprint' <> v_inbox.provider_account_fingerprint THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'integration_contract_changed');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_inbox.salon_id::text || ':square_inventory_webhook', 0)
  );

  IF v_inbox.event_type = 'inventory.count.updated' THEN
    IF pg_catalog.jsonb_typeof(v_inbox.material -> 'counts') <> 'array'
       OR pg_catalog.jsonb_array_length(v_inbox.material -> 'counts') NOT BETWEEN 1 AND 100 THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_inventory_event');
    END IF;
    FOR v_count, v_event_sequence IN
      SELECT value, ordinality::integer
      FROM pg_catalog.jsonb_array_elements(v_inbox.material -> 'counts') WITH ORDINALITY
    LOOP
      IF v_count ->> 'catalog_object_type' <> 'ITEM_VARIATION'
         OR v_count ->> 'location_id' <> v_contract ->> 'location_id'
         OR v_count ->> 'catalog_object_id' IS NULL
         OR length(v_count ->> 'catalog_object_id') NOT BETWEEN 1 AND 255
         OR (v_count ->> 'catalog_object_id') ~ '[[:cntrl:]]'
         OR v_count ->> 'quantity' !~ '^-?[0-9]{1,12}([.][0-9]{1,5})?$'
         OR v_count ->> 'state' NOT IN (
           'CUSTOM','IN_STOCK','SOLD','RETURNED_BY_CUSTOMER','RESERVED_FOR_SALE',
           'SOLD_ONLINE','ORDERED_FROM_VENDOR','RECEIVED_FROM_VENDOR','IN_TRANSIT_TO',
           'IN_TRANSIT','NONE','WASTE','UNLINKED_RETURN','UNTRACKED','COMPOSED',
           'DECOMPOSED','SUPPORTED_BY_NEWER_VERSION'
         ) THEN
        RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_inventory_event');
      END IF;
      BEGIN
        PERFORM (v_count ->> 'calculated_at')::timestamptz;
      EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
        RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_inventory_event');
      END;

      INSERT INTO public.square_inventory_count_event_mirrors(
        salon_id, inbox_id, event_sequence, provider_account_fingerprint,
        webhook_event_id, square_catalog_variation_id, square_location_id,
        inventory_state, quantity, calculated_at, webhook_occurred_at,
        payload_fingerprint
      ) VALUES (
        v_inbox.salon_id, v_inbox.id, v_event_sequence,
        v_inbox.provider_account_fingerprint, v_inbox.event_id,
        v_count ->> 'catalog_object_id', v_count ->> 'location_id',
        v_count ->> 'state', (v_count ->> 'quantity')::numeric,
        (v_count ->> 'calculated_at')::timestamptz, v_inbox.occurred_at,
        v_inbox.payload_fingerprint
      )
      ON CONFLICT (inbox_id, event_sequence) DO UPDATE
      SET inbox_id = EXCLUDED.inbox_id
      RETURNING id INTO v_event_mirror_id;

      INSERT INTO public.square_inventory_count_mirrors(
        salon_id, provider_account_fingerprint, square_catalog_variation_id,
        square_location_id, inventory_state, quantity, calculated_at,
        last_event_at, last_event_id, source_event_mirror_id
      ) VALUES (
        v_inbox.salon_id, v_inbox.provider_account_fingerprint,
        v_count ->> 'catalog_object_id', v_count ->> 'location_id',
        v_count ->> 'state', (v_count ->> 'quantity')::numeric,
        (v_count ->> 'calculated_at')::timestamptz, v_inbox.occurred_at,
        v_inbox.event_id, v_event_mirror_id
      )
      ON CONFLICT (
        salon_id, provider_account_fingerprint, square_catalog_variation_id,
        square_location_id, inventory_state
      ) DO UPDATE SET
        quantity = EXCLUDED.quantity,
        calculated_at = EXCLUDED.calculated_at,
        last_event_at = EXCLUDED.last_event_at,
        last_event_id = EXCLUDED.last_event_id,
        source_event_mirror_id = EXCLUDED.source_event_mirror_id,
        updated_at = transaction_timestamp()
      WHERE (
        EXCLUDED.calculated_at, EXCLUDED.last_event_at, EXCLUDED.last_event_id
      ) > (
        square_inventory_count_mirrors.calculated_at,
        square_inventory_count_mirrors.last_event_at,
        square_inventory_count_mirrors.last_event_id
      );
      v_applied := v_applied + 1;
    END LOOP;
  ELSIF v_inbox.event_type = 'catalog.version.updated' THEN
    BEGIN
      v_catalog_updated_at := (v_inbox.material ->> 'catalog_updated_at')::timestamptz;
    EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_catalog_event');
    END;
    IF v_catalog_updated_at IS NULL THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_catalog_event');
    END IF;
    INSERT INTO public.square_inventory_catalog_sync_state(
      salon_id, provider_account_fingerprint, square_location_id,
      refresh_required, refresh_required_since
    ) VALUES (
      v_inbox.salon_id, v_inbox.provider_account_fingerprint,
      v_contract ->> 'location_id', true, v_catalog_updated_at
    )
    ON CONFLICT (salon_id) DO UPDATE SET
      provider_account_fingerprint = EXCLUDED.provider_account_fingerprint,
      square_location_id = EXCLUDED.square_location_id,
      refresh_required = CASE
        WHEN square_inventory_catalog_sync_state.last_provider_latest_time IS NOT NULL
          AND square_inventory_catalog_sync_state.last_provider_latest_time >= EXCLUDED.refresh_required_since
        THEN square_inventory_catalog_sync_state.refresh_required
        ELSE true
      END,
      refresh_required_since = CASE
        WHEN square_inventory_catalog_sync_state.last_provider_latest_time IS NOT NULL
          AND square_inventory_catalog_sync_state.last_provider_latest_time >= EXCLUDED.refresh_required_since
        THEN square_inventory_catalog_sync_state.refresh_required_since
        ELSE GREATEST(
          square_inventory_catalog_sync_state.refresh_required_since,
          EXCLUDED.refresh_required_since
        )
      END,
      updated_at = transaction_timestamp();
    v_applied := 1;
  ELSE
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'unsupported_inventory_event');
  END IF;

  v_result_fingerprint := encode(extensions.digest(pg_catalog.convert_to(
    v_inbox.id::text || E'\n' || v_inbox.payload_fingerprint || E'\n' || v_applied::text,
    'UTF8'
  ), 'sha256'), 'hex');
  UPDATE public.square_webhook_inbox
  SET status = 'processed', result_fingerprint = v_result_fingerprint,
      error_code = NULL, claim_token = NULL, lease_expires_at = NULL,
      completed_at = clock_timestamp()
  WHERE id = v_inbox.id;

  INSERT INTO public.square_sync_cursors(
    salon_id, feature, provider_account_fingerprint, last_event_at, last_event_id
  ) VALUES (
    v_inbox.salon_id, 'inventory', v_inbox.provider_account_fingerprint,
    v_inbox.occurred_at, v_inbox.event_id
  )
  ON CONFLICT (salon_id, feature) DO UPDATE SET
    provider_account_fingerprint = EXCLUDED.provider_account_fingerprint,
    last_event_at = GREATEST(square_sync_cursors.last_event_at, EXCLUDED.last_event_at),
    last_event_id = CASE
      WHEN square_sync_cursors.last_event_at IS NULL
        OR (EXCLUDED.last_event_at, EXCLUDED.last_event_id)
          >= (square_sync_cursors.last_event_at, square_sync_cursors.last_event_id)
      THEN EXCLUDED.last_event_id ELSE square_sync_cursors.last_event_id
    END,
    updated_at = transaction_timestamp();

  RETURN pg_catalog.jsonb_build_object(
    'success', true, 'code', 'inventory_event_applied',
    'event_id', v_inbox.event_id, 'rows_applied', v_applied
  );
END;
$apply_square_inventory_webhook_event$;

REVOKE ALL ON FUNCTION public.apply_square_inventory_webhook_event(uuid, uuid)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_square_inventory_webhook_event(uuid, uuid)
TO service_role;

COMMENT ON TABLE public.square_inventory_catalog_variation_mirrors IS
  'Read-only Square CatalogItemVariation retail mirror. Never services, ingredients, or bundles.';
COMMENT ON TABLE public.square_inventory_retail_mappings IS
  'Bound-location retail mapping candidates; only owner/admin auth.uid decisions can confirm or reject.';
COMMENT ON TABLE public.square_inventory_count_event_mirrors IS
  'Immutable provider count revisions adopted from claimed, signature-verified Square webhook inbox rows.';
COMMENT ON TABLE public.square_inventory_count_mirrors IS
  'Latest Square-computed quantity by variation, location, and inventory state; Square remains authoritative.';
COMMENT ON TABLE public.square_inventory_catalog_sync_state IS
  'Catalog webhook refresh marker and Square SearchCatalogObjects latest_time receipt cursor.';
