-- Product-approved 2026-08-22 compensation reporting contract.
--
-- Tips are actual collected evidence owned 100% by assigned staff and split by
-- each service's after-discount subtotal. Commission is an estimate, never a
-- payroll/payout instruction, calculated from after-discount service revenue
-- only (tax and tips excluded). Corrections/refunds append debit evidence;
-- historical rows are never rewritten or deleted.

CREATE TABLE public.salon_financial_metric_policies (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  metric text NOT NULL,
  policy_version text NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  commission_rate_basis_points integer,
  definition_fingerprint text NOT NULL,
  approved_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  approved_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT salon_financial_metric_policies_metric_check CHECK (
    metric IN ('tips', 'commission')
  ),
  CONSTRAINT salon_financial_metric_policies_version_check CHECK (
    (metric = 'tips'
      AND policy_version = 'tips-staff-100-proportional-v1'
      AND commission_rate_basis_points IS NULL)
    OR
    (metric = 'commission'
      AND policy_version = 'commission-estimate-net-service-v1'
      AND commission_rate_basis_points BETWEEN 0 AND 10000)
  ),
  CONSTRAINT salon_financial_metric_policies_time_check CHECK (
    effective_to IS NULL OR effective_to > effective_from
  ),
  CONSTRAINT salon_financial_metric_policies_fingerprint_check CHECK (
    definition_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  EXCLUDE USING gist (
    salon_id WITH =,
    metric WITH =,
    tstzrange(effective_from, effective_to, '[)') WITH &&
  )
);

CREATE INDEX salon_financial_metric_policies_approved_by_idx
  ON public.salon_financial_metric_policies (approved_by);
CREATE INDEX salon_financial_metric_policies_lookup_idx
  ON public.salon_financial_metric_policies (
    salon_id,
    metric,
    effective_from DESC
  );

CREATE TABLE public.booking_financial_metric_evidence (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  booking_id uuid NOT NULL REFERENCES public.bookings(id) ON DELETE RESTRICT,
  metric text NOT NULL,
  policy_id uuid NOT NULL
    REFERENCES public.salon_financial_metric_policies(id) ON DELETE RESTRICT,
  staff_id uuid NOT NULL REFERENCES public.staff(id) ON DELETE RESTRICT,
  service_id uuid NOT NULL REFERENCES public.services(id) ON DELETE RESTRICT,
  payment_operation_id uuid
    REFERENCES public.booking_payment_operations(id) ON DELETE RESTRICT,
  allocation_key text NOT NULL,
  occurred_at timestamptz NOT NULL,
  source_kind text NOT NULL,
  source_event_id text NOT NULL,
  source_material_fingerprint text NOT NULL,
  currency text NOT NULL,
  effect text NOT NULL,
  basis_amount_cents bigint NOT NULL,
  amount_cents bigint NOT NULL,
  provider text,
  provider_account_fingerprint text,
  provider_receipt_id text,
  material_fingerprint text NOT NULL,
  recorded_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT booking_financial_metric_evidence_metric_check CHECK (
    metric IN ('tips', 'commission')
  ),
  CONSTRAINT booking_financial_metric_evidence_source_check CHECK (
    source_kind IN ('provider_receipt', 'manual_verified', 'policy_calculation')
  ),
  CONSTRAINT booking_financial_metric_evidence_effect_check CHECK (
    effect IN ('credit', 'debit')
  ),
  CONSTRAINT booking_financial_metric_evidence_amount_check CHECK (
    basis_amount_cents >= 0 AND amount_cents >= 0
  ),
  CONSTRAINT booking_financial_metric_evidence_currency_check CHECK (
    currency ~ '^[A-Z]{3}$'
  ),
  CONSTRAINT booking_financial_metric_evidence_key_check CHECK (
    allocation_key ~ '^[0-9a-f-]{36}:[0-9a-f-]{36}$'
    AND source_event_id ~ '^[A-Za-z0-9:_./-]{1,180}$'
  ),
  CONSTRAINT booking_financial_metric_evidence_fingerprint_check CHECK (
    source_material_fingerprint ~ '^[0-9a-f]{64}$'
    AND material_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT booking_financial_metric_evidence_provider_check CHECK (
    (source_kind = 'provider_receipt'
      AND payment_operation_id IS NOT NULL
      AND provider IN ('square', 'stripe')
      AND provider_account_fingerprint ~ '^[0-9a-f]{64}$'
      AND pg_catalog.length(provider_receipt_id) BETWEEN 1 AND 255)
    OR
    (source_kind <> 'provider_receipt'
      AND payment_operation_id IS NULL
      AND provider IS NULL
      AND provider_account_fingerprint IS NULL
      AND provider_receipt_id IS NULL)
  ),
  UNIQUE (
    salon_id,
    metric,
    source_kind,
    source_event_id,
    allocation_key
  )
);

CREATE UNIQUE INDEX booking_financial_metric_one_credit_allocation_idx
  ON public.booking_financial_metric_evidence (
    salon_id,
    booking_id,
    metric,
    allocation_key
  )
  WHERE effect = 'credit';
CREATE INDEX booking_financial_metric_report_idx
  ON public.booking_financial_metric_evidence (
    salon_id,
    occurred_at,
    metric,
    id
  );
CREATE INDEX booking_financial_metric_booking_idx
  ON public.booking_financial_metric_evidence (booking_id, metric);
CREATE INDEX booking_financial_metric_policy_idx
  ON public.booking_financial_metric_evidence (policy_id);
CREATE INDEX booking_financial_metric_staff_idx
  ON public.booking_financial_metric_evidence (staff_id);
CREATE INDEX booking_financial_metric_service_idx
  ON public.booking_financial_metric_evidence (service_id);
CREATE INDEX booking_financial_metric_payment_idx
  ON public.booking_financial_metric_evidence (payment_operation_id)
  WHERE payment_operation_id IS NOT NULL;
CREATE INDEX booking_financial_metric_recorded_by_idx
  ON public.booking_financial_metric_evidence (recorded_by)
  WHERE recorded_by IS NOT NULL;

COMMENT ON TABLE public.salon_financial_metric_policies IS
  'Owner-approved effective-dated reporting semantics. Commission is an estimate, never payroll or payout authority.';
COMMENT ON TABLE public.booking_financial_metric_evidence IS
  'Immutable staff/service compensation evidence. Refunds and corrections append debit rows instead of changing history.';

ALTER TABLE public.salon_financial_metric_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.salon_financial_metric_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE public.booking_financial_metric_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_financial_metric_evidence FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.salon_financial_metric_policies
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.booking_financial_metric_evidence
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.salon_financial_metric_policies TO service_role;
GRANT SELECT ON TABLE public.booking_financial_metric_evidence TO service_role;

CREATE OR REPLACE FUNCTION public.reject_financial_metric_evidence_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $reject_metric_mutation$
BEGIN
  -- A top-level salon/account deletion owns its cascading retention decision.
  -- Keep individual ledger rows immutable while allowing the parent FK cascade
  -- to remove an entire salon atomically (internal RI trigger depth > 1).
  IF TG_OP = 'DELETE' AND pg_catalog.pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION USING
    ERRCODE = '42501',
    MESSAGE = 'financial metric evidence is immutable';
END;
$reject_metric_mutation$;

REVOKE ALL ON FUNCTION public.reject_financial_metric_evidence_mutation()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER reject_financial_metric_evidence_mutation
  BEFORE UPDATE OR DELETE ON public.booking_financial_metric_evidence
  FOR EACH ROW EXECUTE FUNCTION public.reject_financial_metric_evidence_mutation();

CREATE OR REPLACE FUNCTION public.configure_salon_financial_metric_policy(
  p_salon_id uuid,
  p_actor_user_id uuid,
  p_metric text,
  p_commission_rate_basis_points integer,
  p_effective_from timestamptz,
  p_effective_to timestamptz DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $configure_metric_policy$
DECLARE
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_policy_version text;
  v_definition jsonb;
  v_fingerprint text;
  v_policy_id uuid;
BEGIN
  IF v_role <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service role required';
  END IF;
  IF p_salon_id IS NULL OR p_actor_user_id IS NULL OR p_effective_from IS NULL
     OR p_metric IS NULL OR p_metric NOT IN ('tips', 'commission')
     OR (p_effective_to IS NOT NULL AND p_effective_to <= p_effective_from) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid financial metric policy';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.salon_members AS m
    WHERE m.salon_id = p_salon_id
      AND m.user_id = p_actor_user_id
      AND m.role = 'owner'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'salon owner approval required';
  END IF;
  IF p_metric = 'tips' THEN
    IF p_commission_rate_basis_points IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'tip policy does not accept a commission rate';
    END IF;
    v_policy_version := 'tips-staff-100-proportional-v1';
    v_definition := pg_catalog.jsonb_build_object(
      'metric', 'tips',
      'ownership', 'staff_100_percent',
      'allocation', 'after_discount_service_subtotal_largest_remainder',
      'rounding', 'exact_cent_conservation',
      'corrections', 'immutable_debit_evidence'
    );
  ELSE
    IF p_commission_rate_basis_points IS NULL
       OR p_commission_rate_basis_points NOT BETWEEN 0 AND 10000 THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'commission rate must be 0..10000 basis points';
    END IF;
    v_policy_version := 'commission-estimate-net-service-v1';
    v_definition := pg_catalog.jsonb_build_object(
      'metric', 'commission',
      'classification', 'estimate_not_payroll',
      'basis', 'after_discount_service_revenue_excluding_tax_and_tips',
      'rate_basis_points', p_commission_rate_basis_points,
      'allocation', 'booking_or_segment_staff',
      'rounding', 'half_up_per_allocation',
      'refunds', 'difference_of_cumulative_clawback',
      'payout_tracking', false
    );
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('financial-policy:' || p_salon_id::text || ':' || p_metric, 0)
  );

  -- A new effective-dated policy closes the one currently open at the same
  -- boundary. Historical definitions remain intact and overlapping intervals
  -- are still rejected below.
  UPDATE public.salon_financial_metric_policies AS p
  SET effective_to = p_effective_from
  WHERE p.salon_id = p_salon_id
    AND p.metric = p_metric
    AND p.effective_to IS NULL
    AND p.effective_from < p_effective_from;

  IF EXISTS (
    SELECT 1 FROM public.salon_financial_metric_policies AS p
    WHERE p.salon_id = p_salon_id
      AND p.metric = p_metric
      AND pg_catalog.tstzrange(p.effective_from, p.effective_to, '[)')
          && pg_catalog.tstzrange(p_effective_from, p_effective_to, '[)')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23P01', MESSAGE = 'financial metric policy interval overlaps';
  END IF;

  v_fingerprint := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(v_definition::text, 'UTF8'), 'sha256'),
    'hex'
  );
  INSERT INTO public.salon_financial_metric_policies (
    salon_id, metric, policy_version, effective_from, effective_to,
    commission_rate_basis_points, definition_fingerprint, approved_by
  ) VALUES (
    p_salon_id, p_metric, v_policy_version, p_effective_from, p_effective_to,
    p_commission_rate_basis_points, v_fingerprint, p_actor_user_id
  ) RETURNING id INTO v_policy_id;
  RETURN v_policy_id;
END;
$configure_metric_policy$;

REVOKE ALL ON FUNCTION public.configure_salon_financial_metric_policy(
  uuid, uuid, text, integer, timestamptz, timestamptz
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.configure_salon_financial_metric_policy(
  uuid, uuid, text, integer, timestamptz, timestamptz
) TO service_role;

CREATE OR REPLACE FUNCTION public.record_booking_tip_evidence(
  p_salon_id uuid,
  p_booking_id uuid,
  p_actor_user_id uuid,
  p_total_tip_cents bigint,
  p_currency text,
  p_source_kind text,
  p_source_event_id text,
  p_payment_operation_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $record_tip_evidence$
DECLARE
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_booking public.bookings%ROWTYPE;
  v_policy public.salon_financial_metric_policies%ROWTYPE;
  v_operation public.booking_payment_operations%ROWTYPE;
  v_occurred_at timestamptz;
  v_provider text;
  v_provider_fingerprint text;
  v_provider_receipt text;
  v_source_fingerprint text;
  v_existing_fingerprint text;
  v_existing_count integer;
  v_inserted integer;
BEGIN
  IF v_role <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service role required';
  END IF;
  IF p_salon_id IS NULL OR p_booking_id IS NULL
     OR p_total_tip_cents IS NULL OR p_total_tip_cents NOT BETWEEN 0 AND 100000000
     OR p_currency IS NULL OR p_currency !~ '^[A-Z]{3}$'
     OR p_source_kind IS NULL OR p_source_kind NOT IN ('provider_receipt', 'manual_verified')
     OR p_source_event_id IS NULL OR p_source_event_id !~ '^[A-Za-z0-9:_./-]{1,180}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid tip evidence';
  END IF;

  SELECT b.* INTO v_booking
  FROM public.bookings AS b
  WHERE b.id = p_booking_id AND b.salon_id = p_salon_id AND b.deleted_at IS NULL;
  IF NOT FOUND OR v_booking.status <> 'completed' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'tip evidence requires a completed booking';
  END IF;
  IF upper(p_currency) <> upper((SELECT s.currency_code FROM public.salons AS s WHERE s.id = p_salon_id)) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'tip currency does not match salon';
  END IF;

  IF p_source_kind = 'manual_verified' THEN
    IF p_actor_user_id IS NULL OR p_payment_operation_id IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM public.salon_members AS m
      WHERE m.salon_id = p_salon_id
        AND m.user_id = p_actor_user_id
        AND m.role IN ('owner', 'admin')
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'owner or admin verification required';
    END IF;
    -- Keep evidence inside a report requested later in this same transaction;
    -- transaction_timestamp() is also the report's exclusive data-as-of edge.
    v_occurred_at := transaction_timestamp() - interval '1 microsecond';
  ELSE
    IF p_payment_operation_id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'provider tip evidence requires a payment operation';
    END IF;
    SELECT o.* INTO v_operation
    FROM public.booking_payment_operations AS o
    WHERE o.id = p_payment_operation_id
      AND o.salon_id = p_salon_id
      AND o.booking_id = p_booking_id
      AND o.status IN ('succeeded', 'compensated')
      AND o.operation_kind IN ('deposit_charge', 'noshow_charge', 'late_cancel_charge')
      AND o.provider_payment_id IS NOT NULL
      AND o.completed_at IS NOT NULL;
    IF NOT FOUND OR upper(v_operation.currency) <> upper(p_currency) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'provider tip receipt is not authoritative';
    END IF;
    v_occurred_at := v_operation.completed_at;
    v_provider := v_operation.provider;
    v_provider_fingerprint := v_operation.provider_account_fingerprint;
    v_provider_receipt := v_operation.provider_payment_id;
  END IF;

  SELECT p.* INTO v_policy
  FROM public.salon_financial_metric_policies AS p
  WHERE p.salon_id = p_salon_id
    AND p.metric = 'tips'
    AND p.effective_from <= v_occurred_at
    AND (p.effective_to IS NULL OR p.effective_to > v_occurred_at);
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'active tip policy required';
  END IF;

  v_source_fingerprint := pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
    pg_catalog.jsonb_build_object(
      'salon_id', p_salon_id, 'booking_id', p_booking_id,
      'policy_id', v_policy.id, 'tip_cents', p_total_tip_cents,
      'currency', upper(p_currency), 'source_kind', p_source_kind,
      'source_event_id', p_source_event_id,
      'payment_operation_id', p_payment_operation_id
    )::text, 'UTF8'), 'sha256'), 'hex');

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'financial-tip:' || p_salon_id::text || ':' || p_source_kind || ':' || p_source_event_id, 0
  ));
  SELECT count(*)::integer, min(e.source_material_fingerprint)
  INTO v_existing_count, v_existing_fingerprint
  FROM public.booking_financial_metric_evidence AS e
  WHERE e.salon_id = p_salon_id
    AND e.metric = 'tips'
    AND e.source_kind = p_source_kind
    AND e.source_event_id = p_source_event_id;
  IF v_existing_count > 0 THEN
    IF v_existing_fingerprint <> v_source_fingerprint THEN
      RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'tip evidence idempotency payload mismatch';
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'applied', false, 'event_rows', v_existing_count,
      'total_tip_cents', p_total_tip_cents
    );
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.booking_financial_metric_evidence AS e
    WHERE e.salon_id = p_salon_id AND e.booking_id = p_booking_id
      AND e.metric = 'tips' AND e.effect = 'credit'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'booking already has tip credit evidence';
  END IF;

  WITH raw_allocations AS (
    SELECT seg.staff_id, seg.service_id,
      pg_catalog.sum(seg.subtotal_cents)::bigint AS service_basis,
      pg_catalog.min(seg.position)::integer AS first_position
    FROM public.booking_service_segments AS seg
    WHERE v_booking.schedule_model = 'segments_v1'
      AND seg.booking_id = p_booking_id
    GROUP BY seg.staff_id, seg.service_id
    UNION ALL
    SELECT v_booking.staff_id, v_booking.service_id,
      greatest(coalesce(v_booking.subtotal_cents, v_booking.price_cents, 0), 0)::bigint,
      0
    WHERE v_booking.schedule_model = 'single'
      AND v_booking.staff_id IS NOT NULL
  ), weighted AS (
    SELECT r.*,
      CASE WHEN pg_catalog.sum(r.service_basis) OVER () = 0 THEN 1::bigint ELSE r.service_basis END AS weight,
      CASE WHEN pg_catalog.sum(r.service_basis) OVER () = 0
        THEN pg_catalog.count(*) OVER ()::bigint
        ELSE pg_catalog.sum(r.service_basis) OVER ()::bigint END AS weight_total
    FROM raw_allocations AS r
  ), based AS (
    SELECT w.*,
      (p_total_tip_cents * w.weight / w.weight_total)::bigint AS base_amount,
      (p_total_tip_cents * w.weight % w.weight_total)::bigint AS fractional,
      (w.staff_id::text || ':' || w.service_id::text) AS key
    FROM weighted AS w
  ), ranked AS (
    SELECT b.*,
      pg_catalog.row_number() OVER (
        ORDER BY b.fractional DESC, b.first_position, b.key
      )::bigint AS remainder_rank,
      (p_total_tip_cents - pg_catalog.sum(b.base_amount) OVER ())::bigint AS remainder
    FROM based AS b
  ), inserted AS (
    INSERT INTO public.booking_financial_metric_evidence (
      salon_id, booking_id, metric, policy_id, staff_id, service_id,
      payment_operation_id, allocation_key, occurred_at, source_kind,
      source_event_id, source_material_fingerprint, currency, effect,
      basis_amount_cents, amount_cents, provider,
      provider_account_fingerprint, provider_receipt_id,
      material_fingerprint, recorded_by
    )
    SELECT p_salon_id, p_booking_id, 'tips', v_policy.id,
      r.staff_id, r.service_id, p_payment_operation_id, r.key,
      v_occurred_at, p_source_kind, p_source_event_id,
      v_source_fingerprint, upper(p_currency), 'credit',
      r.base_amount + CASE WHEN r.remainder_rank <= r.remainder THEN 1 ELSE 0 END,
      r.base_amount + CASE WHEN r.remainder_rank <= r.remainder THEN 1 ELSE 0 END,
      v_provider, v_provider_fingerprint, v_provider_receipt,
      pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
        v_source_fingerprint || ':' || r.key || ':' ||
        (r.base_amount + CASE WHEN r.remainder_rank <= r.remainder THEN 1 ELSE 0 END)::text,
        'UTF8'), 'sha256'), 'hex'),
      p_actor_user_id
    FROM ranked AS r
    RETURNING 1
  ) SELECT count(*)::integer INTO v_inserted FROM inserted;

  IF v_inserted = 0 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'booking has no attributable staff service allocation';
  END IF;
  RETURN pg_catalog.jsonb_build_object(
    'applied', true, 'event_rows', v_inserted,
    'total_tip_cents', p_total_tip_cents
  );
END;
$record_tip_evidence$;

REVOKE ALL ON FUNCTION public.record_booking_tip_evidence(
  uuid, uuid, uuid, bigint, text, text, text, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_booking_tip_evidence(
  uuid, uuid, uuid, bigint, text, text, text, uuid
) TO service_role;

CREATE OR REPLACE FUNCTION public.calculate_booking_commission_evidence(
  p_salon_id uuid,
  p_booking_id uuid,
  p_actor_user_id uuid,
  p_source_event_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $calculate_commission$
DECLARE
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_booking public.bookings%ROWTYPE;
  v_policy public.salon_financial_metric_policies%ROWTYPE;
  v_currency text;
  v_source_fingerprint text;
  v_existing_fingerprint text;
  v_existing_count integer;
  v_inserted integer;
  v_total bigint;
BEGIN
  IF v_role <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service role required';
  END IF;
  IF p_salon_id IS NULL OR p_booking_id IS NULL OR p_actor_user_id IS NULL
     OR p_source_event_id IS NULL OR p_source_event_id !~ '^[A-Za-z0-9:_./-]{1,180}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid commission calculation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.salon_members AS m
    WHERE m.salon_id = p_salon_id AND m.user_id = p_actor_user_id
      AND m.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'owner or admin calculation required';
  END IF;
  SELECT b.* INTO v_booking FROM public.bookings AS b
  WHERE b.id = p_booking_id AND b.salon_id = p_salon_id AND b.deleted_at IS NULL;
  IF NOT FOUND OR v_booking.status <> 'completed' OR v_booking.end_time_utc IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'commission requires a completed booking';
  END IF;
  SELECT upper(s.currency_code) INTO v_currency FROM public.salons AS s WHERE s.id = p_salon_id;
  SELECT p.* INTO v_policy FROM public.salon_financial_metric_policies AS p
  WHERE p.salon_id = p_salon_id AND p.metric = 'commission'
    AND p.effective_from <= v_booking.end_time_utc
    AND (p.effective_to IS NULL OR p.effective_to > v_booking.end_time_utc);
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'active commission policy required';
  END IF;
  v_source_fingerprint := pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
    pg_catalog.jsonb_build_object(
      'salon_id', p_salon_id, 'booking_id', p_booking_id,
      'policy_id', v_policy.id, 'source_event_id', p_source_event_id,
      'classification', 'estimate_not_payroll'
    )::text, 'UTF8'), 'sha256'), 'hex');

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'financial-commission:' || p_salon_id::text || ':' || p_booking_id::text, 0
  ));
  SELECT count(*)::integer, min(e.source_material_fingerprint)
  INTO v_existing_count, v_existing_fingerprint
  FROM public.booking_financial_metric_evidence AS e
  WHERE e.salon_id = p_salon_id AND e.booking_id = p_booking_id
    AND e.metric = 'commission' AND e.effect = 'credit';
  IF v_existing_count > 0 THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.booking_financial_metric_evidence AS e
      WHERE e.salon_id = p_salon_id AND e.booking_id = p_booking_id
        AND e.metric = 'commission' AND e.effect = 'credit'
        AND e.source_event_id = p_source_event_id
        AND e.source_material_fingerprint = v_source_fingerprint
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'booking already has different commission evidence';
    END IF;
    SELECT coalesce(pg_catalog.sum(e.amount_cents), 0)::bigint INTO v_total
    FROM public.booking_financial_metric_evidence AS e
    WHERE e.salon_id = p_salon_id AND e.booking_id = p_booking_id
      AND e.metric = 'commission' AND e.effect = 'credit';
    RETURN pg_catalog.jsonb_build_object(
      'applied', false, 'event_rows', v_existing_count,
      'commission_cents', v_total, 'classification', 'estimate_not_payroll'
    );
  END IF;

  WITH allocations AS (
    SELECT seg.staff_id, seg.service_id,
      pg_catalog.sum(seg.subtotal_cents)::bigint AS basis,
      pg_catalog.min(seg.position)::integer AS first_position
    FROM public.booking_service_segments AS seg
    WHERE v_booking.schedule_model = 'segments_v1' AND seg.booking_id = p_booking_id
    GROUP BY seg.staff_id, seg.service_id
    UNION ALL
    SELECT v_booking.staff_id, v_booking.service_id,
      greatest(coalesce(v_booking.subtotal_cents, v_booking.price_cents, 0), 0)::bigint,
      0
    WHERE v_booking.schedule_model = 'single' AND v_booking.staff_id IS NOT NULL
  ), inserted AS (
    INSERT INTO public.booking_financial_metric_evidence (
      salon_id, booking_id, metric, policy_id, staff_id, service_id,
      allocation_key, occurred_at, source_kind, source_event_id,
      source_material_fingerprint, currency, effect, basis_amount_cents,
      amount_cents, material_fingerprint, recorded_by
    )
    SELECT p_salon_id, p_booking_id, 'commission', v_policy.id,
      a.staff_id, a.service_id, a.staff_id::text || ':' || a.service_id::text,
      v_booking.end_time_utc, 'policy_calculation', p_source_event_id,
      v_source_fingerprint, v_currency, 'credit', a.basis,
      ((a.basis * v_policy.commission_rate_basis_points + 5000) / 10000)::bigint,
      pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
        v_source_fingerprint || ':' || a.staff_id::text || ':' || a.service_id::text || ':' || a.basis::text,
        'UTF8'), 'sha256'), 'hex'), p_actor_user_id
    FROM allocations AS a
    RETURNING amount_cents
  ) SELECT count(*)::integer, coalesce(pg_catalog.sum(amount_cents), 0)::bigint
    INTO v_inserted, v_total FROM inserted;
  IF v_inserted = 0 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'booking has no attributable staff service allocation';
  END IF;
  RETURN pg_catalog.jsonb_build_object(
    'applied', true, 'event_rows', v_inserted,
    'commission_cents', v_total, 'classification', 'estimate_not_payroll'
  );
END;
$calculate_commission$;

REVOKE ALL ON FUNCTION public.calculate_booking_commission_evidence(
  uuid, uuid, uuid, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.calculate_booking_commission_evidence(
  uuid, uuid, uuid, text
) TO service_role;

CREATE OR REPLACE FUNCTION public.record_booking_financial_metric_reversal(
  p_salon_id uuid,
  p_booking_id uuid,
  p_actor_user_id uuid,
  p_metric text,
  p_basis_amount_cents bigint,
  p_source_event_id text,
  p_payment_operation_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $record_metric_reversal$
DECLARE
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_operation public.booking_payment_operations%ROWTYPE;
  v_source_kind text;
  v_occurred_at timestamptz := transaction_timestamp() - interval '1 microsecond';
  v_provider text;
  v_provider_fingerprint text;
  v_provider_receipt text;
  v_source_fingerprint text;
  v_existing_fingerprint text;
  v_existing_count integer;
  v_available_basis bigint;
  v_inserted integer;
  v_total bigint;
BEGIN
  IF v_role <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service role required';
  END IF;
  IF p_salon_id IS NULL OR p_booking_id IS NULL OR p_actor_user_id IS NULL
     OR p_metric IS NULL OR p_metric NOT IN ('tips', 'commission')
     OR p_basis_amount_cents IS NULL OR p_basis_amount_cents <= 0
     OR p_source_event_id IS NULL OR p_source_event_id !~ '^[A-Za-z0-9:_./-]{1,180}$'
     OR NOT EXISTS (
       SELECT 1 FROM public.salon_members AS m
       WHERE m.salon_id = p_salon_id AND m.user_id = p_actor_user_id
         AND m.role IN ('owner', 'admin')
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid financial metric reversal';
  END IF;
  IF p_payment_operation_id IS NULL THEN
    v_source_kind := CASE WHEN p_metric = 'tips' THEN 'manual_verified' ELSE 'policy_calculation' END;
  ELSE
    SELECT o.* INTO v_operation FROM public.booking_payment_operations AS o
    WHERE o.id = p_payment_operation_id AND o.salon_id = p_salon_id
      AND o.booking_id = p_booking_id
      AND o.operation_kind IN ('deposit_refund', 'noshow_refund', 'late_cancel_refund')
      AND o.status IN ('succeeded', 'compensated')
      AND o.provider_refund_id IS NOT NULL AND o.completed_at IS NOT NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'authoritative refund operation required';
    END IF;
    v_source_kind := 'provider_receipt';
    v_occurred_at := v_operation.completed_at;
    v_provider := v_operation.provider;
    v_provider_fingerprint := v_operation.provider_account_fingerprint;
    v_provider_receipt := v_operation.provider_refund_id;
  END IF;
  v_source_fingerprint := pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
    pg_catalog.jsonb_build_object(
      'salon_id', p_salon_id, 'booking_id', p_booking_id,
      'metric', p_metric, 'basis_amount_cents', p_basis_amount_cents,
      'source_event_id', p_source_event_id,
      'payment_operation_id', p_payment_operation_id
    )::text, 'UTF8'), 'sha256'), 'hex');

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'financial-reversal:' || p_salon_id::text || ':' || p_booking_id::text || ':' || p_metric, 0
  ));
  SELECT count(*)::integer, min(e.source_material_fingerprint)
  INTO v_existing_count, v_existing_fingerprint
  FROM public.booking_financial_metric_evidence AS e
  WHERE e.salon_id = p_salon_id AND e.booking_id = p_booking_id
    AND e.metric = p_metric AND e.source_event_id = p_source_event_id;
  IF v_existing_count > 0 THEN
    IF v_existing_fingerprint <> v_source_fingerprint THEN
      RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'financial reversal idempotency payload mismatch';
    END IF;
    SELECT coalesce(pg_catalog.sum(e.amount_cents), 0)::bigint INTO v_total
    FROM public.booking_financial_metric_evidence AS e
    WHERE e.salon_id = p_salon_id AND e.booking_id = p_booking_id
      AND e.metric = p_metric AND e.source_event_id = p_source_event_id;
    RETURN pg_catalog.jsonb_build_object(
      'applied', false, 'event_rows', v_existing_count, 'reversed_cents', v_total
    );
  END IF;
  SELECT coalesce(pg_catalog.sum(
    CASE WHEN e.effect = 'credit' THEN e.basis_amount_cents ELSE -e.basis_amount_cents END
  ), 0)::bigint INTO v_available_basis
  FROM public.booking_financial_metric_evidence AS e
  WHERE e.salon_id = p_salon_id AND e.booking_id = p_booking_id AND e.metric = p_metric;
  IF v_available_basis < p_basis_amount_cents THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'financial reversal exceeds remaining evidence basis';
  END IF;

  WITH balances AS (
    SELECT credit.policy_id, credit.staff_id, credit.service_id,
      credit.allocation_key, credit.currency,
      pg_catalog.max(credit.basis_amount_cents)::bigint AS credit_basis,
      pg_catalog.max(credit.amount_cents)::bigint AS credit_amount,
      coalesce(pg_catalog.sum(debit.basis_amount_cents), 0)::bigint AS prior_basis,
      coalesce(pg_catalog.sum(debit.amount_cents), 0)::bigint AS prior_amount,
      pg_catalog.max(policy.commission_rate_basis_points) AS rate
    FROM public.booking_financial_metric_evidence AS credit
    JOIN public.salon_financial_metric_policies AS policy ON policy.id = credit.policy_id
    LEFT JOIN public.booking_financial_metric_evidence AS debit
      ON debit.salon_id = credit.salon_id AND debit.booking_id = credit.booking_id
      AND debit.metric = credit.metric AND debit.allocation_key = credit.allocation_key
      AND debit.effect = 'debit'
    WHERE credit.salon_id = p_salon_id AND credit.booking_id = p_booking_id
      AND credit.metric = p_metric AND credit.effect = 'credit'
    GROUP BY credit.policy_id, credit.staff_id, credit.service_id,
      credit.allocation_key, credit.currency
  ), weighted AS (
    SELECT b.*, (b.credit_basis - b.prior_basis)::bigint AS outstanding_basis,
      pg_catalog.sum(b.credit_basis - b.prior_basis) OVER ()::bigint AS total_outstanding
    FROM balances AS b
    WHERE b.credit_basis > b.prior_basis
  ), based AS (
    SELECT w.*,
      (p_basis_amount_cents * w.outstanding_basis / w.total_outstanding)::bigint AS base_basis,
      (p_basis_amount_cents * w.outstanding_basis % w.total_outstanding)::bigint AS fractional
    FROM weighted AS w
  ), ranked AS (
    SELECT b.*,
      pg_catalog.row_number() OVER (ORDER BY b.fractional DESC, b.allocation_key)::bigint AS remainder_rank,
      (p_basis_amount_cents - pg_catalog.sum(b.base_basis) OVER ())::bigint AS remainder
    FROM based AS b
  ), amounts AS (
    SELECT r.*,
      (r.base_basis + CASE WHEN r.remainder_rank <= r.remainder THEN 1 ELSE 0 END)::bigint AS reversal_basis
    FROM ranked AS r
  ), inserted AS (
    INSERT INTO public.booking_financial_metric_evidence (
      salon_id, booking_id, metric, policy_id, staff_id, service_id,
      payment_operation_id, allocation_key, occurred_at, source_kind,
      source_event_id, source_material_fingerprint, currency, effect,
      basis_amount_cents, amount_cents, provider,
      provider_account_fingerprint, provider_receipt_id,
      material_fingerprint, recorded_by
    )
    SELECT p_salon_id, p_booking_id, p_metric, a.policy_id,
      a.staff_id, a.service_id, p_payment_operation_id, a.allocation_key,
      v_occurred_at, v_source_kind, p_source_event_id,
      v_source_fingerprint, a.currency, 'debit', a.reversal_basis,
      CASE WHEN p_metric = 'tips' THEN a.reversal_basis
        ELSE least(
          a.credit_amount - a.prior_amount,
          ((a.prior_basis + a.reversal_basis) * a.rate + 5000) / 10000 - a.prior_amount
        ) END::bigint,
      v_provider, v_provider_fingerprint, v_provider_receipt,
      pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
        v_source_fingerprint || ':' || a.allocation_key || ':' || a.reversal_basis::text,
        'UTF8'), 'sha256'), 'hex'), p_actor_user_id
    FROM amounts AS a WHERE a.reversal_basis > 0
    RETURNING amount_cents
  ) SELECT count(*)::integer, coalesce(pg_catalog.sum(amount_cents), 0)::bigint
    INTO v_inserted, v_total FROM inserted;
  IF v_inserted = 0 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'no financial metric evidence remains to reverse';
  END IF;
  RETURN pg_catalog.jsonb_build_object(
    'applied', true, 'event_rows', v_inserted, 'reversed_cents', v_total
  );
END;
$record_metric_reversal$;

REVOKE ALL ON FUNCTION public.record_booking_financial_metric_reversal(
  uuid, uuid, uuid, text, bigint, text, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_booking_financial_metric_reversal(
  uuid, uuid, uuid, text, bigint, text, uuid
) TO service_role;

-- Preserve the existing audited financial read contract as an internal base,
-- then add metric evidence without copying/reinterpreting its booking/payment
-- logic. Direct execution of the base remains unavailable to API roles.
ALTER FUNCTION public.load_authoritative_financial_report(
  uuid, uuid, date, date, timestamptz
) RENAME TO load_authoritative_financial_report_base_v2;
REVOKE ALL ON FUNCTION public.load_authoritative_financial_report_base_v2(
  uuid, uuid, date, date, timestamptz
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.load_authoritative_financial_report_base_v2(
  uuid, uuid, date, date, timestamptz
) TO service_role;

CREATE OR REPLACE FUNCTION public.load_authoritative_financial_report(
  p_salon_id uuid,
  p_actor_user_id uuid,
  p_local_from date,
  p_local_to_exclusive date,
  p_data_as_of timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $financial_report_with_metrics$
DECLARE
  v_report jsonb;
  v_metric_events jsonb := '[]'::jsonb;
  v_policies jsonb := '[]'::jsonb;
  v_tip_count integer := 0;
  v_commission_count integer := 0;
  v_tip_total bigint;
  v_commission_total bigint;
  v_tip_policy_count integer := 0;
  v_commission_policy_count integer := 0;
  v_tip_sources jsonb := '{}'::jsonb;
  v_commission_sources jsonb := '{}'::jsonb;
  v_material jsonb;
  v_fingerprint text;
BEGIN
  v_report := public.load_authoritative_financial_report_base_v2(
    p_salon_id, p_actor_user_id, p_local_from, p_local_to_exclusive, p_data_as_of
  );
  IF v_report->>'success' IS DISTINCT FROM 'true' THEN
    RETURN v_report;
  END IF;

  SELECT coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'evidence_id', e.id, 'metric', e.metric, 'booking_id', e.booking_id,
      'payment_operation_id', e.payment_operation_id, 'policy_id', e.policy_id,
      'staff_id', e.staff_id, 'service_id', e.service_id,
      'occurred_at', e.occurred_at, 'source_kind', e.source_kind,
      'source_event_id', e.source_event_id, 'currency', e.currency,
      'effect', e.effect, 'amount_cents', e.amount_cents,
      'signed_amount_cents', CASE WHEN e.effect = 'credit' THEN e.amount_cents ELSE -e.amount_cents END,
      'provider', e.provider,
      'provider_account_fingerprint', e.provider_account_fingerprint,
      'provider_receipt_id', e.provider_receipt_id,
      'material_fingerprint', e.material_fingerprint
    ) ORDER BY e.occurred_at, e.id
  ), '[]'::jsonb),
  count(*) FILTER (WHERE e.metric = 'tips')::integer,
  count(*) FILTER (WHERE e.metric = 'commission')::integer,
  pg_catalog.sum(CASE WHEN e.metric = 'tips' THEN
    CASE WHEN e.effect = 'credit' THEN e.amount_cents ELSE -e.amount_cents END END)::bigint,
  pg_catalog.sum(CASE WHEN e.metric = 'commission' THEN
    CASE WHEN e.effect = 'credit' THEN e.amount_cents ELSE -e.amount_cents END END)::bigint
  INTO v_metric_events, v_tip_count, v_commission_count, v_tip_total, v_commission_total
  FROM public.booking_financial_metric_evidence AS e
  WHERE e.salon_id = p_salon_id
    AND e.occurred_at >= (v_report#>>'{range,utc_from}')::timestamptz
    AND e.occurred_at < (v_report#>>'{range,effective_utc_to_exclusive}')::timestamptz;

  SELECT coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'policy_id', p.id, 'metric', p.metric,
      'policy_version', p.policy_version,
      'effective_from', p.effective_from, 'effective_to', p.effective_to,
      'definition_fingerprint', p.definition_fingerprint,
      'approved_at', p.approved_at
    ) ORDER BY p.effective_from, p.id
  ), '[]'::jsonb),
  count(*) FILTER (WHERE p.metric = 'tips')::integer,
  count(*) FILTER (WHERE p.metric = 'commission')::integer
  INTO v_policies, v_tip_policy_count, v_commission_policy_count
  FROM public.salon_financial_metric_policies AS p
  WHERE p.salon_id = p_salon_id
    AND p.effective_from < (v_report#>>'{range,effective_utc_to_exclusive}')::timestamptz
    AND (p.effective_to IS NULL OR p.effective_to > (v_report#>>'{range,utc_from}')::timestamptz);

  SELECT coalesce(pg_catalog.jsonb_object_agg(source_kind, amount), '{}'::jsonb)
  INTO v_tip_sources FROM (
    SELECT e.source_kind, count(*)::integer AS amount
    FROM public.booking_financial_metric_evidence AS e
    WHERE e.salon_id = p_salon_id AND e.metric = 'tips'
      AND e.occurred_at >= (v_report#>>'{range,utc_from}')::timestamptz
      AND e.occurred_at < (v_report#>>'{range,effective_utc_to_exclusive}')::timestamptz
    GROUP BY e.source_kind ORDER BY e.source_kind
  ) AS counts;
  SELECT coalesce(pg_catalog.jsonb_object_agg(source_kind, amount), '{}'::jsonb)
  INTO v_commission_sources FROM (
    SELECT e.source_kind, count(*)::integer AS amount
    FROM public.booking_financial_metric_evidence AS e
    WHERE e.salon_id = p_salon_id AND e.metric = 'commission'
      AND e.occurred_at >= (v_report#>>'{range,utc_from}')::timestamptz
      AND e.occurred_at < (v_report#>>'{range,effective_utc_to_exclusive}')::timestamptz
    GROUP BY e.source_kind ORDER BY e.source_kind
  ) AS counts;

  v_report := pg_catalog.jsonb_set(v_report, '{metric_events}', v_metric_events, true);
  v_report := pg_catalog.jsonb_set(v_report, '{metric_policies}', v_policies, true);
  v_report := pg_catalog.jsonb_set(v_report, '{totals,tip_cents}',
    CASE WHEN v_tip_count = 0 THEN 'null'::jsonb ELSE pg_catalog.to_jsonb(v_tip_total) END, true);
  v_report := pg_catalog.jsonb_set(v_report, '{totals,commission_cents}',
    CASE WHEN v_commission_count = 0 THEN 'null'::jsonb ELSE pg_catalog.to_jsonb(v_commission_total) END, true);
  v_report := pg_catalog.jsonb_set(v_report, '{coverage,tips}',
    CASE WHEN v_tip_policy_count = 0 THEN pg_catalog.jsonb_build_object(
      'unit','evidence','state','not_configured','included_rows',0,'excluded_rows',0,
      'reason_codes',pg_catalog.jsonb_build_array('authoritative_tip_ingestion_not_configured'),
      'source_counts','{}'::jsonb)
    WHEN v_tip_count = 0 THEN pg_catalog.jsonb_build_object(
      'unit','evidence','state','unknown','included_rows',0,'excluded_rows',0,
      'reason_codes',pg_catalog.jsonb_build_array('tip_evidence_missing'),
      'source_counts','{}'::jsonb)
    ELSE pg_catalog.jsonb_build_object(
      'unit','evidence','state','partial','included_rows',v_tip_count,'excluded_rows',0,
      'reason_codes',pg_catalog.jsonb_build_array('tip_sources_not_fully_reconciled'),
      'source_counts',v_tip_sources) END, true);
  v_report := pg_catalog.jsonb_set(v_report, '{coverage,commission}',
    CASE WHEN v_commission_policy_count = 0 THEN pg_catalog.jsonb_build_object(
      'unit','evidence','state','not_configured','included_rows',0,'excluded_rows',0,
      'reason_codes',pg_catalog.jsonb_build_array('approved_commission_policy_not_configured'),
      'source_counts','{}'::jsonb)
    WHEN v_commission_count = 0 THEN pg_catalog.jsonb_build_object(
      'unit','evidence','state','unknown','included_rows',0,'excluded_rows',0,
      'reason_codes',pg_catalog.jsonb_build_array('commission_evidence_missing'),
      'source_counts','{}'::jsonb)
    ELSE pg_catalog.jsonb_build_object(
      'unit','evidence','state','partial','included_rows',v_commission_count,'excluded_rows',0,
      'reason_codes',pg_catalog.jsonb_build_array('commission_estimate_not_payroll'),
      'source_counts',v_commission_sources) END, true);

  v_material := v_report - 'source_fingerprint' - 'generated_at';
  v_fingerprint := pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(v_material::text, 'UTF8'), 'sha256'), 'hex');
  RETURN v_report || pg_catalog.jsonb_build_object('source_fingerprint', v_fingerprint);
END;
$financial_report_with_metrics$;

REVOKE ALL ON FUNCTION public.load_authoritative_financial_report(
  uuid, uuid, date, date, timestamptz
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.load_authoritative_financial_report(
  uuid, uuid, date, date, timestamptz
) TO service_role;

COMMENT ON FUNCTION public.load_authoritative_financial_report(
  uuid, uuid, date, date, timestamptz
) IS 'Owner/admin-bound financial report with immutable tip evidence and commission estimates. Commission is explicitly not payroll or payout authority.';
