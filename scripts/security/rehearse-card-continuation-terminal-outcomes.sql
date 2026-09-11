\set ON_ERROR_STOP on

-- Disposable local/CI database only. Every synthetic row is rolled back.
BEGIN;
SET LOCAL request.jwt.claim.role = 'service_role';
DO $guard$ BEGIN
  IF EXISTS (SELECT 1 FROM public.salons) THEN
    RAISE EXCEPTION 'card continuation rehearsal requires an empty disposable database';
  END IF;
END $guard$;

CREATE TEMP TABLE qa_card_cases (
  n integer PRIMARY KEY, scenario text, booking_status text, required boolean,
  saved boolean, deleted boolean, save_resolution text,
  initial_status text, initial_reason text, attempts integer,
  expected_status text, expected_reason text
) ON COMMIT DROP;
INSERT INTO qa_card_cases VALUES
  (1,'cancelled with unresolved card','cancelled',true,false,false,'manual_review_required','pending','card_required',0,'resolved','booking_inactive'),
  (2,'completed before assessment','completed',false,false,false,NULL,'armed','assessment_scheduled',0,'resolved','booking_inactive'),
  (3,'no-show with card requirement','no_show',true,false,false,NULL,'pending','card_required',0,'resolved','booking_inactive'),
  (4,'active card requires manual review','confirmed',true,false,false,'manual_review_required','pending','card_required',0,'manual_review','reconciliation_exhausted'),
  (5,'active card still retryable','confirmed',true,false,false,'provider_card_not_found','pending','card_required',0,'provider_reconciliation','provider_operation_pending'),
  (6,'active card already saved','confirmed',true,true,false,NULL,'pending','card_required',0,'resolved','card_saved'),
  (7,'active customer still needs card','confirmed',true,false,false,NULL,'pending','card_required',0,'awaiting_customer','card_required'),
  (8,'active assessment never completed','confirmed',false,false,false,NULL,'armed','assessment_scheduled',0,'manual_review','assessment_missing'),
  (9,'soft-deleted booking','confirmed',true,false,true,NULL,'pending','card_required',0,'resolved','booking_inactive'),
  (10,'future continuation is untouched','confirmed',true,false,false,NULL,'pending','card_required',0,'pending','card_required'),
  (11,'active assessment retries exhausted','confirmed',false,false,false,NULL,'pending','assessment_unavailable',2,'manual_review','reconciliation_exhausted'),
  (12,'completed with unresolved card','completed',true,false,false,'manual_review_required','pending','card_required',0,'resolved','booking_inactive');

INSERT INTO public.service_categories(slug,name_en,name_vi)
VALUES ('e2e-card-terminal','E2E card terminal','E2E card terminal');
INSERT INTO public.salons(id,slug,name,phone,timezone,currency_code)
VALUES ('c9000000-0000-4000-8000-000000000001','e2e-card-terminal','E2E Card terminal','+16045550100','UTC','CAD');
INSERT INTO public.services(id,salon_id,name,price_cents,duration_minutes,category)
VALUES ('c9000000-0000-4000-8000-000000000002','c9000000-0000-4000-8000-000000000001','E2E Service',3000,30,'e2e-card-terminal');
INSERT INTO public.staff(id,salon_id,name,status)
VALUES ('c9000000-0000-4000-8000-000000000003','c9000000-0000-4000-8000-000000000001','E2E Staff','active');

DO $fixtures$
DECLARE
  c record;
  booking_id uuid;
  request_id uuid;
  capability_id uuid;
  claim jsonb;
  receipt jsonb;
  op_id uuid;
  attempt_id uuid;
  salon_id constant uuid := 'c9000000-0000-4000-8000-000000000001';
BEGIN
  FOR c IN SELECT * FROM qa_card_cases ORDER BY n LOOP
    booking_id := ('c9100000-0000-4000-8000-' || lpad(c.n::text,12,'0'))::uuid;
    request_id := ('c9200000-0000-4000-8000-' || lpad(c.n::text,12,'0'))::uuid;
    INSERT INTO public.bookings(id,salon_id,service_id,staff_id,client_name,client_phone,
      start_time_utc,end_time_utc,status,price_cents,noshow_card_required,noshow_fee_cents)
    VALUES (booking_id,salon_id,'c9000000-0000-4000-8000-000000000002',
      'c9000000-0000-4000-8000-000000000003','E2E Guest','16045550101',
      transaction_timestamp()+c.n*interval '1 day',transaction_timestamp()+c.n*interval '1 day'+interval '30 minutes',
      'confirmed',3000,c.required,1000);

    IF c.save_resolution IS NOT NULL THEN
      capability_id := (public.mint_booking_management_capability(
        salon_id,booking_id,'card_manage',transaction_timestamp()+interval '10 minutes')->>'token_id')::uuid;
      claim := public.claim_booking_card_save_operation(capability_id,request_id,'square','save_card',repeat('a',64));
      IF claim->>'code' IS DISTINCT FROM 'claimed' THEN
        RAISE EXCEPTION 'fixture claim failed: %',claim;
      END IF;
      op_id := (claim->>'operation_id')::uuid;
      attempt_id := (claim->>'attempt_token')::uuid;
      receipt := public.prepare_booking_card_save_dispatch(op_id,attempt_id,transaction_timestamp(),jsonb_build_object('policyVersion','nsp_'||repeat('a',64),'scope','booking_member','policyEn','QA policy','policyVi','QA policy'));
      IF receipt->>'ok' IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'fixture dispatch preparation failed: %',receipt;
      END IF;
      receipt := public.complete_booking_card_save_operation(op_id,attempt_id,'unknown',NULL,NULL,NULL,NULL,NULL,NULL,NULL,'provider_exception');
      IF receipt->>'code' IS NULL THEN RAISE EXCEPTION 'fixture completion missing'; END IF;
      UPDATE public.booking_card_save_operations o
      SET resolution_code=c.save_resolution,
          reconciliation_attempt_count=CASE WHEN c.save_resolution='manual_review_required' THEN 3 ELSE 1 END,
          next_reconcile_at=CASE WHEN c.save_resolution='manual_review_required' THEN NULL ELSE transaction_timestamp()+interval '2 minutes' END
      WHERE o.id=op_id;
    END IF;

    -- Fixture setup only; the worker below must never alter these booking states.
    UPDATE public.bookings b SET status=c.booking_status,
      deleted_at=CASE WHEN c.deleted THEN transaction_timestamp() ELSE NULL END,
      noshow_card_id=NULL
    WHERE b.id=booking_id;
    IF c.saved THEN
      receipt := public.record_booking_existing_square_card(booking_id,salon_id,'customer_qa','ccof:e2e-saved','merchant_qa','sandbox','VISA','4242',
        jsonb_build_object('policyVersion','nsp_'||repeat('a',64),'scope','booking_member','policyEn','QA policy','policyVi','QA policy',
          'source','explicit_reuse','receiptSource','existing_card_read','feeCents',1000));
      IF receipt->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'saved fixture receipt missing: %',receipt; END IF;
    END IF;
    INSERT INTO public.booking_card_management_continuations(
      salon_id,booking_id,create_idempotency_key,pricing_fingerprint,scope,
      stage,status,reason_code,attempt_count,next_reconcile_at)
    VALUES (salon_id,booking_id,request_id,repeat('b',64),'individual','assessment',
      c.initial_status,c.initial_reason,c.attempts,
      transaction_timestamp()+CASE WHEN c.n=10 THEN interval '1 day' ELSE interval '-1 minute' END);
  END LOOP;
END $fixtures$;

CREATE TEMP TABLE qa_bookings_before AS SELECT id,to_jsonb(b) AS value FROM public.bookings b;
CREATE TEMP TABLE qa_operations_before AS SELECT id,to_jsonb(o) AS value FROM public.booking_card_save_operations o;
CREATE TEMP TABLE qa_continuations_before AS SELECT id,to_jsonb(c) AS value FROM public.booking_card_management_continuations c;

DO $limits$ BEGIN
  IF (SELECT count(*) FROM public.reconcile_due_booking_card_management_continuations(0)) <> 0
    OR EXISTS (SELECT 1 FROM public.booking_card_management_continuations c JOIN qa_continuations_before b USING(id) WHERE to_jsonb(c)<>b.value) THEN
    RAISE EXCEPTION 'zero limit changed a continuation';
  END IF;
END $limits$;
CREATE TEMP TABLE qa_reconcile_results AS
SELECT result FROM public.reconcile_due_booking_card_management_continuations(25) result;
CREATE TEMP TABLE qa_outcomes AS
SELECT q.scenario,q.expected_status,q.expected_reason,c.status AS actual_status,c.reason_code AS actual_reason,
  (c.status=q.expected_status AND c.reason_code=q.expected_reason
    AND ((c.status IN ('resolved','manual_review') AND c.next_reconcile_at IS NULL AND c.resolved_at IS NOT NULL)
      OR (c.status NOT IN ('resolved','manual_review') AND c.next_reconcile_at>transaction_timestamp() AND c.resolved_at IS NULL))) AS passed
FROM qa_card_cases q JOIN public.booking_card_management_continuations c
ON c.booking_id=('c9100000-0000-4000-8000-' || lpad(q.n::text,12,'0'))::uuid;
TABLE qa_outcomes;

DO $acceptance$ BEGIN
  IF (SELECT count(*) FROM qa_reconcile_results)<>11 THEN RAISE EXCEPTION 'due selection mismatch'; END IF;
  IF EXISTS(SELECT 1 FROM qa_outcomes WHERE passed IS NOT TRUE) THEN
    RAISE EXCEPTION 'continuation outcomes failed: %', (SELECT count(*) FROM qa_outcomes WHERE passed IS NOT TRUE);
  END IF;
  IF EXISTS(SELECT 1 FROM public.bookings b FULL JOIN qa_bookings_before q USING(id) WHERE to_jsonb(b) IS DISTINCT FROM q.value)
    OR EXISTS(SELECT 1 FROM public.booking_card_save_operations o FULL JOIN qa_operations_before q USING(id) WHERE to_jsonb(o) IS DISTINCT FROM q.value) THEN
    RAISE EXCEPTION 'worker changed booking or provider-operation evidence';
  END IF;
  IF (SELECT count(*) FROM public.reconcile_due_booking_card_management_continuations(25))<>0 THEN
    RAISE EXCEPTION 'same-time replay reprocessed terminal or deferred work';
  END IF;
  IF has_function_privilege('anon','public.reconcile_due_booking_card_management_continuations(integer)','EXECUTE')
    OR has_function_privilege('authenticated','public.reconcile_due_booking_card_management_continuations(integer)','EXECUTE')
    OR NOT has_function_privilege('service_role','public.reconcile_due_booking_card_management_continuations(integer)','EXECUTE') THEN
    RAISE EXCEPTION 'worker execution permissions widened';
  END IF;
  RAISE NOTICE 'PASS: 12 outcomes, zero limit, immutable bookings/provider evidence, replay and service-only execution';
END $acceptance$;
ROLLBACK;
