\set ON_ERROR_STOP on

BEGIN;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', true);

INSERT INTO public.platform_settings (
  id, sms_consent_hash_secret, sms_consent_hash_key_id
) VALUES (
  'platform', repeat('q', 48), '18110000-0000-4000-8000-000000000099'
)
ON CONFLICT (id) DO UPDATE
SET sms_consent_hash_secret = excluded.sms_consent_hash_secret,
    sms_consent_hash_key_id = excluded.sms_consent_hash_key_id;

INSERT INTO public.salons(
  id, slug, name, phone, timezone, is_beta, customer_channel,
  sms_outbound_enabled, email_outbound_enabled, sms_a2p_registered,
  subscription_status
) VALUES (
  '18110000-0000-4000-8000-000000000001',
  'reactivation-delivery-contract-qa', 'Reactivation Delivery Contract QA',
  '+16045551901', 'UTC', true, 'email_only', false, true, false, 'active'
), (
  '18110000-0000-4000-8000-000000000002',
  'reactivation-delivery-cross-tenant-qa', 'Reactivation Cross Tenant QA',
  '+16045551902', 'UTC', true, 'email_only', false, true, false, 'active'
);

INSERT INTO public.client_profiles(
  id, phone, name, email, marketing_email_consent_at
) VALUES
  ('18110000-0000-4000-8000-000000000011', '16045551911',
   'Delivery QA One', 'delivery-one@nailiq.invalid', transaction_timestamp()),
  ('18110000-0000-4000-8000-000000000012', '16045551912',
   'Delivery QA Two', 'delivery-two@nailiq.invalid', transaction_timestamp()),
  ('18110000-0000-4000-8000-000000000013', '16045551913',
   'Delivery QA Append Probe', 'delivery-append@nailiq.invalid',
   transaction_timestamp());

INSERT INTO public.salon_clients(salon_id, client_profile_id, source)
VALUES
  ('18110000-0000-4000-8000-000000000001',
   '18110000-0000-4000-8000-000000000011', 'manual'),
  ('18110000-0000-4000-8000-000000000001',
   '18110000-0000-4000-8000-000000000012', 'manual');

INSERT INTO public.customer_preferences(
  client_profile_id, salon_id, preferred_language,
  preferred_communication_channel, consent_marketing_sms,
  consent_marketing_email
) VALUES
  ('18110000-0000-4000-8000-000000000011',
   '18110000-0000-4000-8000-000000000001', 'en', 'email', false, true),
  ('18110000-0000-4000-8000-000000000012',
   '18110000-0000-4000-8000-000000000001', 'vi', 'email', false, true);

INSERT INTO public.approval_requests(
  id, salon_id, action_type, summary, payload, status,
  decided_at, expires_at
) VALUES (
  '18110000-0000-4000-8000-000000000021',
  '18110000-0000-4000-8000-000000000001', 'bulk_message',
  'Reactivation source approval',
  jsonb_build_object(
    'proposal_source', 'reactivation_campaign',
    'reactivation_kind', 'winback',
    'dispatch_enabled', false,
    'no_messages_sent', true
  ), 'approved', transaction_timestamp(), transaction_timestamp() + interval '1 hour'
);

INSERT INTO public.ai_execution_jobs(
  id, salon_id, approval_request_id, action_type, payload, status,
  idempotency_key, result
) VALUES (
  '18110000-0000-4000-8000-000000000022',
  '18110000-0000-4000-8000-000000000001',
  '18110000-0000-4000-8000-000000000021', 'bulk_message',
  jsonb_build_object(
    'proposal_source', 'reactivation_campaign',
    'reactivation_kind', 'winback',
    'dispatch_enabled', false,
    'no_messages_sent', true
  ), 'waiting_input', 'mqa0181-source',
  jsonb_build_object(
    'blocker', 'release_approval_required',
    'dispatch_enabled', false,
    'no_messages_sent', true
  )
);

INSERT INTO public.ai_campaign_manifests(
  id, salon_id, source_execution_job_id, source_approval_request_id,
  audience_fingerprint, message_sha256, message, summary
) VALUES (
  '18110000-0000-4000-8000-000000000031',
  '18110000-0000-4000-8000-000000000001',
  '18110000-0000-4000-8000-000000000022',
  '18110000-0000-4000-8000-000000000021',
  '43896fa2be5458b48719bb98', repeat('b', 64),
  '{"en":"QA source copy","vi":"Ban QA"}',
  jsonb_build_object(
    'reactivation_kind', 'winback',
    'no_messages_sent', true,
    'eligible_count', 2
  )
);

INSERT INTO public.ai_campaign_manifest_recipients(
  manifest_id, salon_id, client_profile_id, sms, email
) VALUES
  ('18110000-0000-4000-8000-000000000031',
   '18110000-0000-4000-8000-000000000001',
   '18110000-0000-4000-8000-000000000011', false, true),
  ('18110000-0000-4000-8000-000000000031',
   '18110000-0000-4000-8000-000000000001',
   '18110000-0000-4000-8000-000000000012', false, true);

INSERT INTO public.approval_requests(
  id, salon_id, action_type, summary, payload, status,
  decided_at, expires_at, release_manifest_id
) VALUES (
  '18110000-0000-4000-8000-000000000041',
  '18110000-0000-4000-8000-000000000001', 'bulk_message',
  'Reactivation release approval',
  jsonb_build_object(
    'proposal_source', 'reactivation_campaign_release_gate',
    'reactivation_kind', 'winback',
    'manifest_id', '18110000-0000-4000-8000-000000000031',
    'source_execution_job_id', '18110000-0000-4000-8000-000000000022',
    'audience_fingerprint', '43896fa2be5458b48719bb98',
    'message_sha256', repeat('b', 64),
    'dispatch_enabled', false,
    'no_messages_sent', true
  ), 'approved', transaction_timestamp(), transaction_timestamp() + interval '1 hour',
  '18110000-0000-4000-8000-000000000031'
);

INSERT INTO public.ai_execution_jobs(
  id, salon_id, approval_request_id, action_type, payload, status,
  idempotency_key, result
) VALUES (
  '18110000-0000-4000-8000-000000000042',
  '18110000-0000-4000-8000-000000000001',
  '18110000-0000-4000-8000-000000000041', 'bulk_message',
  jsonb_build_object(
    'proposal_source', 'reactivation_campaign_release_gate',
    'reactivation_kind', 'winback',
    'manifest_id', '18110000-0000-4000-8000-000000000031',
    'source_execution_job_id', '18110000-0000-4000-8000-000000000022',
    'audience_fingerprint', '43896fa2be5458b48719bb98',
    'message_sha256', repeat('b', 64),
    'dispatch_enabled', false,
    'no_messages_sent', true
  ), 'waiting_input', 'mqa0181-release',
  jsonb_build_object(
    'blocker', 'dispatch_not_enabled',
    'dispatch_plan_id', '18110000-0000-4000-8000-000000000061',
    'dispatch_enabled', false,
    'no_messages_sent', true
  )
);

INSERT INTO public.ai_campaign_dispatch_preflights(
  id, salon_id, manifest_id, release_execution_job_id,
  preflight_fingerprint, status, summary, created_at, valid_until
) VALUES (
  '18110000-0000-4000-8000-000000000051',
  '18110000-0000-4000-8000-000000000001',
  '18110000-0000-4000-8000-000000000031',
  '18110000-0000-4000-8000-000000000042',
  '961e32356bdf9b4f3404aa631afaf74c4e17dec0ddc3dccb6d78400ee17dcaa5',
  'ready',
  jsonb_build_object(
    'preflight_fingerprint',
      '961e32356bdf9b4f3404aa631afaf74c4e17dec0ddc3dccb6d78400ee17dcaa5',
    'dispatch_enabled', false,
    'no_messages_sent', true,
    'manifest_recipient_count', 2,
    'eligible_count', 2,
    'email_recipient_count', 2,
    'sms_recipient_count', 0,
    'dual_channel_count', 0,
    'excluded_recent_contact', 0,
    'excluded_no_consent', 0,
    'excluded_no_channel', 0,
    'excluded_missing_profile', 0,
    'excluded_manifest_channel_unavailable', 0,
    'estimated_cost_usd_cents', 0.2,
    'within_recipient_cap', true,
    'within_cost_cap', true
  ), transaction_timestamp(), transaction_timestamp() + interval '5 minutes'
);

INSERT INTO public.ai_campaign_dispatch_preflight_decisions(
  preflight_id, salon_id, client_profile_id, sms, email, exclusion
) VALUES
  ('18110000-0000-4000-8000-000000000051',
   '18110000-0000-4000-8000-000000000001',
   '18110000-0000-4000-8000-000000000011', false, true, NULL),
  ('18110000-0000-4000-8000-000000000051',
   '18110000-0000-4000-8000-000000000001',
   '18110000-0000-4000-8000-000000000012', false, true, NULL);

INSERT INTO public.ai_campaign_dispatch_plans(
  id, salon_id, manifest_id, preflight_id, release_execution_job_id,
  plan_fingerprint, status, recipient_count, sms_recipient_count,
  email_recipient_count, estimated_cost_usd_cents, expires_at,
  dispatch_enabled, no_messages_sent
) VALUES (
  '18110000-0000-4000-8000-000000000061',
  '18110000-0000-4000-8000-000000000001',
  '18110000-0000-4000-8000-000000000031',
  '18110000-0000-4000-8000-000000000051',
  '18110000-0000-4000-8000-000000000042', repeat('d', 64), 'sealed',
  2, 0, 2, 0.2, transaction_timestamp() + interval '5 minutes', false, true
);

DO $rehearse$
DECLARE
  v_result jsonb;
  v_claim jsonb;
  v_delivery public.reactivation_campaign_deliveries%ROWTYPE;
  v_material text := repeat('e', 64);
  v_payload text;
  v_authorized_at timestamptz := transaction_timestamp();
  v_authorization_expires_at timestamptz := transaction_timestamp() + interval '4 minutes';
  v_authorization_fingerprint text;
  v_attempt_token uuid;
  v_receipt_token uuid;
  v_count integer;
  v_rpc regprocedure;
BEGIN
  v_result := public.materialize_reactivation_campaign_deliveries(
    '18110000-0000-4000-8000-000000000061'
  );
  IF v_result ->> 'code' <> 'materialized'
     OR (v_result ->> 'created_count')::integer <> 2
     OR (v_result ->> 'dispatch_authorized')::boolean IS NOT FALSE
     OR (SELECT count(*) FROM public.reactivation_campaign_deliveries
          WHERE dispatch_plan_id = '18110000-0000-4000-8000-000000000061'
            AND status = 'awaiting_material') <> 2 THEN
    RAISE EXCEPTION 'materialization failed: %', v_result;
  END IF;

  v_result := public.materialize_reactivation_campaign_deliveries(
    '18110000-0000-4000-8000-000000000061'
  );
  IF v_result ->> 'code' <> 'unchanged'
     OR (v_result ->> 'existing_count')::integer <> 2 THEN
    RAISE EXCEPTION 'materialization replay drifted: %', v_result;
  END IF;

  FOR v_delivery IN
    SELECT delivery.* FROM public.reactivation_campaign_deliveries AS delivery
     WHERE delivery.dispatch_plan_id = '18110000-0000-4000-8000-000000000061'
     ORDER BY delivery.client_profile_id
  LOOP
    v_payload := encode(extensions.digest(convert_to(concat_ws('|',
      'reactivation-payload-v1', v_delivery.id::text,
      v_delivery.plan_fingerprint, v_delivery.preflight_fingerprint,
      v_delivery.source_material_fingerprint, v_material,
      v_delivery.contact_fingerprint, v_delivery.preference_fingerprint,
      v_delivery.recipient_fingerprint), 'UTF8'), 'sha256'), 'hex');
    v_result := public.bind_reactivation_campaign_delivery_material(
      v_delivery.id, v_delivery.source_material_fingerprint, v_material,
      v_delivery.contact_fingerprint, v_delivery.preference_fingerprint,
      v_delivery.recipient_fingerprint, v_payload
    );
    IF v_result ->> 'code' <> 'bound' THEN
      RAISE EXCEPTION 'material bind failed: %', v_result;
    END IF;
  END LOOP;

  -- Claim must mirror materialization's exact release provenance. Exercise a
  -- drifted release payload inside a subtransaction, prove fail-closed
  -- suppression, then roll the probe back so the positive path remains valid.
  BEGIN
    UPDATE public.ai_execution_jobs
       SET payload = jsonb_set(
         payload, '{message_sha256}', to_jsonb(repeat('0', 64)), false
       )
     WHERE id = '18110000-0000-4000-8000-000000000042';
    SELECT count(*)::integer INTO v_count
      FROM public.claim_reactivation_campaign_deliveries(10) AS claim_result
     WHERE claim_result ->> 'code' = 'suppressed'
       AND claim_result ->> 'reason' = 'source_contract_changed';
    IF v_count <> 2 THEN
      RAISE EXCEPTION 'claim-time exact provenance drift was not blocked: %', v_count;
    END IF;
    RAISE EXCEPTION 'mqa0181_claim_provenance_probe_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'mqa0181_claim_provenance_probe_rollback' THEN
      RAISE;
    END IF;
  END;

  -- The legacy evidence tables reject UPDATE/DELETE but still permit a
  -- service-role INSERT. Appending a recipient plus decision after sealing
  -- must change both audience hashes/counts and suppress every old candidate.
  BEGIN
    INSERT INTO public.ai_campaign_manifest_recipients(
      manifest_id, salon_id, client_profile_id, sms, email
    ) VALUES (
      '18110000-0000-4000-8000-000000000031',
      '18110000-0000-4000-8000-000000000001',
      '18110000-0000-4000-8000-000000000013', false, true
    );
    INSERT INTO public.ai_campaign_dispatch_preflight_decisions(
      preflight_id, salon_id, client_profile_id, sms, email, exclusion
    ) VALUES (
      '18110000-0000-4000-8000-000000000051',
      '18110000-0000-4000-8000-000000000001',
      '18110000-0000-4000-8000-000000000013', false, true, NULL
    );
    SELECT count(*)::integer INTO v_count
      FROM public.claim_reactivation_campaign_deliveries(10) AS claim_result
     WHERE claim_result ->> 'code' = 'suppressed'
       AND claim_result ->> 'reason' = 'source_contract_changed';
    IF v_count <> 2 THEN
      RAISE EXCEPTION 'claim-time audience append drift was not blocked: %', v_count;
    END IF;
    RAISE EXCEPTION 'mqa0181_claim_audience_probe_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'mqa0181_claim_audience_probe_rollback' THEN
      RAISE;
    END IF;
  END;

  -- Separate salon_id FKs on legacy child tables must not hide tenant-polluted
  -- rows that still point at this manifest/preflight parent.
  BEGIN
    INSERT INTO public.ai_campaign_manifest_recipients(
      manifest_id, salon_id, client_profile_id, sms, email
    ) VALUES (
      '18110000-0000-4000-8000-000000000031',
      '18110000-0000-4000-8000-000000000002',
      '18110000-0000-4000-8000-000000000013', false, true
    );
    INSERT INTO public.ai_campaign_dispatch_preflight_decisions(
      preflight_id, salon_id, client_profile_id, sms, email, exclusion
    ) VALUES (
      '18110000-0000-4000-8000-000000000051',
      '18110000-0000-4000-8000-000000000002',
      '18110000-0000-4000-8000-000000000013', false, true, NULL
    );
    SELECT count(*)::integer INTO v_count
      FROM public.claim_reactivation_campaign_deliveries(10) AS claim_result
     WHERE claim_result ->> 'code' = 'suppressed'
       AND claim_result ->> 'reason' = 'source_contract_changed';
    IF v_count <> 2 THEN
      RAISE EXCEPTION 'claim-time cross-tenant append was not blocked: %', v_count;
    END IF;
    RAISE EXCEPTION 'mqa0181_claim_tenant_probe_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'mqa0181_claim_tenant_probe_rollback' THEN
      RAISE;
    END IF;
  END;

  SELECT count(*)::integer INTO v_count
    FROM public.claim_reactivation_campaign_deliveries(10) AS claim_result
   WHERE claim_result ->> 'code' = 'dispatch_not_authorized'
     AND (claim_result ->> 'provider_ready')::boolean IS FALSE;
  IF v_count <> 2
     OR (SELECT count(*) FROM public.reactivation_campaign_deliveries
          WHERE status = 'awaiting_authorization') <> 2 THEN
    RAISE EXCEPTION 'hard-off authorization gate failed: %', v_count;
  END IF;

  SELECT delivery.* INTO STRICT v_delivery
    FROM public.reactivation_campaign_deliveries AS delivery
   WHERE delivery.client_profile_id = '18110000-0000-4000-8000-000000000011';
  v_authorization_fingerprint := encode(extensions.digest(convert_to(concat_ws('|',
    'reactivation-dispatch-authorization-v1', v_delivery.id::text,
    v_delivery.salon_id::text, v_delivery.dispatch_plan_id::text,
    v_delivery.plan_fingerprint, v_delivery.source_material_fingerprint,
    v_delivery.material_fingerprint, v_delivery.payload_fingerprint,
    v_delivery.contact_fingerprint, v_delivery.preference_fingerprint,
    v_delivery.recipient_fingerprint, v_authorized_at::text,
    v_authorization_expires_at::text), 'UTF8'), 'sha256'), 'hex');

  -- Deliberate DB-owner-only fixture. No application/service role can perform
  -- this insert because the migration grants no table privilege or RPC.
  INSERT INTO public.reactivation_campaign_dispatch_authorizations(
    delivery_id, salon_id, dispatch_plan_id, plan_fingerprint,
    source_material_fingerprint, material_fingerprint, payload_fingerprint,
    contact_fingerprint, preference_fingerprint, recipient_fingerprint,
    authorization_fingerprint, authorized_at, expires_at
  ) VALUES (
    v_delivery.id, v_delivery.salon_id, v_delivery.dispatch_plan_id,
    v_delivery.plan_fingerprint, v_delivery.source_material_fingerprint,
    v_delivery.material_fingerprint, v_delivery.payload_fingerprint,
    v_delivery.contact_fingerprint, v_delivery.preference_fingerprint,
    v_delivery.recipient_fingerprint, v_authorization_fingerprint,
    v_authorized_at, v_authorization_expires_at
  );

  SELECT claim_result INTO v_claim
    FROM public.claim_reactivation_campaign_deliveries(10) AS claim_result
   WHERE (claim_result ->> 'success')::boolean IS TRUE;
  IF v_claim ->> 'code' <> 'delivery_claimed'
     OR (v_claim ->> 'provider_ready')::boolean IS NOT FALSE
     OR v_claim ? 'destination' OR v_claim ? 'message' OR v_claim ? 'body' THEN
    RAISE EXCEPTION 'authorized hash-only claim failed: %', v_claim;
  END IF;
  v_attempt_token := (v_claim ->> 'attempt_token')::uuid;

  v_result := public.complete_reactivation_campaign_delivery(
    (v_claim ->> 'delivery_id')::uuid, v_attempt_token,
    'provider_accepted', 'email_provider', repeat('f', 64), NULL
  );
  IF v_result ->> 'code' <> 'completed'
     OR v_result ->> 'status' <> 'provider_accepted'
     OR v_result ->> 'delivery_receipt_token' IS NULL THEN
    RAISE EXCEPTION 'provider acceptance receipt failed: %', v_result;
  END IF;
  v_receipt_token := (v_result ->> 'delivery_receipt_token')::uuid;

  v_result := public.record_reactivation_campaign_delivery_receipt(
    (v_claim ->> 'delivery_id')::uuid, v_receipt_token,
    'email_provider', repeat('1', 64), clock_timestamp()
  );
  IF v_result ->> 'code' <> 'recorded'
     OR v_result ->> 'status' <> 'delivered' THEN
    RAISE EXCEPTION 'separate delivered receipt failed: %', v_result;
  END IF;

  INSERT INTO public.client_email_optouts(email)
  VALUES ('delivery-two@nailiq.invalid');
  SELECT claim_result INTO v_claim
    FROM public.claim_reactivation_campaign_deliveries(10) AS claim_result
   WHERE claim_result ->> 'reason' = 'email_opted_out';
  IF v_claim ->> 'code' <> 'suppressed'
     OR (SELECT status FROM public.reactivation_campaign_deliveries
          WHERE client_profile_id = '18110000-0000-4000-8000-000000000012')
        <> 'suppressed' THEN
    RAISE EXCEPTION 'claim-time email opt-out recheck failed: %', v_claim;
  END IF;

  IF (SELECT count(*) FROM public.reactivation_campaign_delivery_receipts
       WHERE delivery_id = (v_result ->> 'delivery_id')::uuid) <> 2 THEN
    RAISE EXCEPTION 'receipt count mismatch';
  END IF;

  IF has_table_privilege('service_role',
       'public.reactivation_campaign_dispatch_authorizations', 'INSERT')
     OR has_table_privilege('authenticated',
       'public.reactivation_campaign_deliveries', 'SELECT') THEN
    RAISE EXCEPTION 'reactivation delivery table grants widened';
  END IF;

  FOREACH v_rpc IN ARRAY ARRAY[
    'public.materialize_reactivation_campaign_deliveries(uuid)'::regprocedure,
    'public.bind_reactivation_campaign_delivery_material(uuid,text,text,text,text,text,text)'::regprocedure,
    'public.claim_reactivation_campaign_deliveries(integer)'::regprocedure,
    'public.complete_reactivation_campaign_delivery(uuid,uuid,text,text,text,text)'::regprocedure,
    'public.record_reactivation_campaign_delivery_receipt(uuid,uuid,text,text,timestamp with time zone)'::regprocedure,
    'public.reconcile_stale_reactivation_campaign_deliveries(integer)'::regprocedure
  ] LOOP
    IF has_function_privilege('anon', v_rpc, 'EXECUTE')
       OR has_function_privilege('authenticated', v_rpc, 'EXECUTE')
       OR NOT has_function_privilege('service_role', v_rpc, 'EXECUTE') THEN
      RAISE EXCEPTION 'reactivation delivery RPC ACL mismatch: %', v_rpc;
    END IF;
  END LOOP;

  PERFORM pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);
  SELECT count(*)::integer INTO v_count
    FROM public.claim_reactivation_campaign_deliveries(10);
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'browser role reached claim RPC';
  END IF;
  PERFORM pg_catalog.set_config('request.jwt.claim.role', 'service_role', true);

  v_result := public.reconcile_stale_reactivation_campaign_deliveries(100);
  IF v_result ->> 'code' <> 'reconciled'
     OR (v_result ->> 'retry_allowed')::boolean IS NOT FALSE THEN
    RAISE EXCEPTION 'reconciliation contract failed: %', v_result;
  END IF;
END;
$rehearse$;

ROLLBACK;

DO $cleanup$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.salons
     WHERE id = '18110000-0000-4000-8000-000000000001'
  ) OR EXISTS (
    SELECT 1 FROM public.reactivation_campaign_deliveries
     WHERE salon_id = '18110000-0000-4000-8000-000000000001'
  ) THEN
    RAISE EXCEPTION 'reactivation delivery rehearsal left fixture rows';
  END IF;
END;
$cleanup$;

SELECT 'reactivation_campaign_delivery_contract_rehearsal_pass' AS result;
