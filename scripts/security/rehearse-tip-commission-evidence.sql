\set ON_ERROR_STOP on

BEGIN;

DO $tip_commission_rehearsal$
DECLARE
  v_salon constant uuid := 'f1600000-0000-4000-8000-000000000001';
  v_other_salon constant uuid := 'f1600000-0000-4000-8000-000000000002';
  v_owner constant uuid := 'f1600000-0000-4000-8000-000000000003';
  v_admin constant uuid := 'f1600000-0000-4000-8000-000000000004';
  v_other_owner constant uuid := 'f1600000-0000-4000-8000-000000000005';
  v_service_a constant uuid := 'f1600000-0000-4000-8000-000000000011';
  v_service_b constant uuid := 'f1600000-0000-4000-8000-000000000012';
  v_staff_a constant uuid := 'f1600000-0000-4000-8000-000000000021';
  v_staff_b constant uuid := 'f1600000-0000-4000-8000-000000000022';
  v_booking constant uuid := 'f1600000-0000-4000-8000-000000000031';
  v_tip_policy uuid;
  v_commission_policy uuid;
  v_next_commission_policy uuid;
  v_result jsonb;
  v_report jsonb;
  v_denied boolean;
BEGIN
  INSERT INTO auth.users(id, email, created_at) VALUES
    (v_owner, 'compensation-owner@nailiq.invalid', transaction_timestamp()),
    (v_admin, 'compensation-admin@nailiq.invalid', transaction_timestamp()),
    (v_other_owner, 'compensation-other@nailiq.invalid', transaction_timestamp());
  INSERT INTO public.salons(id, slug, name, phone, timezone, currency_code) VALUES
    (v_salon, 'mqa-compensation', 'MQA Compensation', '+16045550701', 'America/Vancouver', 'CAD'),
    (v_other_salon, 'mqa-compensation-other', 'MQA Compensation Other', '+16045550702', 'America/Vancouver', 'CAD');
  INSERT INTO public.salon_members(salon_id, user_id, role) VALUES
    (v_salon, v_owner, 'owner'),
    (v_salon, v_admin, 'admin'),
    (v_other_salon, v_other_owner, 'owner');
  INSERT INTO public.service_categories(slug, name_en, name_vi)
    VALUES ('mqa-compensation', 'MQA Compensation', 'MQA Compensation');
  INSERT INTO public.services(id, salon_id, name, duration_minutes, price_cents, category) VALUES
    (v_service_a, v_salon, 'Service A', 30, 1000, 'mqa-compensation'),
    (v_service_b, v_salon, 'Service B', 30, 2000, 'mqa-compensation');
  INSERT INTO public.staff(id, salon_id, name, status) VALUES
    (v_staff_a, v_salon, 'Tech A', 'active'),
    (v_staff_b, v_salon, 'Tech B', 'active');
  INSERT INTO public.bookings(
    id, salon_id, service_id, client_name, start_time_utc, end_time_utc,
    status, subtotal_cents, tax_amount_cents, price_cents,
    schedule_model, sequence_version
  ) VALUES (
    v_booking, v_salon, v_service_a, 'Must not appear in report',
    '2026-08-22 15:00Z', '2026-08-22 16:00Z', 'completed',
    3000, 0, 3000, 'segments_v1', 1
  );
  INSERT INTO public.booking_service_segments(
    booking_id, salon_id, position, line_id, service_id, staff_id,
    customer_start_utc, customer_end_utc, occupied_start_utc, occupied_end_utc,
    prep_minutes, service_duration_minutes, sequential_addon_minutes,
    trailing_buffer_minutes, service_name, staff_name,
    original_service_price_cents, service_pre_voucher_cents,
    service_price_cents, subtotal_cents, total_cents, reservation_status
  ) VALUES (
    v_booking, v_salon, 0, 'f1600000-0000-4000-8000-000000000041',
    v_service_a, v_staff_a, '2026-08-22 15:00Z', '2026-08-22 15:30Z',
    '2026-08-22 15:00Z', '2026-08-22 15:30Z', 0, 30, 0, 0,
    'Service A', 'Tech A', 1000, 1000, 1000, 1000, 1000, 'completed'
  ), (
    v_booking, v_salon, 1, 'f1600000-0000-4000-8000-000000000042',
    v_service_b, v_staff_b, '2026-08-22 15:30Z', '2026-08-22 16:00Z',
    '2026-08-22 15:30Z', '2026-08-22 16:00Z', 0, 30, 0, 0,
    'Service B', 'Tech B', 2000, 2000, 2000, 2000, 2000, 'completed'
  );

  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  v_tip_policy := public.configure_salon_financial_metric_policy(
    v_salon, v_owner, 'tips', NULL, '2026-08-01 00:00Z', NULL
  );
  v_commission_policy := public.configure_salon_financial_metric_policy(
    v_salon, v_owner, 'commission', 2000, '2026-08-01 00:00Z', NULL
  );
  v_next_commission_policy := public.configure_salon_financial_metric_policy(
    v_salon, v_owner, 'commission', 2500, '2026-09-01 00:00Z', NULL
  );
  IF v_tip_policy IS NULL OR v_commission_policy IS NULL
     OR v_next_commission_policy IS NULL THEN
    RAISE EXCEPTION 'financial metric policy creation failed';
  END IF;
  IF (SELECT effective_to FROM public.salon_financial_metric_policies
      WHERE id = v_commission_policy) <> '2026-09-01 00:00Z'::timestamptz THEN
    RAISE EXCEPTION 'effective-dated commission policy did not close the prior interval';
  END IF;

  v_denied := false;
  BEGIN
    PERFORM public.configure_salon_financial_metric_policy(
      v_salon, v_other_owner, 'commission', 5000, '2027-01-01 00:00Z', NULL
    );
  EXCEPTION WHEN insufficient_privilege THEN v_denied := true;
  END;
  IF NOT v_denied THEN RAISE EXCEPTION 'cross-tenant policy approval was accepted'; END IF;

  v_result := public.record_booking_tip_evidence(
    v_salon, v_booking, v_admin, 1001, 'CAD', 'manual_verified', 'tip:receipt:one', NULL
  );
  IF v_result#>>'{applied}' <> 'true'
     OR (v_result->>'event_rows')::integer <> 2
     OR (v_result->>'total_tip_cents')::integer <> 1001 THEN
    RAISE EXCEPTION 'tip evidence was not applied: %', v_result;
  END IF;
  v_result := public.record_booking_tip_evidence(
    v_salon, v_booking, v_admin, 1001, 'CAD', 'manual_verified', 'tip:receipt:one', NULL
  );
  IF v_result#>>'{applied}' <> 'false' THEN
    RAISE EXCEPTION 'tip replay was not idempotent: %', v_result;
  END IF;
  IF (SELECT amount_cents FROM public.booking_financial_metric_evidence
      WHERE metric = 'tips' AND effect = 'credit' AND staff_id = v_staff_a) <> 334
     OR (SELECT amount_cents FROM public.booking_financial_metric_evidence
      WHERE metric = 'tips' AND effect = 'credit' AND staff_id = v_staff_b) <> 667 THEN
    RAISE EXCEPTION 'tip largest-remainder allocation is wrong';
  END IF;

  v_result := public.calculate_booking_commission_evidence(
    v_salon, v_booking, v_admin, 'commission:booking:one'
  );
  IF v_result#>>'{applied}' <> 'true'
     OR (v_result->>'event_rows')::integer <> 2
     OR (v_result->>'commission_cents')::integer <> 600
     OR v_result->>'classification' <> 'estimate_not_payroll' THEN
    RAISE EXCEPTION 'commission estimate was not applied: %', v_result;
  END IF;
  v_result := public.calculate_booking_commission_evidence(
    v_salon, v_booking, v_admin, 'commission:booking:one'
  );
  IF v_result#>>'{applied}' <> 'false' THEN
    RAISE EXCEPTION 'commission replay was not idempotent: %', v_result;
  END IF;

  v_result := public.record_booking_financial_metric_reversal(
    v_salon, v_booking, v_admin, 'tips', 201, 'tip:refund:one', NULL
  );
  IF (v_result->>'reversed_cents')::integer <> 201 THEN
    RAISE EXCEPTION 'tip reversal did not conserve cents: %', v_result;
  END IF;
  v_result := public.record_booking_financial_metric_reversal(
    v_salon, v_booking, v_admin, 'commission', 1500, 'commission:refund:one', NULL
  );
  IF (v_result->>'reversed_cents')::integer <> 300 THEN
    RAISE EXCEPTION 'commission partial clawback is wrong: %', v_result;
  END IF;
  v_result := public.record_booking_financial_metric_reversal(
    v_salon, v_booking, v_admin, 'commission', 1500, 'commission:refund:two', NULL
  );
  IF (v_result->>'reversed_cents')::integer <> 300 THEN
    RAISE EXCEPTION 'commission cumulative clawback is wrong: %', v_result;
  END IF;

  v_denied := false;
  BEGIN
    PERFORM public.record_booking_financial_metric_reversal(
      v_salon, v_booking, v_admin, 'commission', 1, 'commission:over-refund', NULL
    );
  EXCEPTION WHEN check_violation THEN v_denied := true;
  END;
  IF NOT v_denied THEN RAISE EXCEPTION 'over-refund was accepted'; END IF;

  v_report := public.load_authoritative_financial_report(
    v_salon, v_owner, '2026-08-01', '2026-09-01', NULL
  );
  IF v_report->>'success' <> 'true'
     OR (v_report#>>'{totals,tip_cents}')::integer <> 800
     OR (v_report#>>'{totals,commission_cents}')::integer <> 0
     OR v_report#>>'{coverage,tips,state}' <> 'partial'
     OR v_report#>>'{coverage,commission,state}' <> 'partial'
     OR v_report#>>'{coverage,commission,reason_codes,0}' <> 'commission_estimate_not_payroll'
     OR jsonb_array_length(v_report->'metric_events') <> 10
     OR jsonb_array_length(v_report->'metric_policies') <> 2 THEN
    RAISE EXCEPTION 'tip/commission report totals or coverage failed: %', v_report;
  END IF;
  IF v_report::text ~* 'Must not appear|compensation-owner@nailiq.invalid' THEN
    RAISE EXCEPTION 'financial report leaked customer or owner PII';
  END IF;

  v_denied := false;
  BEGIN
    UPDATE public.booking_financial_metric_evidence
    SET amount_cents = amount_cents + 1
    WHERE booking_id = v_booking;
  EXCEPTION WHEN insufficient_privilege THEN v_denied := true;
  END;
  IF NOT v_denied THEN RAISE EXCEPTION 'immutable metric evidence was updated'; END IF;
END;
$tip_commission_rehearsal$;

DO $tip_commission_acl$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'booking_financial_metric_evidence'
      AND c.relrowsecurity AND c.relforcerowsecurity
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'salon_financial_metric_policies'
      AND c.relrowsecurity AND c.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'financial metric tables are missing forced RLS';
  END IF;
  IF pg_catalog.has_table_privilege('anon', 'public.booking_financial_metric_evidence', 'SELECT')
     OR pg_catalog.has_table_privilege('authenticated', 'public.booking_financial_metric_evidence', 'SELECT')
     OR pg_catalog.has_table_privilege('service_role', 'public.booking_financial_metric_evidence', 'INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'financial metric evidence table ACL is too broad';
  END IF;
  IF pg_catalog.has_function_privilege(
    'authenticated',
    'public.record_booking_tip_evidence(uuid,uuid,uuid,bigint,text,text,text,uuid)',
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'anon',
    'public.calculate_booking_commission_evidence(uuid,uuid,uuid,text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'financial metric mutation RPC leaked to a browser role';
  END IF;
END;
$tip_commission_acl$;

ROLLBACK;

SELECT 'PASS tip allocation, commission estimate, immutable reversal and report integration' AS result;
