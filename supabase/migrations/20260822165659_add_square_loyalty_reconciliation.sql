-- MQA-0124: local Square Loyalty reconciliation state. This migration does
-- not call Square or enable the provider capability. It turns a previously
-- inert, signature-verified inbox into an atomic PII-free provider mirror.

CREATE TABLE public.square_loyalty_account_mirrors (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  provider_account_fingerprint text NOT NULL
    CHECK (provider_account_fingerprint ~ '^[0-9a-f]{64}$'),
  square_account_id text NOT NULL
    CHECK (length(square_account_id) BETWEEN 1 AND 255 AND square_account_id !~ '[[:cntrl:]]'),
  square_program_id text
    CHECK (square_program_id IS NULL OR (length(square_program_id) BETWEEN 1 AND 255 AND square_program_id !~ '[[:cntrl:]]')),
  subject_fingerprint text
    CHECK (subject_fingerprint IS NULL OR subject_fingerprint ~ '^[0-9a-f]{64}$'),
  balance integer CHECK (balance IS NULL OR balance >= 0),
  lifetime_points integer CHECK (lifetime_points IS NULL OR lifetime_points >= 0),
  state text NOT NULL DEFAULT 'pending_account'
    CHECK (state IN ('pending_account', 'active', 'deleted')),
  provider_updated_at timestamptz,
  last_event_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (salon_id, provider_account_fingerprint, square_account_id),
  UNIQUE (salon_id, id)
);

CREATE UNIQUE INDEX square_loyalty_account_subject_once
  ON public.square_loyalty_account_mirrors (
    salon_id, provider_account_fingerprint, subject_fingerprint
  ) WHERE subject_fingerprint IS NOT NULL;
CREATE INDEX square_loyalty_account_provider_idx
  ON public.square_loyalty_account_mirrors (
    provider_account_fingerprint, square_account_id
  );

CREATE TABLE public.square_loyalty_event_mirrors (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  salon_id uuid NOT NULL,
  account_mirror_id uuid NOT NULL,
  inbox_id uuid NOT NULL UNIQUE
    REFERENCES public.square_webhook_inbox(id) ON DELETE RESTRICT,
  provider_account_fingerprint text NOT NULL
    CHECK (provider_account_fingerprint ~ '^[0-9a-f]{64}$'),
  square_event_id text NOT NULL
    CHECK (length(square_event_id) BETWEEN 1 AND 255 AND square_event_id !~ '[[:cntrl:]]'),
  event_type text NOT NULL CHECK (event_type IN (
    'ACCUMULATE_POINTS', 'ACCUMULATE_PROMOTION_POINTS', 'CREATE_REWARD',
    'REDEEM_REWARD', 'DELETE_REWARD', 'ADJUST_POINTS', 'EXPIRE_POINTS', 'OTHER'
  )),
  points_delta integer,
  square_program_id text NOT NULL
    CHECK (length(square_program_id) BETWEEN 1 AND 255 AND square_program_id !~ '[[:cntrl:]]'),
  square_reward_id text
    CHECK (square_reward_id IS NULL OR (length(square_reward_id) BETWEEN 1 AND 255 AND square_reward_id !~ '[[:cntrl:]]')),
  square_order_id text
    CHECK (square_order_id IS NULL OR (length(square_order_id) BETWEEN 1 AND 255 AND square_order_id !~ '[[:cntrl:]]')),
  square_location_id text
    CHECK (square_location_id IS NULL OR (length(square_location_id) BETWEEN 1 AND 255 AND square_location_id !~ '[[:cntrl:]]')),
  source text CHECK (source IS NULL OR source IN ('SQUARE', 'LOYALTY_API')),
  occurred_at timestamptz NOT NULL,
  payload_fingerprint text NOT NULL CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (provider_account_fingerprint, square_event_id),
  FOREIGN KEY (salon_id, account_mirror_id)
    REFERENCES public.square_loyalty_account_mirrors(salon_id, id)
    ON DELETE CASCADE,
  CONSTRAINT square_loyalty_event_points_check CHECK (
    (event_type = 'REDEEM_REWARD' AND points_delta IS NULL)
    OR (event_type <> 'REDEEM_REWARD' AND points_delta IS NOT NULL AND points_delta <> 0)
  )
);

CREATE INDEX square_loyalty_event_account_history_idx
  ON public.square_loyalty_event_mirrors (account_mirror_id, occurred_at DESC);
CREATE INDEX square_loyalty_event_account_fk_idx
  ON public.square_loyalty_event_mirrors (salon_id, account_mirror_id);
CREATE INDEX square_loyalty_event_salon_history_idx
  ON public.square_loyalty_event_mirrors (salon_id, occurred_at DESC);

CREATE TABLE public.square_loyalty_reward_mirrors (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  salon_id uuid NOT NULL,
  account_mirror_id uuid NOT NULL,
  provider_account_fingerprint text NOT NULL
    CHECK (provider_account_fingerprint ~ '^[0-9a-f]{64}$'),
  square_reward_id text NOT NULL
    CHECK (length(square_reward_id) BETWEEN 1 AND 255 AND square_reward_id !~ '[[:cntrl:]]'),
  square_program_id text NOT NULL
    CHECK (length(square_program_id) BETWEEN 1 AND 255 AND square_program_id !~ '[[:cntrl:]]'),
  status text NOT NULL CHECK (status IN ('issued', 'redeemed', 'deleted')),
  points_effect integer,
  square_order_id text
    CHECK (square_order_id IS NULL OR (length(square_order_id) BETWEEN 1 AND 255 AND square_order_id !~ '[[:cntrl:]]')),
  last_square_event_id text NOT NULL,
  provider_updated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (provider_account_fingerprint, square_reward_id),
  FOREIGN KEY (salon_id, account_mirror_id)
    REFERENCES public.square_loyalty_account_mirrors(salon_id, id)
    ON DELETE CASCADE
);

CREATE INDEX square_loyalty_reward_account_idx
  ON public.square_loyalty_reward_mirrors (account_mirror_id, provider_updated_at DESC);
CREATE INDEX square_loyalty_reward_account_fk_idx
  ON public.square_loyalty_reward_mirrors (salon_id, account_mirror_id);

ALTER TABLE public.square_loyalty_account_mirrors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.square_loyalty_account_mirrors FORCE ROW LEVEL SECURITY;
ALTER TABLE public.square_loyalty_event_mirrors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.square_loyalty_event_mirrors FORCE ROW LEVEL SECURITY;
ALTER TABLE public.square_loyalty_reward_mirrors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.square_loyalty_reward_mirrors FORCE ROW LEVEL SECURITY;

REVOKE ALL ON public.square_loyalty_account_mirrors,
  public.square_loyalty_event_mirrors,
  public.square_loyalty_reward_mirrors
FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.square_loyalty_account_mirrors,
  public.square_loyalty_event_mirrors,
  public.square_loyalty_reward_mirrors
TO service_role;

CREATE OR REPLACE FUNCTION public.reject_square_loyalty_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $reject_square_loyalty_event_mutation$
BEGIN
  IF pg_catalog.pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '42501',
    MESSAGE = 'Square loyalty event mirrors are immutable';
END;
$reject_square_loyalty_event_mutation$;

REVOKE ALL ON FUNCTION public.reject_square_loyalty_event_mutation()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER reject_square_loyalty_event_mutation
  BEFORE UPDATE OR DELETE ON public.square_loyalty_event_mirrors
  FOR EACH ROW EXECUTE FUNCTION public.reject_square_loyalty_event_mutation();

CREATE OR REPLACE FUNCTION public.bind_square_loyalty_subject(
  p_salon_id uuid,
  p_operation_id uuid,
  p_square_account_id text,
  p_subject_fingerprint text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $bind_square_loyalty_subject$
DECLARE
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_operation public.square_feature_operations%ROWTYPE;
  v_account public.square_loyalty_account_mirrors%ROWTYPE;
BEGIN
  IF v_role <> 'service_role' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  IF p_salon_id IS NULL OR p_operation_id IS NULL
     OR p_square_account_id IS NULL
     OR pg_catalog.length(p_square_account_id) NOT BETWEEN 1 AND 255
     OR p_square_account_id ~ '[[:cntrl:]]'
     OR p_subject_fingerprint IS NULL
     OR p_subject_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_subject_binding');
  END IF;

  SELECT o.* INTO v_operation
  FROM public.square_feature_operations AS o
  WHERE o.id = p_operation_id
    AND o.salon_id = p_salon_id
    AND o.feature = 'loyalty'
    AND o.operation_kind = 'loyalty_account_create'
    AND o.status = 'succeeded'
    AND o.provider_object_id = p_square_account_id
    AND o.provider_receipt_id IS NOT NULL
    AND o.material ->> 'source_id' = p_subject_fingerprint;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'provider_receipt_binding_required');
  END IF;

  SELECT a.* INTO v_account
  FROM public.square_loyalty_account_mirrors AS a
  WHERE a.salon_id = p_salon_id
    AND a.provider_account_fingerprint = v_operation.provider_account_fingerprint
    AND a.square_account_id = p_square_account_id
  FOR UPDATE;
  IF FOUND AND v_account.subject_fingerprint IS NOT NULL
     AND v_account.subject_fingerprint <> p_subject_fingerprint THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'subject_binding_conflict');
  END IF;

  INSERT INTO public.square_loyalty_account_mirrors (
    salon_id, provider_account_fingerprint, square_account_id,
    subject_fingerprint
  ) VALUES (
    p_salon_id, v_operation.provider_account_fingerprint,
    p_square_account_id, p_subject_fingerprint
  )
  ON CONFLICT (salon_id, provider_account_fingerprint, square_account_id)
  DO UPDATE SET
    subject_fingerprint = coalesce(
      public.square_loyalty_account_mirrors.subject_fingerprint,
      excluded.subject_fingerprint
    ),
    updated_at = transaction_timestamp()
  RETURNING * INTO v_account;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'code', 'subject_bound',
    'account_mirror_id', v_account.id,
    'square_account_id', v_account.square_account_id
  );
END;
$bind_square_loyalty_subject$;

REVOKE ALL ON FUNCTION public.bind_square_loyalty_subject(uuid, uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bind_square_loyalty_subject(uuid, uuid, text, text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.apply_square_loyalty_webhook_event(
  p_inbox_id uuid,
  p_claim_token uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $apply_square_loyalty_webhook_event$
DECLARE
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_inbox public.square_webhook_inbox%ROWTYPE;
  v_contract jsonb;
  v_entity jsonb;
  v_account public.square_loyalty_account_mirrors%ROWTYPE;
  v_event public.square_loyalty_event_mirrors%ROWTYPE;
  v_event_type text;
  v_account_id text;
  v_program_id text;
  v_reward_id text;
  v_order_id text;
  v_location_id text;
  v_source text;
  v_points integer;
  v_entity_occurred_at timestamptz;
  v_provider_updated_at timestamptz;
  v_result_fingerprint text;
  v_reward_status text;
BEGIN
  IF v_role <> 'service_role' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  IF p_inbox_id IS NULL OR p_claim_token IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_claim');
  END IF;

  SELECT i.* INTO v_inbox
  FROM public.square_webhook_inbox AS i
  WHERE i.id = p_inbox_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'event_not_found');
  END IF;
  IF v_inbox.feature <> 'loyalty' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'feature_mismatch');
  END IF;
  IF v_inbox.status = 'processed' THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', true, 'code', 'application_replay', 'event_id', v_inbox.event_id
    );
  END IF;
  IF v_inbox.status <> 'processing' OR v_inbox.claim_token IS DISTINCT FROM p_claim_token THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'claim_mismatch');
  END IF;

  v_contract := public.square_feature_contract(v_inbox.salon_id, 'loyalty');
  IF v_contract ->> 'code' <> 'ready'
     OR v_contract ->> 'provider_account_fingerprint'
       <> v_inbox.provider_account_fingerprint THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'integration_contract_changed');
  END IF;
  v_entity := v_inbox.material -> 'entity';
  IF pg_catalog.jsonb_typeof(v_entity) <> 'object'
     OR v_entity ->> 'id' IS DISTINCT FROM v_inbox.entity_id THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_loyalty_material');
  END IF;

  IF v_inbox.event_type IN (
    'loyalty.account.created', 'loyalty.account.updated', 'loyalty.account.deleted'
  ) THEN
    v_account_id := v_entity ->> 'id';
    IF v_inbox.event_type = 'loyalty.account.deleted' THEN
      INSERT INTO public.square_loyalty_account_mirrors (
        salon_id, provider_account_fingerprint, square_account_id, state,
        provider_updated_at, last_event_at
      ) VALUES (
        v_inbox.salon_id, v_inbox.provider_account_fingerprint,
        v_account_id, 'deleted', v_inbox.occurred_at, v_inbox.occurred_at
      )
      ON CONFLICT (salon_id, provider_account_fingerprint, square_account_id)
      DO UPDATE SET
        state = CASE
          WHEN public.square_loyalty_account_mirrors.provider_updated_at IS NULL
            OR excluded.provider_updated_at >= public.square_loyalty_account_mirrors.provider_updated_at
          THEN 'deleted' ELSE public.square_loyalty_account_mirrors.state
        END,
        provider_updated_at = greatest(
          public.square_loyalty_account_mirrors.provider_updated_at,
          excluded.provider_updated_at
        ),
        last_event_at = greatest(
          public.square_loyalty_account_mirrors.last_event_at,
          excluded.last_event_at
        ),
        updated_at = transaction_timestamp()
      RETURNING * INTO v_account;
    ELSE
      v_program_id := v_entity ->> 'program_id';
      BEGIN
        v_points := (v_entity ->> 'balance')::integer;
        v_provider_updated_at := (v_entity ->> 'updated_at')::timestamptz;
      EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range
        OR datetime_field_overflow OR invalid_datetime_format THEN
        RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_loyalty_material');
      END;
      IF v_program_id IS NULL OR pg_catalog.length(v_program_id) NOT BETWEEN 1 AND 255
         OR v_points < 0 OR v_provider_updated_at IS NULL
         OR (v_entity ->> 'lifetime_points') !~ '^[0-9]{1,10}$' THEN
        RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_loyalty_material');
      END IF;
      INSERT INTO public.square_loyalty_account_mirrors (
        salon_id, provider_account_fingerprint, square_account_id,
        square_program_id, balance, lifetime_points, state,
        provider_updated_at, last_event_at
      ) VALUES (
        v_inbox.salon_id, v_inbox.provider_account_fingerprint,
        v_account_id, v_program_id, v_points,
        (v_entity ->> 'lifetime_points')::integer, 'active',
        v_provider_updated_at, v_inbox.occurred_at
      )
      ON CONFLICT (salon_id, provider_account_fingerprint, square_account_id)
      DO UPDATE SET
        square_program_id = CASE
          WHEN public.square_loyalty_account_mirrors.provider_updated_at IS NULL
            OR excluded.provider_updated_at >= public.square_loyalty_account_mirrors.provider_updated_at
          THEN excluded.square_program_id
          ELSE public.square_loyalty_account_mirrors.square_program_id
        END,
        balance = CASE
          WHEN public.square_loyalty_account_mirrors.provider_updated_at IS NULL
            OR excluded.provider_updated_at >= public.square_loyalty_account_mirrors.provider_updated_at
          THEN excluded.balance ELSE public.square_loyalty_account_mirrors.balance
        END,
        lifetime_points = CASE
          WHEN public.square_loyalty_account_mirrors.provider_updated_at IS NULL
            OR excluded.provider_updated_at >= public.square_loyalty_account_mirrors.provider_updated_at
          THEN excluded.lifetime_points ELSE public.square_loyalty_account_mirrors.lifetime_points
        END,
        state = CASE
          WHEN public.square_loyalty_account_mirrors.provider_updated_at IS NULL
            OR excluded.provider_updated_at >= public.square_loyalty_account_mirrors.provider_updated_at
          THEN excluded.state ELSE public.square_loyalty_account_mirrors.state
        END,
        provider_updated_at = greatest(
          public.square_loyalty_account_mirrors.provider_updated_at,
          excluded.provider_updated_at
        ),
        last_event_at = greatest(
          public.square_loyalty_account_mirrors.last_event_at,
          excluded.last_event_at
        ),
        updated_at = transaction_timestamp()
      RETURNING * INTO v_account;
    END IF;
  ELSIF v_inbox.event_type = 'loyalty.event.created' THEN
    v_event_type := v_entity ->> 'type';
    v_account_id := v_entity ->> 'loyalty_account_id';
    v_program_id := v_entity ->> 'program_id';
    v_reward_id := nullif(v_entity ->> 'reward_id', '');
    v_order_id := nullif(v_entity ->> 'order_id', '');
    v_location_id := nullif(v_entity ->> 'location_id', '');
    v_source := nullif(v_entity ->> 'source', '');
    BEGIN
      v_entity_occurred_at := (v_entity ->> 'created_at')::timestamptz;
      v_points := CASE WHEN v_event_type = 'REDEEM_REWARD' THEN NULL
        ELSE (v_entity ->> 'points_delta')::integer END;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range
      OR datetime_field_overflow OR invalid_datetime_format THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_loyalty_material');
    END;
    IF v_account_id IS NULL OR v_program_id IS NULL
       OR v_event_type NOT IN (
         'ACCUMULATE_POINTS', 'ACCUMULATE_PROMOTION_POINTS', 'CREATE_REWARD',
         'REDEEM_REWARD', 'DELETE_REWARD', 'ADJUST_POINTS', 'EXPIRE_POINTS', 'OTHER'
       ) OR (v_event_type <> 'REDEEM_REWARD' AND coalesce(v_points, 0) = 0)
       OR v_entity_occurred_at IS NULL
       OR (v_location_id IS NOT NULL AND v_location_id <> v_contract ->> 'location_id')
       OR (v_source IS NOT NULL AND v_source NOT IN ('SQUARE', 'LOYALTY_API'))
       OR (v_event_type IN ('CREATE_REWARD', 'REDEEM_REWARD', 'DELETE_REWARD')
         AND v_reward_id IS NULL) THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_loyalty_material');
    END IF;

    INSERT INTO public.square_loyalty_account_mirrors (
      salon_id, provider_account_fingerprint, square_account_id,
      square_program_id, last_event_at
    ) VALUES (
      v_inbox.salon_id, v_inbox.provider_account_fingerprint,
      v_account_id, v_program_id, v_entity_occurred_at
    )
    ON CONFLICT (salon_id, provider_account_fingerprint, square_account_id)
    DO UPDATE SET
      square_program_id = coalesce(
        public.square_loyalty_account_mirrors.square_program_id,
        excluded.square_program_id
      ),
      last_event_at = greatest(
        public.square_loyalty_account_mirrors.last_event_at,
        excluded.last_event_at
      ),
      updated_at = transaction_timestamp()
    RETURNING * INTO v_account;

    INSERT INTO public.square_loyalty_event_mirrors (
      salon_id, account_mirror_id, inbox_id,
      provider_account_fingerprint, square_event_id, event_type,
      points_delta, square_program_id, square_reward_id,
      square_order_id, square_location_id, source, occurred_at,
      payload_fingerprint
    ) VALUES (
      v_inbox.salon_id, v_account.id, v_inbox.id,
      v_inbox.provider_account_fingerprint, v_inbox.entity_id, v_event_type,
      v_points, v_program_id, v_reward_id, v_order_id, v_location_id,
      v_source, v_entity_occurred_at, v_inbox.payload_fingerprint
    )
    ON CONFLICT (provider_account_fingerprint, square_event_id) DO NOTHING
    RETURNING * INTO v_event;
    IF NOT FOUND THEN
      SELECT e.* INTO v_event
      FROM public.square_loyalty_event_mirrors AS e
      WHERE e.provider_account_fingerprint = v_inbox.provider_account_fingerprint
        AND e.square_event_id = v_inbox.entity_id;
      IF v_event.payload_fingerprint <> v_inbox.payload_fingerprint
         OR v_event.inbox_id <> v_inbox.id THEN
        RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'loyalty_event_conflict');
      END IF;
    END IF;

    v_reward_status := CASE v_event_type
      WHEN 'CREATE_REWARD' THEN 'issued'
      WHEN 'REDEEM_REWARD' THEN 'redeemed'
      WHEN 'DELETE_REWARD' THEN 'deleted'
      ELSE NULL
    END;
    IF v_reward_status IS NOT NULL THEN
      INSERT INTO public.square_loyalty_reward_mirrors (
        salon_id, account_mirror_id, provider_account_fingerprint,
        square_reward_id, square_program_id, status, points_effect,
        square_order_id, last_square_event_id, provider_updated_at
      ) VALUES (
        v_inbox.salon_id, v_account.id, v_inbox.provider_account_fingerprint,
        v_reward_id, v_program_id, v_reward_status, v_points,
        v_order_id, v_inbox.entity_id, v_entity_occurred_at
      )
      ON CONFLICT (provider_account_fingerprint, square_reward_id)
      DO UPDATE SET
        status = CASE
          WHEN excluded.provider_updated_at >= public.square_loyalty_reward_mirrors.provider_updated_at
          THEN excluded.status ELSE public.square_loyalty_reward_mirrors.status
        END,
        points_effect = CASE
          WHEN excluded.provider_updated_at >= public.square_loyalty_reward_mirrors.provider_updated_at
          THEN excluded.points_effect ELSE public.square_loyalty_reward_mirrors.points_effect
        END,
        square_order_id = CASE
          WHEN excluded.provider_updated_at >= public.square_loyalty_reward_mirrors.provider_updated_at
          THEN coalesce(excluded.square_order_id, public.square_loyalty_reward_mirrors.square_order_id)
          ELSE public.square_loyalty_reward_mirrors.square_order_id
        END,
        last_square_event_id = CASE
          WHEN excluded.provider_updated_at >= public.square_loyalty_reward_mirrors.provider_updated_at
          THEN excluded.last_square_event_id ELSE public.square_loyalty_reward_mirrors.last_square_event_id
        END,
        provider_updated_at = greatest(
          public.square_loyalty_reward_mirrors.provider_updated_at,
          excluded.provider_updated_at
        ),
        updated_at = transaction_timestamp();
    END IF;
  ELSE
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'unsupported_loyalty_event');
  END IF;

  v_result_fingerprint := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'inbox_id', v_inbox.id,
          'event_id', v_inbox.event_id,
          'payload_fingerprint', v_inbox.payload_fingerprint,
          'account_mirror_id', v_account.id,
          'event_mirror_id', v_event.id
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
  UPDATE public.square_webhook_inbox
  SET status = 'processed',
      result_fingerprint = v_result_fingerprint,
      error_code = NULL,
      claim_token = NULL,
      lease_expires_at = NULL,
      completed_at = clock_timestamp()
  WHERE id = v_inbox.id;
  INSERT INTO public.square_sync_cursors (
    salon_id, feature, provider_account_fingerprint,
    last_event_at, last_event_id
  ) VALUES (
    v_inbox.salon_id, 'loyalty', v_inbox.provider_account_fingerprint,
    v_inbox.occurred_at, v_inbox.event_id
  )
  ON CONFLICT (salon_id, feature) DO UPDATE SET
    last_event_at = greatest(
      public.square_sync_cursors.last_event_at, excluded.last_event_at
    ),
    last_event_id = CASE
      WHEN public.square_sync_cursors.last_event_at IS NULL
        OR excluded.last_event_at >= public.square_sync_cursors.last_event_at
      THEN excluded.last_event_id ELSE public.square_sync_cursors.last_event_id
    END,
    updated_at = clock_timestamp();

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'code', 'loyalty_event_applied',
    'event_id', v_inbox.event_id,
    'account_mirror_id', v_account.id,
    'result_fingerprint', v_result_fingerprint
  );
END;
$apply_square_loyalty_webhook_event$;

REVOKE ALL ON FUNCTION public.apply_square_loyalty_webhook_event(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_square_loyalty_webhook_event(uuid, uuid)
  TO service_role;

COMMENT ON TABLE public.square_loyalty_account_mirrors IS
  'PII-free Square loyalty account mirror. Subject binding requires a succeeded provider receipt.';
COMMENT ON TABLE public.square_loyalty_event_mirrors IS
  'Immutable Square loyalty event ledger adopted atomically from the signature-verified inbox.';
COMMENT ON TABLE public.square_loyalty_reward_mirrors IS
  'Square reward lifecycle mirror. This is provider state, not a NailIQ voucher or payout.';
