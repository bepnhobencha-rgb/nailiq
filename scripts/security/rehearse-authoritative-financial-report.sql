\set ON_ERROR_STOP on

BEGIN;

DO $rehearsal$
DECLARE
  v_salon constant uuid := 'f1100000-0000-4000-8000-000000000001';
  v_other_salon constant uuid := 'f1100000-0000-4000-8000-000000000002';
  v_owner constant uuid := 'f1100000-0000-4000-8000-000000000003';
  v_receptionist constant uuid := 'f1100000-0000-4000-8000-000000000004';
  v_other_owner constant uuid := 'f1100000-0000-4000-8000-000000000005';
  v_service constant uuid := 'f1100000-0000-4000-8000-000000000006';
  v_staff constant uuid := 'f1100000-0000-4000-8000-000000000007';
  v_individual constant uuid := 'f1100000-0000-4000-8000-000000000010';
  v_future constant uuid := 'f1100000-0000-4000-8000-000000000011';
  v_cancelled constant uuid := 'f1100000-0000-4000-8000-000000000012';
  v_group_one constant uuid := 'f1100000-0000-4000-8000-000000000013';
  v_group_two constant uuid := 'f1100000-0000-4000-8000-000000000014';
  v_group_id constant uuid := 'f1100000-0000-4000-8000-000000000015';
  v_cross_group_one constant uuid := 'f1100000-0000-4000-8000-000000000016';
  v_cross_group_two constant uuid := 'f1100000-0000-4000-8000-000000000017';
  v_cross_group_id constant uuid := 'f1100000-0000-4000-8000-000000000018';
  v_charge constant uuid := 'f1100000-0000-4000-8000-000000000020';
  v_refund_one constant uuid := 'f1100000-0000-4000-8000-000000000021';
  v_refund_two constant uuid := 'f1100000-0000-4000-8000-000000000022';
  v_pending constant uuid := 'f1100000-0000-4000-8000-000000000023';
  v_after_cutoff constant uuid := 'f1100000-0000-4000-8000-000000000024';
  v_report jsonb;
  v_spring jsonb;
  v_fall jsonb;
  v_fp_one text := repeat('1',64);
  v_fp_two text := repeat('2',64);
  v_fp_three text := repeat('3',64);
  v_fp_four text := repeat('4',64);
BEGIN
  INSERT INTO auth.users(id,email) VALUES
    (v_owner,'financial-owner@example.test'),
    (v_receptionist,'financial-desk@example.test'),
    (v_other_owner,'financial-other@example.test');
  INSERT INTO public.salons(id,slug,name,phone,timezone,currency_code) VALUES
    (v_salon,'financial-report-rehearsal','Financial report rehearsal',
      '+16045550101','America/Vancouver','CAD'),
    (v_other_salon,'financial-report-other','Financial report other',
      '+16045550102','UTC','USD');
  INSERT INTO public.salon_members(salon_id,user_id,role) VALUES
    (v_salon,v_owner,'owner'),(v_salon,v_receptionist,'receptionist'),
    (v_other_salon,v_other_owner,'owner');
  INSERT INTO public.service_categories(slug,name_en,name_vi)
    VALUES('other','Other','Khác') ON CONFLICT(slug) DO NOTHING;
  INSERT INTO public.services(id,salon_id,name,price_cents,duration_minutes)
    VALUES(v_service,v_salon,'Evidence service',1000,30);
  INSERT INTO public.staff(id,salon_id,name) VALUES(v_staff,v_salon,'Evidence staff');

  INSERT INTO public.bookings(
    id,salon_id,service_id,staff_id,client_name,start_time_utc,end_time_utc,
    status,booking_channel,subtotal_cents,tax_amount_cents,price_cents,
    public_booking_pricing_fingerprint,public_booking_pricing_snapshot
  ) VALUES (
    v_individual,v_salon,v_service,v_staff,'Evidence client',
    '2026-08-05 17:00Z','2026-08-05 17:30Z','completed','online',1000,50,1000,
    v_fp_one,jsonb_build_object('pricing_fingerprint',v_fp_one,'currency','CAD',
      'subtotal_cents',1000,'tax_cents',50,'total_cents',1050,'contract_version',1)
  ),(
    v_future,v_salon,v_service,v_staff,'Future client',
    '2026-08-25 17:00Z','2026-08-25 17:30Z','confirmed','online',1000,50,1000,
    v_fp_two,jsonb_build_object('pricing_fingerprint',v_fp_two,'currency','CAD',
      'subtotal_cents',1000,'tax_cents',50,'total_cents',1050,'contract_version',1)
  ),(
    v_cancelled,v_salon,v_service,v_staff,'Cancelled client',
    '2026-08-10 17:00Z','2026-08-10 17:30Z','cancelled','online',1000,50,1000,
    v_fp_three,jsonb_build_object('pricing_fingerprint',v_fp_three,'currency','CAD',
      'subtotal_cents',1000,'tax_cents',50,'total_cents',1050,'contract_version',1)
  );

  INSERT INTO public.bookings(
    id,salon_id,service_id,staff_id,client_name,start_time_utc,end_time_utc,
    status,booking_channel,subtotal_cents,tax_amount_cents,price_cents,
    group_id,is_group_organizer,
    public_booking_pricing_fingerprint,public_booking_pricing_snapshot
  ) VALUES (
    v_cross_group_one,v_salon,v_service,v_staff,'Cross-range organizer',
    '2026-08-01 06:30Z','2026-08-01 07:00Z','completed','online',500,25,500,
    v_cross_group_id,true,v_fp_one,
    jsonb_build_object(
      'pricing_fingerprint',v_fp_one,'group_id',v_cross_group_id,'currency','CAD',
      'booking_ids',jsonb_build_array(v_cross_group_one,v_cross_group_two),
      'subtotal_cents',1000,'tax_cents',50,'total_cents',1050,
      'member_quotes',jsonb_build_array(jsonb_build_object(
        'member_index',0,'subtotal_cents',500,'tax_cents',25,'total_cents',525))
    )
  ),(
    v_cross_group_two,v_salon,v_service,v_staff,'Cross-range member',
    '2026-08-01 07:00Z','2026-08-01 07:30Z','completed','online',500,25,500,
    v_cross_group_id,false,v_fp_two,
    jsonb_build_object('pricing_fingerprint',v_fp_two,
      'subtotal_cents',500,'tax_cents',25,'total_cents',525)
  );

  INSERT INTO public.bookings(
    id,salon_id,service_id,staff_id,client_name,start_time_utc,end_time_utc,
    status,booking_channel,subtotal_cents,tax_amount_cents,price_cents,
    group_id,is_group_organizer,
    public_booking_pricing_fingerprint,public_booking_pricing_snapshot
  ) VALUES (
    v_group_one,v_salon,v_service,v_staff,'Group organizer',
    '2026-08-06 17:00Z','2026-08-06 17:30Z','completed','online',1000,50,1000,
    v_group_id,true,v_fp_three,
    jsonb_build_object(
      'pricing_fingerprint',v_fp_three,'group_id',v_group_id,'currency','CAD',
      'booking_ids',jsonb_build_array(v_group_one,v_group_two),
      'subtotal_cents',3000,'tax_cents',150,'total_cents',3150,
      'member_quotes',jsonb_build_array(jsonb_build_object(
        'member_index',0,'subtotal_cents',1000,'tax_cents',50,'total_cents',1050))
    )
  ),(
    v_group_two,v_salon,v_service,v_staff,'Group member',
    '2026-08-06 17:30Z','2026-08-06 18:00Z','completed','online',2000,100,2000,
    v_group_id,false,v_fp_four,
    jsonb_build_object('pricing_fingerprint',v_fp_four,
      'subtotal_cents',2000,'tax_cents',100,'total_cents',2100)
  );

  -- Historical report fixtures may contain pre-gate in-flight no-show rows.
  -- Bypass only the synthetic INSERT trigger while seeding that legacy state;
  -- the approval gate is re-enabled before the report is queried.
  ALTER TABLE public.booking_payment_operations
    DISABLE TRIGGER booking_payment_operations_no_show_approval_insert;
  INSERT INTO public.booking_payment_operations(
    id,salon_id,booking_id,request_id,operation_kind,provider,
    provider_account_fingerprint,amount_cents,currency,material_fingerprint,
    material_json,provider_material,provider_payment_id,provider_idempotency_key,
    status,result_json,created_at,completed_at
  ) VALUES (
    v_charge,v_salon,v_individual,'f1100000-0000-4000-8000-000000000120',
    'deposit_charge','stripe',repeat('a',64),1000,'CAD',repeat('b',64),
    '{}'::jsonb,'{}'::jsonb,'pi_financial_parent','nq:financial-parent','succeeded',
    '{"provider_status":"succeeded"}'::jsonb,'2026-07-15 12:00Z','2026-07-15 12:01Z'
  ),(
    v_pending,v_salon,v_individual,'f1100000-0000-4000-8000-000000000123',
    'noshow_charge','stripe',repeat('a',64),300,'CAD',repeat('c',64),
    '{}'::jsonb,'{}'::jsonb,NULL,'nq:financial-pending','sending',NULL,
    '2026-08-10 12:00Z',NULL
  ),(
    v_after_cutoff,v_salon,v_future,'f1100000-0000-4000-8000-000000000124',
    'noshow_charge','stripe',repeat('a',64),300,'CAD',repeat('d',64),
    '{}'::jsonb,'{}'::jsonb,NULL,'nq:financial-after','sending',NULL,
    '2026-08-21 12:00Z',NULL
  );
  ALTER TABLE public.booking_payment_operations
    ENABLE TRIGGER booking_payment_operations_no_show_approval_insert;
  INSERT INTO public.booking_payment_operations(
    id,salon_id,booking_id,request_id,operation_kind,provider,
    provider_account_fingerprint,amount_cents,currency,material_fingerprint,
    material_json,provider_material,parent_payment_id,parent_operation_id,
    provider_refund_id,provider_idempotency_key,status,result_json,created_at,completed_at
  ) VALUES (
    v_refund_one,v_salon,v_individual,'f1100000-0000-4000-8000-000000000121',
    'deposit_refund','stripe',repeat('a',64),200,'CAD',repeat('e',64),
    '{}'::jsonb,'{}'::jsonb,'pi_financial_parent',v_charge,'re_financial_one',
    'nq:financial-refund-one','succeeded','{"provider_status":"succeeded"}'::jsonb,
    '2026-08-08 12:00Z','2026-08-08 12:01Z'
  ),(
    v_refund_two,v_salon,v_individual,'f1100000-0000-4000-8000-000000000122',
    'deposit_refund','stripe',repeat('a',64),200,'CAD',repeat('f',64),
    '{}'::jsonb,'{}'::jsonb,'pi_financial_parent',v_charge,'re_financial_two',
    'nq:financial-refund-two','succeeded','{"provider_status":"succeeded"}'::jsonb,
    '2026-08-09 12:00Z','2026-08-09 12:01Z'
  );

  PERFORM set_config('request.jwt.claim.role','service_role',true);
  v_report:=public.load_authoritative_financial_report(
    v_salon,v_owner,'2026-08-01','2026-09-01','2026-08-20 12:00Z'
  );
  IF v_report->>'success'<>'true' OR v_report->>'schema_version'<>'2'
     OR coalesce(v_report->>'source_fingerprint','')!~'^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'authoritative report did not load: %',v_report;
  END IF;
  IF jsonb_array_length(v_report->'booking_rows')<>6 THEN
    RAISE EXCEPTION 'booking range did not retain later scheduled rows: %',v_report->'booking_rows';
  END IF;
  IF (v_report#>>'{totals,booked_subtotal_cents}')::bigint<>4500
     OR (v_report#>>'{totals,booked_tax_cents}')::bigint<>225
     OR (v_report#>>'{totals,booked_total_cents}')::bigint<>4725 THEN
    RAISE EXCEPTION 'completed-only/group-once estimate totals are wrong: %',v_report->'totals';
  END IF;
  IF NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements(v_report->'booking_rows') r
    WHERE r->>'booking_id'=v_future::text
      AND r#>>'{evidence,coverage_reasons,0}'='booking_status_not_completed'
      AND r->'booked_total_cents'='null'::jsonb
  ) THEN
    RAISE EXCEPTION 'future confirmed booking was not visible-but-excluded';
  END IF;
  IF NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements(v_report->'booking_rows') r
    WHERE r->>'booking_id'=v_group_two::text
      AND r#>>'{evidence,pricing_snapshot}'='true'
  ) OR NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements(v_report->'booking_rows') r
    WHERE r->>'booking_id'=v_group_one::text
      AND jsonb_array_length(r#>'{evidence,group_aggregate_parity,member_booking_ids}')=2
  ) THEN
    RAISE EXCEPTION 'group member currency inheritance/parity failed';
  END IF;
  IF NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements(v_report->'booking_rows') r
    WHERE r->>'booking_id'=v_cross_group_two::text
      AND r#>>'{evidence,pricing_snapshot}'='true'
  ) OR EXISTS(
    SELECT 1 FROM jsonb_array_elements(v_report->'booking_rows') r
    WHERE r->>'booking_id'=v_cross_group_one::text
  ) THEN
    RAISE EXCEPTION 'cross-range group was not validated whole/output range-limited';
  END IF;
  IF jsonb_array_length(v_report->'operation_events')<>3
     OR (v_report#>>'{totals,collected_gross_cents}') IS NOT NULL
     OR (v_report#>>'{totals,refund_cents}')::bigint<>400
     OR (v_report#>>'{totals,collected_net_cents}')::bigint<>-400 THEN
    RAISE EXCEPTION 'refund-only period or as-of cutoff failed: %',v_report->'operation_events';
  END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(v_report->'operation_events') e
      WHERE e->>'kind'='deposit_refund'
        AND e#>>'{parent_reference,provider_payment_id}'='pi_financial_parent'
        AND (e#>>'{parent_reference,cumulative_succeeded_refund_cents}')::integer=400)=2 THEN
    NULL;
  ELSE
    RAISE EXCEPTION 'partial refunds did not retain distinct parent references';
  END IF;
  IF EXISTS(
    SELECT 1 FROM jsonb_array_elements(v_report->'operation_events') e
    WHERE e->>'operation_id'=v_after_cutoff::text
  ) THEN RAISE EXCEPTION 'post-as-of operation leaked into report'; END IF;
  IF v_report#>>'{coverage,payments,state}'='complete'
     OR v_report#>>'{coverage,refunds,state}'='complete' THEN
    RAISE EXCEPTION 'provider coverage was overclaimed';
  END IF;
  IF v_report#>>'{coverage,payments,source_counts,noshow_charge}'<>'1'
     OR v_report#>'{coverage,payments,source_counts,deposit_refund}' IS NOT NULL
     OR v_report#>>'{coverage,refunds,source_counts,deposit_refund}'<>'2'
     OR v_report#>'{coverage,refunds,source_counts,noshow_charge}' IS NOT NULL THEN
    RAISE EXCEPTION 'charge/refund coverage source counts were mixed';
  END IF;
  IF v_report#>'{totals,tip_cents}'<>'null'::jsonb
     OR v_report#>>'{coverage,tips,state}'<>'not_configured'
     OR v_report#>>'{coverage,commission,state}'<>'not_configured'
     OR v_report#>'{totals,commission_cents}'<>'null'::jsonb THEN
    RAISE EXCEPTION 'metric null/partial contract failed: %',v_report->'coverage';
  END IF;
  IF v_report::text ~* 'Evidence client|financial-owner@example' THEN
    RAISE EXCEPTION 'report leaked customer/actor PII';
  END IF;

  IF public.load_authoritative_financial_report(
    v_salon,v_receptionist,'2026-08-01','2026-09-01',NULL
  )->>'code'<>'actor_unauthorized' OR public.load_authoritative_financial_report(
    v_salon,v_other_owner,'2026-08-01','2026-09-01',NULL
  )->>'code'<>'actor_unauthorized' THEN
    RAISE EXCEPTION 'actor/tenant boundary failed';
  END IF;

  INSERT INTO public.bookings(
    salon_id,service_id,client_name,start_time_utc,end_time_utc,status
  )
  SELECT v_salon,v_service,'Bounded report row',
    '2026-08-12 12:00Z'::timestamptz+(g.n||' seconds')::interval,
    '2026-08-12 12:30Z'::timestamptz+(g.n||' seconds')::interval,
    'completed'
  FROM generate_series(1,701) g(n);
  v_report:=public.load_authoritative_financial_report(
    v_salon,v_owner,'2026-08-01','2026-09-01','2026-08-20 12:00Z'
  );
  IF v_report->>'code'<>'report_too_large'
     OR v_report->>'max_records'<>'700'
     OR v_report ? 'booking_rows' OR v_report ? 'operation_events' THEN
    RAISE EXCEPTION 'financial report did not fail early at 700 records: %',v_report;
  END IF;

  v_spring:=public.load_authoritative_financial_report(
    v_salon,v_owner,'2026-03-08','2026-03-09','2026-08-20Z'
  );
  v_fall:=public.load_authoritative_financial_report(
    v_salon,v_owner,'2025-11-02','2025-11-03','2026-08-20Z'
  );
  IF extract(epoch FROM ((v_spring#>>'{range,utc_to_exclusive}')::timestamptz-
      (v_spring#>>'{range,utc_from}')::timestamptz))/3600<>23
     OR extract(epoch FROM ((v_fall#>>'{range,utc_to_exclusive}')::timestamptz-
      (v_fall#>>'{range,utc_from}')::timestamptz))/3600<>25 THEN
    RAISE EXCEPTION 'DST half-open range conversion failed';
  END IF;

END;
$rehearsal$;

DO $acl$
BEGIN
  IF pg_catalog.has_function_privilege(
       'anon','public.load_authoritative_financial_report(uuid,uuid,date,date,timestamptz)','EXECUTE')
     OR pg_catalog.has_function_privilege(
       'authenticated','public.load_authoritative_financial_report(uuid,uuid,date,date,timestamptz)','EXECUTE')
     OR NOT pg_catalog.has_function_privilege(
       'service_role','public.load_authoritative_financial_report(uuid,uuid,date,date,timestamptz)','EXECUTE') THEN
    RAISE EXCEPTION 'financial report RPC ACL mismatch';
  END IF;
  IF to_regclass('public.booking_financial_metric_evidence') IS NULL
     OR to_regclass('public.salon_financial_metric_policies') IS NULL
     OR pg_catalog.has_table_privilege(
       'authenticated','public.booking_financial_metric_evidence','SELECT'
     ) OR pg_catalog.has_table_privilege(
       'service_role','public.booking_financial_metric_evidence','INSERT,UPDATE,DELETE'
     ) THEN
    RAISE EXCEPTION 'approved tip/commission evidence ACL mismatch';
  END IF;
END;
$acl$;

ROLLBACK;
