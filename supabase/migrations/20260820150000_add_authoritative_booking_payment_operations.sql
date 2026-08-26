-- MQA-0065/0067/0068/0069/0070/0074/0075: additive, service-only
-- payment operation ledger.  Existing payment callers remain unchanged until
-- they explicitly adopt these RPCs; no provider call is performed in SQL.

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS deposit_payment_ledger_enforced_at timestamptz,
  ADD COLUMN IF NOT EXISTS noshow_payment_ledger_enforced_at timestamptz,
  ADD COLUMN IF NOT EXISTS deposit_refunded_cents integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deposit_refund_status text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS noshow_refunded_cents integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS noshow_refund_status text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS late_cancel_charge_status text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS late_cancel_payment_id text,
  ADD COLUMN IF NOT EXISTS late_cancel_charged_cents integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS late_cancel_refunded_cents integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS late_cancel_refund_status text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS late_cancel_charge_occurrence_version bigint,
  ADD COLUMN IF NOT EXISTS late_cancel_payment_ledger_enforced_at timestamptz;

DO $constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.bookings'::regclass
      AND conname = 'bookings_payment_refund_counters_check'
  ) THEN
    ALTER TABLE public.bookings ADD CONSTRAINT bookings_payment_refund_counters_check
      CHECK (
        deposit_refunded_cents >= 0
        AND noshow_refunded_cents >= 0
        AND deposit_refund_status IN ('none','partial','full')
        AND noshow_refund_status IN ('none','partial','full')
      ) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid='public.bookings'::regclass
      AND conname='bookings_late_cancel_payment_counters_check'
  ) THEN
    ALTER TABLE public.bookings ADD CONSTRAINT bookings_late_cancel_payment_counters_check
      CHECK (
        late_cancel_charge_status IN ('none','charged','refunded')
        AND late_cancel_refund_status IN ('none','partial','full')
        AND late_cancel_charged_cents >= 0
        AND late_cancel_refunded_cents BETWEEN 0 AND late_cancel_charged_cents
        AND (late_cancel_charge_occurrence_version IS NULL
          OR late_cancel_charge_occurrence_version > 0)
        AND (late_cancel_payment_ledger_enforced_at IS NULL OR (
          late_cancel_charged_cents > 0
          AND late_cancel_charge_occurrence_version IS NOT NULL
          AND nullif(trim(coalesce(late_cancel_payment_id,'')),'') IS NOT NULL
          AND (
            late_cancel_refund_status='none' AND late_cancel_refunded_cents=0
              AND late_cancel_charge_status='charged'
            OR late_cancel_refund_status='partial'
              AND late_cancel_refunded_cents>0
              AND late_cancel_refunded_cents<late_cancel_charged_cents
              AND late_cancel_charge_status='charged'
            OR late_cancel_refund_status='full'
              AND late_cancel_refunded_cents=late_cancel_charged_cents
              AND late_cancel_charge_status='refunded'
          )
        ))
      ) NOT VALID;
  END IF;

  -- Historical rows are intentionally not scanned during Phase A.  The
  -- predicate is enforced for every ledger-adopted row immediately.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.bookings'::regclass
      AND conname = 'bookings_payment_ledger_coherence_check'
  ) THEN
    ALTER TABLE public.bookings ADD CONSTRAINT bookings_payment_ledger_coherence_check
      CHECK (
        (deposit_payment_ledger_enforced_at IS NULL OR (
          deposit_refunded_cents <= coalesce(deposit_amount_cents, 0)
          AND (
            deposit_status NOT IN ('paid','refunded') OR (
              coalesce(deposit_amount_cents,0) > 0
              AND deposit_paid_at IS NOT NULL
              AND num_nonnulls(stripe_payment_intent_id, square_payment_id) = 1
            )
          )
          AND (
            deposit_refund_status = 'none' AND deposit_refunded_cents = 0
            OR deposit_refund_status = 'partial'
              AND deposit_refunded_cents > 0
              AND deposit_refunded_cents < coalesce(deposit_amount_cents,0)
              AND deposit_status = 'paid'
            OR deposit_refund_status = 'full'
              AND deposit_refunded_cents = coalesce(deposit_amount_cents,0)
              AND deposit_status = 'refunded'
          )
        ))
        AND (noshow_payment_ledger_enforced_at IS NULL OR (
          noshow_refunded_cents <= coalesce(noshow_fee_cents, 0)
          AND (noshow_charge_status NOT IN ('charged','refunded') OR (
            coalesce(noshow_fee_cents,0) > 0
            AND nullif(trim(coalesce(noshow_payment_id,'')),'') IS NOT NULL
          ))
          AND (
            noshow_refund_status = 'none' AND noshow_refunded_cents = 0
            OR noshow_refund_status = 'partial'
              AND noshow_refunded_cents > 0
              AND noshow_refunded_cents < coalesce(noshow_fee_cents,0)
              AND noshow_charge_status = 'charged'
            OR noshow_refund_status = 'full'
              AND noshow_refunded_cents = coalesce(noshow_fee_cents,0)
              AND noshow_charge_status = 'refunded'
          )
        ))
      ) NOT VALID;
  END IF;
END
$constraints$;

CREATE TABLE IF NOT EXISTS public.booking_payment_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  booking_id uuid REFERENCES public.bookings(id) ON DELETE RESTRICT,
  request_id uuid NOT NULL,
  operation_kind text NOT NULL CHECK (operation_kind IN (
    'deposit_charge','noshow_charge','late_cancel_charge',
    'deposit_refund','noshow_refund','late_cancel_refund'
  )),
  operation_occurrence_version bigint CHECK (
    operation_occurrence_version IS NULL OR operation_occurrence_version > 0
  ),
  provider text NOT NULL CHECK (provider IN ('square','stripe')),
  provider_account_fingerprint text NOT NULL
    CHECK (provider_account_fingerprint ~ '^[0-9a-f]{64}$'),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  material_fingerprint text NOT NULL
    CHECK (material_fingerprint ~ '^[0-9a-f]{64}$'),
  material_json jsonb NOT NULL CHECK (jsonb_typeof(material_json) = 'object'),
  provider_material jsonb NOT NULL CHECK (jsonb_typeof(provider_material) = 'object'),
  public_request_fingerprint text CHECK (
    public_request_fingerprint IS NULL OR public_request_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  booking_create_fingerprint text CHECK (
    booking_create_fingerprint IS NULL OR booking_create_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  booking_intent_idempotency_key uuid,
  pricing_fingerprint text CHECK (
    pricing_fingerprint IS NULL OR pricing_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  service_id uuid REFERENCES public.services(id) ON DELETE RESTRICT,
  staff_id uuid REFERENCES public.staff(id) ON DELETE RESTRICT,
  start_time_utc timestamptz,
  end_time_utc timestamptz,
  client_phone_fingerprint text CHECK (
    client_phone_fingerprint IS NULL OR client_phone_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  parent_payment_id text,
  parent_operation_id uuid REFERENCES public.booking_payment_operations(id) ON DELETE RESTRICT,
  provider_payment_id text,
  provider_refund_id text,
  provider_order_id text,
  provider_link_id text,
  provider_link_url text,
  delivery_mode text CHECK (
    delivery_mode IS NULL OR delivery_mode IN ('square_hosted_link','public_customer_present')
  ),
  public_square_capability_token_hash text CHECK (
    public_square_capability_token_hash IS NULL
      OR public_square_capability_token_hash ~ '^[0-9a-f]{64}$'
  ),
  public_square_capability_expires_at timestamptz,
  public_square_capability_consumed_at timestamptz,
  provider_status text,
  provider_idempotency_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'sending' CHECK (status IN (
    'sending','pending_customer','pending_provider','reconciling','succeeded','compensated','failed','unknown'
  )),
  failure_disposition text CHECK (
    failure_disposition IS NULL OR failure_disposition IN (
      'definite_pre_acceptance','terminal','ambiguous'
    )
  ),
  error_code text CHECK (
    error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,64}$'
  ),
  attempt_count smallint NOT NULL DEFAULT 1 CHECK (attempt_count BETWEEN 1 AND 3),
  attempt_token uuid,
  lease_expires_at timestamptz,
  next_reconcile_at timestamptz,
  customer_finalize_token_hash text CHECK (
    customer_finalize_token_hash IS NULL OR customer_finalize_token_hash ~ '^[0-9a-f]{64}$'
  ),
  customer_finalize_expires_at timestamptz,
  binding_expires_at timestamptz,
  unbound_compensation_due_at timestamptz,
  compensation_request_id uuid,
  compensation_lease_token uuid,
  compensation_lease_expires_at timestamptz,
  result_json jsonb CHECK (result_json IS NULL OR jsonb_typeof(result_json) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT booking_payment_operations_refund_parent_check CHECK (
    (operation_kind IN ('deposit_refund','noshow_refund','late_cancel_refund')) =
      (nullif(trim(coalesce(parent_payment_id,'')),'') IS NOT NULL)
  ),
  CONSTRAINT booking_payment_operations_late_cancel_occurrence_check CHECK (
    (operation_kind IN ('late_cancel_charge','late_cancel_refund')) =
      (operation_occurrence_version IS NOT NULL)
    AND (operation_kind<>'late_cancel_refund' OR parent_operation_id IS NOT NULL)
  ),
  CONSTRAINT booking_payment_operations_prebooking_check CHECK (
    booking_id IS NOT NULL OR (
      operation_kind = 'deposit_charge'
      AND booking_intent_idempotency_key IS NOT NULL
      AND pricing_fingerprint IS NOT NULL
      AND service_id IS NOT NULL
      AND staff_id IS NOT NULL
      AND start_time_utc IS NOT NULL
      AND end_time_utc IS NOT NULL
      AND client_phone_fingerprint IS NOT NULL
    ) OR (
      operation_kind='deposit_refund'
      AND parent_operation_id IS NOT NULL
      AND parent_payment_id IS NOT NULL
    )
  ),
  CONSTRAINT booking_payment_operations_final_state_check CHECK (
    (status = 'succeeded') = (completed_at IS NOT NULL AND result_json IS NOT NULL)
    OR status <> 'succeeded'
  )
);

ALTER TABLE public.booking_payment_operations
  ADD COLUMN IF NOT EXISTS provider_order_id text,
  ADD COLUMN IF NOT EXISTS provider_link_id text,
  ADD COLUMN IF NOT EXISTS provider_link_url text,
  ADD COLUMN IF NOT EXISTS delivery_mode text,
  ADD COLUMN IF NOT EXISTS public_square_capability_token_hash text,
  ADD COLUMN IF NOT EXISTS public_square_capability_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS public_square_capability_consumed_at timestamptz;

DO $constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid='public.booking_payment_operations'::regclass
      AND conname='booking_payment_operations_delivery_mode_coherence_check') THEN
    ALTER TABLE public.booking_payment_operations ADD CONSTRAINT
      booking_payment_operations_delivery_mode_coherence_check CHECK (
        delivery_mode IS NULL OR (
          provider='square'
          AND delivery_mode IN ('square_hosted_link','public_customer_present')
          AND provider_material->>'provider_environment' IN ('sandbox','production')
          AND (delivery_mode<>'square_hosted_link' OR booking_id IS NOT NULL)
          AND (delivery_mode<>'public_customer_present' OR (
            booking_intent_idempotency_key IS NOT NULL
            AND NOT (provider_material ? 'saved_card_id')
            AND NOT (provider_material ? 'customer_id')
          ))
        )
      ) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid='public.booking_payment_operations'::regclass
      AND conname='booking_payment_operations_square_link_receipt_check') THEN
    ALTER TABLE public.booking_payment_operations ADD CONSTRAINT
      booking_payment_operations_square_link_receipt_check CHECK (
        delivery_mode<>'square_hosted_link'
        OR status NOT IN ('pending_provider','succeeded')
        OR (
          nullif(trim(coalesce(provider_order_id,'')),'') IS NOT NULL
          AND length(provider_order_id)<=255 AND provider_order_id~'^[[:graph:]]+$'
          AND nullif(trim(coalesce(provider_link_id,'')),'') IS NOT NULL
          AND length(provider_link_id)<=255 AND provider_link_id~'^[[:graph:]]+$'
          AND length(coalesce(provider_link_url,''))<=2048
          AND provider_link_url~'^https://[^[:space:]]+$'
        )
      ) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid='public.booking_payment_operations'::regclass
      AND conname='booking_payment_operations_public_square_capability_check') THEN
    ALTER TABLE public.booking_payment_operations ADD CONSTRAINT
      booking_payment_operations_public_square_capability_check CHECK (
        public_square_capability_token_hash IS NULL OR (
          delivery_mode='public_customer_present'
          AND public_square_capability_token_hash~'^[0-9a-f]{64}$'
          AND public_square_capability_expires_at IS NOT NULL
        )
      ) NOT VALID;
  END IF;
END
$constraints$;

ALTER TABLE public.booking_payment_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_payment_operations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.booking_payment_operations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.booking_payment_operations TO service_role;

CREATE TABLE IF NOT EXISTS public.booking_cancel_deposit_refund_sagas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  booking_id uuid NOT NULL REFERENCES public.bookings(id) ON DELETE RESTRICT,
  request_id uuid NOT NULL,
  requested_amount_cents integer NOT NULL CHECK (requested_amount_cents>0),
  refund_operation_id uuid NOT NULL UNIQUE
    REFERENCES public.booking_payment_operations(id) ON DELETE RESTRICT,
  refund_material_fingerprint text NOT NULL
    CHECK (refund_material_fingerprint ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN (
    'refund_claimed','refund_pending','refund_unknown','refunded','refund_failed'
  )),
  cancellation_transition_version bigint NOT NULL
    CHECK (cancellation_transition_version>0),
  cancellation_result jsonb NOT NULL CHECK (jsonb_typeof(cancellation_result)='object'),
  result_json jsonb NOT NULL CHECK (jsonb_typeof(result_json)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(salon_id,request_id)
);
ALTER TABLE public.booking_cancel_deposit_refund_sagas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_cancel_deposit_refund_sagas FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.booking_cancel_deposit_refund_sagas FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON TABLE public.booking_cancel_deposit_refund_sagas TO service_role;

CREATE UNIQUE INDEX IF NOT EXISTS booking_payment_operations_request_once
  ON public.booking_payment_operations(salon_id, request_id, operation_kind);
CREATE UNIQUE INDEX IF NOT EXISTS booking_payment_operations_payment_receipt_once
  ON public.booking_payment_operations(provider, provider_account_fingerprint, provider_payment_id)
  WHERE provider_payment_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS booking_payment_operations_refund_receipt_once
  ON public.booking_payment_operations(provider, provider_account_fingerprint, provider_refund_id)
  WHERE provider_refund_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS booking_payment_operations_provider_order_once
  ON public.booking_payment_operations(provider,provider_account_fingerprint,provider_order_id)
  WHERE provider_order_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS booking_payment_operations_provider_link_once
  ON public.booking_payment_operations(provider,provider_account_fingerprint,provider_link_id)
  WHERE provider_link_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS booking_payment_operations_public_square_capability_once
  ON public.booking_payment_operations(public_square_capability_token_hash)
  WHERE public_square_capability_token_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS booking_payment_operations_active_charge_once
  ON public.booking_payment_operations(booking_id,operation_kind)
  WHERE operation_kind IN ('deposit_charge','noshow_charge')
    AND booking_id IS NOT NULL
    AND status IN ('sending','pending_customer','pending_provider','reconciling','unknown','succeeded');
CREATE UNIQUE INDEX IF NOT EXISTS booking_payment_operations_late_cancel_occurrence_once
  ON public.booking_payment_operations(booking_id,operation_kind,operation_occurrence_version)
  WHERE operation_kind='late_cancel_charge'
    AND booking_id IS NOT NULL AND operation_occurrence_version IS NOT NULL
    AND status IN ('sending','pending_provider','reconciling','unknown','succeeded');
CREATE UNIQUE INDEX IF NOT EXISTS booking_payment_operations_active_deposit_intent_once
  ON public.booking_payment_operations(salon_id, booking_intent_idempotency_key)
  WHERE operation_kind='deposit_charge'
    AND booking_intent_idempotency_key IS NOT NULL
    AND status IN ('sending','pending_customer','pending_provider','reconciling','unknown','succeeded');
CREATE UNIQUE INDEX IF NOT EXISTS booking_payment_operations_unbound_refund_once
  ON public.booking_payment_operations(parent_operation_id)
  WHERE operation_kind='deposit_refund' AND parent_operation_id IS NOT NULL
    AND status IN ('sending','pending_provider','reconciling','unknown','succeeded');
CREATE INDEX IF NOT EXISTS booking_payment_operations_reconcile_due
  ON public.booking_payment_operations(next_reconcile_at, created_at)
  WHERE status IN ('pending_provider','unknown');
CREATE INDEX IF NOT EXISTS booking_payment_operations_expired_attempt_due
  ON public.booking_payment_operations(lease_expires_at, created_at)
  WHERE status IN ('sending','reconciling');
CREATE INDEX IF NOT EXISTS booking_payment_operations_booking_history
  ON public.booking_payment_operations(salon_id, booking_id, created_at DESC)
  WHERE booking_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS booking_payment_operations_unbound_compensation_due
  ON public.booking_payment_operations(unbound_compensation_due_at, created_at)
  WHERE operation_kind='deposit_charge' AND status='succeeded' AND booking_id IS NULL;

CREATE OR REPLACE FUNCTION public.booking_payment_provider_context(
  p_salon_id uuid,
  p_operation_kind text
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
  v_salon public.salons%ROWTYPE;
  v_square public.square_integrations%ROWTYPE;
  v_provider text;
  v_account text;
  v_location text;
  v_application text;
  v_environment text;
  v_available integer := 0;
  v_material jsonb;
BEGIN
  SELECT * INTO v_salon FROM public.salons WHERE id=p_salon_id AND archived_at IS NULL;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','salon_not_found'); END IF;
  SELECT * INTO v_square FROM public.square_integrations
    WHERE salon_id=p_salon_id AND enabled IS TRUE;

  v_provider := nullif(trim(coalesce(v_salon.payment_provider,'')),'');
  IF v_provider IS NULL THEN
    IF v_salon.stripe_connect_charges_enabled IS TRUE
       AND nullif(trim(coalesce(v_salon.stripe_connect_account_id,'')),'') IS NOT NULL THEN
      v_provider := 'stripe'; v_available := v_available + 1;
    END IF;
    IF v_square.salon_id IS NOT NULL THEN
      IF v_available > 0 THEN
        RETURN jsonb_build_object('success',false,'code','payment_provider_ambiguous');
      END IF;
      v_provider := 'square'; v_available := v_available + 1;
    END IF;
  END IF;

  IF v_provider='stripe' THEN
    v_account := nullif(trim(coalesce(v_salon.stripe_connect_account_id,'')),'');
    IF v_account IS NULL OR v_salon.stripe_connect_charges_enabled IS NOT TRUE THEN
      RETURN jsonb_build_object('success',false,'code','stripe_account_not_chargeable');
    END IF;
  ELSIF v_provider='square' THEN
    IF v_square.salon_id IS NULL THEN
      RETURN jsonb_build_object('success',false,'code','square_account_not_configured');
    END IF;
    v_account := nullif(trim(coalesce(v_square.merchant_id,'')),'');
    v_location := nullif(trim(coalesce(v_square.location_id,'')),'');
    IF v_account IS NULL OR v_location IS NULL THEN
      RETURN jsonb_build_object('success',false,'code','square_account_not_configured');
    END IF;
    v_application := nullif(trim(coalesce(v_square.application_id,'')),'');
    v_environment := lower(nullif(trim(coalesce(v_square.environment,'')),''));
    IF v_environment NOT IN ('sandbox','production') THEN
      RETURN jsonb_build_object('success',false,'code','square_environment_invalid');
    END IF;
  ELSE
    RETURN jsonb_build_object('success',false,'code','payment_provider_not_configured');
  END IF;

  v_material := jsonb_build_object(
    'provider',v_provider,
    'provider_account_id',v_account,
    'provider_location_id',v_location,
    'provider_application_id',v_application,
    'provider_environment',v_environment,
    'currency',upper(coalesce(nullif(trim(v_salon.currency_code),''),'CAD'))
  );
  RETURN jsonb_build_object(
    'success',true,'code','provider_resolved',
    'provider',v_provider,
    'provider_account_fingerprint',encode(
      extensions.digest(convert_to(v_provider||':'||v_account||':'||coalesce(v_location,'')||':'||coalesce(v_environment,''),'UTF8'),'sha256'),'hex'
    ),
    'provider_material',v_material,
    'currency',v_material->>'currency'
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.complete_booking_payment_operation(
  p_operation_id uuid,
  p_attempt_token uuid,
  p_outcome text,
  p_provider_status text,
  p_provider_payment_id text DEFAULT NULL,
  p_provider_refund_id text DEFAULT NULL,
  p_error_code text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
  v_op public.booking_payment_operations%ROWTYPE;
  v_booking public.bookings%ROWTYPE;
  v_parent_op public.booking_payment_operations%ROWTYPE;
  v_payment text:=nullif(trim(coalesce(p_provider_payment_id,'')),'');
  v_refund text:=nullif(trim(coalesce(p_provider_refund_id,'')),'');
  v_provider_status text:=nullif(trim(coalesce(p_provider_status,'')),'');
  v_error text:=nullif(trim(coalesce(p_error_code,'')),'');
  v_final_ok boolean:=false;
  v_new_refunded integer;
  v_result jsonb;
  v_conflict uuid;
BEGIN
  IF p_operation_id IS NULL OR p_attempt_token IS NULL
     OR p_outcome NOT IN ('pending_customer','pending_provider','succeeded','definite_failure','unknown') THEN
    RETURN jsonb_build_object('success',false,'code','invalid_input');
  END IF;
  SELECT * INTO v_op FROM public.booking_payment_operations WHERE id=p_operation_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','operation_not_found'); END IF;

  IF v_op.attempt_token IS DISTINCT FROM p_attempt_token
     OR v_op.status NOT IN ('sending','reconciling') THEN
    IF v_op.status='succeeded' AND p_outcome='succeeded'
       AND v_op.provider_payment_id IS NOT DISTINCT FROM v_payment
       AND v_op.provider_refund_id IS NOT DISTINCT FROM v_refund THEN
      RETURN jsonb_build_object('success',true,'code','completion_replay','status','succeeded',
        'operation_id',v_op.id,'material_fingerprint',v_op.material_fingerprint,
        'material',v_op.material_json,'result',v_op.result_json);
    ELSIF v_op.status='failed' AND p_outcome='definite_failure'
       AND v_op.error_code IS NOT DISTINCT FROM v_error THEN
      RETURN jsonb_build_object('success',false,'code','completion_replay','status','failed',
        'operation_id',v_op.id,'error_code',v_op.error_code,
        'material_fingerprint',v_op.material_fingerprint);
    ELSIF v_op.status='unknown' AND p_outcome='unknown'
       AND v_op.error_code IS NOT DISTINCT FROM v_error THEN
      RETURN jsonb_build_object('success',false,'code','completion_replay','status','unknown',
        'operation_id',v_op.id,'error_code',v_op.error_code,
        'material_fingerprint',v_op.material_fingerprint);
    ELSIF v_op.status='pending_provider' AND p_outcome='pending_provider'
       AND v_op.provider_payment_id IS NOT DISTINCT FROM v_payment
       AND v_op.provider_refund_id IS NOT DISTINCT FROM v_refund THEN
      RETURN jsonb_build_object('success',true,'code','completion_replay','status','pending_provider',
        'operation_id',v_op.id,'material_fingerprint',v_op.material_fingerprint,
        'material',v_op.material_json);
    ELSIF v_op.status='pending_customer' AND p_outcome='pending_customer'
       AND v_op.provider_payment_id IS NOT DISTINCT FROM v_payment THEN
      RETURN jsonb_build_object('success',true,'code','completion_replay','status','pending_customer',
        'operation_id',v_op.id,'material_fingerprint',v_op.material_fingerprint,
        'material',v_op.material_json);
    END IF;
    RETURN jsonb_build_object('success',false,'code','invalid_attempt_token','status',v_op.status);
  END IF;

  IF v_op.operation_kind IN ('deposit_charge','noshow_charge','late_cancel_charge') THEN
    IF v_refund IS NOT NULL THEN RETURN jsonb_build_object('success',false,'code','unexpected_refund_receipt'); END IF;
  ELSE
    IF v_payment IS NOT NULL THEN RETURN jsonb_build_object('success',false,'code','unexpected_payment_receipt'); END IF;
  END IF;
  IF v_payment IS NOT NULL AND (
       (v_op.provider='stripe' AND v_payment !~ '^pi_[A-Za-z0-9_]{6,250}$')
       OR (v_op.provider='square' AND (length(v_payment)>255 OR v_payment !~ '^[[:graph:]]+$'))
     ) THEN RETURN jsonb_build_object('success',false,'code','invalid_provider_receipt'); END IF;
  IF v_refund IS NOT NULL AND (
       (v_op.provider='stripe' AND v_refund !~ '^re_[A-Za-z0-9_]{6,250}$')
       OR (v_op.provider='square' AND (length(v_refund)>255 OR v_refund !~ '^[[:graph:]]+$'))
     ) THEN RETURN jsonb_build_object('success',false,'code','invalid_provider_receipt'); END IF;

  IF p_outcome='succeeded' THEN
    IF v_op.operation_kind IN ('deposit_charge','noshow_charge','late_cancel_charge') AND v_payment IS NULL
       OR v_op.operation_kind IN ('deposit_refund','noshow_refund','late_cancel_refund') AND v_refund IS NULL THEN
      RETURN jsonb_build_object('success',false,'code','provider_receipt_required');
    END IF;
    v_final_ok := (v_op.provider='stripe' AND lower(v_provider_status)='succeeded')
      OR (v_op.provider='square' AND upper(v_provider_status)='COMPLETED');
    IF NOT v_final_ok THEN RETURN jsonb_build_object('success',false,'code','provider_status_not_final'); END IF;
  ELSIF p_outcome='pending_customer' THEN
    IF v_op.operation_kind<>'deposit_charge' OR v_op.provider<>'stripe' OR v_payment IS NULL
       OR lower(v_provider_status) NOT IN ('requires_payment_method','requires_action')
       OR v_op.customer_finalize_token_hash IS NULL
       OR v_op.customer_finalize_expires_at<=now() THEN
      RETURN jsonb_build_object('success',false,'code','provider_status_not_customer_action');
    END IF;
  ELSIF p_outcome='pending_provider' THEN
    IF v_op.operation_kind IN ('deposit_charge','noshow_charge','late_cancel_charge') AND v_payment IS NULL
       OR v_op.operation_kind IN ('deposit_refund','noshow_refund','late_cancel_refund') AND v_refund IS NULL THEN
      RETURN jsonb_build_object('success',false,'code','provider_receipt_required');
    END IF;
    IF NOT (
      v_op.provider='stripe' AND lower(v_provider_status) IN
        ('processing','requires_capture','pending')
      OR v_op.provider='square' AND upper(v_provider_status) IN ('PENDING','OPEN','APPROVED')
    ) THEN RETURN jsonb_build_object('success',false,'code','provider_status_not_pending'); END IF;
  ELSIF p_outcome='definite_failure' THEN
    IF v_error NOT IN ('card_declined','expired_card','insufficient_funds',
      'authentication_required','provider_rejected','invalid_payment_method','invalid_request') THEN
      RETURN jsonb_build_object('success',false,'code','invalid_failure_code');
    END IF;
  ELSE
    IF v_error NOT IN ('provider_timeout','provider_transport_error','provider_response_lost',
      'completion_write_uncertain','provider_outcome_ambiguous') THEN
      RETURN jsonb_build_object('success',false,'code','invalid_ambiguous_code');
    END IF;
  END IF;

  IF v_payment IS NOT NULL THEN
    SELECT id INTO v_conflict FROM public.booking_payment_operations
      WHERE provider=v_op.provider
        AND provider_account_fingerprint=v_op.provider_account_fingerprint
        AND provider_payment_id=v_payment AND id<>v_op.id LIMIT 1 FOR UPDATE;
  ELSIF v_refund IS NOT NULL THEN
    SELECT id INTO v_conflict FROM public.booking_payment_operations
      WHERE provider=v_op.provider
        AND provider_account_fingerprint=v_op.provider_account_fingerprint
        AND provider_refund_id=v_refund AND id<>v_op.id LIMIT 1 FOR UPDATE;
  END IF;
  IF v_conflict IS NOT NULL THEN
    RETURN jsonb_build_object('success',false,'code','provider_receipt_conflict');
  END IF;

  BEGIN
    IF p_outcome='pending_customer' THEN
      UPDATE public.booking_payment_operations SET
        status='pending_customer',provider_status=v_provider_status,
        provider_payment_id=coalesce(v_payment,provider_payment_id),
        attempt_token=NULL,lease_expires_at=NULL,next_reconcile_at=NULL,
        failure_disposition=NULL,error_code=NULL,updated_at=now()
        WHERE id=v_op.id RETURNING * INTO v_op;
      RETURN jsonb_build_object('success',true,'code','pending_customer','status','pending_customer',
        'operation_id',v_op.id,'finalize_expires_at',v_op.customer_finalize_expires_at,
        'material_fingerprint',v_op.material_fingerprint,'material',v_op.material_json);
    ELSIF p_outcome='pending_provider' THEN
      UPDATE public.booking_payment_operations SET
        status='pending_provider',provider_status=v_provider_status,
        provider_payment_id=coalesce(v_payment,provider_payment_id),
        provider_refund_id=coalesce(v_refund,provider_refund_id),
        attempt_token=NULL,lease_expires_at=NULL,next_reconcile_at=now()+interval '30 seconds',
        failure_disposition=NULL,error_code=NULL,updated_at=now()
        WHERE id=v_op.id RETURNING * INTO v_op;
      RETURN jsonb_build_object('success',true,'code','pending_provider','status','pending_provider',
        'operation_id',v_op.id,'next_reconcile_at',v_op.next_reconcile_at,
        'material_fingerprint',v_op.material_fingerprint,'material',v_op.material_json);
    ELSIF p_outcome='definite_failure' THEN
      UPDATE public.booking_payment_operations SET
        status='failed',provider_status=v_provider_status,failure_disposition='definite_pre_acceptance',
        error_code=v_error,attempt_token=NULL,lease_expires_at=NULL,next_reconcile_at=NULL,
        updated_at=now() WHERE id=v_op.id RETURNING * INTO v_op;
      RETURN jsonb_build_object('success',false,'code','definite_failure','status','failed',
        'operation_id',v_op.id,'error_code',v_error,
        'material_fingerprint',v_op.material_fingerprint);
    ELSIF p_outcome='unknown' THEN
      UPDATE public.booking_payment_operations SET
        status='unknown',provider_status=v_provider_status,
        provider_payment_id=coalesce(v_payment,provider_payment_id),
        provider_refund_id=coalesce(v_refund,provider_refund_id),
        failure_disposition='ambiguous',error_code=v_error,attempt_token=NULL,
        lease_expires_at=NULL,next_reconcile_at=now()+interval '30 seconds',updated_at=now()
        WHERE id=v_op.id RETURNING * INTO v_op;
      RETURN jsonb_build_object('success',false,'code','provider_outcome_unknown','status','unknown',
        'operation_id',v_op.id,'next_reconcile_at',v_op.next_reconcile_at,
        'material_fingerprint',v_op.material_fingerprint);
    END IF;

    IF v_op.booking_id IS NOT NULL THEN
      SELECT * INTO v_booking FROM public.bookings
        WHERE id=v_op.booking_id AND salon_id=v_op.salon_id FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','booking_not_found'); END IF;
    END IF;

    IF v_op.operation_kind='deposit_charge' THEN
      IF v_op.booking_id IS NOT NULL THEN
        IF coalesce(v_booking.deposit_amount_cents,0)<>v_op.amount_cents
           OR v_booking.deposit_status NOT IN ('required','paid')
           OR (v_booking.deposit_status='paid' AND
             (CASE WHEN v_op.provider='stripe' THEN v_booking.stripe_payment_intent_id
                   ELSE v_booking.square_payment_id END) IS DISTINCT FROM v_payment) THEN
          RETURN jsonb_build_object('success',false,'code','booking_financial_state_changed');
        END IF;
        UPDATE public.bookings SET deposit_required=true,deposit_status='paid',
          deposit_paid_at=coalesce(deposit_paid_at,now()),deposit_hold=false,
          status=CASE WHEN deposit_hold IS TRUE AND status='pending' THEN 'confirmed' ELSE status END,
          stripe_payment_intent_id=CASE WHEN v_op.provider='stripe' THEN v_payment ELSE NULL END,
          square_payment_id=CASE WHEN v_op.provider='square' THEN v_payment ELSE NULL END,
          verification_method='deposit',verification_completed_at=coalesce(verification_completed_at,now()),
          deposit_payment_ledger_enforced_at=coalesce(deposit_payment_ledger_enforced_at,now())
          WHERE id=v_op.booking_id RETURNING * INTO v_booking;
      END IF;
    ELSIF v_op.operation_kind='noshow_charge' THEN
      IF v_op.booking_id IS NULL THEN RETURN jsonb_build_object('success',false,'code','booking_not_bound'); END IF;
      IF coalesce(v_booking.noshow_fee_cents,0)<>v_op.amount_cents
         OR coalesce(v_booking.noshow_charge_status,'') NOT IN ('saved','failed','charged')
         OR (v_booking.noshow_charge_status='charged'
             AND v_booking.noshow_payment_id IS DISTINCT FROM v_payment) THEN
        RETURN jsonb_build_object('success',false,'code','booking_financial_state_changed');
      END IF;
      UPDATE public.bookings SET noshow_charge_status='charged',noshow_payment_id=v_payment,
        noshow_charge_attempts=greatest(coalesce(noshow_charge_attempts,0),v_op.attempt_count),
        noshow_last_charge_attempt_at=now(),noshow_charge_error=NULL,
        noshow_payment_ledger_enforced_at=coalesce(noshow_payment_ledger_enforced_at,now())
        WHERE id=v_op.booking_id RETURNING * INTO v_booking;
    ELSIF v_op.operation_kind='late_cancel_charge' THEN
      IF v_op.booking_id IS NULL OR v_op.operation_occurrence_version IS NULL
         OR coalesce((v_op.material_json->'cancel_preview'->>'will_charge')::boolean,false) IS NOT TRUE
         OR (v_op.material_json->'cancel_preview'->>'fee_cents')::integer IS DISTINCT FROM v_op.amount_cents
         OR coalesce(v_op.material_json->>'scope_kind','')<>'booking_own'
         OR coalesce(v_op.material_json->>'rsvp_semantic','')<>'' THEN
        RETURN jsonb_build_object('success',false,'code','late_cancel_material_invalid');
      END IF;
      UPDATE public.bookings SET late_cancel_charge_status='charged',
        late_cancel_payment_id=v_payment,late_cancel_charged_cents=v_op.amount_cents,
        late_cancel_refunded_cents=0,late_cancel_refund_status='none',
        late_cancel_charge_occurrence_version=v_op.operation_occurrence_version,
        late_cancel_payment_ledger_enforced_at=coalesce(late_cancel_payment_ledger_enforced_at,now())
        WHERE id=v_op.booking_id RETURNING * INTO v_booking;
    ELSIF v_op.operation_kind='deposit_refund' THEN
      IF v_op.booking_id IS NULL THEN
        IF v_op.parent_operation_id IS NULL THEN
          RETURN jsonb_build_object('success',false,'code','booking_not_bound');
        END IF;
        SELECT * INTO v_parent_op FROM public.booking_payment_operations
          WHERE id=v_op.parent_operation_id FOR UPDATE;
        IF NOT FOUND OR v_parent_op.operation_kind<>'deposit_charge'
           OR v_parent_op.status<>'succeeded' OR v_parent_op.booking_id IS NOT NULL
           OR v_parent_op.provider_payment_id IS DISTINCT FROM v_op.parent_payment_id
           OR v_parent_op.provider IS DISTINCT FROM v_op.provider
           OR v_parent_op.provider_account_fingerprint IS DISTINCT FROM v_op.provider_account_fingerprint
           OR v_parent_op.amount_cents IS DISTINCT FROM v_op.amount_cents THEN
          RETURN jsonb_build_object('success',false,'code','unbound_parent_state_changed');
        END IF;
        v_new_refunded:=v_op.amount_cents;
        UPDATE public.booking_payment_operations SET status='compensated',
          result_json=coalesce(result_json,'{}'::jsonb)||
          jsonb_build_object('compensation_status','refunded',
            'compensating_refund_operation_id',v_op.id,'compensating_refund_id',v_refund),
          compensation_lease_token=NULL,compensation_lease_expires_at=NULL,
          updated_at=now() WHERE id=v_parent_op.id;
      ELSE
        IF v_booking.deposit_status NOT IN ('paid','refunded')
           OR (CASE WHEN v_op.provider='stripe' THEN v_booking.stripe_payment_intent_id ELSE v_booking.square_payment_id END)
              IS DISTINCT FROM v_op.parent_payment_id THEN
          RETURN jsonb_build_object('success',false,'code','booking_financial_state_changed');
        END IF;
        v_new_refunded:=coalesce(v_booking.deposit_refunded_cents,0)+v_op.amount_cents;
        IF v_new_refunded>coalesce((v_op.material_json->>'captured_cents')::integer,0) THEN
          RETURN jsonb_build_object('success',false,'code','refund_amount_exceeds_remaining');
        END IF;
        UPDATE public.bookings SET deposit_refunded_cents=v_new_refunded,
          deposit_refund_status=CASE WHEN v_new_refunded=(v_op.material_json->>'captured_cents')::integer THEN 'full' ELSE 'partial' END,
          deposit_status=CASE WHEN v_new_refunded=(v_op.material_json->>'captured_cents')::integer THEN 'refunded' ELSE 'paid' END,
          deposit_payment_ledger_enforced_at=coalesce(deposit_payment_ledger_enforced_at,now())
          WHERE id=v_op.booking_id RETURNING * INTO v_booking;
      END IF;
    ELSIF v_op.operation_kind='noshow_refund' THEN
      IF v_op.booking_id IS NULL OR coalesce(v_booking.noshow_charge_status,'') NOT IN ('charged','refunded')
         OR v_booking.noshow_payment_id IS DISTINCT FROM v_op.parent_payment_id THEN
        RETURN jsonb_build_object('success',false,'code','booking_financial_state_changed');
      END IF;
      v_new_refunded:=coalesce(v_booking.noshow_refunded_cents,0)+v_op.amount_cents;
      IF v_new_refunded>coalesce((v_op.material_json->>'captured_cents')::integer,0) THEN
        RETURN jsonb_build_object('success',false,'code','refund_amount_exceeds_remaining');
      END IF;
      UPDATE public.bookings SET noshow_refunded_cents=v_new_refunded,
        noshow_refund_status=CASE WHEN v_new_refunded=(v_op.material_json->>'captured_cents')::integer THEN 'full' ELSE 'partial' END,
        noshow_charge_status=CASE WHEN v_new_refunded=(v_op.material_json->>'captured_cents')::integer THEN 'refunded' ELSE 'charged' END,
        noshow_payment_ledger_enforced_at=coalesce(noshow_payment_ledger_enforced_at,now())
        WHERE id=v_op.booking_id RETURNING * INTO v_booking;
    ELSE
      IF v_op.booking_id IS NULL OR v_op.parent_operation_id IS NULL THEN
        RETURN jsonb_build_object('success',false,'code','booking_not_bound');
      END IF;
      SELECT * INTO v_parent_op FROM public.booking_payment_operations
        WHERE id=v_op.parent_operation_id AND booking_id=v_op.booking_id FOR UPDATE;
      IF NOT FOUND OR v_parent_op.operation_kind<>'late_cancel_charge'
         OR v_parent_op.status<>'succeeded'
         OR v_parent_op.provider_payment_id IS DISTINCT FROM v_op.parent_payment_id
         OR v_parent_op.operation_occurrence_version IS DISTINCT FROM v_op.operation_occurrence_version
         OR v_parent_op.provider IS DISTINCT FROM v_op.provider
         OR v_parent_op.provider_account_fingerprint IS DISTINCT FROM v_op.provider_account_fingerprint
         OR v_booking.late_cancel_payment_id IS DISTINCT FROM v_parent_op.provider_payment_id
         OR v_booking.late_cancel_charge_occurrence_version IS DISTINCT FROM v_parent_op.operation_occurrence_version THEN
        RETURN jsonb_build_object('success',false,'code','late_cancel_parent_state_changed');
      END IF;
      v_new_refunded:=coalesce((SELECT sum(o.amount_cents)::integer
        FROM public.booking_payment_operations o
        WHERE o.parent_operation_id=v_parent_op.id AND o.operation_kind='late_cancel_refund'
          AND o.status='succeeded' AND o.id<>v_op.id),0)+v_op.amount_cents;
      IF v_new_refunded>v_parent_op.amount_cents THEN
        RETURN jsonb_build_object('success',false,'code','refund_amount_exceeds_remaining');
      END IF;
      UPDATE public.bookings SET late_cancel_refunded_cents=v_new_refunded,
        late_cancel_refund_status=CASE WHEN v_new_refunded=v_parent_op.amount_cents THEN 'full' ELSE 'partial' END,
        late_cancel_charge_status=CASE WHEN v_new_refunded=v_parent_op.amount_cents THEN 'refunded' ELSE 'charged' END,
        late_cancel_payment_ledger_enforced_at=coalesce(late_cancel_payment_ledger_enforced_at,now())
        WHERE id=v_op.booking_id RETURNING * INTO v_booking;
    END IF;

    v_result:=jsonb_build_object(
      'operation_id',v_op.id,'salon_id',v_op.salon_id,'booking_id',v_op.booking_id,
      'operation_kind',v_op.operation_kind,'provider',v_op.provider,
      'provider_payment_id',v_payment,'provider_refund_id',v_refund,
      'provider_status',v_provider_status,'amount_cents',v_op.amount_cents,
      'currency',v_op.currency,'status','succeeded','bound',v_op.booking_id IS NOT NULL,
      'deposit_status',CASE WHEN v_op.booking_id IS NULL THEN NULL ELSE v_booking.deposit_status END,
      'deposit_refunded_cents',CASE WHEN v_op.booking_id IS NULL THEN NULL ELSE v_booking.deposit_refunded_cents END,
      'deposit_refund_status',CASE WHEN v_op.booking_id IS NULL THEN NULL ELSE v_booking.deposit_refund_status END,
      'noshow_charge_status',CASE WHEN v_op.booking_id IS NULL THEN NULL ELSE v_booking.noshow_charge_status END,
      'noshow_refunded_cents',CASE WHEN v_op.booking_id IS NULL THEN NULL ELSE v_booking.noshow_refunded_cents END,
      'noshow_refund_status',CASE WHEN v_op.booking_id IS NULL THEN NULL ELSE v_booking.noshow_refund_status END
      ,'late_cancel_charge_status',CASE WHEN v_op.booking_id IS NULL THEN NULL ELSE v_booking.late_cancel_charge_status END
      ,'late_cancel_charged_cents',CASE WHEN v_op.booking_id IS NULL THEN NULL ELSE v_booking.late_cancel_charged_cents END
      ,'late_cancel_refunded_cents',CASE WHEN v_op.booking_id IS NULL THEN NULL ELSE v_booking.late_cancel_refunded_cents END
      ,'late_cancel_refund_status',CASE WHEN v_op.booking_id IS NULL THEN NULL ELSE v_booking.late_cancel_refund_status END
      ,'operation_occurrence_version',v_op.operation_occurrence_version
    );
    UPDATE public.booking_payment_operations SET status='succeeded',provider_status=v_provider_status,
      provider_payment_id=coalesce(v_payment,provider_payment_id),
      provider_refund_id=coalesce(v_refund,provider_refund_id),
      failure_disposition=NULL,error_code=NULL,attempt_token=NULL,lease_expires_at=NULL,
      next_reconcile_at=NULL,customer_finalize_token_hash=NULL,
      customer_finalize_expires_at=NULL,
      binding_expires_at=CASE
        WHEN operation_kind='deposit_charge' AND booking_id IS NULL
          THEN least(now()+interval '10 minutes',start_time_utc)
        ELSE binding_expires_at END,
      unbound_compensation_due_at=CASE
        WHEN operation_kind='deposit_charge' AND booking_id IS NULL
          THEN least(now()+interval '10 minutes',start_time_utc)
        ELSE unbound_compensation_due_at END,
      result_json=v_result,completed_at=now(),updated_at=now()
      WHERE id=v_op.id RETURNING * INTO v_op;
    RETURN jsonb_build_object('success',true,
      'code',CASE
        WHEN v_op.operation_kind='deposit_charge' AND v_op.booking_id IS NULL THEN 'succeeded_unbound'
        WHEN v_op.operation_kind='deposit_refund' AND v_op.booking_id IS NULL THEN 'compensated'
        ELSE 'succeeded' END,
      'status','succeeded','operation_id',v_op.id,
      'material_fingerprint',v_op.material_fingerprint,'material',v_op.material_json,'result',v_result);
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('success',false,'code','provider_receipt_conflict');
  END;
END
$function$;

CREATE OR REPLACE FUNCTION public.protect_booking_provider_financial_truth()
RETURNS trigger LANGUAGE plpgsql SET search_path TO '' AS $function$
DECLARE v_role text:=coalesce(nullif(current_setting('request.jwt.claim.role',true),''),current_user);
BEGIN
  IF v_role NOT IN ('anon','authenticated') THEN RETURN NEW; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.deposit_payment_ledger_enforced_at IS NOT NULL
       OR NEW.noshow_payment_ledger_enforced_at IS NOT NULL
       OR NEW.late_cancel_payment_ledger_enforced_at IS NOT NULL
       OR NEW.deposit_status IN ('paid','refunded') OR NEW.deposit_paid_at IS NOT NULL
       OR NEW.stripe_payment_intent_id IS NOT NULL OR NEW.square_payment_id IS NOT NULL
       OR NEW.deposit_refunded_cents<>0 OR NEW.deposit_refund_status<>'none'
       OR coalesce(NEW.noshow_charge_status,'') IN ('charged','refunded')
       OR NEW.noshow_payment_id IS NOT NULL OR NEW.noshow_refunded_cents<>0
       OR NEW.noshow_refund_status<>'none'
       OR NEW.late_cancel_charge_status<>'none'
       OR NEW.late_cancel_payment_id IS NOT NULL
       OR NEW.late_cancel_charged_cents<>0 OR NEW.late_cancel_refunded_cents<>0
       OR NEW.late_cancel_refund_status<>'none'
       OR NEW.late_cancel_charge_occurrence_version IS NOT NULL THEN
      RAISE EXCEPTION 'provider-owned booking financial fields require service role' USING ERRCODE='42501';
    END IF;
  ELSE
    IF NEW.deposit_payment_ledger_enforced_at IS DISTINCT FROM OLD.deposit_payment_ledger_enforced_at
       OR NEW.noshow_payment_ledger_enforced_at IS DISTINCT FROM OLD.noshow_payment_ledger_enforced_at
       OR NEW.late_cancel_payment_ledger_enforced_at IS DISTINCT FROM OLD.late_cancel_payment_ledger_enforced_at
       OR NEW.deposit_paid_at IS DISTINCT FROM OLD.deposit_paid_at
       OR NEW.stripe_payment_intent_id IS DISTINCT FROM OLD.stripe_payment_intent_id
       OR NEW.square_payment_id IS DISTINCT FROM OLD.square_payment_id
       OR NEW.deposit_refunded_cents IS DISTINCT FROM OLD.deposit_refunded_cents
       OR NEW.deposit_refund_status IS DISTINCT FROM OLD.deposit_refund_status
       OR NEW.noshow_payment_id IS DISTINCT FROM OLD.noshow_payment_id
       OR NEW.noshow_refunded_cents IS DISTINCT FROM OLD.noshow_refunded_cents
       OR NEW.noshow_refund_status IS DISTINCT FROM OLD.noshow_refund_status
       OR NEW.noshow_charge_attempts IS DISTINCT FROM OLD.noshow_charge_attempts
       OR NEW.noshow_last_charge_attempt_at IS DISTINCT FROM OLD.noshow_last_charge_attempt_at
       OR NEW.noshow_charge_error IS DISTINCT FROM OLD.noshow_charge_error
       OR NEW.late_cancel_charge_status IS DISTINCT FROM OLD.late_cancel_charge_status
       OR NEW.late_cancel_payment_id IS DISTINCT FROM OLD.late_cancel_payment_id
       OR NEW.late_cancel_charged_cents IS DISTINCT FROM OLD.late_cancel_charged_cents
       OR NEW.late_cancel_refunded_cents IS DISTINCT FROM OLD.late_cancel_refunded_cents
       OR NEW.late_cancel_refund_status IS DISTINCT FROM OLD.late_cancel_refund_status
       OR NEW.late_cancel_charge_occurrence_version IS DISTINCT FROM OLD.late_cancel_charge_occurrence_version
       OR (NEW.deposit_status IS DISTINCT FROM OLD.deposit_status
           AND (NEW.deposit_status IN ('paid','refunded') OR OLD.deposit_status IN ('paid','refunded')))
       OR (NEW.noshow_charge_status IS DISTINCT FROM OLD.noshow_charge_status
           AND (NEW.noshow_charge_status IN ('charged','refunded') OR OLD.noshow_charge_status IN ('charged','refunded'))) THEN
      RAISE EXCEPTION 'provider-owned booking financial fields require service role' USING ERRCODE='42501';
    END IF;
    IF OLD.deposit_payment_ledger_enforced_at IS NOT NULL AND (
         NEW.deposit_required IS DISTINCT FROM OLD.deposit_required
         OR NEW.deposit_amount_cents IS DISTINCT FROM OLD.deposit_amount_cents
         OR NEW.deposit_reason IS DISTINCT FROM OLD.deposit_reason
         OR NEW.deposit_hold IS DISTINCT FROM OLD.deposit_hold
       ) THEN
      RAISE EXCEPTION 'ledger-enforced deposit material requires service role' USING ERRCODE='42501';
    END IF;
    IF OLD.noshow_payment_ledger_enforced_at IS NOT NULL AND (
         NEW.noshow_fee_cents IS DISTINCT FROM OLD.noshow_fee_cents
         OR NEW.noshow_card_id IS DISTINCT FROM OLD.noshow_card_id
         OR NEW.noshow_customer_id IS DISTINCT FROM OLD.noshow_customer_id
         OR NEW.noshow_consent_at IS DISTINCT FROM OLD.noshow_consent_at
       ) THEN
      RAISE EXCEPTION 'ledger-enforced no-show material requires service role' USING ERRCODE='42501';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS protect_booking_provider_financial_truth_trigger ON public.bookings;
CREATE TRIGGER protect_booking_provider_financial_truth_trigger
  BEFORE INSERT OR UPDATE ON public.bookings FOR EACH ROW
  EXECUTE FUNCTION public.protect_booking_provider_financial_truth();


CREATE OR REPLACE FUNCTION public.bind_public_deposit_payment_operation(
  p_operation_id uuid,
  p_request_id uuid,
  p_expected_material_fingerprint text,
  p_booking_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
  v_op public.booking_payment_operations%ROWTYPE;
  v_booking public.bookings%ROWTYPE;
  v_phone_fp text;
  v_other uuid;
  v_result jsonb;
BEGIN
  IF p_operation_id IS NULL OR p_request_id IS NULL OR p_booking_id IS NULL
     OR coalesce(p_expected_material_fingerprint,'')!~'^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('success',false,'code','invalid_input');
  END IF;
  SELECT * INTO v_op FROM public.booking_payment_operations
    WHERE id=p_operation_id AND request_id=p_request_id FOR UPDATE;
  IF NOT FOUND OR v_op.operation_kind<>'deposit_charge'
     OR v_op.booking_intent_idempotency_key IS NULL THEN
    RETURN jsonb_build_object('success',false,'code','operation_not_found');
  END IF;
  IF v_op.material_fingerprint IS DISTINCT FROM p_expected_material_fingerprint THEN
    RETURN jsonb_build_object('success',false,'code','operation_conflict');
  END IF;
  IF v_op.status='compensated' THEN
    RETURN jsonb_build_object('success',false,'code','deposit_already_compensated',
      'operation_id',v_op.id,'status',v_op.status,'result',v_op.result_json);
  END IF;
  IF v_op.status<>'succeeded' THEN
    RETURN jsonb_build_object('success',false,'code','payment_not_succeeded','status',v_op.status);
  END IF;
  IF v_op.booking_id IS NOT NULL AND v_op.booking_id<>p_booking_id THEN
    RETURN jsonb_build_object('success',false,'code','operation_already_bound');
  END IF;
  IF v_op.booking_id IS NULL AND (
       v_op.binding_expires_at IS NULL OR v_op.binding_expires_at<=now()
     ) THEN
    RETURN jsonb_build_object('success',false,'code','binding_expired',
      'operation_id',v_op.id,'binding_expires_at',v_op.binding_expires_at);
  END IF;
  PERFORM 1 FROM public.booking_payment_operations
    WHERE parent_operation_id=v_op.id AND operation_kind='deposit_refund' FOR UPDATE;
  IF FOUND THEN
    RETURN jsonb_build_object('success',false,'code','deposit_compensation_already_claimed');
  END IF;
  SELECT * INTO v_booking FROM public.bookings WHERE id=p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','booking_not_found'); END IF;
  IF v_booking.status<>'confirmed'
     OR v_booking.group_id IS NOT NULL
     OR v_booking.deleted_at IS NOT NULL
     OR v_booking.recovered_from_booking_id IS NOT NULL
     OR v_booking.recovery_kind IS NOT NULL
     OR v_booking.recovered_by_user_id IS NOT NULL THEN
    RETURN jsonb_build_object('success',false,'code','booking_not_bindable');
  END IF;
  v_phone_fp := encode(extensions.digest(
    convert_to(public.canonical_phone(v_booking.client_phone),'UTF8'),'sha256'
  ),'hex');
  IF v_booking.salon_id<>v_op.salon_id
     OR v_booking.service_id IS DISTINCT FROM v_op.service_id
     OR v_booking.staff_id IS DISTINCT FROM v_op.staff_id
     OR v_booking.start_time_utc IS DISTINCT FROM v_op.start_time_utc
     OR v_booking.end_time_utc IS DISTINCT FROM v_op.end_time_utc
     OR v_booking.idempotency_key IS DISTINCT FROM v_op.booking_intent_idempotency_key
     OR v_booking.public_booking_pricing_fingerprint IS DISTINCT FROM v_op.pricing_fingerprint
     OR v_phone_fp IS DISTINCT FROM v_op.client_phone_fingerprint THEN
    RETURN jsonb_build_object('success',false,'code','booking_binding_mismatch');
  END IF;
  SELECT id INTO v_other FROM public.booking_payment_operations
    WHERE booking_id=p_booking_id AND operation_kind='deposit_charge'
      AND status IN ('sending','pending_customer','pending_provider','reconciling','unknown','succeeded')
      AND id<>p_operation_id LIMIT 1 FOR UPDATE;
  IF FOUND THEN RETURN jsonb_build_object('success',false,'code','booking_payment_already_bound'); END IF;

  UPDATE public.booking_payment_operations SET booking_id=p_booking_id,
    binding_expires_at=NULL,unbound_compensation_due_at=NULL,
    compensation_lease_token=NULL,compensation_lease_expires_at=NULL,updated_at=now()
    WHERE id=p_operation_id;
  UPDATE public.bookings SET
    deposit_required=true,
    deposit_amount_cents=v_op.amount_cents,
    deposit_reason=coalesce(v_op.material_json->>'deposit_reason','authoritative_payment_operation'),
    deposit_status=CASE WHEN v_op.status='succeeded' THEN 'paid' ELSE 'required' END,
    deposit_paid_at=CASE WHEN v_op.status='succeeded' THEN coalesce(deposit_paid_at,v_op.completed_at,now()) ELSE deposit_paid_at END,
    stripe_payment_intent_id=CASE WHEN v_op.status='succeeded' AND v_op.provider='stripe' THEN v_op.provider_payment_id ELSE stripe_payment_intent_id END,
    square_payment_id=CASE WHEN v_op.status='succeeded' AND v_op.provider='square' THEN v_op.provider_payment_id ELSE square_payment_id END,
    deposit_hold=CASE WHEN v_op.status='succeeded' THEN false ELSE deposit_hold END,
    verification_method=CASE WHEN v_op.status='succeeded' THEN 'deposit' ELSE verification_method END,
    verification_completed_at=CASE WHEN v_op.status='succeeded' THEN coalesce(verification_completed_at,v_op.completed_at,now()) ELSE verification_completed_at END,
    deposit_payment_ledger_enforced_at=CASE WHEN v_op.status='succeeded' THEN coalesce(deposit_payment_ledger_enforced_at,now()) ELSE deposit_payment_ledger_enforced_at END
    WHERE id=p_booking_id;
  v_result := coalesce(v_op.result_json,'{}'::jsonb) || jsonb_build_object(
    'booking_id',p_booking_id,'bound',true,'status',v_op.status
  );
  UPDATE public.booking_payment_operations SET result_json=CASE
    WHEN status='succeeded' THEN v_result ELSE result_json END,updated_at=now()
    WHERE id=p_operation_id;
  RETURN jsonb_build_object(
    'success',true,'code',CASE WHEN v_op.booking_id=p_booking_id THEN 'binding_replay' ELSE 'bound' END,
    'operation_id',p_operation_id,'booking_id',p_booking_id,'status',v_op.status,
    'material_fingerprint',v_op.material_fingerprint,'material',v_op.material_json,
    'result',CASE WHEN v_op.status='succeeded' THEN v_result ELSE v_op.result_json END
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.inspect_booking_payment_operation(
  p_salon_id uuid,p_booking_id uuid,p_request_id uuid,p_operation_kind text
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE v_op public.booking_payment_operations%ROWTYPE;
BEGIN
  SELECT * INTO v_op FROM public.booking_payment_operations
    WHERE salon_id=p_salon_id AND request_id=p_request_id
      AND operation_kind=p_operation_kind
      AND (p_booking_id IS NULL OR booking_id=p_booking_id);
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','operation_not_found'); END IF;
  RETURN jsonb_build_object(
    'success',true,'code','operation_loaded','operation_id',v_op.id,
    'salon_id',v_op.salon_id,'booking_id',v_op.booking_id,'status',v_op.status,
    'attempt_count',v_op.attempt_count,'lease_expires_at',v_op.lease_expires_at,
    'next_reconcile_at',v_op.next_reconcile_at,'provider_status',v_op.provider_status,
    'error_code',v_op.error_code,'material_fingerprint',v_op.material_fingerprint,
    'material',v_op.material_json,'provider_material',v_op.provider_material,
    'provider_order_id',v_op.provider_order_id,'provider_link_id',v_op.provider_link_id,
    'provider_link_url',v_op.provider_link_url,'delivery_mode',v_op.delivery_mode,
    'result',v_op.result_json
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.claim_booking_payment_operation_reconciliation(
  p_operation_id uuid,p_request_id uuid,p_expected_material_fingerprint text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE v_op public.booking_payment_operations%ROWTYPE; v_token uuid:=gen_random_uuid();
BEGIN
  SELECT * INTO v_op FROM public.booking_payment_operations
    WHERE id=p_operation_id AND request_id=p_request_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','operation_not_found'); END IF;
  IF v_op.material_fingerprint IS DISTINCT FROM p_expected_material_fingerprint THEN
    RETURN jsonb_build_object('success',false,'code','operation_conflict');
  END IF;
  IF v_op.status='succeeded' THEN
    RETURN jsonb_build_object('success',true,'code','operation_replay','status','succeeded',
      'operation_id',v_op.id,'material_fingerprint',v_op.material_fingerprint,
      'material',v_op.material_json,'result',v_op.result_json);
  ELSIF v_op.status='failed' THEN
    RETURN jsonb_build_object('success',false,'code','operation_failed','status','failed',
      'operation_id',v_op.id,'error_code',v_op.error_code,
      'material_fingerprint',v_op.material_fingerprint);
  ELSIF v_op.status IN ('sending','reconciling') AND v_op.lease_expires_at>now() THEN
    RETURN jsonb_build_object('success',false,'code','in_flight','status',v_op.status,
      'operation_id',v_op.id,'lease_expires_at',v_op.lease_expires_at,
      'material_fingerprint',v_op.material_fingerprint);
  ELSIF v_op.delivery_mode='public_customer_present'
     AND v_op.provider_payment_id IS NULL
     AND v_op.status IN ('sending','reconciling','unknown') THEN
    IF v_op.status<>'unknown' THEN
      UPDATE public.booking_payment_operations SET status='unknown',
        failure_disposition='ambiguous',error_code='customer_present_receipt_unknown',
        attempt_token=NULL,lease_expires_at=NULL,next_reconcile_at=NULL,updated_at=now()
        WHERE id=v_op.id RETURNING * INTO v_op;
    END IF;
    RETURN jsonb_build_object('success',false,'code','manual_reconciliation_required',
      'status','unknown','operation_id',v_op.id,
      'material_fingerprint',v_op.material_fingerprint);
  ELSIF v_op.status IN ('pending_provider','unknown') AND coalesce(v_op.next_reconcile_at,now())>now() THEN
    RETURN jsonb_build_object('success',false,'code','reconcile_not_due','status',v_op.status,
      'operation_id',v_op.id,'next_reconcile_at',v_op.next_reconcile_at,
      'material_fingerprint',v_op.material_fingerprint);
  END IF;
  IF v_op.attempt_count>=3 THEN
    RETURN jsonb_build_object('success',false,'code','reconciliation_exhausted','status',v_op.status,
      'operation_id',v_op.id,'material_fingerprint',v_op.material_fingerprint);
  END IF;
  UPDATE public.booking_payment_operations SET status='reconciling',
    failure_disposition=CASE WHEN v_op.status IN ('sending','reconciling')
      THEN 'ambiguous' ELSE failure_disposition END,
    error_code=CASE
      WHEN v_op.status='sending' AND v_op.booking_intent_idempotency_key IS NOT NULL
        THEN 'provider_attach_outcome_unknown'
      WHEN v_op.status IN ('sending','reconciling') THEN 'provider_outcome_ambiguous'
      ELSE error_code END,
    attempt_token=v_token,
    attempt_count=attempt_count+1,lease_expires_at=now()+interval '2 minutes',
    next_reconcile_at=NULL,updated_at=now() WHERE id=v_op.id RETURNING * INTO v_op;
  RETURN jsonb_build_object(
    'success',true,'code','reconcile_claimed','status','reconciling',
    'operation_id',v_op.id,'attempt_token',v_token,
    'provider_idempotency_key',v_op.provider_idempotency_key,
    'attempt_count',v_op.attempt_count,'lease_expires_at',v_op.lease_expires_at,
    'provider_payment_id',v_op.provider_payment_id,
    'provider_refund_id',v_op.provider_refund_id,
    'provider_order_id',v_op.provider_order_id,
    'provider_link_id',v_op.provider_link_id,
    'provider_link_url',v_op.provider_link_url,
    'delivery_mode',v_op.delivery_mode,
    'material_fingerprint',v_op.material_fingerprint,'material',v_op.material_json,
    'provider_material',v_op.provider_material
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.discover_due_booking_payment_reconciliations(
  p_limit integer DEFAULT 25
) RETURNS SETOF jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
  v_op public.booking_payment_operations%ROWTYPE;
  v_attempt uuid;
BEGIN
  IF p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid limit' USING ERRCODE='22023';
  END IF;
  FOR v_op IN
    SELECT p.* FROM public.booking_payment_operations p
    WHERE p.attempt_count<3 AND (
      (p.status IN ('sending','reconciling') AND p.lease_expires_at<=now())
      OR (p.status IN ('pending_provider','unknown')
          AND coalesce(p.next_reconcile_at,p.updated_at)<=now())
    )
    AND NOT (coalesce(p.delivery_mode,'')='public_customer_present'
      AND p.provider_payment_id IS NULL AND p.status='unknown')
    ORDER BY coalesce(p.next_reconcile_at,p.lease_expires_at,p.updated_at),p.created_at,p.id
    FOR UPDATE SKIP LOCKED LIMIT p_limit
  LOOP
    IF v_op.delivery_mode='public_customer_present'
       AND v_op.provider_payment_id IS NULL
       AND v_op.status IN ('sending','reconciling','unknown') THEN
      UPDATE public.booking_payment_operations SET status='unknown',
        failure_disposition='ambiguous',error_code='customer_present_receipt_unknown',
        attempt_token=NULL,lease_expires_at=NULL,next_reconcile_at=NULL,updated_at=now()
        WHERE id=v_op.id RETURNING * INTO v_op;
      RETURN NEXT jsonb_build_object(
        'success',false,'code','manual_reconciliation_required','status','unknown',
        'operation_id',v_op.id,'salon_id',v_op.salon_id,'booking_id',v_op.booking_id,
        'request_id',v_op.request_id,'operation_kind',v_op.operation_kind,
        'material_fingerprint',v_op.material_fingerprint
      );
      CONTINUE;
    END IF;
    v_attempt:=gen_random_uuid();
    UPDATE public.booking_payment_operations SET status='reconciling',
      failure_disposition=CASE WHEN v_op.status IN ('sending','reconciling')
        THEN 'ambiguous' ELSE failure_disposition END,
      error_code=CASE
        WHEN v_op.status='sending' AND v_op.booking_intent_idempotency_key IS NOT NULL
          THEN 'provider_attach_outcome_unknown'
        WHEN v_op.status IN ('sending','reconciling') THEN 'provider_outcome_ambiguous'
        ELSE error_code END,
      attempt_token=v_attempt,attempt_count=attempt_count+1,
      lease_expires_at=now()+interval '2 minutes',next_reconcile_at=NULL,
      updated_at=now()
      WHERE id=v_op.id RETURNING * INTO v_op;
    RETURN NEXT jsonb_build_object(
      'success',true,'code','reconcile_claimed','status','reconciling',
      'operation_id',v_op.id,'salon_id',v_op.salon_id,'booking_id',v_op.booking_id,
      'request_id',v_op.request_id,'operation_kind',v_op.operation_kind,
      'attempt_token',v_attempt,'attempt_count',v_op.attempt_count,
      'lease_expires_at',v_op.lease_expires_at,
      'provider_payment_id',v_op.provider_payment_id,
      'provider_refund_id',v_op.provider_refund_id,
      'provider_order_id',v_op.provider_order_id,
      'provider_link_id',v_op.provider_link_id,
      'provider_link_url',v_op.provider_link_url,
      'delivery_mode',v_op.delivery_mode,
      'provider_idempotency_key',v_op.provider_idempotency_key,
      'material_fingerprint',v_op.material_fingerprint,
      'material',v_op.material_json,'provider_material',v_op.provider_material
    );
  END LOOP;
  RETURN;
END
$function$;


REVOKE ALL ON FUNCTION public.booking_payment_provider_context(uuid,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.booking_payment_provider_context(uuid,text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.resolve_booking_payment_operation_material(
  p_salon_id uuid,
  p_booking_id uuid,
  p_operation_kind text,
  p_amount_cents integer,
  p_lock_booking boolean DEFAULT false,
  p_exclude_operation_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
  v_booking public.bookings%ROWTYPE;
  v_parent_op public.booking_payment_operations%ROWTYPE;
  v_context jsonb;
  v_provider text;
  v_currency text;
  v_amount integer;
  v_captured integer;
  v_refunded integer := 0;
  v_reserved integer := 0;
  v_remaining integer;
  v_parent text;
  v_provider_material jsonb;
  v_fingerprint_material jsonb;
  v_fingerprint text;
  v_cancel_cap public.booking_management_capabilities%ROWTYPE;
  v_cancel_preview jsonb;
BEGIN
  IF p_salon_id IS NULL OR p_booking_id IS NULL
     OR p_operation_kind NOT IN ('deposit_charge','noshow_charge','late_cancel_charge',
       'deposit_refund','noshow_refund') THEN
    RETURN jsonb_build_object('success',false,'code','invalid_input');
  END IF;

  IF p_lock_booking THEN
    SELECT * INTO v_booking FROM public.bookings
      WHERE id=p_booking_id AND salon_id=p_salon_id FOR UPDATE;
  ELSE
    SELECT * INTO v_booking FROM public.bookings
      WHERE id=p_booking_id AND salon_id=p_salon_id;
  END IF;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','booking_not_found'); END IF;

  IF p_operation_kind IN ('deposit_refund','noshow_refund') THEN
    SELECT * INTO v_parent_op FROM public.booking_payment_operations o
      WHERE o.booking_id=p_booking_id
        AND o.operation_kind=CASE WHEN p_operation_kind='deposit_refund'
          THEN 'deposit_charge' ELSE 'noshow_charge' END
        AND o.status='succeeded' AND o.provider_payment_id IS NOT NULL
      ORDER BY o.completed_at DESC LIMIT 1;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('success',false,'code','legacy_payment_not_ledgered');
    END IF;
    v_provider:=v_parent_op.provider;
    v_currency:=v_parent_op.currency;
    v_context:=jsonb_build_object(
      'provider_account_fingerprint',v_parent_op.provider_account_fingerprint
    );
    v_provider_material:=v_parent_op.provider_material;
  ELSE
    v_context := public.booking_payment_provider_context(p_salon_id,p_operation_kind);
    IF coalesce((v_context->>'success')::boolean,false) IS NOT TRUE THEN RETURN v_context; END IF;
    v_provider := v_context->>'provider';
    v_currency := v_context->>'currency';
    v_provider_material := v_context->'provider_material';
  END IF;

  IF p_operation_kind='deposit_charge' THEN
    v_amount := coalesce(v_booking.deposit_amount_cents,0);
    IF v_booking.deposit_required IS NOT TRUE OR v_amount <= 0
       OR v_booking.deposit_status <> 'required' THEN
      RETURN jsonb_build_object('success',false,'code','deposit_not_chargeable');
    END IF;
    IF p_amount_cents IS NOT NULL AND p_amount_cents <> v_amount THEN
      RETURN jsonb_build_object('success',false,'code','amount_changed','amount_cents',v_amount);
    END IF;
  ELSIF p_operation_kind='noshow_charge' THEN
    v_amount := coalesce(v_booking.noshow_fee_cents,0);
    IF v_booking.status <> 'no_show' OR v_amount <= 0
       OR v_booking.noshow_consent_at IS NULL
       OR nullif(trim(coalesce(v_booking.noshow_card_id,'')),'') IS NULL
       OR nullif(trim(coalesce(v_booking.noshow_customer_id,'')),'') IS NULL
       OR coalesce(v_booking.noshow_charge_status,'') NOT IN ('saved','failed') THEN
      RETURN jsonb_build_object('success',false,'code','noshow_not_chargeable');
    END IF;
    IF p_amount_cents IS NOT NULL AND p_amount_cents <> v_amount THEN
      RETURN jsonb_build_object('success',false,'code','amount_changed','amount_cents',v_amount);
    END IF;
    v_provider_material := v_provider_material || jsonb_build_object(
      'saved_card_id',v_booking.noshow_card_id,
      'customer_id',v_booking.noshow_customer_id
    );
  ELSIF p_operation_kind='late_cancel_charge' THEN
    SELECT * INTO v_cancel_cap FROM public.booking_management_capabilities c
      WHERE c.salon_id=p_salon_id AND c.booking_id=p_booking_id
        AND c.action='cancel' AND c.consumed_at IS NOT NULL
        AND c.scope_kind='booking_own'
        AND coalesce(c.result_json->>'rsvp_semantic','')=''
        AND coalesce(c.result_json->>'status','')='cancelled'
        AND coalesce(c.result_json->>'customer_transition_version','')~'^[0-9]+$'
        AND (c.result_json->>'customer_transition_version')::bigint=v_booking.customer_transition_version
      ORDER BY c.consumed_at DESC,c.id LIMIT 1;
    IF NOT FOUND OR v_booking.status<>'cancelled' OR v_booking.group_id IS NOT NULL
       OR v_booking.customer_transition_kind<>'cancel'
       OR v_booking.customer_transition_version<=0 THEN
      RETURN jsonb_build_object('success',false,'code','late_cancel_occurrence_not_authorized');
    END IF;
    v_cancel_preview:=v_cancel_cap.result_json->'cancel_preview';
    IF jsonb_typeof(v_cancel_preview)<>'object'
       OR coalesce(v_cancel_preview->>'will_charge','false')<>'true'
       OR coalesce(v_cancel_preview->>'fee_cents','')!~'^[0-9]+$'
       OR (v_cancel_preview->>'fee_cents')::integer<=0
       OR coalesce(v_cancel_preview->>'has_chargeable_card','false')<>'true'
       OR v_booking.noshow_consent_at IS NULL
       OR nullif(trim(coalesce(v_booking.noshow_card_id,'')),'') IS NULL
       OR nullif(trim(coalesce(v_booking.noshow_customer_id,'')),'') IS NULL THEN
      RETURN jsonb_build_object('success',false,'code','late_cancel_not_chargeable');
    END IF;
    v_amount:=(v_cancel_preview->>'fee_cents')::integer;
    IF p_amount_cents IS NOT NULL AND p_amount_cents<>v_amount THEN
      RETURN jsonb_build_object('success',false,'code','amount_changed','amount_cents',v_amount);
    END IF;
    v_provider_material:=v_provider_material||jsonb_build_object(
      'saved_card_id',v_booking.noshow_card_id,
      'customer_id',v_booking.noshow_customer_id
    );
  ELSIF p_operation_kind='deposit_refund' THEN
    v_captured := v_parent_op.amount_cents;
    v_refunded := coalesce(v_booking.deposit_refunded_cents,0);
    IF v_booking.deposit_status NOT IN ('paid','refunded') OR v_captured <= 0 THEN
      RETURN jsonb_build_object('success',false,'code','deposit_not_refundable');
    END IF;
    v_parent := v_parent_op.provider_payment_id;
    IF (CASE WHEN v_provider='stripe' THEN v_booking.stripe_payment_intent_id
             ELSE v_booking.square_payment_id END) IS DISTINCT FROM v_parent THEN
      RETURN jsonb_build_object('success',false,'code','parent_payment_binding_mismatch');
    END IF;
  ELSE
    v_captured := v_parent_op.amount_cents;
    v_refunded := coalesce(v_booking.noshow_refunded_cents,0);
    IF coalesce(v_booking.noshow_charge_status,'') NOT IN ('charged','refunded') OR v_captured <= 0 THEN
      RETURN jsonb_build_object('success',false,'code','noshow_not_refundable');
    END IF;
    v_parent := v_parent_op.provider_payment_id;
    IF v_booking.noshow_payment_id IS DISTINCT FROM v_parent THEN
      RETURN jsonb_build_object('success',false,'code','parent_payment_binding_mismatch');
    END IF;
  END IF;

  IF p_operation_kind IN ('deposit_refund','noshow_refund') THEN
    IF p_amount_cents IS NULL OR p_amount_cents <= 0 THEN
      RETURN jsonb_build_object('success',false,'code','invalid_refund_amount');
    END IF;
    SELECT coalesce(sum(o.amount_cents),0)::integer INTO v_reserved
      FROM public.booking_payment_operations o
      WHERE o.booking_id=p_booking_id
        AND o.operation_kind=p_operation_kind
        AND o.status IN ('sending','pending_provider','reconciling','unknown')
        AND (p_exclude_operation_id IS NULL OR o.id<>p_exclude_operation_id);
    v_remaining := greatest(0,v_captured-v_refunded-v_reserved);
    IF p_amount_cents > v_remaining THEN
      RETURN jsonb_build_object(
        'success',false,'code','refund_amount_exceeds_remaining',
        'captured_cents',v_captured,'refunded_cents',v_refunded,
        'reserved_cents',v_reserved,'remaining_refundable_cents',v_remaining
      );
    END IF;
    v_amount := p_amount_cents;
    v_provider_material := v_provider_material || jsonb_build_object('parent_payment_id',v_parent);
  ELSE
    v_captured := v_amount;
    v_remaining := 0;
  END IF;

  v_fingerprint_material := jsonb_build_object(
    'salon_id',p_salon_id,
    'booking_id',p_booking_id,
    'operation_kind',p_operation_kind,
    'provider',v_provider,
    'provider_account_fingerprint',v_context->>'provider_account_fingerprint',
    'amount_cents',v_amount,
    'currency',v_currency,
    'parent_payment_id',v_parent,
    'deposit_status',v_booking.deposit_status,
    'deposit_amount_cents',v_booking.deposit_amount_cents,
    'deposit_refunded_cents',v_booking.deposit_refunded_cents,
    'noshow_status',v_booking.noshow_charge_status,
    'noshow_fee_cents',v_booking.noshow_fee_cents,
    'noshow_refunded_cents',v_booking.noshow_refunded_cents,
    'booking_status',v_booking.status,
    'operation_occurrence_version',CASE WHEN p_operation_kind='late_cancel_charge'
      THEN v_booking.customer_transition_version ELSE NULL END,
    'cancel_preview',CASE WHEN p_operation_kind='late_cancel_charge' THEN v_cancel_preview ELSE NULL END,
    'cancel_receipt_fingerprint',CASE WHEN p_operation_kind='late_cancel_charge'
      THEN v_cancel_cap.result_fingerprint ELSE NULL END,
    'scope_kind',CASE WHEN p_operation_kind='late_cancel_charge' THEN v_cancel_cap.scope_kind ELSE NULL END,
    'rsvp_semantic',CASE WHEN p_operation_kind='late_cancel_charge'
      THEN v_cancel_cap.result_json->>'rsvp_semantic' ELSE NULL END,
    'consent_at',v_booking.noshow_consent_at,
    'card_fingerprint',CASE WHEN v_booking.noshow_card_id IS NULL THEN NULL ELSE encode(
      extensions.digest(convert_to(v_booking.noshow_card_id,'UTF8'),'sha256'),'hex') END,
    'reserved_cents',v_reserved
  );
  v_fingerprint := encode(
    extensions.digest(convert_to(v_fingerprint_material::text,'UTF8'),'sha256'),'hex'
  );

  RETURN jsonb_build_object(
    'success',true,'code','material_loaded',
    'salon_id',p_salon_id,'booking_id',p_booking_id,
    'operation_kind',p_operation_kind,
    'provider',v_provider,
    'provider_account_fingerprint',v_context->>'provider_account_fingerprint',
    'amount_cents',v_amount,'currency',v_currency,
    'parent_payment_id',v_parent,
    'parent_operation_id',v_parent_op.id,
    'operation_occurrence_version',CASE WHEN p_operation_kind='late_cancel_charge'
      THEN v_booking.customer_transition_version ELSE v_parent_op.operation_occurrence_version END,
    'cancel_preview',CASE WHEN p_operation_kind='late_cancel_charge' THEN v_cancel_preview ELSE NULL END,
    'scope_kind',CASE WHEN p_operation_kind='late_cancel_charge' THEN v_cancel_cap.scope_kind ELSE NULL END,
    'rsvp_semantic',CASE WHEN p_operation_kind='late_cancel_charge'
      THEN v_cancel_cap.result_json->>'rsvp_semantic' ELSE NULL END,
    'captured_cents',v_captured,'refunded_cents',v_refunded,
    'reserved_cents',v_reserved,'remaining_refundable_cents',v_remaining,
    'provider_material',v_provider_material,
    'material_fingerprint',v_fingerprint
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.load_booking_payment_operation_material(
  p_salon_id uuid,
  p_booking_id uuid,
  p_operation_kind text,
  p_amount_cents integer DEFAULT NULL
) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $function$
  SELECT public.resolve_booking_payment_operation_material(
    p_salon_id,p_booking_id,p_operation_kind,p_amount_cents,false,NULL
  )
$function$;

REVOKE ALL ON FUNCTION public.resolve_booking_payment_operation_material(uuid,uuid,text,integer,boolean,uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.load_booking_payment_operation_material(uuid,uuid,text,integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_booking_payment_operation_material(uuid,uuid,text,integer,boolean,uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.load_booking_payment_operation_material(uuid,uuid,text,integer)
  TO service_role;

CREATE OR REPLACE FUNCTION public.resolve_public_deposit_payment_material(
  p_salon_id uuid,
  p_service_id uuid,
  p_staff_id uuid,
  p_start_time_utc timestamptz,
  p_end_time_utc timestamptz,
  p_addon_service_ids uuid[],
  p_combo_id uuid,
  p_voucher_id uuid,
  p_client_phone text,
  p_client_email text,
  p_apply_email_discount boolean,
  p_booking_idempotency_key uuid,
  p_expected_pricing_fingerprint text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
  v_quote jsonb;
  v_context jsonb;
  v_salon public.salons%ROWTYPE;
  v_client record;
  v_phone text := public.canonical_phone(p_client_phone);
  v_phone_fp text;
  v_service_price integer;
  v_amount integer := 0;
  v_reason text;
  v_pct integer;
  v_material jsonb;
  v_fp text;
BEGIN
  IF p_salon_id IS NULL OR p_service_id IS NULL OR p_staff_id IS NULL
     OR p_start_time_utc IS NULL OR p_end_time_utc IS NULL
     OR p_booking_idempotency_key IS NULL
     OR coalesce(p_expected_pricing_fingerprint,'') !~ '^[0-9a-f]{64}$'
     OR v_phone IS NULL OR length(regexp_replace(v_phone,'\D','','g')) < 7 THEN
    RETURN jsonb_build_object('success',false,'code','invalid_input');
  END IF;

  v_quote := public.resolve_public_booking_pricing(
    p_salon_id,p_service_id,p_staff_id,p_start_time_utc,p_end_time_utc,
    coalesce(p_addon_service_ids,ARRAY[]::uuid[]),p_combo_id,p_voucher_id,
    p_client_phone,p_client_email,coalesce(p_apply_email_discount,false),false
  );
  IF coalesce((v_quote->>'success')::boolean,false) IS NOT TRUE THEN RETURN v_quote; END IF;
  IF v_quote->>'pricing_fingerprint' IS DISTINCT FROM p_expected_pricing_fingerprint THEN
    RETURN jsonb_build_object(
      'success',false,'code','pricing_changed','quote',v_quote
    );
  END IF;

  SELECT * INTO v_salon FROM public.salons WHERE id=p_salon_id AND archived_at IS NULL;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','salon_not_found'); END IF;
  v_service_price := coalesce((v_quote->>'price_cents')::integer,0);
  IF v_service_price <= 0 THEN RETURN jsonb_build_object('success',false,'code','deposit_not_required'); END IF;

  SELECT * INTO v_client FROM public.get_booking_client_snapshot(p_salon_id,v_phone) LIMIT 1;
  IF FOUND AND coalesce(v_client.is_vip,false) THEN
    RETURN jsonb_build_object('success',false,'code','deposit_not_required','reason','vip');
  ELSIF FOUND AND coalesce(v_client.no_show_count,0) > 0 THEN
    v_pct := coalesce(v_salon.deposit_pct_no_show,50); v_reason := 'previous_no_show';
  ELSIF v_service_price >= coalesce(v_salon.deposit_high_value_cents,10000) THEN
    v_pct := coalesce(v_salon.deposit_pct_high_value,30); v_reason := 'high_value_service';
  ELSIF NOT FOUND OR coalesce(v_client.visit_count,0) <= 0 THEN
    v_pct := coalesce(v_salon.deposit_pct_new_customer,20); v_reason := 'new_customer';
  ELSE
    RETURN jsonb_build_object('success',false,'code','deposit_not_required');
  END IF;

  v_amount := round(v_service_price::numeric * greatest(0,least(100,v_pct)) / 100)::integer;
  IF v_amount <= 0 THEN RETURN jsonb_build_object('success',false,'code','deposit_not_required'); END IF;
  v_context := public.booking_payment_provider_context(p_salon_id,'deposit_charge');
  IF coalesce((v_context->>'success')::boolean,false) IS NOT TRUE THEN RETURN v_context; END IF;
  IF v_context->>'provider'='square'
     AND nullif(v_context->'provider_material'->>'provider_application_id','') IS NULL THEN
    RETURN jsonb_build_object('success',false,'code','square_public_configuration_missing');
  END IF;
  v_phone_fp := encode(extensions.digest(convert_to(v_phone,'UTF8'),'sha256'),'hex');

  v_material := jsonb_build_object(
    'salon_id',p_salon_id,'service_id',p_service_id,'staff_id',p_staff_id,
    'start_time_utc',p_start_time_utc,'end_time_utc',v_quote->>'end_time_utc',
    'booking_idempotency_key',p_booking_idempotency_key,
    'pricing_fingerprint',p_expected_pricing_fingerprint,
    'client_phone_fingerprint',v_phone_fp,
    'operation_kind','deposit_charge','provider',v_context->>'provider',
    'provider_account_fingerprint',v_context->>'provider_account_fingerprint',
    'amount_cents',v_amount,'currency',v_context->>'currency','deposit_reason',v_reason,
    'provider_material',(v_context->'provider_material') || jsonb_build_object(
      'amount_cents',v_amount,
      'booking_intent_reference',p_booking_idempotency_key,
      'pricing_fingerprint',p_expected_pricing_fingerprint
    )
  );
  v_fp := encode(extensions.digest(convert_to(v_material::text,'UTF8'),'sha256'),'hex');
  RETURN jsonb_build_object(
    'success',true,'code','material_loaded','material_fingerprint',v_fp,'material',v_material
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.load_public_deposit_payment_material(
  p_salon_id uuid,p_service_id uuid,p_staff_id uuid,
  p_start_time_utc timestamptz,p_end_time_utc timestamptz,
  p_addon_service_ids uuid[],p_combo_id uuid,p_voucher_id uuid,
  p_client_phone text,p_client_email text,p_apply_email_discount boolean,
  p_booking_idempotency_key uuid,p_expected_pricing_fingerprint text
) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $function$
  SELECT public.resolve_public_deposit_payment_material(
    p_salon_id,p_service_id,p_staff_id,p_start_time_utc,p_end_time_utc,
    p_addon_service_ids,p_combo_id,p_voucher_id,p_client_phone,p_client_email,
    p_apply_email_discount,p_booking_idempotency_key,p_expected_pricing_fingerprint
  )
$function$;

-- A stable, no-PII envelope binds caller-controlled booking/deposit facts before
-- any mutable catalog, provider, client-history or lifecycle lookup.  Exact
-- request/intent replay compares this digest first and then returns the stored
-- operation authority, so a committed provider attempt is never hidden by
-- later pricing/configuration drift.
CREATE OR REPLACE FUNCTION public.public_deposit_request_fingerprint(
  p_salon_id uuid,p_service_id uuid,p_staff_id uuid,
  p_start_time_utc timestamptz,p_end_time_utc timestamptz,
  p_addon_service_ids uuid[],p_combo_id uuid,p_voucher_id uuid,
  p_client_phone text,p_client_email text,p_apply_email_discount boolean,
  p_booking_idempotency_key uuid,p_expected_pricing_fingerprint text
) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
  v_phone text:=public.canonical_phone(p_client_phone);
  v_phone_fp text;
  v_email_fp text;
  v_envelope jsonb;
BEGIN
  IF p_salon_id IS NULL OR p_service_id IS NULL OR p_staff_id IS NULL
     OR p_start_time_utc IS NULL OR p_end_time_utc IS NULL
     OR p_booking_idempotency_key IS NULL
     OR coalesce(p_expected_pricing_fingerprint,'')!~'^[0-9a-f]{64}$'
     OR v_phone IS NULL OR length(regexp_replace(v_phone,'\D','','g'))<7 THEN
    RETURN NULL;
  END IF;
  v_phone_fp:=encode(extensions.digest(convert_to(v_phone,'UTF8'),'sha256'),'hex');
  IF nullif(lower(trim(coalesce(p_client_email,''))),'') IS NOT NULL THEN
    v_email_fp:=encode(extensions.digest(convert_to(
      lower(trim(p_client_email)),'UTF8'
    ),'sha256'),'hex');
  END IF;
  v_envelope:=jsonb_build_object(
    'salon_id',p_salon_id,'service_id',p_service_id,'staff_id',p_staff_id,
    'start_time_utc',p_start_time_utc,'end_time_utc',p_end_time_utc,
    'addon_service_ids',to_jsonb(coalesce(p_addon_service_ids,ARRAY[]::uuid[])),
    'combo_id',p_combo_id,'voucher_id',p_voucher_id,
    'client_phone_fingerprint',v_phone_fp,
    'client_email_fingerprint',v_email_fp,
    'apply_email_discount',coalesce(p_apply_email_discount,false),
    'booking_idempotency_key',p_booking_idempotency_key,
    'expected_pricing_fingerprint',p_expected_pricing_fingerprint
  );
  RETURN encode(extensions.digest(convert_to(v_envelope::text,'UTF8'),'sha256'),'hex');
END
$function$;

CREATE OR REPLACE FUNCTION public.claim_public_deposit_payment_operation(
  p_salon_id uuid,p_service_id uuid,p_staff_id uuid,
  p_start_time_utc timestamptz,p_end_time_utc timestamptz,
  p_addon_service_ids uuid[],p_combo_id uuid,p_voucher_id uuid,
  p_client_phone text,p_client_email text,p_apply_email_discount boolean,
  p_booking_idempotency_key uuid,p_expected_pricing_fingerprint text,
  p_request_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
  v_loaded jsonb;
  v_material jsonb;
  v_existing public.booking_payment_operations%ROWTYPE;
  v_request_fingerprint text;
  v_id uuid := gen_random_uuid();
  v_token uuid := gen_random_uuid();
BEGIN
  IF p_request_id IS NULL THEN
    RETURN jsonb_build_object('success',false,'code','invalid_request_id');
  END IF;
  v_request_fingerprint:=public.public_deposit_request_fingerprint(
    p_salon_id,p_service_id,p_staff_id,p_start_time_utc,p_end_time_utc,
    p_addon_service_ids,p_combo_id,p_voucher_id,p_client_phone,p_client_email,
    p_apply_email_discount,p_booking_idempotency_key,p_expected_pricing_fingerprint
  );
  IF v_request_fingerprint IS NULL THEN
    RETURN jsonb_build_object('success',false,'code','invalid_input');
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_salon_id::text||':deposit:'||p_booking_idempotency_key::text,0
  ));

  -- Exact request replay is deliberately before the live resolver.  The
  -- persisted request fingerprint is caller-payload bound but contains no PII.
  SELECT * INTO v_existing FROM public.booking_payment_operations
    WHERE salon_id=p_salon_id AND request_id=p_request_id
      AND operation_kind='deposit_charge' FOR UPDATE;
  IF FOUND THEN
    IF v_existing.public_request_fingerprint IS DISTINCT FROM v_request_fingerprint
       OR v_existing.booking_intent_idempotency_key IS DISTINCT FROM p_booking_idempotency_key THEN
      RETURN jsonb_build_object('success',false,'code','operation_conflict');
    END IF;
    IF v_existing.status='succeeded' THEN
      RETURN jsonb_build_object('success',true,'code','operation_replay','status',v_existing.status,
        'operation_id',v_existing.id,'material_fingerprint',v_existing.material_fingerprint,
        'material',v_existing.material_json,'result',v_existing.result_json);
    ELSIF v_existing.status='compensated' THEN
      RETURN jsonb_build_object('success',false,'code','deposit_compensated','status',v_existing.status,
        'operation_id',v_existing.id,'material_fingerprint',v_existing.material_fingerprint,
        'material',v_existing.material_json,'result',v_existing.result_json);
    ELSIF v_existing.status='failed' THEN
      RETURN jsonb_build_object('success',false,'code','operation_failed','status',v_existing.status,
        'operation_id',v_existing.id,'error_code',v_existing.error_code,
        'material_fingerprint',v_existing.material_fingerprint);
    ELSIF v_existing.status='pending_customer' THEN
      RETURN jsonb_build_object('success',true,'code','customer_confirmation_pending',
        'status','pending_customer','operation_id',v_existing.id,
        'provider_payment_id',v_existing.provider_payment_id,
        'provider_idempotency_key',v_existing.provider_idempotency_key,
        'finalize_expires_at',v_existing.customer_finalize_expires_at,
        'material_fingerprint',v_existing.material_fingerprint,
        'material',v_existing.material_json,'provider_material',v_existing.provider_material);
    ELSIF v_existing.status IN ('pending_provider','unknown') THEN
      RETURN jsonb_build_object('success',false,'code','reconciliation_required','status',v_existing.status,
        'operation_id',v_existing.id,'provider_payment_id',v_existing.provider_payment_id,
        'provider_idempotency_key',v_existing.provider_idempotency_key,
        'material_fingerprint',v_existing.material_fingerprint,
        'material',v_existing.material_json,'provider_material',v_existing.provider_material);
    ELSIF v_existing.status IN ('sending','reconciling')
          AND v_existing.lease_expires_at<=now() THEN
      UPDATE public.booking_payment_operations SET status='unknown',
        failure_disposition='ambiguous',error_code=CASE
          WHEN v_existing.status='sending' THEN 'provider_attach_outcome_unknown'
          ELSE 'provider_outcome_ambiguous' END,
        attempt_token=NULL,lease_expires_at=NULL,next_reconcile_at=now(),updated_at=now()
        WHERE id=v_existing.id RETURNING * INTO v_existing;
      RETURN jsonb_build_object('success',false,'code','reconciliation_required','status','unknown',
        'operation_id',v_existing.id,'provider_payment_id',v_existing.provider_payment_id,
        'provider_idempotency_key',v_existing.provider_idempotency_key,
        'material_fingerprint',v_existing.material_fingerprint,
        'material',v_existing.material_json,'provider_material',v_existing.provider_material);
    ELSIF v_existing.status='sending' THEN
      RETURN jsonb_build_object('success',true,'code','attempt_replay','status','sending',
        'operation_id',v_existing.id,'attempt_token',v_existing.attempt_token,
        'provider_idempotency_key',v_existing.provider_idempotency_key,
        'lease_expires_at',v_existing.lease_expires_at,'attempt_count',v_existing.attempt_count,
        'material_fingerprint',v_existing.material_fingerprint,
        'material',v_existing.material_json,'provider_material',v_existing.provider_material);
    ELSE
      RETURN jsonb_build_object('success',false,'code','in_flight','status',v_existing.status,
        'operation_id',v_existing.id,'lease_expires_at',v_existing.lease_expires_at,
        'material_fingerprint',v_existing.material_fingerprint,
        'material',v_existing.material_json,'provider_material',v_existing.provider_material);
    END IF;
  END IF;

  -- A caller that rotated only its transport request id after losing the first
  -- response must still converge on the one active booking intent.
  SELECT * INTO v_existing FROM public.booking_payment_operations
    WHERE salon_id=p_salon_id
      AND booking_intent_idempotency_key=p_booking_idempotency_key
      AND operation_kind='deposit_charge'
      AND status IN ('sending','pending_customer','pending_provider','reconciling','unknown','succeeded')
    FOR UPDATE;
  IF FOUND THEN
    IF v_existing.public_request_fingerprint IS DISTINCT FROM v_request_fingerprint THEN
      RETURN jsonb_build_object('success',false,'code','booking_intent_conflict');
    END IF;
    IF v_existing.status IN ('sending','reconciling')
       AND v_existing.lease_expires_at<=now() THEN
      UPDATE public.booking_payment_operations SET status='unknown',
        failure_disposition='ambiguous',error_code=CASE
          WHEN v_existing.status='sending' THEN 'provider_attach_outcome_unknown'
          ELSE 'provider_outcome_ambiguous' END,
        attempt_token=NULL,lease_expires_at=NULL,next_reconcile_at=now(),updated_at=now()
        WHERE id=v_existing.id RETURNING * INTO v_existing;
    END IF;
    RETURN jsonb_build_object(
      'success',v_existing.status IN ('succeeded','pending_customer'),
      'code',CASE WHEN v_existing.status='succeeded' THEN 'intent_replay'
                  WHEN v_existing.status='pending_customer' THEN 'customer_confirmation_pending'
                  WHEN v_existing.status IN ('pending_provider','unknown') THEN 'reconciliation_required'
                  ELSE 'intent_in_flight' END,
      'status',v_existing.status,'operation_id',v_existing.id,
      'lease_expires_at',v_existing.lease_expires_at,
      'provider_payment_id',v_existing.provider_payment_id,
      'provider_idempotency_key',v_existing.provider_idempotency_key,
      'finalize_expires_at',v_existing.customer_finalize_expires_at,
      'material_fingerprint',v_existing.material_fingerprint,
      'material',v_existing.material_json,'provider_material',v_existing.provider_material,
      'result',v_existing.result_json
    );
  END IF;

  -- Only a genuinely new intent consults mutable pricing/client/provider state.
  v_loaded := public.resolve_public_deposit_payment_material(
    p_salon_id,p_service_id,p_staff_id,p_start_time_utc,p_end_time_utc,
    p_addon_service_ids,p_combo_id,p_voucher_id,p_client_phone,p_client_email,
    p_apply_email_discount,p_booking_idempotency_key,p_expected_pricing_fingerprint
  );
  IF coalesce((v_loaded->>'success')::boolean,false) IS NOT TRUE THEN RETURN v_loaded; END IF;
  v_material := v_loaded->'material';

  INSERT INTO public.booking_payment_operations(
    id,salon_id,request_id,operation_kind,provider,provider_account_fingerprint,
    amount_cents,currency,material_fingerprint,material_json,provider_material,
    delivery_mode,public_request_fingerprint,
    booking_intent_idempotency_key,pricing_fingerprint,service_id,staff_id,
    start_time_utc,end_time_utc,client_phone_fingerprint,
    provider_idempotency_key,status,attempt_token,lease_expires_at
  ) VALUES (
    v_id,p_salon_id,p_request_id,'deposit_charge',v_material->>'provider',
    v_material->>'provider_account_fingerprint',(v_material->>'amount_cents')::integer,
    v_material->>'currency',v_loaded->>'material_fingerprint',v_material,v_material->'provider_material',
    CASE WHEN v_material->>'provider'='square' THEN 'public_customer_present' ELSE NULL END,
    v_request_fingerprint,
    p_booking_idempotency_key,p_expected_pricing_fingerprint,p_service_id,p_staff_id,
    p_start_time_utc,(v_material->>'end_time_utc')::timestamptz,
    v_material->>'client_phone_fingerprint','nq:'||v_id::text,
    'sending',v_token,now()+interval '2 minutes'
  );
  RETURN jsonb_build_object(
    'success',true,'code','claimed','status','sending','operation_id',v_id,
    'attempt_token',v_token,'provider_idempotency_key','nq:'||v_id::text,
    'lease_expires_at',now()+interval '2 minutes','attempt_count',1,
    'material_fingerprint',v_loaded->>'material_fingerprint','material',v_material,
    'provider_material',v_material->'provider_material'
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.public_booking_create_request_fingerprint(
  p_salon_id uuid,p_service_id uuid,p_staff_id uuid,
  p_client_name text,p_client_phone text,
  p_start_time_utc timestamptz,p_end_time_utc timestamptz,p_status text,
  p_client_notes text,p_addon_service_ids uuid[],p_client_email text,
  p_resource_id uuid,p_combo_id uuid,p_voucher_id uuid,
  p_apply_email_discount boolean,p_expected_pricing_fingerprint text
) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO ''
AS $function$
  SELECT encode(extensions.digest(convert_to(jsonb_build_object(
    'salon_id',p_salon_id,
    'service_id',p_service_id,
    'staff_id',p_staff_id,
    'client_name',trim(coalesce(p_client_name,'')),
    'client_phone',regexp_replace(coalesce(p_client_phone,''),'\D','','g'),
    'start_time_utc',p_start_time_utc,
    'end_time_utc',p_end_time_utc,
    'status','confirmed',
    'client_notes',nullif(trim(coalesce(p_client_notes,'')),''),
    'addon_service_ids',to_jsonb(coalesce(p_addon_service_ids,ARRAY[]::uuid[])),
    'client_email',nullif(lower(trim(coalesce(p_client_email,''))),''),
    'resource_id',p_resource_id,
    'combo_id',p_combo_id,
    'voucher_id',p_voucher_id,
    'apply_email_discount',coalesce(p_apply_email_discount,false),
    'expected_pricing_fingerprint',p_expected_pricing_fingerprint
  )::text,'UTF8'),'sha256'),'hex')
  WHERE p_status IS NOT DISTINCT FROM 'confirmed'
$function$;

-- Service-only canonical boundary for a paid public deposit.  The booking
-- create and successful payment bind commit together.  A structured bind
-- failure is raised inside a PL/pgSQL subtransaction and caught only after all
-- booking/profile/voucher/add-on writes have rolled back.
CREATE OR REPLACE FUNCTION public.create_public_booking_with_deposit_payment(
  p_salon_id uuid,
  p_service_id uuid,
  p_staff_id uuid,
  p_client_name text,
  p_client_phone text,
  p_start_time_utc timestamptz,
  p_end_time_utc timestamptz,
  p_status text,
  p_client_notes text,
  p_addon_service_ids uuid[],
  p_client_email text,
  p_resource_id uuid,
  p_combo_id uuid,
  p_voucher_id uuid,
  p_apply_email_discount boolean,
  p_idempotency_key uuid,
  p_expected_pricing_fingerprint text,
  p_payment_operation_id uuid,
  p_payment_request_id uuid,
  p_expected_payment_material_fingerprint text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
  v_op public.booking_payment_operations%ROWTYPE;
  v_booking public.bookings%ROWTYPE;
  v_public_request_fp text;
  v_create_fp text;
  v_create jsonb;
  v_bind jsonb;
  v_combined_result jsonb;
  v_booking_id uuid;
BEGIN
  IF p_payment_operation_id IS NULL OR p_payment_request_id IS NULL
     OR coalesce(p_expected_payment_material_fingerprint,'')!~'^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('success',false,'code','invalid_payment_binding_input');
  END IF;
  v_public_request_fp:=public.public_deposit_request_fingerprint(
    p_salon_id,p_service_id,p_staff_id,p_start_time_utc,p_end_time_utc,
    p_addon_service_ids,p_combo_id,p_voucher_id,p_client_phone,p_client_email,
    p_apply_email_discount,p_idempotency_key,p_expected_pricing_fingerprint
  );
  v_create_fp:=public.public_booking_create_request_fingerprint(
    p_salon_id,p_service_id,p_staff_id,p_client_name,p_client_phone,
    p_start_time_utc,p_end_time_utc,p_status,p_client_notes,p_addon_service_ids,
    p_client_email,p_resource_id,p_combo_id,p_voucher_id,p_apply_email_discount,
    p_expected_pricing_fingerprint
  );
  IF v_public_request_fp IS NULL OR v_create_fp IS NULL THEN
    RETURN jsonb_build_object('success',false,'code','invalid_booking_input');
  END IF;

  -- This row lock is also the bind-vs-compensation serialization point.
  SELECT * INTO v_op FROM public.booking_payment_operations
    WHERE id=p_payment_operation_id AND salon_id=p_salon_id
      AND request_id=p_payment_request_id AND operation_kind='deposit_charge'
    FOR UPDATE;
  IF NOT FOUND OR v_op.booking_intent_idempotency_key IS NULL THEN
    RETURN jsonb_build_object('success',false,'code','payment_operation_not_found');
  END IF;
  IF v_op.material_fingerprint IS DISTINCT FROM p_expected_payment_material_fingerprint
     OR v_op.public_request_fingerprint IS DISTINCT FROM v_public_request_fp
     OR v_op.booking_intent_idempotency_key IS DISTINCT FROM p_idempotency_key THEN
    RETURN jsonb_build_object('success',false,'code','payment_operation_conflict');
  END IF;
  IF v_op.booking_create_fingerprint IS NOT NULL
     AND v_op.booking_create_fingerprint IS DISTINCT FROM v_create_fp THEN
    RETURN jsonb_build_object('success',false,'code','booking_idempotency_conflict');
  END IF;

  -- Exact committed replay uses only persisted booking/payment authority.  It
  -- intentionally does not re-run current pricing, provider, policy or salon
  -- lifecycle checks.
  IF v_op.booking_id IS NOT NULL THEN
    SELECT * INTO v_booking FROM public.bookings
      WHERE id=v_op.booking_id AND salon_id=v_op.salon_id;
    IF NOT FOUND OR v_booking.idempotency_key IS DISTINCT FROM p_idempotency_key
       OR v_booking.public_booking_request_fingerprint IS DISTINCT FROM v_create_fp THEN
      RETURN jsonb_build_object('success',false,'code','bound_booking_conflict');
    END IF;
    UPDATE public.booking_payment_operations SET
      booking_create_fingerprint=coalesce(booking_create_fingerprint,v_create_fp),
      updated_at=now() WHERE id=v_op.id RETURNING * INTO v_op;
    RETURN jsonb_build_object(
      'success',true,'code','booking_payment_replay','idempotent',true,
      'booking_id',v_op.booking_id,'operation_id',v_op.id,'payment_status',v_op.status,
      'material_fingerprint',v_op.material_fingerprint,
      'booking',coalesce(v_op.result_json->'booking_create_result',
        v_booking.public_booking_pricing_snapshot || jsonb_build_object(
          'success',true,'code','booked','idempotent',true,
          'booking_id',v_booking.id,'start_time_utc',v_booking.start_time_utc,
          'end_time_utc',v_booking.end_time_utc
        )),
      'payment_result',v_op.result_json
    );
  END IF;
  IF v_op.status='compensated' THEN
    RETURN jsonb_build_object('success',false,'code','deposit_already_compensated',
      'operation_id',v_op.id,'payment_status',v_op.status,'payment_result',v_op.result_json);
  ELSIF v_op.status='pending_customer' THEN
    RETURN jsonb_build_object('success',false,'code','payment_customer_action_required',
      'operation_id',v_op.id,'payment_status',v_op.status,
      'provider_payment_id',v_op.provider_payment_id,
      'finalize_expires_at',v_op.customer_finalize_expires_at);
  ELSIF v_op.status IN ('sending','pending_provider','reconciling','unknown') THEN
    RETURN jsonb_build_object('success',false,'code','payment_reconciliation_required',
      'operation_id',v_op.id,'payment_status',v_op.status,
      'provider_payment_id',v_op.provider_payment_id,
      'provider_idempotency_key',v_op.provider_idempotency_key,
      'material_fingerprint',v_op.material_fingerprint,
      'provider_material',v_op.provider_material);
  ELSIF v_op.status<>'succeeded' THEN
    RETURN jsonb_build_object('success',false,'code','payment_not_succeeded',
      'operation_id',v_op.id,'payment_status',v_op.status,'error_code',v_op.error_code);
  END IF;
  IF v_op.binding_expires_at IS NULL OR v_op.binding_expires_at<=now() THEN
    RETURN jsonb_build_object('success',false,'code','binding_expired',
      'operation_id',v_op.id,'binding_expires_at',v_op.binding_expires_at);
  END IF;
  PERFORM 1 FROM public.booking_payment_operations
    WHERE parent_operation_id=v_op.id AND operation_kind='deposit_refund' FOR UPDATE;
  IF FOUND THEN
    RETURN jsonb_build_object('success',false,'code','deposit_compensation_already_claimed');
  END IF;
  UPDATE public.booking_payment_operations SET
    booking_create_fingerprint=coalesce(booking_create_fingerprint,v_create_fp),
    updated_at=now() WHERE id=v_op.id RETURNING * INTO v_op;

  BEGIN
    v_create:=public.create_public_booking(
      p_salon_id,p_service_id,p_staff_id,p_client_name,p_client_phone,
      p_start_time_utc,p_end_time_utc,p_status,p_client_notes,
      coalesce(p_addon_service_ids,ARRAY[]::uuid[]),p_client_email,p_resource_id,
      p_combo_id,p_voucher_id,p_apply_email_discount,p_idempotency_key,
      p_expected_pricing_fingerprint
    );
    IF coalesce((v_create->>'success')::boolean,false) IS NOT TRUE THEN
      RETURN jsonb_build_object('success',false,'code','booking_create_failed',
        'operation_id',v_op.id,'payment_status',v_op.status,'booking',v_create);
    END IF;
    v_booking_id:=nullif(v_create->>'booking_id','')::uuid;
    IF v_booking_id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE='NI001',MESSAGE='atomic_deposit_bind_failed';
    END IF;
    v_bind:=public.bind_public_deposit_payment_operation(
      v_op.id,v_op.request_id,v_op.material_fingerprint,v_booking_id
    );
    IF coalesce((v_bind->>'success')::boolean,false) IS NOT TRUE THEN
      RAISE EXCEPTION USING ERRCODE='NI001',MESSAGE='atomic_deposit_bind_failed';
    END IF;
    v_combined_result:=coalesce(v_bind->'result','{}'::jsonb)||jsonb_build_object(
      'booking_create_result',v_create,'booking_id',v_booking_id,'bound',true
    );
    UPDATE public.booking_payment_operations SET result_json=v_combined_result,
      booking_create_fingerprint=v_create_fp,updated_at=now()
      WHERE id=v_op.id;
    RETURN jsonb_build_object(
      'success',true,'code','booked_and_deposit_bound','idempotent',false,
      'booking_id',v_booking_id,'operation_id',v_op.id,'payment_status','succeeded',
      'material_fingerprint',v_op.material_fingerprint,'booking',v_create,
      'payment_result',v_combined_result
    );
  EXCEPTION WHEN SQLSTATE 'NI001' THEN
    RETURN jsonb_build_object(
      'success',false,'code','atomic_deposit_bind_failed','operation_id',v_op.id,
      'payment_status',v_op.status,'booking',v_create,'binding',v_bind
    );
  END;
END
$function$;

REVOKE ALL ON FUNCTION public.load_public_deposit_payment_material(
  uuid,uuid,uuid,timestamptz,timestamptz,uuid[],uuid,uuid,text,text,boolean,uuid,text
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.public_deposit_request_fingerprint(
  uuid,uuid,uuid,timestamptz,timestamptz,uuid[],uuid,uuid,text,text,boolean,uuid,text
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.public_booking_create_request_fingerprint(
  uuid,uuid,uuid,text,text,timestamptz,timestamptz,text,text,uuid[],text,
  uuid,uuid,uuid,boolean,text
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_public_deposit_payment_operation(
  uuid,uuid,uuid,timestamptz,timestamptz,uuid[],uuid,uuid,text,text,boolean,uuid,text,uuid
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_public_booking_with_deposit_payment(
  uuid,uuid,uuid,text,text,timestamptz,timestamptz,text,text,uuid[],text,
  uuid,uuid,uuid,boolean,uuid,text,uuid,uuid,text
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_booking_payment_operation(uuid,uuid,text,text,text,text,text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_booking_payment_operation_reconciliation(uuid,uuid,text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.discover_due_booking_payment_reconciliations(integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.inspect_booking_payment_operation(uuid,uuid,uuid,text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bind_public_deposit_payment_operation(uuid,uuid,text,uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.protect_booking_provider_financial_truth()
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.load_public_deposit_payment_material(
  uuid,uuid,uuid,timestamptz,timestamptz,uuid[],uuid,uuid,text,text,boolean,uuid,text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.public_deposit_request_fingerprint(
  uuid,uuid,uuid,timestamptz,timestamptz,uuid[],uuid,uuid,text,text,boolean,uuid,text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.public_booking_create_request_fingerprint(
  uuid,uuid,uuid,text,text,timestamptz,timestamptz,text,text,uuid[],text,
  uuid,uuid,uuid,boolean,text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_public_deposit_payment_operation(
  uuid,uuid,uuid,timestamptz,timestamptz,uuid[],uuid,uuid,text,text,boolean,uuid,text,uuid
) TO service_role;
GRANT EXECUTE ON FUNCTION public.create_public_booking_with_deposit_payment(
  uuid,uuid,uuid,text,text,timestamptz,timestamptz,text,text,uuid[],text,
  uuid,uuid,uuid,boolean,uuid,text,uuid,uuid,text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_booking_payment_operation(uuid,uuid,text,text,text,text,text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_booking_payment_operation_reconciliation(uuid,uuid,text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.discover_due_booking_payment_reconciliations(integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.inspect_booking_payment_operation(uuid,uuid,uuid,text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.bind_public_deposit_payment_operation(uuid,uuid,text,uuid)
  TO service_role;

COMMENT ON TABLE public.booking_payment_operations IS
  'Service-only authoritative payment/refund operation ledger. Provider calls remain outside SQL; exact request/material/idempotency and receipts are reconciled here.';
COMMENT ON COLUMN public.booking_payment_operations.booking_id IS
  'Nullable only for canonical public deposit operations created before the booking; bind_public_deposit_payment_operation links exactly once.';
COMMENT ON COLUMN public.booking_payment_operations.provider_idempotency_key IS
  'Stable across initial call and all reconciliation attempts; callers must never replace it.';
COMMENT ON FUNCTION public.claim_booking_payment_operation_reconciliation(uuid,uuid,text) IS
  'Returns the same provider idempotency key after a lease/pending/unknown outcome. At most three exact attempts; never rotates a charge/refund key.';

CREATE OR REPLACE FUNCTION public.claim_booking_payment_operation(
  p_salon_id uuid,p_booking_id uuid,p_request_id uuid,p_operation_kind text,
  p_amount_cents integer,p_expected_material_fingerprint text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
  v_existing public.booking_payment_operations%ROWTYPE;
  v_loaded jsonb;
  v_id uuid := gen_random_uuid();
  v_token uuid := gen_random_uuid();
BEGIN
  IF p_request_id IS NULL OR coalesce(p_expected_material_fingerprint,'')!~'^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('success',false,'code','invalid_input');
  END IF;
  IF p_operation_kind='late_cancel_refund' THEN
    RETURN jsonb_build_object('success',false,'code','dedicated_late_cancel_refund_required');
  ELSIF p_operation_kind NOT IN ('deposit_charge','noshow_charge','late_cancel_charge',
      'deposit_refund','noshow_refund') THEN
    RETURN jsonb_build_object('success',false,'code','invalid_input');
  END IF;
  SELECT * INTO v_existing FROM public.booking_payment_operations
    WHERE salon_id=p_salon_id AND request_id=p_request_id AND operation_kind=p_operation_kind
    FOR UPDATE;
  IF FOUND THEN
    IF v_existing.booking_id IS DISTINCT FROM p_booking_id
       OR v_existing.amount_cents IS DISTINCT FROM p_amount_cents
       OR v_existing.material_fingerprint IS DISTINCT FROM p_expected_material_fingerprint THEN
      RETURN jsonb_build_object('success',false,'code','operation_conflict');
    END IF;
    IF v_existing.status='succeeded' THEN
      RETURN jsonb_build_object('success',true,'code','operation_replay','status','succeeded',
        'operation_id',v_existing.id,'material_fingerprint',v_existing.material_fingerprint,
        'material',v_existing.material_json,'result',v_existing.result_json);
    ELSIF v_existing.status='failed' THEN
      RETURN jsonb_build_object('success',false,'code','operation_failed','status','failed',
        'operation_id',v_existing.id,'error_code',v_existing.error_code,
        'material_fingerprint',v_existing.material_fingerprint);
    ELSIF v_existing.status IN ('pending_provider','unknown') THEN
      RETURN jsonb_build_object('success',false,'code','reconciliation_required','status',v_existing.status,
        'operation_id',v_existing.id,'material_fingerprint',v_existing.material_fingerprint);
    ELSE
      RETURN jsonb_build_object('success',false,'code','in_flight','status',v_existing.status,
        'operation_id',v_existing.id,'lease_expires_at',v_existing.lease_expires_at,
        'material_fingerprint',v_existing.material_fingerprint);
    END IF;
  END IF;

  IF p_operation_kind IN ('deposit_charge','noshow_charge') THEN
    PERFORM 1 FROM public.bookings WHERE id=p_booking_id AND salon_id=p_salon_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','booking_not_found'); END IF;
    SELECT * INTO v_existing FROM public.booking_payment_operations
      WHERE booking_id=p_booking_id AND operation_kind=p_operation_kind
        AND status IN ('sending','pending_customer','pending_provider','reconciling','unknown','succeeded')
      FOR UPDATE;
    IF FOUND THEN
      IF v_existing.amount_cents IS DISTINCT FROM p_amount_cents
         OR v_existing.material_fingerprint IS DISTINCT FROM p_expected_material_fingerprint THEN
        RETURN jsonb_build_object('success',false,'code','charge_occurrence_conflict');
      END IF;
      RETURN jsonb_build_object(
        'success',v_existing.status='succeeded',
        'code',CASE WHEN v_existing.status='succeeded' THEN 'charge_replay'
                    WHEN v_existing.status IN ('pending_provider','unknown') THEN 'reconciliation_required'
                    ELSE 'charge_in_flight' END,
        'status',v_existing.status,'operation_id',v_existing.id,
        'lease_expires_at',v_existing.lease_expires_at,
        'material_fingerprint',v_existing.material_fingerprint,
        'material',v_existing.material_json,'result',v_existing.result_json
      );
    END IF;
  ELSIF p_operation_kind='late_cancel_charge' THEN
    v_loaded:=public.resolve_booking_payment_operation_material(
      p_salon_id,p_booking_id,p_operation_kind,p_amount_cents,true,NULL
    );
    IF coalesce((v_loaded->>'success')::boolean,false) IS NOT TRUE THEN RETURN v_loaded; END IF;
    SELECT * INTO v_existing FROM public.booking_payment_operations
      WHERE booking_id=p_booking_id AND operation_kind='late_cancel_charge'
        AND operation_occurrence_version=(v_loaded->>'operation_occurrence_version')::bigint
        AND status IN ('sending','pending_provider','reconciling','unknown','succeeded')
      FOR UPDATE;
    IF FOUND THEN
      IF v_existing.amount_cents IS DISTINCT FROM p_amount_cents
         OR v_existing.material_fingerprint IS DISTINCT FROM p_expected_material_fingerprint THEN
        RETURN jsonb_build_object('success',false,'code','charge_occurrence_conflict');
      END IF;
      RETURN jsonb_build_object(
        'success',v_existing.status='succeeded',
        'code',CASE WHEN v_existing.status='succeeded' THEN 'charge_replay'
                    WHEN v_existing.status IN ('pending_provider','unknown') THEN 'reconciliation_required'
                    ELSE 'charge_in_flight' END,
        'status',v_existing.status,'operation_id',v_existing.id,
        'operation_occurrence_version',v_existing.operation_occurrence_version,
        'lease_expires_at',v_existing.lease_expires_at,
        'material_fingerprint',v_existing.material_fingerprint,
        'material',v_existing.material_json,'result',v_existing.result_json
      );
    END IF;
  END IF;

  v_loaded := public.resolve_booking_payment_operation_material(
    p_salon_id,p_booking_id,p_operation_kind,p_amount_cents,true,NULL
  );
  IF coalesce((v_loaded->>'success')::boolean,false) IS NOT TRUE THEN RETURN v_loaded; END IF;
  IF v_loaded->>'material_fingerprint' IS DISTINCT FROM p_expected_material_fingerprint THEN
    RETURN jsonb_build_object('success',false,'code','material_changed','material',v_loaded);
  END IF;
  SELECT * INTO v_existing FROM public.booking_payment_operations
    WHERE salon_id=p_salon_id AND request_id=p_request_id AND operation_kind=p_operation_kind
    FOR UPDATE;
  IF FOUND THEN RETURN public.claim_booking_payment_operation(
    p_salon_id,p_booking_id,p_request_id,p_operation_kind,p_amount_cents,p_expected_material_fingerprint
  ); END IF;

  INSERT INTO public.booking_payment_operations(
    id,salon_id,booking_id,request_id,operation_kind,provider,
    provider_account_fingerprint,amount_cents,currency,material_fingerprint,
    material_json,provider_material,parent_payment_id,parent_operation_id,
    operation_occurrence_version,provider_idempotency_key,status,
    attempt_token,lease_expires_at
  ) VALUES (
    v_id,p_salon_id,p_booking_id,p_request_id,p_operation_kind,v_loaded->>'provider',
    v_loaded->>'provider_account_fingerprint',(v_loaded->>'amount_cents')::integer,
    v_loaded->>'currency',p_expected_material_fingerprint,
    v_loaded-'success'-'code'-'material_fingerprint',v_loaded->'provider_material',
    nullif(v_loaded->>'parent_payment_id',''),
    nullif(v_loaded->>'parent_operation_id','')::uuid,
    nullif(v_loaded->>'operation_occurrence_version','')::bigint,'nq:'||v_id::text,
    'sending',v_token,now()+interval '2 minutes'
  );
  RETURN jsonb_build_object(
    'success',true,'code','claimed','status','sending','operation_id',v_id,
    'attempt_token',v_token,'provider_idempotency_key','nq:'||v_id::text,
    'lease_expires_at',now()+interval '2 minutes','attempt_count',1,
    'material_fingerprint',p_expected_material_fingerprint,
    'material',v_loaded-'success'-'code'-'material_fingerprint'
  );
END
$function$;

REVOKE ALL ON FUNCTION public.claim_booking_payment_operation(uuid,uuid,uuid,text,integer,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_booking_payment_operation(uuid,uuid,uuid,text,integer,text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.load_late_cancel_refund_material(
  p_parent_operation_id uuid,
  p_amount_cents integer
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
  v_parent public.booking_payment_operations%ROWTYPE;
  v_refunded integer;
  v_reserved integer;
  v_remaining integer;
  v_material jsonb;
  v_fp text;
BEGIN
  SELECT * INTO v_parent FROM public.booking_payment_operations
    WHERE id=p_parent_operation_id AND operation_kind='late_cancel_charge'
      AND status='succeeded' AND booking_id IS NOT NULL;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','parent_operation_not_found'); END IF;
  IF p_amount_cents IS NULL OR p_amount_cents<=0 THEN
    RETURN jsonb_build_object('success',false,'code','invalid_refund_amount');
  END IF;
  SELECT coalesce(sum(amount_cents),0)::integer INTO v_refunded
    FROM public.booking_payment_operations
    WHERE parent_operation_id=v_parent.id AND operation_kind='late_cancel_refund'
      AND status='succeeded';
  SELECT coalesce(sum(amount_cents),0)::integer INTO v_reserved
    FROM public.booking_payment_operations
    WHERE parent_operation_id=v_parent.id AND operation_kind='late_cancel_refund'
      AND status IN ('sending','pending_provider','reconciling','unknown');
  v_remaining:=greatest(0,v_parent.amount_cents-v_refunded-v_reserved);
  IF p_amount_cents>v_remaining THEN
    RETURN jsonb_build_object('success',false,'code','refund_amount_exceeds_remaining',
      'captured_cents',v_parent.amount_cents,'refunded_cents',v_refunded,
      'reserved_cents',v_reserved,'remaining_refundable_cents',v_remaining);
  END IF;
  v_material:=jsonb_build_object(
    'salon_id',v_parent.salon_id,'booking_id',v_parent.booking_id,
    'operation_kind','late_cancel_refund',
    'operation_occurrence_version',v_parent.operation_occurrence_version,
    'parent_operation_id',v_parent.id,'parent_payment_id',v_parent.provider_payment_id,
    'provider',v_parent.provider,
    'provider_account_fingerprint',v_parent.provider_account_fingerprint,
    'amount_cents',p_amount_cents,'currency',v_parent.currency,
    'captured_cents',v_parent.amount_cents,'refunded_cents',v_refunded,
    'reserved_cents',v_reserved,'remaining_refundable_cents',v_remaining,
    'provider_material',v_parent.provider_material||
      jsonb_build_object('parent_payment_id',v_parent.provider_payment_id)
  );
  v_fp:=encode(extensions.digest(convert_to(v_material::text,'UTF8'),'sha256'),'hex');
  RETURN jsonb_build_object('success',true,'code','material_loaded',
    'material_fingerprint',v_fp,'material',v_material);
END
$function$;

CREATE OR REPLACE FUNCTION public.claim_late_cancel_refund(
  p_parent_operation_id uuid,
  p_request_id uuid,
  p_amount_cents integer,
  p_expected_material_fingerprint text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
  v_parent public.booking_payment_operations%ROWTYPE;
  v_existing public.booking_payment_operations%ROWTYPE;
  v_loaded jsonb;
  v_material jsonb;
  v_id uuid:=gen_random_uuid();
  v_attempt uuid:=gen_random_uuid();
BEGIN
  IF p_request_id IS NULL OR coalesce(p_expected_material_fingerprint,'')!~'^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('success',false,'code','invalid_input');
  END IF;
  SELECT * INTO v_parent FROM public.booking_payment_operations
    WHERE id=p_parent_operation_id AND operation_kind='late_cancel_charge' FOR UPDATE;
  IF NOT FOUND OR v_parent.status<>'succeeded' OR v_parent.booking_id IS NULL THEN
    RETURN jsonb_build_object('success',false,'code','parent_operation_not_found');
  END IF;
  SELECT * INTO v_existing FROM public.booking_payment_operations
    WHERE salon_id=v_parent.salon_id AND request_id=p_request_id
      AND operation_kind='late_cancel_refund' FOR UPDATE;
  IF FOUND THEN
    IF v_existing.parent_operation_id IS DISTINCT FROM v_parent.id
       OR v_existing.amount_cents IS DISTINCT FROM p_amount_cents
       OR v_existing.material_fingerprint IS DISTINCT FROM p_expected_material_fingerprint THEN
      RETURN jsonb_build_object('success',false,'code','operation_conflict');
    END IF;
    RETURN jsonb_build_object(
      'success',v_existing.status='succeeded',
      'code',CASE WHEN v_existing.status='succeeded' THEN 'operation_replay'
                  WHEN v_existing.status IN ('pending_provider','unknown') THEN 'reconciliation_required'
                  ELSE 'in_flight' END,
      'operation_id',v_existing.id,'status',v_existing.status,
      'material_fingerprint',v_existing.material_fingerprint,
      'material',v_existing.material_json,'result',v_existing.result_json
    );
  END IF;
  v_loaded:=public.load_late_cancel_refund_material(v_parent.id,p_amount_cents);
  IF coalesce((v_loaded->>'success')::boolean,false) IS NOT TRUE THEN RETURN v_loaded; END IF;
  IF v_loaded->>'material_fingerprint' IS DISTINCT FROM p_expected_material_fingerprint THEN
    RETURN jsonb_build_object('success',false,'code','material_changed','material',v_loaded);
  END IF;
  v_material:=v_loaded->'material';
  INSERT INTO public.booking_payment_operations(
    id,salon_id,booking_id,request_id,operation_kind,operation_occurrence_version,
    provider,provider_account_fingerprint,amount_cents,currency,material_fingerprint,
    material_json,provider_material,parent_payment_id,parent_operation_id,
    provider_idempotency_key,status,attempt_token,lease_expires_at
  ) VALUES (
    v_id,v_parent.salon_id,v_parent.booking_id,p_request_id,'late_cancel_refund',
    v_parent.operation_occurrence_version,v_parent.provider,
    v_parent.provider_account_fingerprint,p_amount_cents,v_parent.currency,
    p_expected_material_fingerprint,v_material,v_material->'provider_material',
    v_parent.provider_payment_id,v_parent.id,'nq:'||v_id::text,
    'sending',v_attempt,now()+interval '2 minutes'
  );
  RETURN jsonb_build_object('success',true,'code','claimed','status','sending',
    'operation_id',v_id,'attempt_token',v_attempt,
    'provider_idempotency_key','nq:'||v_id::text,
    'operation_occurrence_version',v_parent.operation_occurrence_version,
    'lease_expires_at',now()+interval '2 minutes','attempt_count',1,
    'material_fingerprint',p_expected_material_fingerprint,'material',v_material);
END
$function$;

REVOKE ALL ON FUNCTION public.load_late_cancel_refund_material(uuid,integer)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.claim_late_cancel_refund(uuid,uuid,integer,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.load_late_cancel_refund_material(uuid,integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_late_cancel_refund(uuid,uuid,integer,text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.load_unbound_deposit_refund_material(
  p_parent_operation_id uuid
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
  v_parent public.booking_payment_operations%ROWTYPE;
  v_child public.booking_payment_operations%ROWTYPE;
  v_material jsonb;
  v_fp text;
BEGIN
  SELECT * INTO v_parent FROM public.booking_payment_operations
    WHERE id=p_parent_operation_id AND operation_kind='deposit_charge';
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','parent_operation_not_found'); END IF;
  IF v_parent.status='compensated' THEN
    SELECT * INTO v_child FROM public.booking_payment_operations
      WHERE parent_operation_id=p_parent_operation_id AND operation_kind='deposit_refund'
        AND status='succeeded' LIMIT 1;
    RETURN jsonb_build_object('success',true,'code','compensation_replay',
      'operation_id',v_child.id,'status','succeeded',
      'material_fingerprint',v_child.material_fingerprint,
      'material',v_child.material_json,'result',v_child.result_json);
  END IF;
  IF v_parent.status<>'succeeded' OR v_parent.provider_payment_id IS NULL THEN
    RETURN jsonb_build_object('success',false,'code','parent_payment_not_succeeded');
  END IF;
  IF v_parent.booking_id IS NOT NULL THEN
    RETURN jsonb_build_object('success',false,'code','parent_payment_already_bound');
  END IF;
  SELECT * INTO v_child FROM public.booking_payment_operations
    WHERE parent_operation_id=p_parent_operation_id AND operation_kind='deposit_refund'
      AND status IN ('sending','pending_provider','reconciling','unknown','succeeded')
    LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'success',v_child.status='succeeded',
      'code',CASE WHEN v_child.status='succeeded' THEN 'compensation_replay'
                  WHEN v_child.status IN ('pending_provider','unknown') THEN 'reconciliation_required'
                  ELSE 'compensation_in_flight' END,
      'operation_id',v_child.id,'status',v_child.status,
      'material_fingerprint',v_child.material_fingerprint,
      'material',v_child.material_json,'result',v_child.result_json
    );
  END IF;
  v_material:=jsonb_build_object(
    'salon_id',v_parent.salon_id,'booking_id',NULL,'operation_kind','deposit_refund',
    'parent_operation_id',v_parent.id,'parent_payment_id',v_parent.provider_payment_id,
    'provider',v_parent.provider,
    'provider_account_fingerprint',v_parent.provider_account_fingerprint,
    'amount_cents',v_parent.amount_cents,'currency',v_parent.currency,
    'captured_cents',v_parent.amount_cents,'refunded_cents',0,'reserved_cents',0,
    'remaining_refundable_cents',v_parent.amount_cents,
    'provider_material',v_parent.provider_material ||
      jsonb_build_object('parent_payment_id',v_parent.provider_payment_id)
  );
  v_fp:=encode(extensions.digest(convert_to(v_material::text,'UTF8'),'sha256'),'hex');
  RETURN jsonb_build_object('success',true,'code','material_loaded',
    'material_fingerprint',v_fp,'material',v_material);
END
$function$;

CREATE OR REPLACE FUNCTION public.claim_unbound_deposit_refund(
  p_parent_operation_id uuid,
  p_request_id uuid,
  p_expected_material_fingerprint text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
  v_parent public.booking_payment_operations%ROWTYPE;
  v_existing public.booking_payment_operations%ROWTYPE;
  v_loaded jsonb;
  v_material jsonb;
  v_id uuid:=gen_random_uuid();
  v_token uuid:=gen_random_uuid();
BEGIN
  IF p_parent_operation_id IS NULL OR p_request_id IS NULL
     OR coalesce(p_expected_material_fingerprint,'')!~'^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('success',false,'code','invalid_input');
  END IF;
  SELECT * INTO v_parent FROM public.booking_payment_operations
    WHERE id=p_parent_operation_id AND operation_kind='deposit_charge' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','parent_operation_not_found'); END IF;
  v_loaded:=public.load_unbound_deposit_refund_material(p_parent_operation_id);
  IF coalesce((v_loaded->>'success')::boolean,false) IS NOT TRUE THEN RETURN v_loaded; END IF;
  IF v_loaded->>'material_fingerprint' IS DISTINCT FROM p_expected_material_fingerprint THEN
    RETURN jsonb_build_object('success',false,'code','material_changed','material',v_loaded);
  END IF;
  v_material:=v_loaded->'material';
  SELECT * INTO v_existing FROM public.booking_payment_operations
    WHERE salon_id=v_parent.salon_id AND request_id=p_request_id
      AND operation_kind='deposit_refund' FOR UPDATE;
  IF FOUND THEN
    IF v_existing.parent_operation_id IS DISTINCT FROM p_parent_operation_id
       OR v_existing.material_fingerprint IS DISTINCT FROM p_expected_material_fingerprint THEN
      RETURN jsonb_build_object('success',false,'code','operation_conflict');
    END IF;
    RETURN jsonb_build_object(
      'success',v_existing.status='succeeded',
      'code',CASE WHEN v_existing.status='succeeded' THEN 'operation_replay'
                  WHEN v_existing.status IN ('pending_provider','unknown') THEN 'reconciliation_required'
                  ELSE 'in_flight' END,
      'operation_id',v_existing.id,'status',v_existing.status,
      'material_fingerprint',v_existing.material_fingerprint,
      'material',v_existing.material_json,'result',v_existing.result_json
    );
  END IF;
  INSERT INTO public.booking_payment_operations(
    id,salon_id,booking_id,request_id,operation_kind,provider,
    provider_account_fingerprint,amount_cents,currency,material_fingerprint,
    material_json,provider_material,parent_payment_id,parent_operation_id,
    provider_idempotency_key,status,attempt_token,lease_expires_at
  ) VALUES (
    v_id,v_parent.salon_id,NULL,p_request_id,'deposit_refund',v_parent.provider,
    v_parent.provider_account_fingerprint,v_parent.amount_cents,v_parent.currency,
    p_expected_material_fingerprint,v_material,v_material->'provider_material',
    v_parent.provider_payment_id,v_parent.id,'nq:'||v_id::text,
    'sending',v_token,now()+interval '2 minutes'
  );
  RETURN jsonb_build_object('success',true,'code','claimed','status','sending',
    'operation_id',v_id,'attempt_token',v_token,
    'provider_idempotency_key','nq:'||v_id::text,
    'lease_expires_at',now()+interval '2 minutes','attempt_count',1,
    'material_fingerprint',p_expected_material_fingerprint,'material',v_material);
END
$function$;

REVOKE ALL ON FUNCTION public.load_unbound_deposit_refund_material(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_unbound_deposit_refund(uuid,uuid,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.load_unbound_deposit_refund_material(uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_unbound_deposit_refund(uuid,uuid,text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.attach_public_deposit_provider_intent(
  p_operation_id uuid,
  p_attempt_token uuid,
  p_provider_payment_id text,
  p_provider_status text,
  p_finalize_token text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
  v_op public.booking_payment_operations%ROWTYPE;
  v_payment text:=nullif(trim(coalesce(p_provider_payment_id,'')),'');
  v_status text:=lower(trim(coalesce(p_provider_status,'')));
  v_token_hash text;
  v_conflict uuid;
BEGIN
  IF length(coalesce(p_finalize_token,'')) NOT BETWEEN 20 AND 256 THEN
    RETURN jsonb_build_object('success',false,'code','invalid_finalize_token');
  END IF;
  v_token_hash:=encode(extensions.digest(convert_to(p_finalize_token,'UTF8'),'sha256'),'hex');
  SELECT * INTO v_op FROM public.booking_payment_operations
    WHERE id=p_operation_id AND operation_kind='deposit_charge' FOR UPDATE;
  IF NOT FOUND OR v_op.booking_intent_idempotency_key IS NULL OR v_op.provider<>'stripe' THEN
    RETURN jsonb_build_object('success',false,'code','operation_not_found');
  END IF;
  IF v_op.status='pending_customer' AND v_op.provider_payment_id=v_payment
     AND v_op.customer_finalize_token_hash=v_token_hash THEN
    RETURN jsonb_build_object('success',true,'code','intent_attach_replay',
      'status','pending_customer','operation_id',v_op.id,
      'provider_payment_id',v_op.provider_payment_id,
      'finalize_expires_at',v_op.customer_finalize_expires_at,
      'material_fingerprint',v_op.material_fingerprint,'material',v_op.material_json);
  END IF;
  IF v_op.status NOT IN ('sending','reconciling') OR v_op.attempt_token IS DISTINCT FROM p_attempt_token THEN
    RETURN jsonb_build_object('success',false,'code','invalid_attempt_token','status',v_op.status);
  END IF;
  IF v_payment IS NULL OR v_payment !~ '^pi_[A-Za-z0-9_]{6,250}$'
     OR v_status NOT IN ('requires_payment_method','requires_action') THEN
    RETURN jsonb_build_object('success',false,'code','invalid_provider_intent');
  END IF;
  IF v_op.start_time_utc<=now()+interval '30 seconds' THEN
    RETURN jsonb_build_object('success',false,'code','customer_confirmation_expired');
  END IF;
  SELECT id INTO v_conflict FROM public.booking_payment_operations
    WHERE provider='stripe' AND provider_account_fingerprint=v_op.provider_account_fingerprint
      AND provider_payment_id=v_payment AND id<>v_op.id LIMIT 1 FOR UPDATE;
  IF FOUND THEN RETURN jsonb_build_object('success',false,'code','provider_receipt_conflict'); END IF;
  BEGIN
    UPDATE public.booking_payment_operations SET status='pending_customer',
      provider_payment_id=v_payment,provider_status=v_status,
      customer_finalize_token_hash=v_token_hash,
      customer_finalize_expires_at=least(now()+interval '30 minutes',v_op.start_time_utc),
      attempt_token=NULL,lease_expires_at=NULL,next_reconcile_at=NULL,updated_at=now()
      WHERE id=v_op.id RETURNING * INTO v_op;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('success',false,'code','provider_receipt_conflict');
  END;
  RETURN jsonb_build_object('success',true,'code','intent_attached',
    'status','pending_customer','operation_id',v_op.id,
    'provider_payment_id',v_payment,'finalize_expires_at',v_op.customer_finalize_expires_at,
    'material_fingerprint',v_op.material_fingerprint,'material',v_op.material_json);
END
$function$;

CREATE OR REPLACE FUNCTION public.claim_public_deposit_finalization(
  p_operation_id uuid,
  p_request_id uuid,
  p_finalize_token text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
  v_op public.booking_payment_operations%ROWTYPE;
  v_hash text;
  v_attempt uuid:=gen_random_uuid();
BEGIN
  v_hash:=encode(extensions.digest(convert_to(coalesce(p_finalize_token,''),'UTF8'),'sha256'),'hex');
  SELECT * INTO v_op FROM public.booking_payment_operations
    WHERE id=p_operation_id AND request_id=p_request_id
      AND operation_kind='deposit_charge' FOR UPDATE;
  IF NOT FOUND OR v_op.booking_intent_idempotency_key IS NULL THEN
    RETURN jsonb_build_object('success',false,'code','operation_not_found');
  END IF;
  IF v_op.status='succeeded' THEN
    RETURN jsonb_build_object('success',true,'code','operation_replay','status','succeeded',
      'operation_id',v_op.id,'material_fingerprint',v_op.material_fingerprint,
      'material',v_op.material_json,'result',v_op.result_json);
  END IF;
  IF v_op.customer_finalize_token_hash IS DISTINCT FROM v_hash THEN
    RETURN jsonb_build_object('success',false,'code','invalid_finalize_token');
  END IF;
  IF v_op.customer_finalize_expires_at IS NULL OR v_op.customer_finalize_expires_at<=now() THEN
    RETURN jsonb_build_object('success',false,'code','finalize_token_expired');
  END IF;
  IF v_op.status='reconciling' AND v_op.lease_expires_at>now() THEN
    RETURN jsonb_build_object('success',false,'code','in_flight','status','reconciling',
      'operation_id',v_op.id,'lease_expires_at',v_op.lease_expires_at,
      'material_fingerprint',v_op.material_fingerprint);
  END IF;
  IF v_op.status NOT IN ('pending_customer','reconciling') THEN
    RETURN jsonb_build_object('success',false,'code','finalization_not_available','status',v_op.status);
  END IF;
  UPDATE public.booking_payment_operations SET status='reconciling',attempt_token=v_attempt,
    lease_expires_at=now()+interval '2 minutes',updated_at=now()
    WHERE id=v_op.id RETURNING * INTO v_op;
  RETURN jsonb_build_object('success',true,'code','finalization_claimed',
    'status','reconciling','operation_id',v_op.id,'attempt_token',v_attempt,
    'provider_payment_id',v_op.provider_payment_id,
    'provider_idempotency_key',v_op.provider_idempotency_key,
    'lease_expires_at',v_op.lease_expires_at,
    'finalize_expires_at',v_op.customer_finalize_expires_at,
    'material_fingerprint',v_op.material_fingerprint,'material',v_op.material_json);
END
$function$;

REVOKE ALL ON FUNCTION public.attach_public_deposit_provider_intent(uuid,uuid,text,text,text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_public_deposit_finalization(uuid,uuid,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attach_public_deposit_provider_intent(uuid,uuid,text,text,text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_public_deposit_finalization(uuid,uuid,text)
  TO service_role;
REVOKE ALL ON FUNCTION public.resolve_public_deposit_payment_material(
  uuid,uuid,uuid,timestamptz,timestamptz,uuid[],uuid,uuid,text,text,boolean,uuid,text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_public_deposit_payment_material(
  uuid,uuid,uuid,timestamptz,timestamptz,uuid[],uuid,uuid,text,text,boolean,uuid,text
) TO service_role;

-- Re-authorize the same stored Stripe PaymentIntent after its original browser
-- finalize bearer expires.  The service caller must first retrieve the exact
-- stored intent from Stripe.  No new provider object is authorized here.
CREATE OR REPLACE FUNCTION public.resume_public_deposit_customer_confirmation(
  p_operation_id uuid,
  p_request_id uuid,
  p_expected_material_fingerprint text,
  p_provider_payment_id text,
  p_provider_status text,
  p_provider_error_code text,
  p_new_finalize_token text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
  v_op public.booking_payment_operations%ROWTYPE;
  v_status text:=lower(trim(coalesce(p_provider_status,'')));
  v_error text:=nullif(lower(trim(coalesce(p_provider_error_code,''))), '');
  v_hash text;
  v_expires timestamptz;
  v_attempt uuid:=gen_random_uuid();
BEGIN
  IF coalesce(p_expected_material_fingerprint,'')!~'^[0-9a-f]{64}$'
     OR length(coalesce(p_new_finalize_token,'')) NOT BETWEEN 20 AND 256 THEN
    RETURN jsonb_build_object('success',false,'code','invalid_input');
  END IF;
  SELECT * INTO v_op FROM public.booking_payment_operations
    WHERE id=p_operation_id AND request_id=p_request_id
      AND operation_kind='deposit_charge' FOR UPDATE;
  IF NOT FOUND OR v_op.booking_intent_idempotency_key IS NULL OR v_op.provider<>'stripe' THEN
    RETURN jsonb_build_object('success',false,'code','operation_not_found');
  END IF;
  IF v_op.material_fingerprint IS DISTINCT FROM p_expected_material_fingerprint
     OR v_op.provider_payment_id IS DISTINCT FROM nullif(trim(coalesce(p_provider_payment_id,'')),'') THEN
    RETURN jsonb_build_object('success',false,'code','operation_conflict');
  END IF;
  IF v_op.status='succeeded' THEN
    RETURN jsonb_build_object('success',true,'code','operation_replay','status','succeeded',
      'operation_id',v_op.id,'material_fingerprint',v_op.material_fingerprint,
      'material',v_op.material_json,'result',v_op.result_json);
  END IF;
  IF v_op.status<>'pending_customer' THEN
    RETURN jsonb_build_object('success',false,'code','customer_confirmation_not_available',
      'status',v_op.status);
  END IF;

  IF v_status='canceled' OR v_error IN ('card_declined','expired_card','insufficient_funds',
      'authentication_required','provider_rejected','invalid_payment_method','invalid_request') THEN
    UPDATE public.booking_payment_operations SET status='failed',provider_status=v_status,
      failure_disposition='definite_pre_acceptance',
      error_code=coalesce(v_error,'provider_rejected'),customer_finalize_token_hash=NULL,
      customer_finalize_expires_at=NULL,attempt_token=NULL,lease_expires_at=NULL,
      next_reconcile_at=NULL,updated_at=now() WHERE id=v_op.id RETURNING * INTO v_op;
    RETURN jsonb_build_object('success',false,'code','definite_failure','status','failed',
      'operation_id',v_op.id,'error_code',v_op.error_code,
      'material_fingerprint',v_op.material_fingerprint);
  END IF;

  IF v_status IN ('processing','requires_capture','succeeded') THEN
    UPDATE public.booking_payment_operations SET status='reconciling',
      provider_status=v_status,attempt_token=v_attempt,
      lease_expires_at=now()+interval '2 minutes',next_reconcile_at=NULL,
      customer_finalize_token_hash=NULL,customer_finalize_expires_at=NULL,
      updated_at=now() WHERE id=v_op.id RETURNING * INTO v_op;
    RETURN jsonb_build_object('success',true,'code','provider_reconciliation_claimed',
      'status','reconciling','operation_id',v_op.id,'attempt_token',v_attempt,
      'provider_payment_id',v_op.provider_payment_id,
      'provider_idempotency_key',v_op.provider_idempotency_key,
      'lease_expires_at',v_op.lease_expires_at,
      'material_fingerprint',v_op.material_fingerprint,'material',v_op.material_json);
  END IF;
  IF v_status NOT IN ('requires_payment_method','requires_action') THEN
    RETURN jsonb_build_object('success',false,'code','provider_status_not_resumable');
  END IF;

  v_expires:=least(now()+interval '15 minutes',v_op.start_time_utc);
  IF v_expires<=now()+interval '30 seconds' THEN
    UPDATE public.booking_payment_operations SET status='failed',
      failure_disposition='terminal',error_code='customer_confirmation_expired',
      customer_finalize_token_hash=NULL,customer_finalize_expires_at=NULL,
      updated_at=now() WHERE id=v_op.id;
    RETURN jsonb_build_object('success',false,'code','customer_confirmation_expired','status','failed');
  END IF;
  v_hash:=encode(extensions.digest(convert_to(p_new_finalize_token,'UTF8'),'sha256'),'hex');
  UPDATE public.booking_payment_operations SET provider_status=v_status,
    customer_finalize_token_hash=v_hash,customer_finalize_expires_at=v_expires,
    failure_disposition=NULL,error_code=NULL,updated_at=now()
    WHERE id=v_op.id RETURNING * INTO v_op;
  RETURN jsonb_build_object('success',true,'code','customer_confirmation_resumed',
    'status','pending_customer','operation_id',v_op.id,
    'provider_payment_id',v_op.provider_payment_id,
    'provider_idempotency_key',v_op.provider_idempotency_key,
    'finalize_expires_at',v_op.customer_finalize_expires_at,
    'material_fingerprint',v_op.material_fingerprint,'material',v_op.material_json);
END
$function$;

-- A crash-safe service worker can discover paid deposits that were never
-- attached to a booking.  Discovery leases the parent only; the subsequent
-- claim still locks the parent against a late bind and creates one durable
-- refund child.
CREATE OR REPLACE FUNCTION public.discover_due_unbound_deposit_compensations(
  p_limit integer DEFAULT 25
) RETURNS SETOF jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
  v_parent public.booking_payment_operations%ROWTYPE;
  v_loaded jsonb;
  v_lease uuid;
BEGIN
  IF p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid limit' USING ERRCODE='22023';
  END IF;
  FOR v_parent IN
    SELECT * FROM public.booking_payment_operations p
    WHERE p.operation_kind='deposit_charge' AND p.status='succeeded'
      AND p.booking_id IS NULL AND p.unbound_compensation_due_at<=now()
      AND (p.compensation_lease_expires_at IS NULL OR p.compensation_lease_expires_at<=now())
      AND NOT EXISTS (
        SELECT 1 FROM public.booking_payment_operations c
        WHERE c.parent_operation_id=p.id AND c.operation_kind='deposit_refund'
          AND c.status IN ('sending','pending_provider','reconciling','unknown','succeeded')
      )
    ORDER BY p.unbound_compensation_due_at,p.created_at,p.id
    FOR UPDATE SKIP LOCKED LIMIT p_limit
  LOOP
    v_lease:=gen_random_uuid();
    UPDATE public.booking_payment_operations p SET
      compensation_request_id=CASE WHEN p.compensation_request_id IS NULL OR EXISTS(
        SELECT 1 FROM public.booking_payment_operations c
        WHERE c.parent_operation_id=v_parent.id AND c.operation_kind='deposit_refund'
          AND c.request_id=p.compensation_request_id AND c.status='failed'
      ) THEN gen_random_uuid() ELSE p.compensation_request_id END,
      compensation_lease_token=v_lease,
      compensation_lease_expires_at=now()+interval '2 minutes',updated_at=now()
      WHERE id=v_parent.id RETURNING * INTO v_parent;
    v_loaded:=public.load_unbound_deposit_refund_material(v_parent.id);
    RETURN NEXT jsonb_build_object(
      'success',true,'code','compensation_due','parent_operation_id',v_parent.id,
      'salon_id',v_parent.salon_id,'request_id',v_parent.compensation_request_id,
      'lease_token',v_lease,'lease_expires_at',v_parent.compensation_lease_expires_at,
      'binding_expires_at',v_parent.binding_expires_at,
      'material_fingerprint',v_loaded->>'material_fingerprint','material',v_loaded->'material'
    );
  END LOOP;
  RETURN;
END
$function$;

CREATE OR REPLACE FUNCTION public.claim_due_unbound_deposit_refund(
  p_parent_operation_id uuid,
  p_lease_token uuid,
  p_expected_material_fingerprint text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
  v_parent public.booking_payment_operations%ROWTYPE;
  v_result jsonb;
BEGIN
  SELECT * INTO v_parent FROM public.booking_payment_operations
    WHERE id=p_parent_operation_id AND operation_kind='deposit_charge' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','parent_operation_not_found'); END IF;
  IF v_parent.booking_id IS NOT NULL THEN
    RETURN jsonb_build_object('success',false,'code','parent_payment_already_bound');
  END IF;
  IF v_parent.status='compensated' THEN
    RETURN public.load_unbound_deposit_refund_material(v_parent.id);
  END IF;
  IF v_parent.status<>'succeeded' OR v_parent.compensation_request_id IS NULL
     OR v_parent.compensation_lease_token IS DISTINCT FROM p_lease_token
     OR v_parent.compensation_lease_expires_at<=now() THEN
    RETURN jsonb_build_object('success',false,'code','invalid_compensation_lease');
  END IF;
  v_result:=public.claim_unbound_deposit_refund(
    v_parent.id,v_parent.compensation_request_id,p_expected_material_fingerprint
  );
  IF coalesce(v_result->>'operation_id','')<>'' THEN
    UPDATE public.booking_payment_operations SET compensation_lease_token=NULL,
      compensation_lease_expires_at=NULL,updated_at=now() WHERE id=v_parent.id;
  END IF;
  RETURN v_result;
END
$function$;

REVOKE ALL ON FUNCTION public.resume_public_deposit_customer_confirmation(
  uuid,uuid,text,text,text,text,text
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.discover_due_unbound_deposit_compensations(integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_due_unbound_deposit_refund(uuid,uuid,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resume_public_deposit_customer_confirmation(
  uuid,uuid,text,text,text,text,text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.discover_due_unbound_deposit_compensations(integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_due_unbound_deposit_refund(uuid,uuid,text)
  TO service_role;

-- ---------------------------------------------------------------------------
-- Desk cancellation + deposit-refund saga
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_booking_cancel_deposit_refund_saga()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE v_status text;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.result_json IS NOT DISTINCT FROM OLD.result_json THEN
    RETURN NEW;
  END IF;
  v_status:=CASE NEW.status
    WHEN 'succeeded' THEN 'refunded'
    WHEN 'pending_provider' THEN 'refund_pending'
    WHEN 'unknown' THEN 'refund_unknown'
    WHEN 'failed' THEN 'refund_failed'
    ELSE 'refund_claimed' END;
  UPDATE public.booking_cancel_deposit_refund_sagas SET
    status=v_status,
    result_json=result_json||jsonb_build_object(
      'refund_status',NEW.status,'refund_result',NEW.result_json,
      'refund_error_code',NEW.error_code
    ),
    completed_at=CASE WHEN NEW.status IN ('succeeded','failed')
      THEN coalesce(completed_at,now()) ELSE NULL END,
    updated_at=now()
    WHERE refund_operation_id=NEW.id;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS sync_booking_cancel_deposit_refund_saga_trigger
  ON public.booking_payment_operations;
CREATE TRIGGER sync_booking_cancel_deposit_refund_saga_trigger
  AFTER UPDATE OF status,result_json,error_code ON public.booking_payment_operations
  FOR EACH ROW EXECUTE FUNCTION public.sync_booking_cancel_deposit_refund_saga();

CREATE OR REPLACE FUNCTION public.inspect_booking_cancel_deposit_refund_saga(
  p_salon_id uuid,p_booking_id uuid,p_saga_request_id uuid
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
  v_saga public.booking_cancel_deposit_refund_sagas%ROWTYPE;
  v_op public.booking_payment_operations%ROWTYPE;
BEGIN
  SELECT * INTO v_saga FROM public.booking_cancel_deposit_refund_sagas
    WHERE salon_id=p_salon_id AND request_id=p_saga_request_id;
  IF NOT FOUND OR v_saga.booking_id IS DISTINCT FROM p_booking_id THEN
    RETURN jsonb_build_object('success',false,'code','saga_not_found');
  END IF;
  SELECT * INTO v_op FROM public.booking_payment_operations
    WHERE id=v_saga.refund_operation_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','refund_operation_missing'); END IF;
  RETURN jsonb_build_object(
    'success',true,'code','saga_replay','idempotent',true,
    'saga_id',v_saga.id,'saga_request_id',v_saga.request_id,
    'saga_status',v_saga.status,'salon_id',v_saga.salon_id,
    'booking_id',v_saga.booking_id,
    'cancellation_transition_version',v_saga.cancellation_transition_version,
    'cancellation_result',v_saga.cancellation_result,
    'refund_operation_id',v_op.id,'refund_status',v_op.status,
    'refund_amount_cents',v_op.amount_cents,
    'refund_material_fingerprint',v_op.material_fingerprint,
    'refund_material',v_op.material_json,'provider_material',v_op.provider_material,
    'provider_idempotency_key',v_op.provider_idempotency_key,
    'attempt_token',CASE WHEN v_op.status IN ('sending','reconciling')
      AND v_op.lease_expires_at>now() THEN v_op.attempt_token ELSE NULL END,
    'lease_expires_at',v_op.lease_expires_at,
    'provider_refund_id',v_op.provider_refund_id,
    'result',v_saga.result_json
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.cancel_booking_with_deposit_refund_saga(
  p_salon_id uuid,
  p_booking_id uuid,
  p_saga_request_id uuid,
  p_refund_amount_cents integer,
  p_notify_email boolean DEFAULT false,
  p_notification_not_before timestamptz DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
  v_saga public.booking_cancel_deposit_refund_sagas%ROWTYPE;
  v_booking public.bookings%ROWTYPE;
  v_loaded jsonb;
  v_claim jsonb;
  v_cancel jsonb;
  v_waitlist jsonb;
  v_transition bigint;
  v_result jsonb;
BEGIN
  IF p_salon_id IS NULL OR p_booking_id IS NULL OR p_saga_request_id IS NULL
     OR p_refund_amount_cents IS NULL OR p_refund_amount_cents<=0
     OR (coalesce(p_notify_email,false) AND p_notification_not_before IS NULL) THEN
    RETURN jsonb_build_object('success',false,'code','invalid_input');
  END IF;

  -- Caller-held request replay is deliberately before the current booking
  -- status guard.  A committed cancel/refund intent remains discoverable after
  -- the row is already cancelled or the provider is pending/unknown.
  SELECT * INTO v_saga FROM public.booking_cancel_deposit_refund_sagas
    WHERE salon_id=p_salon_id AND request_id=p_saga_request_id FOR UPDATE;
  IF FOUND THEN
    IF v_saga.booking_id IS DISTINCT FROM p_booking_id
       OR v_saga.requested_amount_cents IS DISTINCT FROM p_refund_amount_cents THEN
      RETURN jsonb_build_object('success',false,'code','saga_conflict');
    END IF;
    RETURN public.inspect_booking_cancel_deposit_refund_saga(
      p_salon_id,p_booking_id,p_saga_request_id
    );
  END IF;

  SELECT * INTO v_booking FROM public.bookings
    WHERE id=p_booking_id AND salon_id=p_salon_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','booking_not_found'); END IF;
  -- A same-request caller can have observed no saga before waiting on the
  -- booking lock.  Recheck after serialization so the committed winner is an
  -- exact replay rather than a false booking_not_cancellable response.
  SELECT * INTO v_saga FROM public.booking_cancel_deposit_refund_sagas
    WHERE salon_id=p_salon_id AND request_id=p_saga_request_id FOR UPDATE;
  IF FOUND THEN
    IF v_saga.booking_id IS DISTINCT FROM p_booking_id
       OR v_saga.requested_amount_cents IS DISTINCT FROM p_refund_amount_cents THEN
      RETURN jsonb_build_object('success',false,'code','saga_conflict');
    END IF;
    RETURN public.inspect_booking_cancel_deposit_refund_saga(
      p_salon_id,p_booking_id,p_saga_request_id
    );
  END IF;
  IF v_booking.status NOT IN ('pending','confirmed','in_progress')
     OR v_booking.deleted_at IS NOT NULL OR v_booking.group_id IS NOT NULL THEN
    RETURN jsonb_build_object('success',false,'code','booking_not_cancellable');
  END IF;

  v_loaded:=public.resolve_booking_payment_operation_material(
    p_salon_id,p_booking_id,'deposit_refund',p_refund_amount_cents,true,NULL
  );
  IF coalesce((v_loaded->>'success')::boolean,false) IS NOT TRUE THEN RETURN v_loaded; END IF;
  v_claim:=public.claim_booking_payment_operation(
    p_salon_id,p_booking_id,p_saga_request_id,'deposit_refund',
    p_refund_amount_cents,v_loaded->>'material_fingerprint'
  );
  IF v_claim->>'code'<>'claimed' THEN
    RETURN jsonb_build_object('success',false,'code','refund_reservation_failed','refund',v_claim);
  END IF;

  UPDATE public.bookings SET status='cancelled',
    customer_transition_email_requested=coalesce(p_notify_email,false),
    customer_transition_email_not_before=CASE WHEN coalesce(p_notify_email,false)
      THEN greatest(now(),p_notification_not_before) ELSE NULL END
    WHERE id=p_booking_id AND salon_id=p_salon_id
      AND status=v_booking.status
    RETURNING customer_transition_version INTO v_transition;
  IF NOT FOUND OR v_transition IS NULL OR v_transition<=0 THEN
    RAISE EXCEPTION 'atomic cancellation transition failed' USING ERRCODE='NI002';
  END IF;
  -- Preserve the canonical freed-slot lifecycle in the same transaction.  No
  -- provider is called here; a returned durable offer can be delivered by the
  -- existing claim-before-provider worker after commit.
  v_waitlist:=public.promote_waitlist_for_booking(p_booking_id);
  v_cancel:=jsonb_build_object(
    'status','cancelled','previous_status',v_booking.status,
    'customer_transition_version',v_transition,
    'previous_start_time_utc',v_booking.start_time_utc,
    'service_id',v_booking.service_id,'staff_id',v_booking.staff_id,
    'promoted_waitlist',CASE WHEN v_waitlist->>'code'='promoted' THEN v_waitlist END,
    'waitlist_result_code',v_waitlist->>'code'
  );
  v_result:=jsonb_build_object(
    'cancellation',v_cancel,'refund_status','sending',
    'refund_operation_id',v_claim->>'operation_id',
    'refund_material_fingerprint',v_loaded->>'material_fingerprint'
  );
  INSERT INTO public.booking_cancel_deposit_refund_sagas(
    salon_id,booking_id,request_id,requested_amount_cents,refund_operation_id,
    refund_material_fingerprint,status,cancellation_transition_version,
    cancellation_result,result_json
  ) VALUES (
    p_salon_id,p_booking_id,p_saga_request_id,p_refund_amount_cents,
    (v_claim->>'operation_id')::uuid,v_loaded->>'material_fingerprint',
    'refund_claimed',v_transition,v_cancel,v_result
  ) RETURNING * INTO v_saga;
  RETURN jsonb_build_object(
    'success',true,'code','cancelled_refund_claimed','idempotent',false,
    'saga_id',v_saga.id,'saga_request_id',p_saga_request_id,
    'saga_status',v_saga.status,'salon_id',p_salon_id,'booking_id',p_booking_id,
    'cancellation_transition_version',v_transition,'cancellation_result',v_cancel,
    'refund_operation_id',v_claim->>'operation_id','refund_status','sending',
    'refund_amount_cents',p_refund_amount_cents,
    'refund_material_fingerprint',v_loaded->>'material_fingerprint',
    'refund_material',v_loaded->'material','provider_material',v_loaded->'provider_material',
    'provider_idempotency_key',v_claim->>'provider_idempotency_key',
    'attempt_token',v_claim->>'attempt_token','lease_expires_at',v_claim->>'lease_expires_at'
  );
END
$function$;

-- ---------------------------------------------------------------------------
-- Booking-bound Square hosted deposit link
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_booking_square_deposit_link(
  p_salon_id uuid,p_booking_id uuid,p_request_id uuid,p_hold boolean DEFAULT true
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
  v_existing public.booking_payment_operations%ROWTYPE;
  v_booking public.bookings%ROWTYPE;
  v_square public.square_integrations%ROWTYPE;
  v_context jsonb;
  v_provider_material jsonb;
  v_material jsonb;
  v_fp text;
  v_amount integer;
  v_id uuid:=gen_random_uuid();
  v_attempt uuid:=gen_random_uuid();
BEGIN
  IF p_salon_id IS NULL OR p_booking_id IS NULL OR p_request_id IS NULL THEN
    RETURN jsonb_build_object('success',false,'code','invalid_input');
  END IF;
  SELECT * INTO v_existing FROM public.booking_payment_operations
    WHERE salon_id=p_salon_id AND request_id=p_request_id
      AND operation_kind='deposit_charge' FOR UPDATE;
  IF FOUND THEN
    IF v_existing.booking_id IS DISTINCT FROM p_booking_id
       OR v_existing.delivery_mode IS DISTINCT FROM 'square_hosted_link'
       OR coalesce((v_existing.material_json->>'hold')::boolean,false)
          IS DISTINCT FROM coalesce(p_hold,true) THEN
      RETURN jsonb_build_object('success',false,'code','operation_conflict');
    END IF;
    IF v_existing.status='succeeded' THEN
      RETURN jsonb_build_object('success',true,'code','link_payment_replay','status','succeeded',
        'operation_id',v_existing.id,'booking_id',v_existing.booking_id,
        'provider_order_id',v_existing.provider_order_id,
        'provider_link_id',v_existing.provider_link_id,
        'link_url',v_existing.provider_link_url,
        'material_fingerprint',v_existing.material_fingerprint,'result',v_existing.result_json);
    ELSIF v_existing.status='pending_provider' AND v_existing.provider_order_id IS NOT NULL THEN
      RETURN jsonb_build_object('success',true,'code','link_ready','status','pending_provider',
        'operation_id',v_existing.id,'booking_id',v_existing.booking_id,
        'provider_order_id',v_existing.provider_order_id,
        'provider_link_id',v_existing.provider_link_id,'link_url',v_existing.provider_link_url,
        'provider_idempotency_key',v_existing.provider_idempotency_key,
        'material_fingerprint',v_existing.material_fingerprint,'material',v_existing.material_json);
    ELSIF v_existing.status='sending' THEN
      UPDATE public.booking_payment_operations SET
        lease_expires_at=greatest(coalesce(lease_expires_at,now()),now()+interval '2 minutes'),
        updated_at=now() WHERE id=v_existing.id RETURNING * INTO v_existing;
      RETURN jsonb_build_object('success',true,'code','link_attempt_replay','status','sending',
        'operation_id',v_existing.id,'booking_id',v_existing.booking_id,
        'attempt_token',v_existing.attempt_token,
        'provider_idempotency_key',v_existing.provider_idempotency_key,
        'lease_expires_at',v_existing.lease_expires_at,
        'material_fingerprint',v_existing.material_fingerprint,
        'material',v_existing.material_json,'provider_material',v_existing.provider_material);
    ELSE
      RETURN jsonb_build_object('success',false,'code','reconciliation_required',
        'status',v_existing.status,'operation_id',v_existing.id,
        'provider_order_id',v_existing.provider_order_id,
        'material_fingerprint',v_existing.material_fingerprint);
    END IF;
  END IF;

  SELECT * INTO v_booking FROM public.bookings
    WHERE id=p_booking_id AND salon_id=p_salon_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','booking_not_found'); END IF;
  IF v_booking.status NOT IN ('pending','confirmed') OR v_booking.deleted_at IS NOT NULL
     OR v_booking.group_id IS NOT NULL OR coalesce(v_booking.price_cents,0)<=0
     OR v_booking.deposit_status IN ('paid','refunded') THEN
    RETURN jsonb_build_object('success',false,'code','booking_not_deposit_eligible');
  END IF;
  SELECT * INTO v_square FROM public.square_integrations
    WHERE salon_id=p_salon_id AND enabled IS TRUE AND deposit_enabled IS TRUE FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','square_deposits_disabled'); END IF;
  v_context:=public.booking_payment_provider_context(p_salon_id,'deposit_charge');
  IF coalesce((v_context->>'success')::boolean,false) IS NOT TRUE
     OR v_context->>'provider'<>'square' THEN
    RETURN jsonb_build_object('success',false,'code','square_provider_not_chargeable');
  END IF;
  v_amount:=CASE WHEN v_booking.deposit_required IS TRUE
      AND v_booking.deposit_status='required' AND coalesce(v_booking.deposit_amount_cents,0)>0
    THEN v_booking.deposit_amount_cents
    ELSE least(v_booking.price_cents,greatest(100,
      round(v_booking.price_cents::numeric*greatest(1,least(100,v_square.deposit_percent))/100)::integer))
    END;
  v_provider_material:=(v_context->'provider_material')||jsonb_build_object(
    'amount_cents',v_amount,'booking_reference',p_booking_id,
    'delivery_mode','square_hosted_link'
  );
  v_material:=jsonb_build_object(
    'salon_id',p_salon_id,'booking_id',p_booking_id,'operation_kind','deposit_charge',
    'delivery_mode','square_hosted_link','provider','square',
    'provider_account_fingerprint',v_context->>'provider_account_fingerprint',
    'amount_cents',v_amount,'currency',v_context->>'currency',
    'hold',coalesce(p_hold,true),'provider_material',v_provider_material
  );
  v_fp:=encode(extensions.digest(convert_to(v_material::text,'UTF8'),'sha256'),'hex');
  BEGIN
    INSERT INTO public.booking_payment_operations(
      id,salon_id,booking_id,request_id,operation_kind,provider,
      provider_account_fingerprint,amount_cents,currency,material_fingerprint,
      material_json,provider_material,delivery_mode,provider_idempotency_key,
      status,attempt_token,lease_expires_at
    ) VALUES (
      v_id,p_salon_id,p_booking_id,p_request_id,'deposit_charge','square',
      v_context->>'provider_account_fingerprint',v_amount,v_context->>'currency',v_fp,
      v_material,v_provider_material,'square_hosted_link','nq:'||v_id::text,
      'sending',v_attempt,now()+interval '2 minutes'
    );
  EXCEPTION WHEN unique_violation THEN
    -- A same-request concurrent winner must replay the exact provider attempt;
    -- a different active request remains an explicit booking-level conflict.
    SELECT * INTO v_existing FROM public.booking_payment_operations
      WHERE salon_id=p_salon_id AND request_id=p_request_id
        AND operation_kind='deposit_charge';
    IF FOUND THEN
      RETURN public.claim_booking_square_deposit_link(
        p_salon_id,p_booking_id,p_request_id,p_hold
      );
    END IF;
    RETURN jsonb_build_object('success',false,'code','booking_deposit_already_claimed');
  END;
  UPDATE public.bookings SET deposit_required=true,deposit_amount_cents=v_amount,
    deposit_status='required',deposit_reason='manual desk Square hosted link',
    deposit_hold=coalesce(p_hold,true),deposit_requested_at=now(),
    status=CASE WHEN coalesce(p_hold,true) AND status='confirmed' THEN 'pending' ELSE status END,
    deposit_payment_ledger_enforced_at=coalesce(deposit_payment_ledger_enforced_at,now())
    WHERE id=p_booking_id;
  RETURN jsonb_build_object(
    'success',true,'code','link_claimed','status','sending','operation_id',v_id,
    'booking_id',p_booking_id,'attempt_token',v_attempt,
    'provider_idempotency_key','nq:'||v_id::text,
    'lease_expires_at',now()+interval '2 minutes',
    'material_fingerprint',v_fp,'material',v_material,'provider_material',v_provider_material
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.attach_booking_square_deposit_link(
  p_operation_id uuid,p_attempt_token uuid,p_square_link_id text,
  p_square_order_id text,p_link_url text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE v_op public.booking_payment_operations%ROWTYPE;
BEGIN
  SELECT * INTO v_op FROM public.booking_payment_operations
    WHERE id=p_operation_id AND operation_kind='deposit_charge'
      AND delivery_mode='square_hosted_link' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','operation_not_found'); END IF;
  IF v_op.status='pending_provider'
     AND v_op.provider_link_id IS NOT DISTINCT FROM nullif(trim(p_square_link_id),'')
     AND v_op.provider_order_id IS NOT DISTINCT FROM nullif(trim(p_square_order_id),'')
     AND v_op.provider_link_url IS NOT DISTINCT FROM nullif(trim(p_link_url),'') THEN
    RETURN jsonb_build_object('success',true,'code','link_attach_replay','status','pending_provider',
      'operation_id',v_op.id,'booking_id',v_op.booking_id,
      'provider_link_id',v_op.provider_link_id,'provider_order_id',v_op.provider_order_id,
      'link_url',v_op.provider_link_url,'material_fingerprint',v_op.material_fingerprint);
  END IF;
  IF v_op.status<>'sending' OR v_op.attempt_token IS DISTINCT FROM p_attempt_token THEN
    RETURN jsonb_build_object('success',false,'code','invalid_attempt_token','status',v_op.status);
  END IF;
  IF nullif(trim(coalesce(p_square_link_id,'')),'') IS NULL
     OR length(trim(p_square_link_id))>255 OR trim(p_square_link_id)!~'^[[:graph:]]+$'
     OR nullif(trim(coalesce(p_square_order_id,'')),'') IS NULL
     OR length(trim(p_square_order_id))>255 OR trim(p_square_order_id)!~'^[[:graph:]]+$'
     OR length(coalesce(p_link_url,''))>2048
     OR coalesce(p_link_url,'')!~'^https://[^[:space:]]+$' THEN
    RETURN jsonb_build_object('success',false,'code','invalid_square_link_receipt');
  END IF;
  BEGIN
    UPDATE public.booking_payment_operations SET status='pending_provider',
      provider_status='LINK_CREATED',provider_link_id=trim(p_square_link_id),
      provider_order_id=trim(p_square_order_id),provider_link_url=trim(p_link_url),
      attempt_token=NULL,lease_expires_at=NULL,next_reconcile_at=now()+interval '30 seconds',
      updated_at=now() WHERE id=v_op.id RETURNING * INTO v_op;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('success',false,'code','square_link_receipt_conflict');
  END;
  UPDATE public.bookings SET square_payment_link_id=v_op.provider_link_id,
    square_deposit_order_id=v_op.provider_order_id,deposit_link_url=v_op.provider_link_url,
    deposit_requested_at=coalesce(deposit_requested_at,now()) WHERE id=v_op.booking_id;
  RETURN jsonb_build_object('success',true,'code','link_attached','status','pending_provider',
    'operation_id',v_op.id,'booking_id',v_op.booking_id,
    'provider_link_id',v_op.provider_link_id,'provider_order_id',v_op.provider_order_id,
    'link_url',v_op.provider_link_url,'next_reconcile_at',v_op.next_reconcile_at,
    'material_fingerprint',v_op.material_fingerprint);
END
$function$;

-- ---------------------------------------------------------------------------
-- Public Square customer-present capability exchange
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.issue_public_square_deposit_capability(
  p_operation_id uuid,p_request_id uuid,p_attempt_token uuid,p_capability_token text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
  v_op public.booking_payment_operations%ROWTYPE;
  v_hash text;
  v_expires timestamptz;
BEGIN
  IF length(coalesce(p_capability_token,'')) NOT BETWEEN 32 AND 256 THEN
    RETURN jsonb_build_object('success',false,'code','invalid_capability_token');
  END IF;
  v_hash:=encode(extensions.digest(convert_to(p_capability_token,'UTF8'),'sha256'),'hex');
  SELECT * INTO v_op FROM public.booking_payment_operations
    WHERE id=p_operation_id AND request_id=p_request_id
      AND operation_kind='deposit_charge' AND booking_intent_idempotency_key IS NOT NULL
    FOR UPDATE;
  IF NOT FOUND OR v_op.provider<>'square' THEN
    RETURN jsonb_build_object('success',false,'code','operation_not_found');
  END IF;
  IF v_op.provider_material ? 'saved_card_id' OR v_op.provider_material ? 'customer_id' THEN
    RETURN jsonb_build_object('success',false,'code','customer_present_material_invalid');
  END IF;
  IF v_op.public_square_capability_token_hash IS NOT NULL THEN
    IF v_op.public_square_capability_token_hash IS DISTINCT FROM v_hash THEN
      RETURN jsonb_build_object('success',false,'code','capability_conflict');
    END IF;
    RETURN jsonb_build_object('success',true,'code','capability_replay',
      'operation_id',v_op.id,'capability_token',p_capability_token,
      'capability_expires_at',v_op.public_square_capability_expires_at,
      'square_application_id',v_op.provider_material->>'provider_application_id',
      'square_location_id',v_op.provider_material->>'provider_location_id',
      'square_environment',v_op.provider_material->>'provider_environment',
      'amount_cents',v_op.amount_cents,'currency',v_op.currency,
      'material_fingerprint',v_op.material_fingerprint);
  END IF;
  IF v_op.status<>'sending' OR v_op.attempt_token IS DISTINCT FROM p_attempt_token
     OR nullif(v_op.provider_material->>'provider_application_id','') IS NULL
     OR nullif(v_op.provider_material->>'provider_location_id','') IS NULL
     OR v_op.provider_material->>'provider_environment' NOT IN ('sandbox','production') THEN
    RETURN jsonb_build_object('success',false,'code','capability_not_available','status',v_op.status);
  END IF;
  v_expires:=least(now()+interval '15 minutes',v_op.start_time_utc);
  IF v_expires<=now()+interval '30 seconds' THEN
    RETURN jsonb_build_object('success',false,'code','capability_expired');
  END IF;
  UPDATE public.booking_payment_operations SET delivery_mode='public_customer_present',
    public_square_capability_token_hash=v_hash,
    public_square_capability_expires_at=v_expires,updated_at=now()
    WHERE id=v_op.id RETURNING * INTO v_op;
  -- Browser-safe result: no provider account, merchant id, attempt token,
  -- provider idempotency key, saved card, or customer reference.
  RETURN jsonb_build_object('success',true,'code','capability_issued',
    'operation_id',v_op.id,'capability_token',p_capability_token,
    'capability_expires_at',v_op.public_square_capability_expires_at,
    'square_application_id',v_op.provider_material->>'provider_application_id',
    'square_location_id',v_op.provider_material->>'provider_location_id',
    'square_environment',v_op.provider_material->>'provider_environment',
    'amount_cents',v_op.amount_cents,'currency',v_op.currency,
    'material_fingerprint',v_op.material_fingerprint);
END
$function$;

CREATE OR REPLACE FUNCTION public.claim_public_square_deposit_completion(
  p_operation_id uuid,p_request_id uuid,p_capability_token text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
  v_op public.booking_payment_operations%ROWTYPE;
  v_hash text;
  v_was_consumed boolean;
BEGIN
  v_hash:=encode(extensions.digest(convert_to(coalesce(p_capability_token,''),'UTF8'),'sha256'),'hex');
  SELECT * INTO v_op FROM public.booking_payment_operations
    WHERE id=p_operation_id AND request_id=p_request_id
      AND operation_kind='deposit_charge' AND booking_intent_idempotency_key IS NOT NULL
      AND provider='square' AND delivery_mode='public_customer_present'
    FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','operation_not_found'); END IF;
  IF v_op.public_square_capability_token_hash IS DISTINCT FROM v_hash THEN
    RETURN jsonb_build_object('success',false,'code','invalid_capability_token');
  END IF;
  IF v_op.status='succeeded' THEN
    RETURN jsonb_build_object('success',true,'code','operation_replay','status','succeeded',
      'operation_id',v_op.id,'material_fingerprint',v_op.material_fingerprint,
      'result',v_op.result_json);
  ELSIF v_op.status IN ('pending_provider','unknown','reconciling') THEN
    RETURN jsonb_build_object('success',false,'code','reconciliation_required',
      'status',v_op.status,'operation_id',v_op.id,
      'provider_payment_id',v_op.provider_payment_id,
      'material_fingerprint',v_op.material_fingerprint);
  END IF;
  IF v_op.status<>'sending' OR v_op.public_square_capability_expires_at<=now()
     OR v_op.start_time_utc<=now() THEN
    RETURN jsonb_build_object('success',false,'code','capability_expired','status',v_op.status);
  END IF;
  IF v_op.provider_material ? 'saved_card_id' OR v_op.provider_material ? 'customer_id' THEN
    RETURN jsonb_build_object('success',false,'code','customer_present_material_invalid');
  END IF;
  v_was_consumed:=v_op.public_square_capability_consumed_at IS NOT NULL;
  UPDATE public.booking_payment_operations SET
    public_square_capability_consumed_at=coalesce(public_square_capability_consumed_at,now()),
    lease_expires_at=greatest(coalesce(lease_expires_at,now()),now()+interval '2 minutes'),
    updated_at=now() WHERE id=v_op.id RETURNING * INTO v_op;
  RETURN jsonb_build_object('success',true,
    'code',CASE WHEN NOT v_was_consumed
      THEN 'square_payment_claimed' ELSE 'square_payment_attempt_replay' END,
    'status','sending','operation_id',v_op.id,'attempt_token',v_op.attempt_token,
    'provider_idempotency_key',v_op.provider_idempotency_key,
    'lease_expires_at',v_op.lease_expires_at,
    'material_fingerprint',v_op.material_fingerprint,
    'material',v_op.material_json,'provider_material',v_op.provider_material);
END
$function$;

REVOKE ALL ON FUNCTION public.sync_booking_cancel_deposit_refund_saga()
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.inspect_booking_cancel_deposit_refund_saga(uuid,uuid,uuid)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.cancel_booking_with_deposit_refund_saga(uuid,uuid,uuid,integer,boolean,timestamptz)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.claim_booking_square_deposit_link(uuid,uuid,uuid,boolean)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.attach_booking_square_deposit_link(uuid,uuid,text,text,text)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.issue_public_square_deposit_capability(uuid,uuid,uuid,text)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.claim_public_square_deposit_completion(uuid,uuid,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inspect_booking_cancel_deposit_refund_saga(uuid,uuid,uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.cancel_booking_with_deposit_refund_saga(uuid,uuid,uuid,integer,boolean,timestamptz)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_booking_square_deposit_link(uuid,uuid,uuid,boolean)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.attach_booking_square_deposit_link(uuid,uuid,text,text,text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.issue_public_square_deposit_capability(uuid,uuid,uuid,text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_public_square_deposit_completion(uuid,uuid,text)
  TO service_role;
