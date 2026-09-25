"""Disposable local SQL regression; no provider, hosted DB, or notifications.

Creates one NEW reduced-schema database in the named local Docker context.
Leaves that isolated database for inspection, never drops or edits a baseline.
Includes an actual overlapping two-session SKIP LOCKED claim.
"""
import datetime
import json
import pathlib
import subprocess
import time

ROOT = pathlib.Path(__file__).resolve().parents[2]
CONTEXT = "colima-nailiq-p0-503"
CONTAINER = "supabase_db_nailiq-day5-20260924"
DATABASE = "nailiq_fee_preflight_qa_" + datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d_%H%M%S_%f")
DOCKER = ["docker", "--context", CONTEXT]
PSQL = DOCKER + ["exec", "-i", CONTAINER, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", DATABASE]


def sql(statement):
    result = subprocess.run(PSQL, input=statement, text=True, capture_output=True, timeout=30)
    if result.returncode:
        raise RuntimeError("local_sql_failed: " + result.stderr[-2500:])
    return result.stdout.strip()


endpoint = subprocess.run(DOCKER + ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], capture_output=True, text=True, check=True).stdout.strip()
if not endpoint.startswith("unix://") or "/.colima/nailiq-p0-503/docker.sock" not in endpoint:
    raise RuntimeError("local_docker_socket_required")
subprocess.run(DOCKER + ["exec", CONTAINER, "createdb", "-U", "postgres", DATABASE], check=True, capture_output=True, text=True)
setup = """
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
 ('aaaaaaaa-0001-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','late_cancel_charge'),
 ('aaaaaaaa-0002-4000-8000-000000000002','22222222-2222-4222-8222-222222222222','late_cancel_charge'),
 ('aaaaaaaa-0003-4000-8000-000000000003','33333333-3333-4333-8333-333333333333','late_cancel_charge'),
 ('aaaaaaaa-0004-4000-8000-000000000004','11111111-1111-4111-8111-111111111111','noshow_charge'),
 ('aaaaaaaa-0005-4000-8000-000000000005','11111111-1111-4111-8111-111111111111','late_cancel_refund'),
 ('aaaaaaaa-0006-4000-8000-000000000006','11111111-1111-4111-8111-111111111111','late_cancel_charge'),
 ('aaaaaaaa-0007-4000-8000-000000000007','11111111-1111-4111-8111-111111111111','late_cancel_charge'),
 ('aaaaaaaa-0008-4000-8000-000000000008','11111111-1111-4111-8111-111111111111','late_cancel_charge'),
 ('aaaaaaaa-0009-4000-8000-000000000009','11111111-1111-4111-8111-111111111111','late_cancel_charge'),
 ('aaaaaaaa-0010-4000-8000-000000000010','11111111-1111-4111-8111-111111111111','late_cancel_charge');
UPDATE booking_payment_operations SET status='reconciling',lease_expires_at=now()+interval '1 hour' WHERE id='aaaaaaaa-0006-4000-8000-000000000006';
UPDATE booking_payment_operations SET attempt_count=3 WHERE id='aaaaaaaa-0007-4000-8000-000000000007';
UPDATE booking_payment_operations SET next_reconcile_at=now()+interval '1 hour' WHERE id='aaaaaaaa-0008-4000-8000-000000000008';
UPDATE booking_payment_operations SET delivery_mode='public_customer_present' WHERE id='aaaaaaaa-0009-4000-8000-000000000009';
UPDATE booking_payment_operations SET lease_expires_at=now()+interval '1 hour' WHERE id='aaaaaaaa-0010-4000-8000-000000000010';
CREATE FUNCTION public.qa_assert(ok boolean, message text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL %',message; END IF; END $$;
"""
sql(setup)
sql((ROOT / "supabase/migrations/20260925202830_gate_payment_reconciliation_discovery.sql").read_text())
legacy_before = sql("SELECT md5(pg_get_functiondef('public.discover_due_enabled_booking_payment_reconciliations(text[],integer)'::regprocedure));")
sql((ROOT / "supabase/migrations/20260925220858_preflight_fee_reconciliation_before_claim.sql").read_text())
legacy_after = sql("SELECT md5(pg_get_functiondef('public.discover_due_enabled_booking_payment_reconciliations(text[],integer)'::regprocedure));")
if legacy_before != legacy_after:
    raise RuntimeError("legacy_rpc_changed")
checks = """
SELECT public.qa_assert(NOT has_function_privilege('anon','public.discover_due_ready_fee_payment_reconciliations(uuid[],text[],integer)','EXECUTE'),'anon denied');
SELECT public.qa_assert(NOT has_function_privilege('authenticated','public.discover_due_ready_fee_payment_reconciliations(uuid[],text[],integer)','EXECUTE'),'authenticated denied');
SELECT public.qa_assert(has_function_privilege('service_role','public.discover_due_ready_fee_payment_reconciliations(uuid[],text[],integer)','EXECUTE'),'service allowed');
DO $$ DECLARE before_state jsonb; after_state jsonb; ids uuid[]; denied boolean; result jsonb; BEGIN
 SELECT jsonb_agg(to_jsonb(o) ORDER BY o.id),array_agg(o.id) INTO before_state,ids FROM public.booking_payment_operations o;
 FOR i IN 1..5 LOOP
  PERFORM discover_due_ready_fee_payment_reconciliations(NULL,ARRAY['noshow_charge','late_cancel_charge'],25);
  PERFORM discover_due_ready_fee_payment_reconciliations('{}'::uuid[],ARRAY['noshow_charge','late_cancel_charge'],25);
  PERFORM discover_due_ready_fee_payment_reconciliations(ids,NULL,25);
  PERFORM discover_due_ready_fee_payment_reconciliations(ids,'{}'::text[],25);
 END LOOP;
 SELECT jsonb_agg(to_jsonb(o) ORDER BY o.id) INTO after_state FROM public.booking_payment_operations o;
 PERFORM public.qa_assert(before_state=after_state,'preflight failure null/empty readiness preserves every operation field after repeated runs');
 PERFORM public.qa_assert((SELECT count(*)=0 FROM discover_due_ready_fee_payment_reconciliations(ARRAY['bbbbbbbb-0000-4000-8000-000000000000']::uuid[],ARRAY['late_cancel_charge'],25)),'nonexistent ready IDs do not broaden discovery');
 PERFORM public.qa_assert((SELECT count(*)=0 FROM discover_due_ready_fee_payment_reconciliations(ARRAY['aaaaaaaa-0004-4000-8000-000000000004']::uuid[],ARRAY['late_cancel_charge'],25)),'ready wrong enabled kind remains untouched');
 denied:=false; BEGIN PERFORM discover_due_ready_fee_payment_reconciliations(ids,ARRAY['deposit_charge'],25); EXCEPTION WHEN invalid_parameter_value THEN denied:=true; END;
 PERFORM public.qa_assert(denied,'nonfee kinds rejected');
 denied:=false; BEGIN PERFORM discover_due_ready_fee_payment_reconciliations(ARRAY[NULL]::uuid[],ARRAY['late_cancel_charge'],25); EXCEPTION WHEN invalid_parameter_value THEN denied:=true; END;
 PERFORM public.qa_assert(denied,'null ID member rejected');
 denied:=false; BEGIN PERFORM discover_due_ready_fee_payment_reconciliations(ids,ARRAY['late_cancel_charge',NULL],25); EXCEPTION WHEN invalid_parameter_value THEN denied:=true; END;
 PERFORM public.qa_assert(denied,'null kind member rejected');
 denied:=false; BEGIN PERFORM discover_due_ready_fee_payment_reconciliations(array_fill(gen_random_uuid(),ARRAY[101]),ARRAY['late_cancel_charge'],25); EXCEPTION WHEN invalid_parameter_value THEN denied:=true; END;
 PERFORM public.qa_assert(denied,'oversized ready set rejected');
 denied:=false; BEGIN PERFORM discover_due_ready_fee_payment_reconciliations(ids,ARRAY['late_cancel_charge'],0); EXCEPTION WHEN invalid_parameter_value THEN denied:=true; END;
 PERFORM public.qa_assert(denied,'invalid limit rejected');
 SELECT value INTO result FROM discover_due_ready_fee_payment_reconciliations(ids,ARRAY['late_cancel_charge'],25) value;
 PERFORM public.qa_assert(result->>'operation_id'='aaaaaaaa-0001-4000-8000-000000000001' AND result->>'attempt_count'='2' AND result->>'code'='reconcile_claimed','only exact ready enabled due fee claimed once');
 SELECT jsonb_agg(to_jsonb(o) ORDER BY o.id) INTO after_state FROM public.booking_payment_operations o WHERE id<>'aaaaaaaa-0001-4000-8000-000000000001';
 PERFORM public.qa_assert(after_state=(SELECT jsonb_agg(row ORDER BY row->>'id') FROM jsonb_array_elements(before_state) row WHERE row->>'id'<>'aaaaaaaa-0001-4000-8000-000000000001'),'disabled/stringflag/wrongkind/refund/activelease/exhausted/future/public untouched');
 PERFORM public.qa_assert((SELECT count(*)=0 FROM discover_due_ready_fee_payment_reconciliations(ids,ARRAY['late_cancel_charge'],25)),'active claimed lease cannot be claimed again');
 -- Tenant configuration may change after the service worker preflight.
 UPDATE public.salons SET feature_flags='{}' WHERE id='11111111-1111-4111-8111-111111111111';
 PERFORM public.qa_assert((SELECT count(*)=0 FROM discover_due_ready_fee_payment_reconciliations(ARRAY['aaaaaaaa-0004-4000-8000-000000000004']::uuid[],ARRAY['noshow_charge'],25)),'tenant gate rechecked at claim time');
 UPDATE public.salons SET feature_flags='{"approved_no_show_charge_dispatch":true}' WHERE id='11111111-1111-4111-8111-111111111111';
END $$;
"""
sql(checks)

# Worker A holds the row lock after claiming. Worker B overlaps and must return
# zero instead of spending another attempt or waiting for A's lease to commit.
claim = "SELECT count(*) FROM public.discover_due_ready_fee_payment_reconciliations(ARRAY['aaaaaaaa-0004-4000-8000-000000000004']::uuid[],ARRAY['noshow_charge'],25);"
worker_a = subprocess.Popen(PSQL, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
worker_a.stdin.write("BEGIN;\n" + claim + "\nSELECT pg_sleep(2);\nCOMMIT;\n")
worker_a.stdin.flush()
line = worker_a.stdout.readline().strip()
if line != "1":
    raise RuntimeError("first_worker_claim_missing")
start = time.monotonic()
worker_b = sql(claim)
elapsed = time.monotonic() - start
worker_a.stdin.close()
worker_a.stdin = None
out, err = worker_a.communicate(timeout=10)
if worker_a.returncode or worker_b != "0" or elapsed >= 1.5:
    raise RuntimeError("skip_locked_concurrency_failed: " + err[-500:])
sql("SELECT public.qa_assert((SELECT attempt_count=2 AND status='reconciling' FROM booking_payment_operations WHERE id='aaaaaaaa-0004-4000-8000-000000000004'),'two workers consumed one attempt');")
print(json.dumps({"status":"PASS_LOCAL_REDUCED_SCHEMA", "database":DATABASE, "legacyRpcUnchanged":True, "sqlAssertions":16, "repeatedEmptyReadinessCalls":20, "concurrentWorkers":2, "claims":1, "attemptIncrements":1, "providerCalls":0, "hostedCalls":0, "scope":"reduced schema only; full-schema lifecycle tested separately"}))
