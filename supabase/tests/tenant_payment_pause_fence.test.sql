\set ON_ERROR_STOP on
BEGIN;
-- Disposable folded-schema bootstrap omits Supabase auth helper role grants.
-- Fixture-only grants are rolled back; no production migration changes ACLs.
GRANT USAGE ON SCHEMA auth TO service_role;
GRANT EXECUTE ON FUNCTION auth.role(), auth.uid() TO service_role;
CREATE FUNCTION pg_temp.assert_true(p_value boolean, p_message text) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN IF p_value IS DISTINCT FROM true THEN RAISE EXCEPTION 'assertion: %',p_message; END IF; END $$;
GRANT EXECUTE ON FUNCTION pg_temp.assert_true(boolean,text) TO service_role;
INSERT INTO public.salons (id,slug,name,phone,subscription_status,payment_grace_ends_at,
  sms_outbound_enabled,email_outbound_enabled,reminders_enabled,voice_ai_enabled,
  voice_ai_upsell_enabled,winback_enabled,phone_otp_enabled,email_links_enabled)
VALUES ('4c111111-1111-4111-8111-111111111111','e2e-r11-pause-sql','E2E R11 Pause SQL','+16045550111','past_due','2026-01-01Z',
  true,false,true,false,true,false,true,false),
 ('4c222222-2222-4222-8222-222222222222','e2e-r11-pause-neighbor','E2E R11 Neighbor','+16045550112','active',NULL,
  false,false,false,false,false,false,false,false);

SELECT pg_temp.assert_true(NOT has_function_privilege('anon','public.pause_tenant_if_payment_grace_expired(uuid,timestamptz)','EXECUTE'),'anon denied');
SELECT pg_temp.assert_true(NOT has_function_privilege('authenticated','public.pause_tenant_if_payment_grace_expired(uuid,timestamptz)','EXECUTE'),'authenticated denied');
SELECT pg_temp.assert_true(has_function_privilege('service_role','public.pause_tenant_if_payment_grace_expired(uuid,timestamptz)','EXECUTE'),'service execute');
SELECT pg_temp.assert_true((SELECT NOT prosecdef AND proconfig @> ARRAY['search_path=""'] FROM pg_proc WHERE oid='public.pause_tenant_if_payment_grace_expired(uuid,timestamptz)'::regprocedure),'invoker empty search path');

SET LOCAL ROLE anon;
DO $$ DECLARE denied boolean:=false; BEGIN
 BEGIN PERFORM public.pause_tenant_if_payment_grace_expired('4c111111-1111-4111-8111-111111111111','2026-01-01Z');
 EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'anon execution was not rejected'; END IF;
END $$;
RESET ROLE;
SET LOCAL ROLE authenticated;
DO $$ DECLARE denied boolean:=false; BEGIN
 BEGIN PERFORM public.pause_tenant_if_payment_grace_expired('4c111111-1111-4111-8111-111111111111','2026-01-01Z');
 EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'authenticated execution was not rejected'; END IF;
END $$;
RESET ROLE;
SET LOCAL ROLE service_role;
DO $$ DECLARE r jsonb; BEGIN
 r:=public.pause_tenant_if_payment_grace_expired(NULL,'2026-01-01Z');
 PERFORM pg_temp.assert_true(r->>'code'='invalid_input','null id');
 r:=public.pause_tenant_if_payment_grace_expired('4c111111-1111-4111-8111-111111111111',NULL);
 PERFORM pg_temp.assert_true(r->>'code'='invalid_input','null deadline');
 r:=public.pause_tenant_if_payment_grace_expired('4c111111-1111-4111-8111-111111111111','infinity');
 PERFORM pg_temp.assert_true(r->>'code'='invalid_input','infinite deadline');
 r:=public.pause_tenant_if_payment_grace_expired('4c999999-9999-4999-8999-999999999999','2026-01-01Z');
 PERFORM pg_temp.assert_true(r->>'code'='skipped_not_eligible','missing salon');
 r:=public.pause_tenant_if_payment_grace_expired('4c111111-1111-4111-8111-111111111111','2026-01-02Z');
 PERFORM pg_temp.assert_true(r->>'code'='skipped_not_eligible','stale deadline');
END $$;

UPDATE public.salons SET subscription_status='active' WHERE id='4c111111-1111-4111-8111-111111111111';
SELECT pg_temp.assert_true(public.pause_tenant_if_payment_grace_expired('4c111111-1111-4111-8111-111111111111','2026-01-01Z')->>'code'='skipped_not_eligible','paid');
UPDATE public.salons SET subscription_status='trialing' WHERE id='4c111111-1111-4111-8111-111111111111';
SELECT pg_temp.assert_true(public.pause_tenant_if_payment_grace_expired('4c111111-1111-4111-8111-111111111111','2026-01-01Z')->>'code'='skipped_not_eligible','trial');
UPDATE public.salons SET subscription_status='past_due',payment_grace_ends_at='2099-01-01Z' WHERE id='4c111111-1111-4111-8111-111111111111';
SELECT pg_temp.assert_true(public.pause_tenant_if_payment_grace_expired('4c111111-1111-4111-8111-111111111111','2099-01-01Z')->>'code'='skipped_not_eligible','future grace');
UPDATE public.salons SET payment_grace_ends_at=NULL WHERE id='4c111111-1111-4111-8111-111111111111';
SELECT pg_temp.assert_true(public.pause_tenant_if_payment_grace_expired('4c111111-1111-4111-8111-111111111111','2026-01-01Z')->>'code'='skipped_not_eligible','cleared grace');
UPDATE public.salons SET payment_grace_ends_at='2026-01-01Z',archived_at=now(),tenant_pause_reason='manual',tenant_pause_snapshot='{"sms_outbound_enabled":false}' WHERE id='4c111111-1111-4111-8111-111111111111';
SELECT pg_temp.assert_true(public.pause_tenant_if_payment_grace_expired('4c111111-1111-4111-8111-111111111111','2026-01-01Z')->>'code'='skipped_not_eligible','manual pause not overwritten');
SELECT pg_temp.assert_true((SELECT tenant_pause_reason='manual' AND tenant_pause_snapshot='{"sms_outbound_enabled":false}'::jsonb FROM public.salons WHERE id='4c111111-1111-4111-8111-111111111111'),'manual snapshot preserved');
UPDATE public.salons SET archived_at=NULL,tenant_pause_reason=NULL,tenant_pause_snapshot=NULL WHERE id='4c111111-1111-4111-8111-111111111111';

RESET ROLE;
-- Simulate audit insert failing after the update. The RPC must roll it all back.
CREATE FUNCTION pg_temp.reject_pause_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.target_id='4c111111-1111-4111-8111-111111111111' THEN RAISE EXCEPTION 'synthetic audit unavailable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER r11_reject_pause_audit BEFORE INSERT ON public.superadmin_audit_logs FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_pause_audit();
SET LOCAL ROLE service_role;
DO $$ DECLARE caught boolean:=false; BEGIN
 BEGIN PERFORM public.pause_tenant_if_payment_grace_expired('4c111111-1111-4111-8111-111111111111','2026-01-01Z');
 EXCEPTION WHEN raise_exception THEN caught:=SQLERRM='synthetic audit unavailable'; END;
 PERFORM pg_temp.assert_true(caught,'audit insert error surfaced');
 PERFORM pg_temp.assert_true((SELECT archived_at IS NULL AND sms_outbound_enabled AND phone_otp_enabled AND payment_grace_ends_at='2026-01-01Z'::timestamptz FROM public.salons WHERE id='4c111111-1111-4111-8111-111111111111'),'audit failure rolls back pause');
 PERFORM pg_temp.assert_true((SELECT count(*)=0 FROM public.superadmin_audit_logs WHERE target_id='4c111111-1111-4111-8111-111111111111'),'no false audit');
END $$;
RESET ROLE;
DROP TRIGGER r11_reject_pause_audit ON public.superadmin_audit_logs;
SET LOCAL ROLE service_role;
DO $$ DECLARE r jsonb; original jsonb; BEGIN
 r:=public.pause_tenant_if_payment_grace_expired('4c111111-1111-4111-8111-111111111111','2026-01-01Z');
 PERFORM pg_temp.assert_true(r->>'code'='paused' AND (r->>'audit_id')::uuid IS NOT NULL AND r->>'salon_id'='4c111111-1111-4111-8111-111111111111','valid receipt');
 PERFORM pg_temp.assert_true((SELECT archived_at IS NOT NULL AND tenant_pause_reason='non_payment' AND payment_grace_ends_at IS NULL AND NOT sms_outbound_enabled AND NOT email_outbound_enabled AND NOT reminders_enabled AND NOT voice_ai_enabled AND NOT voice_ai_upsell_enabled AND NOT winback_enabled AND NOT phone_otp_enabled AND NOT email_links_enabled FROM public.salons WHERE id='4c111111-1111-4111-8111-111111111111'),'all intended fields paused');
 SELECT tenant_pause_snapshot INTO original FROM public.salons WHERE id='4c111111-1111-4111-8111-111111111111';
 PERFORM pg_temp.assert_true(original='{"sms_outbound_enabled":true,"email_outbound_enabled":false,"reminders_enabled":true,"voice_ai_enabled":false,"voice_ai_upsell_enabled":true,"winback_enabled":false,"phone_otp_enabled":true,"email_links_enabled":false}'::jsonb,'exact original flags snapshot');
 PERFORM pg_temp.assert_true((SELECT count(*)=1 FROM public.superadmin_audit_logs WHERE id=(r->>'audit_id')::uuid AND target_id='4c111111-1111-4111-8111-111111111111' AND actor_user_id IS NULL AND actor_role='system' AND before_jsonb->>'subscription_status'='past_due' AND after_jsonb->>'source'='tenant_payment_pause_atomic'),'durable audit binding');
 r:=public.pause_tenant_if_payment_grace_expired('4c111111-1111-4111-8111-111111111111','2026-01-01Z');
 PERFORM pg_temp.assert_true(r->>'code'='skipped_not_eligible','exact retry is safe');
 PERFORM pg_temp.assert_true((SELECT tenant_pause_snapshot=original FROM public.salons WHERE id='4c111111-1111-4111-8111-111111111111'),'retry preserves original snapshot');
 PERFORM pg_temp.assert_true((SELECT count(*)=1 FROM public.superadmin_audit_logs WHERE target_id='4c111111-1111-4111-8111-111111111111'),'single audit across retry');
 PERFORM pg_temp.assert_true((SELECT archived_at IS NULL AND subscription_status='active' FROM public.salons WHERE id='4c222222-2222-4222-8222-222222222222'),'neighbor unchanged');
END $$;
RESET ROLE;
SELECT 'PASS tenant_payment_pause_fence';
ROLLBACK;
