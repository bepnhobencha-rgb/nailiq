\set ON_ERROR_STOP on

BEGIN;

DO $privileges$
BEGIN
  IF has_table_privilege('anon', 'public.ai_upsell_session_claims', 'SELECT')
     OR has_table_privilege('authenticated', 'public.ai_upsell_session_claims', 'SELECT')
     OR has_table_privilege('anon', 'public.ai_upsell_session_claims', 'INSERT')
     OR has_table_privilege('authenticated', 'public.ai_upsell_session_claims', 'INSERT')
     OR has_table_privilege('service_role', 'public.ai_upsell_session_claims', 'UPDATE')
     OR has_table_privilege('service_role', 'public.ai_upsell_session_claims', 'DELETE')
     OR has_table_privilege('service_role', 'public.ai_upsell_session_claims', 'TRUNCATE')
     OR NOT has_table_privilege('service_role', 'public.ai_upsell_session_claims', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.ai_upsell_session_claims', 'INSERT') THEN
    RAISE EXCEPTION 'upsell claim table privileges are broader than append-only service access';
  END IF;
  IF has_function_privilege(
       'anon',
       'public.claim_ai_upsell_offer(uuid,uuid,uuid,text,uuid,uuid,text,numeric)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.claim_ai_upsell_offer(uuid,uuid,uuid,text,uuid,uuid,text,numeric)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role',
       'public.claim_ai_upsell_offer(uuid,uuid,uuid,text,uuid,uuid,text,numeric)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'upsell claim RPC is not service-role-only';
  END IF;
  IF has_table_privilege('authenticated', 'public.ai_upsell_log', 'INSERT')
     OR has_table_privilege('authenticated', 'public.ai_upsell_log', 'UPDATE') THEN
    RAISE EXCEPTION 'legacy upsell shown/outcome mutation remains browser-writable';
  END IF;
END;
$privileges$;

INSERT INTO public.salons(id, slug, name, phone, timezone, is_beta)
VALUES
  ('17500000-0000-4000-8000-000000000001', 'upsell-claim-qa-a',
   'Upsell Claim QA A', '+16045551751', 'UTC', true),
  ('17500000-0000-4000-8000-000000000002', 'upsell-claim-qa-b',
   'Upsell Claim QA B', '+16045551752', 'UTC', true);

INSERT INTO public.service_categories(slug, name_en, name_vi)
VALUES ('upsell-claim-qa', 'Upsell claim QA', 'Upsell claim QA');

INSERT INTO public.services(
  id, salon_id, name, price_cents, duration_minutes, buffer_minutes,
  category, deleted_at, is_addon, addon_timing
)
VALUES
  ('17500000-0000-4000-8000-000000000011',
   '17500000-0000-4000-8000-000000000001',
   'Main service A', 5000, 45, 10, 'upsell-claim-qa', NULL, false, 'sequential'),
  ('17500000-0000-4000-8000-000000000012',
   '17500000-0000-4000-8000-000000000001',
   'Add-on A', 1200, 20, 5, 'upsell-claim-qa', NULL, true, 'sequential'),
  ('17500000-0000-4000-8000-000000000013',
   '17500000-0000-4000-8000-000000000001',
   'Different add-on A', 900, 15, 0, 'upsell-claim-qa', NULL, true, 'concurrent'),
  ('17500000-0000-4000-8000-000000000021',
   '17500000-0000-4000-8000-000000000002',
   'Main service B', 5500, 45, 10, 'upsell-claim-qa', NULL, false, 'sequential'),
  ('17500000-0000-4000-8000-000000000022',
   '17500000-0000-4000-8000-000000000002',
   'Add-on B', 1300, 20, 5, 'upsell-claim-qa', NULL, true, 'sequential');

INSERT INTO public.phone_otp_sessions(id, phone, salon_id, expires_at)
VALUES
  ('17500000-0000-4000-8000-000000000031', '16045551751',
   '17500000-0000-4000-8000-000000000001', now() + interval '15 minutes'),
  ('17500000-0000-4000-8000-000000000032', '16045551751',
   '17500000-0000-4000-8000-000000000001', now() + interval '15 minutes'),
  ('17500000-0000-4000-8000-000000000033', '16045551752',
   '17500000-0000-4000-8000-000000000002', now() + interval '15 minutes');

SET LOCAL ROLE service_role;

DO $behavior$
DECLARE
  v_salon_a uuid := '17500000-0000-4000-8000-000000000001';
  v_salon_b uuid := '17500000-0000-4000-8000-000000000002';
  v_session uuid := '17500000-0000-4000-8000-000000000040';
  v_first record;
  v_replay record;
  v_result record;
BEGIN
  SELECT * INTO v_first FROM public.claim_ai_upsell_offer(
    v_salon_a, v_session,
    '17500000-0000-4000-8000-000000000031', '16045551751',
    '17500000-0000-4000-8000-000000000011',
    '17500000-0000-4000-8000-000000000012',
    'You usually add this (100% of your visits)', 1
  );
  IF v_first.outcome <> 'claimed' OR v_first.replay
     OR v_first.claim_id IS NULL OR v_first.upsell_log_id IS NULL
     OR v_first.offer_payload->>'session_id' <> v_session::text THEN
    RAISE EXCEPTION 'first upsell claim failed: %', row_to_json(v_first);
  END IF;

  SELECT * INTO v_replay FROM public.claim_ai_upsell_offer(
    v_salon_a, v_session,
    '17500000-0000-4000-8000-000000000031', '+1 (604) 555-1751',
    '17500000-0000-4000-8000-000000000011',
    '17500000-0000-4000-8000-000000000012',
    'You usually add this (100% of your visits)', 1
  );
  IF v_replay.outcome <> 'replayed' OR NOT v_replay.replay
     OR v_replay.claim_id <> v_first.claim_id
     OR v_replay.upsell_log_id <> v_first.upsell_log_id
     OR v_replay.offer_payload <> v_first.offer_payload THEN
    RAISE EXCEPTION 'exact replay did not return durable result: %', row_to_json(v_replay);
  END IF;

  IF (SELECT count(*) FROM public.ai_upsell_session_claims
      WHERE salon_id = v_salon_a AND session_id = v_session) <> 1
     OR (SELECT count(*) FROM public.ai_upsell_log
         WHERE salon_id = v_salon_a AND session_id = v_session::text
           AND outcome = 'shown') <> 1 THEN
    RAISE EXCEPTION 'exact replay duplicated claim or shown log';
  END IF;

  UPDATE public.services
     SET price_cents = 9900, deleted_at = now()
   WHERE id = '17500000-0000-4000-8000-000000000012';
  SELECT * INTO v_replay FROM public.claim_ai_upsell_offer(
    v_salon_a, v_session,
    '17500000-0000-4000-8000-000000000031', '16045551751',
    '17500000-0000-4000-8000-000000000011',
    '17500000-0000-4000-8000-000000000012',
    'You usually add this (100% of your visits)', 1
  );
  IF v_replay.outcome <> 'replayed'
     OR v_replay.offer_payload <> v_first.offer_payload
     OR v_replay.offer_payload->>'price_cents' <> '1200'
     OR (SELECT count(*) FROM public.ai_upsell_log
         WHERE salon_id = v_salon_a AND session_id = v_session::text) <> 1 THEN
    RAISE EXCEPTION 'durable replay depended on mutable menu state: %',
      row_to_json(v_replay);
  END IF;
  UPDATE public.services
     SET price_cents = 1200, deleted_at = NULL
   WHERE id = '17500000-0000-4000-8000-000000000012';

  SELECT * INTO v_result FROM public.claim_ai_upsell_offer(
    v_salon_a, v_session,
    '17500000-0000-4000-8000-000000000032', '16045551751',
    '17500000-0000-4000-8000-000000000011',
    '17500000-0000-4000-8000-000000000012',
    'You usually add this (100% of your visits)', 1
  );
  IF v_result.outcome <> 'capability_mismatch'
     OR v_result.claim_id IS NOT NULL OR v_result.offer_payload IS NOT NULL THEN
    RAISE EXCEPTION 'capability mismatch exposed a claim: %', row_to_json(v_result);
  END IF;

  SELECT * INTO v_result FROM public.claim_ai_upsell_offer(
    v_salon_a, v_session,
    '17500000-0000-4000-8000-000000000031', '16045551751',
    '17500000-0000-4000-8000-000000000011',
    '17500000-0000-4000-8000-000000000013',
    'You usually add this (100% of your visits)', 1
  );
  IF v_result.outcome <> 'offer_material_mismatch'
     OR v_result.claim_id IS NOT NULL OR v_result.offer_payload IS NOT NULL THEN
    RAISE EXCEPTION 'offer mismatch exposed a claim: %', row_to_json(v_result);
  END IF;

  -- A browser-generated session UUID is tenant-scoped: salon B can safely use
  -- the same UUID, but cannot read, replay, or deny salon A's claim.
  SELECT * INTO v_result FROM public.claim_ai_upsell_offer(
    v_salon_b, v_session,
    '17500000-0000-4000-8000-000000000033', '16045551752',
    '17500000-0000-4000-8000-000000000021',
    '17500000-0000-4000-8000-000000000022',
    'You usually add this (100% of your visits)', 1
  );
  IF v_result.outcome <> 'claimed' OR v_result.claim_id = v_first.claim_id
     OR v_result.offer_payload->>'service_id'
        <> '17500000-0000-4000-8000-000000000022' THEN
    RAISE EXCEPTION 'cross-tenant session isolation failed: %', row_to_json(v_result);
  END IF;
  IF (SELECT count(*) FROM public.ai_upsell_session_claims
      WHERE session_id = v_session) <> 2 THEN
    RAISE EXCEPTION 'salon-scoped session uniqueness drifted';
  END IF;

  SELECT * INTO v_result FROM public.claim_ai_upsell_offer(
    v_salon_b, v_session,
    '17500000-0000-4000-8000-000000000033', '16045551752',
    '17500000-0000-4000-8000-000000000011',
    '17500000-0000-4000-8000-000000000012',
    'You usually add this (100% of your visits)', 1
  );
  IF v_result.outcome <> 'offer_material_mismatch'
     OR v_result.offer_payload IS NOT NULL THEN
    RAISE EXCEPTION 'cross-tenant service material was accepted: %', row_to_json(v_result);
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.ai_upsell_session_claims c
    WHERE c.phone_fingerprint !~ '^[0-9a-f]{64}$'
       OR c.capability_fingerprint !~ '^[0-9a-f]{64}$'
       OR c.offer_material_fingerprint !~ '^[0-9a-f]{64}$'
       OR to_jsonb(c)::text LIKE '%1604555175%'
       OR to_jsonb(c)::text LIKE '%17500000-0000-4000-8000-00000000003%'
  ) THEN
    RAISE EXCEPTION 'immutable claim persisted raw PII or bearer capability';
  END IF;
END;
$behavior$;

RESET ROLE;

DO $immutability$
BEGIN
  BEGIN
    UPDATE public.ai_upsell_session_claims
       SET offer_payload = offer_payload || '{"tampered":true}'::jsonb
     WHERE salon_id = '17500000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'direct claim mutation unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    NULL;
  END;
END;
$immutability$;

ROLLBACK;

SELECT 'ai_upsell_session_claim_rehearsal_pass' AS result;
