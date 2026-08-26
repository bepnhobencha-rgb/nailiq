-- MQA-0116..0121: truthful financial reporting read model.
--
-- This migration does not reinterpret schedule imports as money and does not
-- invent tip or commission policy.  It reuses the authoritative booking price
-- snapshots and payment-operation ledger, preserves every payment/refund event,
-- and leaves unsupported evidence null with explicit coverage.

-- Tips and commission deliberately have no storage/write contract in this
-- release. The payment ledger does not carry authoritative provider tip
-- amounts, and no approved deterministic commission policy exists. The report
-- therefore returns null + not_configured rather than trusting service-role
-- assertions or fabricating zero.

-- The original compensation index accidentally covered every deposit refund,
-- preventing legitimate multiple partial refunds for a booking-bound charge.
-- Preserve exactly-one compensation for paid-but-unbound deposits while
-- allowing independently keyed, cumulatively bounded booking refunds.
DROP INDEX public.booking_payment_operations_unbound_refund_once;
CREATE UNIQUE INDEX booking_payment_operations_unbound_refund_once
  ON public.booking_payment_operations(parent_operation_id)
  WHERE operation_kind='deposit_refund'
    AND booking_id IS NULL
    AND parent_operation_id IS NOT NULL
    AND status IN ('sending','pending_provider','reconciling','unknown','succeeded');

CREATE INDEX booking_payment_operations_financial_report_occurrence
  ON public.booking_payment_operations(
    salon_id,
    (CASE WHEN status IN ('succeeded','compensated')
      THEN completed_at ELSE created_at END),
    id
  );

CREATE OR REPLACE FUNCTION public.financial_json_nonnegative_cents(
  p_value jsonb,
  p_key text
)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
STRICT
SECURITY INVOKER
SET search_path TO ''
AS $financial_json_cents$
  SELECT CASE
    WHEN p_value->>p_key ~ '^[0-9]{1,19}$'
      AND (p_value->>p_key)::numeric<=9223372036854775807
    THEN (p_value->>p_key)::bigint
    ELSE NULL
  END
$financial_json_cents$;

REVOKE ALL ON FUNCTION public.financial_json_nonnegative_cents(jsonb,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.financial_json_nonnegative_cents(jsonb,text)
  TO service_role;

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
AS $financial_report$
DECLARE
  v_role text:=coalesce(
    nullif(current_setting('request.jwt.claim.role',true),''),
    nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role',''
  );
  v_salon public.salons%ROWTYPE;
  v_timezone text;
  v_currency text;
  v_utc_from timestamptz;
  v_utc_to timestamptz;
  v_now timestamptz:=transaction_timestamp();
  v_data_as_of timestamptz;
  v_effective_utc_to timestamptz;
  v_bounded_work_records integer;
  v_booking record;
  v_operation public.booking_payment_operations%ROWTYPE;
  v_parent_operation public.booking_payment_operations%ROWTYPE;
  v_parent_valid boolean;
  v_parent_refund_total bigint;
  v_pricing jsonb;
  v_snapshot jsonb;
  v_group record;
  v_group_ids text[];
  v_snapshot_ids text[];
  v_group_parity jsonb:='{}'::jsonb;
  v_group_aggregate jsonb:='{}'::jsonb;
  v_source text;
  v_reason text;
  v_valid boolean;
  v_subtotal bigint;
  v_tax bigint;
  v_total bigint;
  v_booking_rows jsonb:='[]'::jsonb;
  v_operations jsonb:='[]'::jsonb;
  v_metric_events jsonb:='[]'::jsonb;
  v_policies jsonb:='[]'::jsonb;
  v_booking_sources jsonb:='{}'::jsonb;
  v_charge_sources jsonb:='{}'::jsonb;
  v_refund_sources jsonb:='{}'::jsonb;
  v_booking_reasons jsonb:='[]'::jsonb;
  v_payment_reasons jsonb:='[]'::jsonb;
  v_refund_reasons jsonb:='[]'::jsonb;
  v_booking_count integer:=0;
  v_booking_included integer:=0;
  v_charge_count integer:=0;
  v_charge_included integer:=0;
  v_refund_count integer:=0;
  v_refund_included integer:=0;
  v_booked_subtotal bigint:=NULL;
  v_booked_tax bigint:=NULL;
  v_booked_total bigint:=NULL;
  v_collected_gross bigint:=NULL;
  v_refund_total bigint:=NULL;
  v_collected_net bigint:=NULL;
  v_gross bigint;
  v_refund bigint;
  v_net bigint;
  v_coverage jsonb;
  v_totals jsonb;
  v_basis text;
  v_report jsonb;
  v_fingerprint text;
BEGIN
  IF v_role<>'service_role' THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','unauthorized');
  END IF;
  IF p_salon_id IS NULL OR p_actor_user_id IS NULL
     OR p_local_from IS NULL OR p_local_to_exclusive IS NULL
     OR p_local_from>=p_local_to_exclusive
     OR p_local_to_exclusive-p_local_from>366 THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','invalid_range');
  END IF;
  IF NOT EXISTS(
    SELECT 1 FROM public.salon_members m
    WHERE m.salon_id=p_salon_id AND m.user_id=p_actor_user_id
      AND m.role IN ('owner','admin')
  ) THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','actor_unauthorized');
  END IF;
  SELECT s.* INTO v_salon FROM public.salons s WHERE s.id=p_salon_id;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','salon_not_found');
  END IF;
  v_timezone:=nullif(trim(v_salon.timezone),'');
  IF v_timezone IS NULL OR NOT EXISTS(
    SELECT 1 FROM pg_catalog.pg_timezone_names z WHERE z.name=v_timezone
  ) THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','invalid_salon_timezone');
  END IF;
  v_currency:=upper(nullif(trim(v_salon.currency_code),''));
  IF coalesce(v_currency,'')!~'^[A-Z]{3}$' THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','invalid_salon_currency');
  END IF;
  v_utc_from:=p_local_from::timestamp AT TIME ZONE v_timezone;
  v_utc_to:=p_local_to_exclusive::timestamp AT TIME ZONE v_timezone;
  v_data_as_of:=coalesce(p_data_as_of,v_now);
  -- This is a current-statement cut-off, not a temporal reconstruction API.
  -- Exact UI/CSV/PDF reuse is provided by the application-signed full DTO.
  IF v_data_as_of>v_now OR v_data_as_of<v_utc_from THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','invalid_data_as_of');
  END IF;
  v_effective_utc_to:=least(v_utc_to,v_data_as_of);

  -- Bound both emitted rows and cross-range group reconciliation work before
  -- any JSON accumulation or per-refund parent lookup. LIMIT 701 makes this a
  -- fail-fast availability gate matching the application export cap of 700.
  SELECT count(*)::integer INTO v_bounded_work_records
  FROM (
    SELECT 1
    FROM public.bookings b
    WHERE b.salon_id=p_salon_id AND b.deleted_at IS NULL
      AND b.start_time_utc>=v_utc_from AND b.start_time_utc<v_utc_to
    UNION ALL
    SELECT 1
    FROM public.booking_payment_operations o
    WHERE o.salon_id=p_salon_id
      AND (CASE WHEN o.status IN ('succeeded','compensated')
        THEN o.completed_at ELSE o.created_at END)>=v_utc_from
      AND (CASE WHEN o.status IN ('succeeded','compensated')
        THEN o.completed_at ELSE o.created_at END)<v_effective_utc_to
    UNION ALL
    SELECT 1
    FROM public.bookings member
    WHERE member.salon_id=p_salon_id AND member.deleted_at IS NULL
      AND member.group_id IS NOT NULL
      AND (member.start_time_utc<v_utc_from OR member.start_time_utc>=v_utc_to)
      AND EXISTS (
        SELECT 1 FROM public.bookings ranged
        WHERE ranged.salon_id=p_salon_id AND ranged.deleted_at IS NULL
          AND ranged.group_id=member.group_id
          AND ranged.start_time_utc>=v_utc_from AND ranged.start_time_utc<v_utc_to
      )
    LIMIT 701
  ) bounded;
  IF v_bounded_work_records>700 THEN
    RETURN pg_catalog.jsonb_build_object(
      'success',false,'code','report_too_large','max_records',700
    );
  END IF;

  -- Validate each whole group against its organizer aggregate once.  The
  -- aggregate is reconciliation evidence only and is never a second sale.
  FOR v_group IN
    WITH relevant_groups AS (
      SELECT DISTINCT b.group_id
      FROM public.bookings b
      WHERE b.salon_id=p_salon_id AND b.group_id IS NOT NULL
        AND b.start_time_utc>=v_utc_from AND b.start_time_utc<v_utc_to
        AND b.deleted_at IS NULL
    )
    SELECT b.group_id,
      pg_catalog.array_agg(b.id::text ORDER BY b.id::text) AS booking_ids,
      count(*)::integer AS member_count,
      count(*) FILTER (WHERE b.is_group_organizer) AS organizer_count,
      sum(b.subtotal_cents)::bigint AS subtotal_cents,
      sum(b.tax_amount_cents)::bigint AS tax_cents,
      sum(b.subtotal_cents+b.tax_amount_cents)::bigint AS total_cents,
      (pg_catalog.array_agg(b.public_booking_pricing_snapshot ORDER BY b.id)
        FILTER (WHERE b.is_group_organizer))[1] AS organizer_snapshot
    FROM public.bookings b
    JOIN relevant_groups rg ON rg.group_id=b.group_id
    WHERE b.salon_id=p_salon_id AND b.deleted_at IS NULL
    GROUP BY b.group_id
  LOOP
    v_group_ids:=v_group.booking_ids;
    v_snapshot:=v_group.organizer_snapshot;
    SELECT coalesce(pg_catalog.array_agg(e.value ORDER BY e.value),ARRAY[]::text[])
      INTO v_snapshot_ids
    FROM pg_catalog.jsonb_array_elements_text(CASE
      WHEN pg_catalog.jsonb_typeof(v_snapshot->'booking_ids')='array'
        THEN v_snapshot->'booking_ids' ELSE '[]'::jsonb END) e(value);
    v_valid:=v_group.organizer_count=1
      AND v_snapshot->>'group_id'=v_group.group_id::text
      AND v_snapshot_ids=v_group_ids
      AND public.financial_json_nonnegative_cents(v_snapshot,'subtotal_cents')
        =v_group.subtotal_cents
      AND public.financial_json_nonnegative_cents(v_snapshot,'tax_cents')
        =v_group.tax_cents
      AND public.financial_json_nonnegative_cents(v_snapshot,'total_cents')
        =v_group.total_cents
      AND upper(nullif(trim(v_snapshot->>'currency'),''))=v_currency;
    IF pg_catalog.jsonb_typeof(v_snapshot)='object'
       AND nullif(trim(v_snapshot->>'currency'),'') IS NOT NULL
       AND upper(trim(v_snapshot->>'currency'))<>v_currency THEN
      RETURN pg_catalog.jsonb_build_object(
        'success',false,'code','historical_currency_mismatch',
        'group_id',v_group.group_id,
        'snapshot_currency',upper(trim(v_snapshot->>'currency')),
        'salon_currency',v_currency
      );
    END IF;
    v_group_parity:=pg_catalog.jsonb_set(
      v_group_parity,ARRAY[v_group.group_id::text],pg_catalog.to_jsonb(v_valid),true
    );
    IF v_valid THEN
      v_group_aggregate:=pg_catalog.jsonb_set(
        v_group_aggregate,ARRAY[v_group.group_id::text],
        pg_catalog.jsonb_build_object(
          'member_booking_ids',pg_catalog.to_jsonb(v_group_ids),
          'subtotal_cents',v_group.subtotal_cents,
          'tax_cents',v_group.tax_cents,'total_cents',v_group.total_cents
        ),true
      );
    END IF;
  END LOOP;

  FOR v_booking IN
    SELECT b.* FROM public.bookings b
    WHERE b.salon_id=p_salon_id
      AND b.start_time_utc>=v_utc_from AND b.start_time_utc<v_utc_to
      AND b.deleted_at IS NULL
    ORDER BY b.start_time_utc,b.id
  LOOP
    v_booking_count:=v_booking_count+1;
    v_snapshot:=v_booking.public_booking_pricing_snapshot;
    v_pricing:=v_snapshot;
    IF v_booking.group_id IS NOT NULL AND v_booking.is_group_organizer
       AND pg_catalog.jsonb_typeof(v_snapshot->'member_quotes')='array' THEN
      SELECT q.value INTO v_pricing
      FROM pg_catalog.jsonb_array_elements(v_snapshot->'member_quotes') q(value)
      WHERE q.value->>'member_index'='0' LIMIT 1;
    END IF;
    v_subtotal:=public.financial_json_nonnegative_cents(v_pricing,'subtotal_cents');
    v_tax:=public.financial_json_nonnegative_cents(v_pricing,'tax_cents');
    v_total:=public.financial_json_nonnegative_cents(v_pricing,'total_cents');
    -- Bookings have no per-row currency column. The authoritative currency is
    -- the tenant currency locked into this single-currency report.
    v_valid:=(
      v_booking.public_booking_pricing_fingerprint~'^[0-9a-f]{64}$'
      AND pg_catalog.jsonb_typeof(v_snapshot)='object'
      AND v_snapshot->>'pricing_fingerprint'
        =v_booking.public_booking_pricing_fingerprint
      AND v_subtotal=v_booking.subtotal_cents
      AND v_tax=v_booking.tax_amount_cents
      AND v_total=v_subtotal+v_tax
      AND (
        upper(nullif(trim(v_snapshot->>'currency'),''))=v_currency
        OR (
          v_booking.group_id IS NOT NULL
          AND coalesce(v_booking.is_group_organizer,false) IS FALSE
          AND coalesce((v_group_parity->>v_booking.group_id::text)::boolean,false)
        )
      )
    );
    IF v_booking.public_booking_pricing_fingerprint~'^[0-9a-f]{64}$'
       AND pg_catalog.jsonb_typeof(v_snapshot)='object'
       AND (v_booking.group_id IS NULL OR v_booking.is_group_organizer)
       AND nullif(trim(v_snapshot->>'currency'),'') IS NOT NULL
       AND upper(trim(v_snapshot->>'currency'))<>v_currency THEN
      RETURN pg_catalog.jsonb_build_object(
        'success',false,'code','historical_currency_mismatch',
        'booking_id',v_booking.id,'snapshot_currency',upper(trim(v_snapshot->>'currency')),
        'salon_currency',v_currency
      );
    END IF;

    IF v_booking.recovered_from_booking_id IS NOT NULL THEN
      v_source:='archived_recovery'; v_valid:=false;
      v_reason:='archived_recovery_pricing_unknown';
    ELSIF v_booking.after_hours_minutes IS NOT NULL THEN
      v_source:='controlled_after_hours'; v_valid:=false;
      v_reason:='controlled_after_hours_pricing_unknown';
    ELSIF v_booking.group_id IS NOT NULL
       AND coalesce((v_group_parity->>v_booking.group_id::text)::boolean,false) IS NOT TRUE THEN
      v_source:='canonical_group_member'; v_valid:=false;
      v_reason:='group_aggregate_parity_invalid';
    ELSIF v_valid AND v_booking.group_id IS NOT NULL THEN
      v_source:='canonical_group_member'; v_reason:=NULL;
    ELSIF v_valid AND v_booking.booking_channel='voice' THEN
      v_source:='canonical_voice'; v_reason:=NULL;
    ELSIF v_valid AND v_booking.booking_channel IN ('desk','walkin') THEN
      v_source:='canonical_desk'; v_reason:=NULL;
    ELSIF v_valid THEN
      v_source:='canonical_individual'; v_reason:=NULL;
    ELSIF v_booking.booking_channel='wix' THEN
      v_source:='wix_schedule'; v_reason:='wix_schedule_not_financial_truth';
    ELSIF v_booking.booking_channel='square' THEN
      v_source:='square_schedule'; v_reason:='square_schedule_not_financial_truth';
    ELSE
      v_source:='legacy'; v_reason:='legacy_pricing_unknown';
    END IF;
    -- Booking price/tax is an earned-service estimate, not a schedule forecast.
    -- Keep non-completed rows visible but never include them in earned totals.
    IF v_valid AND v_booking.status<>'completed' THEN
      v_valid:=false;
      v_reason:='booking_status_not_completed';
    END IF;
    v_booking_sources:=pg_catalog.jsonb_set(v_booking_sources,ARRAY[v_source],
      pg_catalog.to_jsonb(coalesce((v_booking_sources->>v_source)::integer,0)+1),true);
    IF v_valid THEN
      v_booking_included:=v_booking_included+1;
      v_booked_subtotal:=coalesce(v_booked_subtotal,0)+v_subtotal;
      v_booked_tax:=coalesce(v_booked_tax,0)+v_tax;
      v_booked_total:=coalesce(v_booked_total,0)+v_total;
    ELSE
      v_booking_reasons:=v_booking_reasons||pg_catalog.jsonb_build_array(v_reason);
    END IF;
    v_booking_rows:=v_booking_rows||pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'row_id',v_booking.id,
        'booking_id',v_booking.id,'group_id',v_booking.group_id,
        'is_group_organizer',coalesce(v_booking.is_group_organizer,false),
        'occurred_at',v_booking.start_time_utc,'source_path',v_source,
        'channel',v_booking.booking_channel,'staff_id',v_booking.staff_id,
        'service_id',v_booking.service_id,'currency',v_currency,
        'booking_status',v_booking.status,
        'booked_subtotal_cents',CASE WHEN v_valid THEN v_subtotal END,
        'booked_tax_cents',CASE WHEN v_valid THEN v_tax END,
        'booked_total_cents',CASE WHEN v_valid THEN v_total END,
        'evidence',pg_catalog.jsonb_build_object(
          'pricing_snapshot',v_valid,
          'pricing_fingerprint',CASE WHEN v_valid
            THEN v_booking.public_booking_pricing_fingerprint END,
          'pricing_snapshot_version',CASE WHEN v_valid THEN coalesce(
            CASE WHEN v_snapshot->>'contract_version'~'^[1-9][0-9]{0,3}$'
              THEN (v_snapshot->>'contract_version')::integer END,1) END,
          'coverage_reasons',CASE WHEN v_reason IS NULL THEN '[]'::jsonb
            ELSE pg_catalog.jsonb_build_array(v_reason) END,
          'group_aggregate_parity',CASE
            WHEN v_booking.group_id IS NOT NULL AND v_booking.is_group_organizer
              THEN v_group_aggregate->v_booking.group_id::text
            ELSE NULL END
        )
      )
    );
  END LOOP;

  FOR v_operation IN
    SELECT o.* FROM public.booking_payment_operations o
    WHERE o.salon_id=p_salon_id
      AND (CASE WHEN o.status IN ('succeeded','compensated')
          THEN o.completed_at ELSE o.created_at END)>=v_utc_from
      AND (CASE WHEN o.status IN ('succeeded','compensated')
          THEN o.completed_at ELSE o.created_at END)<v_effective_utc_to
    ORDER BY (CASE WHEN o.status IN ('succeeded','compensated')
      THEN o.completed_at ELSE o.created_at END),o.id
  LOOP
    IF v_operation.currency<>v_currency THEN
      RETURN pg_catalog.jsonb_build_object(
        'success',false,'code','operation_currency_mismatch',
        'operation_id',v_operation.id,
        'operation_currency',v_operation.currency,'salon_currency',v_currency
      );
    END IF;
    v_gross:=NULL; v_refund:=NULL; v_net:=NULL;
    v_parent_valid:=NULL; v_parent_refund_total:=NULL;
    IF v_operation.operation_kind IN (
      'deposit_charge','noshow_charge','late_cancel_charge'
    ) THEN
      v_charge_count:=v_charge_count+1;
      IF v_operation.status IN ('succeeded','compensated')
         AND v_operation.completed_at IS NOT NULL
         AND nullif(trim(v_operation.provider_payment_id),'') IS NOT NULL
         AND v_operation.currency=v_currency THEN
        v_gross:=v_operation.amount_cents;
        v_net:=v_gross;
        v_charge_included:=v_charge_included+1;
        v_collected_gross:=coalesce(v_collected_gross,0)+v_gross;
      ELSE
        v_payment_reasons:=v_payment_reasons||pg_catalog.jsonb_build_array(
          CASE WHEN v_operation.currency<>v_currency THEN 'payment_currency_mismatch'
            ELSE 'payment_not_final_or_receipt_missing' END);
      END IF;
    ELSE
      v_refund_count:=v_refund_count+1;
      SELECT p.* INTO v_parent_operation
      FROM public.booking_payment_operations p
      WHERE p.id=v_operation.parent_operation_id;
      v_parent_valid:=FOUND
        AND v_parent_operation.salon_id=v_operation.salon_id
        AND v_parent_operation.booking_id IS NOT DISTINCT FROM v_operation.booking_id
        AND v_parent_operation.provider=v_operation.provider
        AND v_parent_operation.provider_account_fingerprint
          =v_operation.provider_account_fingerprint
        AND v_parent_operation.currency=v_operation.currency
        AND v_parent_operation.provider_payment_id=v_operation.parent_payment_id
        AND v_parent_operation.status IN ('succeeded','compensated')
        AND (
          (v_operation.operation_kind='deposit_refund'
            AND v_parent_operation.operation_kind='deposit_charge')
          OR (v_operation.operation_kind='noshow_refund'
            AND v_parent_operation.operation_kind='noshow_charge')
          OR (v_operation.operation_kind='late_cancel_refund'
            AND v_parent_operation.operation_kind='late_cancel_charge')
        );
      IF v_parent_valid THEN
        SELECT coalesce(sum(c.amount_cents),0)::bigint INTO v_parent_refund_total
        FROM public.booking_payment_operations c
        WHERE c.parent_operation_id=v_parent_operation.id
          AND c.operation_kind IN ('deposit_refund','noshow_refund','late_cancel_refund')
          AND c.status='succeeded';
        v_parent_valid:=v_parent_refund_total<=v_parent_operation.amount_cents;
      END IF;
      IF v_operation.status='succeeded'
         AND v_operation.completed_at IS NOT NULL
         AND nullif(trim(v_operation.provider_refund_id),'') IS NOT NULL
         AND v_operation.parent_operation_id IS NOT NULL
         AND v_parent_valid
         AND v_operation.currency=v_currency THEN
        v_refund:=v_operation.amount_cents;
        v_net:=-v_refund;
        v_refund_included:=v_refund_included+1;
        v_refund_total:=coalesce(v_refund_total,0)+v_refund;
      ELSE
        v_refund_reasons:=v_refund_reasons||pg_catalog.jsonb_build_array(
          CASE WHEN v_operation.currency<>v_currency THEN 'refund_currency_mismatch'
            WHEN coalesce(v_parent_valid,false) IS NOT TRUE THEN 'refund_parent_invalid'
            ELSE 'refund_not_final_or_receipt_missing' END);
      END IF;
    END IF;
    IF v_operation.operation_kind IN (
      'deposit_charge','noshow_charge','late_cancel_charge'
    ) THEN
      v_charge_sources:=pg_catalog.jsonb_set(v_charge_sources,
        ARRAY[v_operation.operation_kind],pg_catalog.to_jsonb(coalesce(
          (v_charge_sources->>v_operation.operation_kind)::integer,0)+1),true);
    ELSE
      v_refund_sources:=pg_catalog.jsonb_set(v_refund_sources,
        ARRAY[v_operation.operation_kind],pg_catalog.to_jsonb(coalesce(
          (v_refund_sources->>v_operation.operation_kind)::integer,0)+1),true);
    END IF;
    v_operations:=v_operations||pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'operation_id',v_operation.id,'booking_id',v_operation.booking_id,
        'parent_operation_id',v_operation.parent_operation_id,
        'request_id',v_operation.request_id,
        'kind',v_operation.operation_kind,'ledger_status',v_operation.status,
        'status',CASE
          WHEN v_gross IS NOT NULL OR v_refund IS NOT NULL THEN 'succeeded'
          WHEN v_operation.status='unknown' THEN 'unknown'
          WHEN v_operation.status='failed' THEN 'failed'
          WHEN v_operation.status IN ('succeeded','compensated') THEN 'unknown'
          ELSE 'pending' END,
        'occurred_at',CASE WHEN v_operation.status IN ('succeeded','compensated')
          THEN v_operation.completed_at ELSE v_operation.created_at END,
        'provider',v_operation.provider,'currency',v_operation.currency,
        'provider_account_fingerprint',v_operation.provider_account_fingerprint,
        'requested_amount_cents',v_operation.amount_cents,
        'provider_payment_id',CASE
          WHEN v_operation.operation_kind IN (
            'deposit_refund','noshow_refund','late_cancel_refund'
          ) AND v_parent_valid THEN v_parent_operation.provider_payment_id
          ELSE v_operation.provider_payment_id END,
        'provider_refund_id',v_operation.provider_refund_id,
        'material_fingerprint',v_operation.material_fingerprint,
        'evidenced_gross_cents',v_gross,
        'evidenced_refund_cents',v_refund,
        'evidenced_net_cents',v_net,
        'parent_reference',CASE WHEN v_operation.operation_kind IN (
          'deposit_refund','noshow_refund','late_cancel_refund'
        ) AND v_parent_valid THEN pg_catalog.jsonb_build_object(
          'operation_id',v_parent_operation.id,
          'booking_id',v_parent_operation.booking_id,
          'provider',v_parent_operation.provider,
          'provider_account_fingerprint',v_parent_operation.provider_account_fingerprint,
          'currency',v_parent_operation.currency,
          'provider_payment_id',v_parent_operation.provider_payment_id,
          'requested_amount_cents',v_parent_operation.amount_cents,
          'cumulative_succeeded_refund_cents',v_parent_refund_total
        ) ELSE NULL END
      )
    );
  END LOOP;
  IF v_collected_gross IS NOT NULL OR v_refund_total IS NOT NULL THEN
    v_collected_net:=coalesce(v_collected_gross,0)-coalesce(v_refund_total,0);
  END IF;

  SELECT coalesce(pg_catalog.jsonb_agg(DISTINCT x.value ORDER BY x.value),'[]'::jsonb)
    INTO v_booking_reasons FROM pg_catalog.jsonb_array_elements(v_booking_reasons) x(value)
    WHERE x.value<>'null'::jsonb;
  SELECT coalesce(pg_catalog.jsonb_agg(DISTINCT x.value ORDER BY x.value),'[]'::jsonb)
    INTO v_payment_reasons FROM pg_catalog.jsonb_array_elements(v_payment_reasons) x(value)
    WHERE x.value<>'null'::jsonb;
  SELECT coalesce(pg_catalog.jsonb_agg(DISTINCT x.value ORDER BY x.value),'[]'::jsonb)
    INTO v_refund_reasons FROM pg_catalog.jsonb_array_elements(v_refund_reasons) x(value)
    WHERE x.value<>'null'::jsonb;

  v_coverage:=pg_catalog.jsonb_build_object(
    'booking_pricing',pg_catalog.jsonb_build_object(
      'unit','booking','state',CASE WHEN v_booking_count=0 OR v_booking_included=0 THEN 'unknown'
        WHEN v_booking_included=v_booking_count THEN 'complete' ELSE 'partial' END,
      'included_rows',v_booking_included,'excluded_rows',v_booking_count-v_booking_included,
      'reason_codes',v_booking_reasons,'source_counts',v_booking_sources),
    'tax',pg_catalog.jsonb_build_object(
      'unit','booking','basis','booking_estimate','state',CASE
        WHEN v_booking_count=0 OR v_booking_included=0 THEN 'unknown'
        WHEN v_booking_included=v_booking_count THEN 'complete' ELSE 'partial' END,
      'included_rows',v_booking_included,'excluded_rows',v_booking_count-v_booking_included,
      'reason_codes',v_booking_reasons,'source_counts',v_booking_sources),
    'payments',pg_catalog.jsonb_build_object(
      'unit','operation','state',CASE WHEN v_charge_included=0 THEN 'unknown' ELSE 'partial' END,
      'included_rows',v_charge_included,'excluded_rows',v_charge_count-v_charge_included,
      'reason_codes',v_payment_reasons||pg_catalog.jsonb_build_array(
        'service_and_external_payments_not_reconciled'),'source_counts',v_charge_sources),
    'refunds',pg_catalog.jsonb_build_object(
      'unit','operation','state',CASE WHEN v_refund_included=0 THEN 'unknown' ELSE 'partial' END,
      'included_rows',v_refund_included,'excluded_rows',v_refund_count-v_refund_included,
      'reason_codes',v_refund_reasons||pg_catalog.jsonb_build_array(
        'external_refunds_not_reconciled'),'source_counts',v_refund_sources),
    'tips',pg_catalog.jsonb_build_object(
      'unit','evidence','state','not_configured',
      'included_rows',0,'excluded_rows',0,
      'reason_codes',pg_catalog.jsonb_build_array(
        'authoritative_tip_ingestion_not_configured'),
      'source_counts','{}'::jsonb),
    'commission',pg_catalog.jsonb_build_object(
      'unit','evidence','state','not_configured',
      'included_rows',0,'excluded_rows',0,
      'reason_codes',pg_catalog.jsonb_build_array(
        'approved_commission_policy_not_configured'),
      'source_counts','{}'::jsonb)
  );
  v_totals:=pg_catalog.jsonb_build_object(
    'booked_subtotal_cents',v_booked_subtotal,
    'booked_tax_cents',v_booked_tax,'booked_total_cents',v_booked_total,
    'collected_gross_cents',v_collected_gross,
    'refund_cents',v_refund_total,'collected_net_cents',v_collected_net,
    'tip_cents',NULL,'commission_cents',NULL
  );
  v_basis:=CASE WHEN v_booking_included>0 AND (v_charge_included+v_refund_included)>0
      THEN 'mixed_with_separate_totals'
    WHEN (v_charge_included+v_refund_included)>0 THEN 'provider_collected'
    ELSE 'booking_estimate' END;
  v_report:=pg_catalog.jsonb_build_object(
    'success',true,'code','loaded','schema_version',2,
    'salon',pg_catalog.jsonb_build_object(
      'id',v_salon.id,'name',v_salon.name,'timezone',v_timezone,'currency',v_currency),
    'range',pg_catalog.jsonb_build_object(
      'local_from',p_local_from,'local_to_exclusive',p_local_to_exclusive,
      'utc_from',v_utc_from,'utc_to_exclusive',v_utc_to,
      'effective_utc_to_exclusive',v_effective_utc_to),
    'data_as_of',v_data_as_of,'basis',v_basis,'coverage',v_coverage,'totals',v_totals,
    'booking_rows',v_booking_rows,'operation_events',v_operations,
    'metric_events',v_metric_events,'metric_policies',v_policies
  );
  v_fingerprint:=pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(v_report::text,'UTF8'),'sha256'),'hex');
  RETURN v_report||pg_catalog.jsonb_build_object(
    'generated_at',v_now,'source_fingerprint',v_fingerprint
  );
END;
$financial_report$;

REVOKE ALL ON FUNCTION public.load_authoritative_financial_report(uuid,uuid,date,date,timestamptz)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.load_authoritative_financial_report(uuid,uuid,date,date,timestamptz)
  TO service_role;

COMMENT ON FUNCTION public.load_authoritative_financial_report(uuid,uuid,date,date,timestamptz) IS
  'Service-role, owner/admin-bound financial evidence DTO at one current cut-off. UI/CSV/PDF reuse one application-signed full DTO; the database does not re-query exports.';
