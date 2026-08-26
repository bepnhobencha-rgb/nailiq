\set ON_ERROR_STOP on
BEGIN;

INSERT INTO public.salons(
  id, slug, name, phone, email, timezone, sms_outbound_enabled
) VALUES
  ('51020000-0000-4000-8000-000000000101', 'sms-consent-a',
   'SMS Consent A', '16045550101', 'a@example.test', 'UTC', true),
  ('51020000-0000-4000-8000-000000000102', 'sms-consent-b',
   'SMS Consent B', '16045550102', 'b@example.test', 'UTC', true);

INSERT INTO public.platform_settings(
  id, twilio_account_sid, twilio_auth_token, twilio_phone_number,
  sms_consent_hash_secret, sms_consent_hash_key_id
) VALUES (
  'platform', 'AC0123456789ABCDEF0123456789ABCDEF', 'test-token',
  '+16045550100', repeat('s', 32),
  '51020000-0000-4000-8000-000000000001'
) ON CONFLICT (id) DO UPDATE SET
  twilio_account_sid = EXCLUDED.twilio_account_sid,
  twilio_phone_number = EXCLUDED.twilio_phone_number,
  sms_consent_hash_secret = EXCLUDED.sms_consent_hash_secret,
  sms_consent_hash_key_id = EXCLUDED.sms_consent_hash_key_id;

DO $$
DECLARE
  v_context jsonb := public.sms_consent_provider_context();
  v_hash jsonb := public.hash_sms_consent_phone('+1 (604) 555-0123');
  v_hash_same jsonb := public.hash_sms_consent_phone('16045550123');
  v_hash_two jsonb := public.hash_sms_consent_phone('+1 604 555 0124');
  v_hash_three jsonb := public.hash_sms_consent_phone('+1 604 555 0125');
  v_claim jsonb;
  v_record jsonb;
  v_decision jsonb;
  v_inspect jsonb;
  v_event_id uuid;
  v_material text;
  v_stop_received_at timestamptz;
  v_tie timestamptz := statement_timestamp() + interval '1 second';
  v_count bigint;
BEGIN
  IF v_context->>'code' <> 'loaded'
     OR v_hash->>'code' <> 'hashed'
     OR v_hash->>'phone_hash' IS DISTINCT FROM v_hash_same->>'phone_hash'
     OR v_hash->>'phone_hash' !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION 'provider context/canonical keyed hash mismatch: %, %, %',
      v_context, v_hash, v_hash_same;
  END IF;

  v_claim := public.claim_sms_consent_event(
    '51020000-0000-4000-8000-000000000201',
    'provider_sender', 'provider_stop', 'twilio_webhook',
    '51020000-0000-4000-8000-000000000101',
    v_hash->>'phone_hash', (v_hash->>'hash_key_id')::uuid,
    v_context->>'provider_account_fingerprint',
    v_context->>'sender_fingerprint',
    'SM0123456789abcdef0123456789abcdef',
    'SM0123456789abcdef0123456789abcdef', NULL
  );
  IF v_claim->>'code' <> 'claimed' THEN
    RAISE EXCEPTION 'provider STOP claim failed: %', v_claim;
  END IF;
  v_event_id := (v_claim->>'event_id')::uuid;
  v_material := v_claim->>'material_fingerprint';
  SELECT occurred_at INTO v_stop_received_at
  FROM public.sms_consent_events WHERE id = v_event_id;

  v_record := public.record_sms_consent_event(
    v_event_id,
    '51020000-0000-4000-8000-000000000201',
    v_material
  );
  IF v_record->>'code' <> 'applied'
     OR v_record->>'effective_state' <> 'suppressed'
     OR (v_record->>'state_epoch')::bigint <> 1
  THEN
    RAISE EXCEPTION 'provider STOP record failed: %', v_record;
  END IF;

  -- A STOP against the shared provider sender suppresses both tenants.
  v_decision := public.load_sms_outbound_suppression(
    '51020000-0000-4000-8000-000000000101',
    v_hash->>'phone_hash', (v_hash->>'hash_key_id')::uuid
  );
  IF v_decision->>'reason' <> 'provider_stop'
     OR (v_decision->>'suppressed')::boolean IS NOT TRUE
     OR (v_decision->>'affirmative_consent_not_evaluated')::boolean IS NOT TRUE
  THEN RAISE EXCEPTION 'tenant A STOP decision mismatch: %', v_decision;
  END IF;
  v_decision := public.load_sms_outbound_suppression(
    '51020000-0000-4000-8000-000000000102',
    v_hash->>'phone_hash', (v_hash->>'hash_key_id')::uuid
  );
  IF v_decision->>'reason' <> 'provider_stop' THEN
    RAISE EXCEPTION 'provider STOP was not shared-sender global: %', v_decision;
  END IF;

  -- Basic webhook has no occurred_at. Delayed exact retry recovers the first
  -- DB receipt and result; no state/event duplication or epoch bump.
  PERFORM pg_catalog.pg_sleep(0.02);
  v_claim := public.claim_sms_consent_event(
    '51020000-0000-4000-8000-000000000201',
    'provider_sender', 'provider_stop', 'twilio_webhook',
    '51020000-0000-4000-8000-000000000101',
    v_hash->>'phone_hash', (v_hash->>'hash_key_id')::uuid,
    v_context->>'provider_account_fingerprint',
    v_context->>'sender_fingerprint',
    'SM0123456789abcdef0123456789abcdef',
    'SM0123456789abcdef0123456789abcdef', NULL
  );
  IF v_claim->>'code' <> 'already_applied'
     OR v_claim->>'material_fingerprint' IS DISTINCT FROM v_material
  THEN RAISE EXCEPTION 'webhook response-loss replay failed: %', v_claim;
  END IF;
  IF (SELECT occurred_at FROM public.sms_consent_events WHERE id = v_event_id)
       IS DISTINCT FROM v_stop_received_at
     OR (SELECT state_epoch FROM public.sms_consent_provider_states
         WHERE phone_hash = v_hash->>'phone_hash') <> 1
  THEN RAISE EXCEPTION 'webhook retry changed occurrence/epoch';
  END IF;

  -- Same provider MessageSid under another local request is provider replay.
  v_claim := public.claim_sms_consent_event(
    '51020000-0000-4000-8000-000000000202',
    'provider_sender', 'provider_stop', 'twilio_webhook',
    '51020000-0000-4000-8000-000000000101',
    v_hash->>'phone_hash', (v_hash->>'hash_key_id')::uuid,
    v_context->>'provider_account_fingerprint',
    v_context->>'sender_fingerprint',
    'SM0123456789abcdef0123456789abcdef',
    'SM0123456789abcdef0123456789abcdef', NULL
  );
  IF v_claim->>'code' <> 'already_applied'
     OR (v_claim->>'event_id')::uuid <> v_event_id
  THEN RAISE EXCEPTION 'provider event replay failed: %', v_claim;
  END IF;

  -- Reusing a request/provider event with changed immutable material fails.
  v_claim := public.claim_sms_consent_event(
    '51020000-0000-4000-8000-000000000201',
    'provider_sender', 'provider_stop', 'twilio_webhook',
    '51020000-0000-4000-8000-000000000101',
    v_hash_two->>'phone_hash', (v_hash_two->>'hash_key_id')::uuid,
    v_context->>'provider_account_fingerprint',
    v_context->>'sender_fingerprint',
    'SM0123456789abcdef0123456789abcdef',
    'SM0123456789abcdef0123456789abcdef', NULL
  );
  IF v_claim->>'code' <> 'request_conflict' THEN
    RAISE EXCEPTION 'changed request material did not conflict: %', v_claim;
  END IF;

  -- Provider START clears provider scope.
  v_claim := public.claim_sms_consent_event(
    '51020000-0000-4000-8000-000000000203',
    'provider_sender', 'provider_start', 'twilio_event_stream', NULL,
    v_hash->>'phone_hash', (v_hash->>'hash_key_id')::uuid,
    v_context->>'provider_account_fingerprint',
    v_context->>'sender_fingerprint',
    'EZ0123456789abcdef0123456789abcdef',
    'SM1123456789abcdef0123456789abcdef',
    v_stop_received_at + interval '1 second'
  );
  v_record := public.record_sms_consent_event(
    (v_claim->>'event_id')::uuid,
    '51020000-0000-4000-8000-000000000203',
    v_claim->>'material_fingerprint'
  );
  IF v_record->>'effective_state' <> 'clear' THEN
    RAISE EXCEPTION 'provider START did not clear provider scope: %', v_record;
  END IF;

  -- Independent salon suppression survives subsequent provider START.
  v_claim := public.claim_sms_consent_event(
    '51020000-0000-4000-8000-000000000204',
    'salon', 'salon_suppress', 'salon_service',
    '51020000-0000-4000-8000-000000000101',
    v_hash->>'phone_hash', (v_hash->>'hash_key_id')::uuid,
    v_context->>'provider_account_fingerprint',
    v_context->>'sender_fingerprint', NULL, NULL,
    v_stop_received_at + interval '2 seconds'
  );
  PERFORM public.record_sms_consent_event(
    (v_claim->>'event_id')::uuid,
    '51020000-0000-4000-8000-000000000204',
    v_claim->>'material_fingerprint'
  );
  v_decision := public.load_sms_outbound_suppression(
    '51020000-0000-4000-8000-000000000101',
    v_hash->>'phone_hash', (v_hash->>'hash_key_id')::uuid
  );
  IF v_decision->>'reason' <> 'salon_suppression' THEN
    RAISE EXCEPTION 'salon suppression missing: %', v_decision;
  END IF;

  v_claim := public.claim_sms_consent_event(
    '51020000-0000-4000-8000-000000000205',
    'provider_sender', 'provider_start', 'twilio_event_stream', NULL,
    v_hash->>'phone_hash', (v_hash->>'hash_key_id')::uuid,
    v_context->>'provider_account_fingerprint',
    v_context->>'sender_fingerprint',
    'EZ1123456789abcdef0123456789abcdef',
    'SM2123456789abcdef0123456789abcdef',
    v_stop_received_at + interval '3 seconds'
  );
  PERFORM public.record_sms_consent_event(
    (v_claim->>'event_id')::uuid,
    '51020000-0000-4000-8000-000000000205',
    v_claim->>'material_fingerprint'
  );
  v_decision := public.load_sms_outbound_suppression(
    '51020000-0000-4000-8000-000000000101',
    v_hash->>'phone_hash', (v_hash->>'hash_key_id')::uuid
  );
  IF v_decision->>'reason' <> 'salon_suppression' THEN
    RAISE EXCEPTION 'provider START cleared salon suppression: %', v_decision;
  END IF;

  v_claim := public.claim_sms_consent_event(
    '51020000-0000-4000-8000-000000000206',
    'salon', 'salon_restore', 'salon_service',
    '51020000-0000-4000-8000-000000000101',
    v_hash->>'phone_hash', (v_hash->>'hash_key_id')::uuid,
    v_context->>'provider_account_fingerprint',
    v_context->>'sender_fingerprint', NULL, NULL,
    v_stop_received_at + interval '4 seconds'
  );
  PERFORM public.record_sms_consent_event(
    (v_claim->>'event_id')::uuid,
    '51020000-0000-4000-8000-000000000206',
    v_claim->>'material_fingerprint'
  );
  IF public.load_sms_outbound_suppression(
    '51020000-0000-4000-8000-000000000101',
    v_hash->>'phone_hash', (v_hash->>'hash_key_id')::uuid
  )->>'code' <> 'clear' THEN
    RAISE EXCEPTION 'salon restore did not clear effective suppression';
  END IF;

  -- Same-timestamp START applied first, then STOP wins deterministically.
  v_claim := public.claim_sms_consent_event(
    '51020000-0000-4000-8000-000000000207',
    'provider_sender', 'provider_start', 'twilio_event_stream', NULL,
    v_hash_two->>'phone_hash', (v_hash_two->>'hash_key_id')::uuid,
    v_context->>'provider_account_fingerprint',
    v_context->>'sender_fingerprint',
    'EZ2123456789abcdef0123456789abcdef',
    'SM3123456789abcdef0123456789abcdef', v_tie
  );
  PERFORM public.record_sms_consent_event(
    (v_claim->>'event_id')::uuid,
    '51020000-0000-4000-8000-000000000207',
    v_claim->>'material_fingerprint'
  );
  v_claim := public.claim_sms_consent_event(
    '51020000-0000-4000-8000-000000000208',
    'provider_sender', 'provider_stop', 'twilio_event_stream', NULL,
    v_hash_two->>'phone_hash', (v_hash_two->>'hash_key_id')::uuid,
    v_context->>'provider_account_fingerprint',
    v_context->>'sender_fingerprint',
    'EZ3123456789abcdef0123456789abcdef',
    'SM4123456789abcdef0123456789abcdef', v_tie
  );
  PERFORM public.record_sms_consent_event(
    (v_claim->>'event_id')::uuid,
    '51020000-0000-4000-8000-000000000208',
    v_claim->>'material_fingerprint'
  );
  IF public.load_sms_outbound_suppression(
    '51020000-0000-4000-8000-000000000102',
    v_hash_two->>'phone_hash', (v_hash_two->>'hash_key_id')::uuid
  )->>'reason' <> 'provider_stop' THEN
    RAISE EXCEPTION 'same-timestamp STOP did not dominate START';
  END IF;

  -- STOP applied first makes equal-time START stale.
  v_claim := public.claim_sms_consent_event(
    '51020000-0000-4000-8000-000000000209',
    'provider_sender', 'provider_stop', 'twilio_event_stream', NULL,
    v_hash_three->>'phone_hash', (v_hash_three->>'hash_key_id')::uuid,
    v_context->>'provider_account_fingerprint',
    v_context->>'sender_fingerprint',
    'EZ4123456789abcdef0123456789abcdef',
    'SM5123456789abcdef0123456789abcdef', v_tie
  );
  PERFORM public.record_sms_consent_event(
    (v_claim->>'event_id')::uuid,
    '51020000-0000-4000-8000-000000000209',
    v_claim->>'material_fingerprint'
  );
  v_claim := public.claim_sms_consent_event(
    '51020000-0000-4000-8000-000000000210',
    'provider_sender', 'provider_start', 'twilio_event_stream', NULL,
    v_hash_three->>'phone_hash', (v_hash_three->>'hash_key_id')::uuid,
    v_context->>'provider_account_fingerprint',
    v_context->>'sender_fingerprint',
    'EZ5123456789abcdef0123456789abcdef',
    'SM6123456789abcdef0123456789abcdef', v_tie
  );
  v_record := public.record_sms_consent_event(
    (v_claim->>'event_id')::uuid,
    '51020000-0000-4000-8000-000000000210',
    v_claim->>'material_fingerprint'
  );
  IF v_record->>'code' <> 'stale_ignored'
     OR v_record->>'effective_state' <> 'suppressed' THEN
    RAISE EXCEPTION 'equal-time START was not safely stale: %', v_record;
  END IF;

  -- Malformed provider identity is rejected before durable writes.
  v_claim := public.claim_sms_consent_event(
    '51020000-0000-4000-8000-000000000211',
    'provider_sender', 'provider_stop', 'twilio_webhook', NULL,
    v_hash->>'phone_hash', (v_hash->>'hash_key_id')::uuid,
    repeat('0', 64), v_context->>'sender_fingerprint',
    'SM7123456789abcdef0123456789abcdef', 'bad-sid', NULL
  );
  IF v_claim->>'code' <> 'invalid_scope_material' THEN
    RAISE EXCEPTION 'malformed provider material accepted: %', v_claim;
  END IF;

  v_inspect := public.inspect_sms_consent_event(
    '51020000-0000-4000-8000-000000000201'
  );
  IF v_inspect->>'code' <> 'loaded'
     OR v_inspect ? 'phone'
     OR v_inspect::text LIKE '%16045550123%'
  THEN RAISE EXCEPTION 'inspect leaked PII or failed: %', v_inspect;
  END IF;

  SELECT count(*) INTO v_count FROM public.sms_consent_events
  WHERE provider_event_id = 'SM0123456789abcdef0123456789abcdef';
  IF v_count <> 1 THEN RAISE EXCEPTION 'provider event duplicated: %', v_count;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.sms_consent_events e
    WHERE e::text LIKE '%16045550123%'
  ) THEN RAISE EXCEPTION 'raw customer phone persisted in consent event';
  END IF;

  -- Config loss is fail-closed for new decisions, while already committed
  -- provider-event replay remains available before live resolver checks.
  UPDATE public.platform_settings SET
    sms_consent_hash_secret = NULL, sms_consent_hash_key_id = NULL
  WHERE id = 'platform';
  v_decision := public.load_sms_outbound_suppression(
    '51020000-0000-4000-8000-000000000101',
    v_hash->>'phone_hash', (v_hash->>'hash_key_id')::uuid
  );
  IF v_decision->>'reason' <> 'provider_context_unavailable'
     OR (v_decision->>'suppressed')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'missing provider config was not fail-closed: %', v_decision;
  END IF;
  v_claim := public.claim_sms_consent_event(
    '51020000-0000-4000-8000-000000000201',
    'provider_sender', 'provider_stop', 'twilio_webhook',
    '51020000-0000-4000-8000-000000000101',
    v_hash->>'phone_hash', (v_hash->>'hash_key_id')::uuid,
    v_context->>'provider_account_fingerprint',
    v_context->>'sender_fingerprint',
    'SM0123456789abcdef0123456789abcdef',
    'SM0123456789abcdef0123456789abcdef', NULL
  );
  IF v_claim->>'code' <> 'already_applied' THEN
    RAISE EXCEPTION 'config drift broke exact committed replay: %', v_claim;
  END IF;
END;
$$;

ROLLBACK;
SELECT 'sms consent suppression behavior passed' AS result;
