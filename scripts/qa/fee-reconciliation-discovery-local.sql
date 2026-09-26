-- Run only against a NEW empty disposable local PostgreSQL database named
-- nailiq_fee_discovery_qa_<digits>. This reduced schema isolates discovery,
-- ACL and retry-budget behavior; it does not certify full payment triggers.
\set ON_ERROR_STOP on
DO $$ BEGIN
 IF current_database() !~ '^nailiq_fee_discovery_qa_[0-9_]+$' THEN RAISE EXCEPTION 'disposable database required'; END IF;
END $$;
CREATE TABLE public.salons (id uuid PRIMARY KEY, feature_flags jsonb NOT NULL DEFAULT '{}');
CREATE TABLE public.booking_payment_operations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), salon_id uuid NOT NULL REFERENCES public.salons,
 booking_id uuid, request_id uuid DEFAULT gen_random_uuid(), operation_kind text NOT NULL,
 provider text NOT NULL DEFAULT 'square', delivery_mode text,
 status text NOT NULL DEFAULT 'unknown', attempt_count integer NOT NULL DEFAULT 1,
 lease_expires_at timestamptz, next_reconcile_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()-interval '1 hour',
 created_at timestamptz NOT NULL DEFAULT now()-interval '1 hour', failure_disposition text, error_code text,
 booking_intent_idempotency_key uuid, attempt_token uuid, provider_payment_id text, provider_refund_id text,
 provider_order_id text, provider_link_id text, provider_link_url text, provider_idempotency_key text,
 material_fingerprint text, material_json jsonb NOT NULL DEFAULT '{}', provider_material jsonb NOT NULL DEFAULT '{}'
);
INSERT INTO salons VALUES
 ('11111111-1111-4111-8111-111111111111','{"approved_cancellation_fee_dispatch":true,"approved_no_show_charge_dispatch":true}'),
 ('22222222-2222-4222-8222-222222222222','{}'),
 ('33333333-3333-4333-8333-333333333333','{"approved_cancellation_fee_dispatch":"true"}');
INSERT INTO booking_payment_operations(id,salon_id,operation_kind) VALUES
 ('aaaaaaaa-1111-4111-8111-111111111111','11111111-1111-4111-8111-111111111111','late_cancel_charge'),
 ('aaaaaaaa-2222-4222-8222-222222222222','22222222-2222-4222-8222-222222222222','late_cancel_charge'),
 ('aaaaaaaa-3333-4333-8333-333333333333','33333333-3333-4333-8333-333333333333','late_cancel_charge'),
 ('aaaaaaaa-4444-4444-8444-444444444444','11111111-1111-4111-8111-111111111111','noshow_charge'),
 ('aaaaaaaa-5555-4555-8555-555555555555','11111111-1111-4111-8111-111111111111','late_cancel_refund');

\ir ../../supabase/migrations/20260925202830_gate_payment_reconciliation_discovery.sql
\set ON_ERROR_STOP on
CREATE FUNCTION pg_temp.assert_true(ok boolean, message text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL %', message; END IF; END $$;
SELECT pg_temp.assert_true(NOT has_function_privilege('anon','public.discover_due_enabled_booking_payment_reconciliations(text[],integer)','EXECUTE'),'anon denied');
SELECT pg_temp.assert_true(NOT has_function_privilege('authenticated','public.discover_due_enabled_booking_payment_reconciliations(text[],integer)','EXECUTE'),'authenticated denied');
SELECT pg_temp.assert_true(has_function_privilege('service_role','public.discover_due_enabled_booking_payment_reconciliations(text[],integer)','EXECUTE'),'service allowed');
DO $$ BEGIN
 FOR i IN 1..5 LOOP
  PERFORM public.discover_due_enabled_booking_payment_reconciliations(ARRAY['deposit_charge','deposit_refund'],25);
 END LOOP;
END $$;
SELECT pg_temp.assert_true((SELECT bool_and(attempt_count=1 AND status='unknown') FROM booking_payment_operations),'disabled attempts/status preserved after five runs');
SELECT pg_temp.assert_true((SELECT count(*)=0 FROM discover_due_enabled_booking_payment_reconciliations('{}'::text[],25)),'empty scope no claims');
SELECT pg_temp.assert_true((SELECT count(*)=1 FROM discover_due_enabled_booking_payment_reconciliations(ARRAY['late_cancel_charge'],25)),'only enabled tenant claimed');
SELECT pg_temp.assert_true((SELECT attempt_count=2 AND status='reconciling' FROM booking_payment_operations WHERE id='aaaaaaaa-1111-4111-8111-111111111111'),'enabled claim counted once');
SELECT pg_temp.assert_true((SELECT bool_and(attempt_count=1 AND status='unknown') FROM booking_payment_operations WHERE id<>'aaaaaaaa-1111-4111-8111-111111111111'),'tenant-disabled string-true other-kind refund untouched');
SELECT pg_temp.assert_true((SELECT count(*)=0 FROM discover_due_enabled_booking_payment_reconciliations(ARRAY['late_cancel_charge'],25)),'active lease not duplicated');
DO $$ DECLARE denied boolean:=false; BEGIN
 BEGIN PERFORM discover_due_enabled_booking_payment_reconciliations(ARRAY['bad'],25); EXCEPTION WHEN invalid_parameter_value THEN denied:=true; END;
 PERFORM pg_temp.assert_true(denied,'invalid kind denied');
 denied:=false;
 BEGIN PERFORM discover_due_enabled_booking_payment_reconciliations(ARRAY['late_cancel_charge',NULL],25); EXCEPTION WHEN invalid_parameter_value THEN denied:=true; END;
 PERFORM pg_temp.assert_true(denied,'null array member denied');
END $$;
SELECT 'PASS 11 discovery/ACL/attempt checks';
