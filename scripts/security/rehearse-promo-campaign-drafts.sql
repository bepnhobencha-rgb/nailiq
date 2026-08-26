\set ON_ERROR_STOP on

BEGIN;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', true);

INSERT INTO public.salons(id, slug, name, phone, timezone, is_beta)
VALUES
  ('17900000-0000-4000-8000-000000000001', 'promo-draft-qa-a',
   'Promo Draft QA A', '+16045551901', 'UTC', true),
  ('17900000-0000-4000-8000-000000000002', 'promo-draft-qa-b',
   'Promo Draft QA B', '+16045551902', 'UTC', true);

INSERT INTO auth.users(
  id, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at
) VALUES (
  '17900000-0000-4000-8000-000000000011',
  'promo-owner@nailiq.invalid', '', statement_timestamp(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb, statement_timestamp()
);
INSERT INTO public.salon_members(salon_id, user_id, role)
VALUES (
  '17900000-0000-4000-8000-000000000001',
  '17900000-0000-4000-8000-000000000011',
  'owner'
);

DO $promo_behavior$
DECLARE
  v_salon_a uuid := '17900000-0000-4000-8000-000000000001';
  v_salon_b uuid := '17900000-0000-4000-8000-000000000002';
  v_owner uuid := '17900000-0000-4000-8000-000000000011';
  v_outsider uuid := '17900000-0000-4000-8000-000000000012';
  v_first record;
  v_duplicate record;
  v_completed record;
  v_replayed record;
  v_retry record;
  v_other_salon record;
  v_transition record;
  v_approval public.approval_requests%ROWTYPE;
  v_update text;
  v_permission jsonb;
BEGIN
  v_permission := public.set_ai_agent_permission(
    v_salon_a, v_owner, 'owner', 'member',
    'ai_promo_campaign_drafts', true, 'draft_only', false
  );
  IF (v_permission->>'success')::boolean IS NOT TRUE
     OR NOT EXISTS (
       SELECT 1 FROM public.ai_agent_permission_audit
       WHERE salon_id = v_salon_a
         AND flag_key = 'ai_promo_campaign_drafts'
         AND enabled
         AND impact = 'draft_only'
     ) THEN
    RAISE EXCEPTION 'promo opt-in permission audit failed: %', v_permission;
  END IF;

  SELECT * INTO v_first FROM public.claim_promo_campaign_draft(
    v_salon_a, 'weekly_strategist', date '2026-08-17'
  );
  IF v_first.outcome <> 'claimed' OR v_first.attempt_count <> 1
     OR v_first.claim_token IS NULL THEN
    RAISE EXCEPTION 'first promo claim failed: %', row_to_json(v_first);
  END IF;

  SELECT * INTO v_duplicate FROM public.claim_promo_campaign_draft(
    v_salon_a, 'weekly_strategist', date '2026-08-17'
  );
  IF v_duplicate.outcome <> 'in_progress'
     OR v_duplicate.claim_token IS NOT NULL THEN
    RAISE EXCEPTION 'duplicate in-flight promo was claimed: %', row_to_json(v_duplicate);
  END IF;

  SELECT * INTO v_completed FROM public.complete_promo_campaign_draft(
    v_first.claim_id, v_first.claim_token,
    'Owner review needed',
    'Quiet salon windows create an opportunity for an owner-configured offer.',
    'Our salon has prepared a new offer for guests. Review the salon-confirmed details on the booking page before choosing a suitable time.',
    'en',
    '["Recent salon activity supports a draft."]'::jsonb
  );
  IF v_completed.outcome <> 'created'
     OR v_completed.approval_request_id IS NULL THEN
    RAISE EXCEPTION 'promo completion failed: %', row_to_json(v_completed);
  END IF;

  SELECT * INTO v_approval FROM public.approval_requests
  WHERE id = v_completed.approval_request_id;
  IF v_approval.action_type <> 'bulk_message'
     OR v_approval.status <> 'pending'
     OR v_approval.notified_at IS NOT NULL
     OR v_approval.promo_campaign_claim_id <> v_first.claim_id
     OR v_approval.payload->>'campaign_mode' <> 'dashboard_draft_only'
     OR v_approval.payload->>'notification_mode' <> 'dashboard_only_no_email'
     OR v_approval.payload->>'delivery_mode' <> 'no_dispatch'
     OR (v_approval.payload->>'dispatch_enabled')::boolean IS NOT FALSE
     OR (v_approval.payload->>'promotion_mutation_enabled')::boolean IS NOT FALSE
     OR (v_approval.payload->>'recipient_selection_required')::boolean IS NOT TRUE
     OR (v_approval.payload->>'owner_offer_facts_confirmed')::boolean IS NOT FALSE THEN
    RAISE EXCEPTION 'promo dashboard-only policy drifted: %', row_to_json(v_approval);
  END IF;

  SELECT * INTO v_replayed FROM public.complete_promo_campaign_draft(
    v_first.claim_id, v_first.claim_token,
    'Owner review needed',
    'Quiet salon windows create an opportunity for an owner-configured offer.',
    'Our salon has prepared a new offer for guests. Review the salon-confirmed details on the booking page before choosing a suitable time.',
    'en', '[]'::jsonb
  );
  IF v_replayed.outcome <> 'existing'
     OR v_replayed.approval_request_id <> v_completed.approval_request_id
     OR (SELECT count(*) FROM public.approval_requests
         WHERE promo_campaign_claim_id = v_first.claim_id) <> 1 THEN
    RAISE EXCEPTION 'promo completion replay duplicated approval';
  END IF;

  v_update := public.update_promo_campaign_draft_as_actor(
    v_completed.approval_request_id, v_outsider,
    'Discover a salon-confirmed offer before choosing an appointment.', false
  );
  IF v_update <> 'forbidden' THEN
    RAISE EXCEPTION 'outsider promo edit accepted: %', v_update;
  END IF;

  v_update := public.update_promo_campaign_draft_as_actor(
    v_completed.approval_request_id, v_owner,
    'Owner confirmed fifteen percent off a selected salon service.', false
  );
  IF v_update <> 'offer_confirmation_required' THEN
    RAISE EXCEPTION 'numeric promo edit bypassed confirmation: %', v_update;
  END IF;

  v_update := public.update_promo_campaign_draft_as_actor(
    v_completed.approval_request_id, v_owner,
    'Owner confirmed 15 percent off a selected salon service.', true
  );
  IF v_update <> 'updated'
     OR NOT (SELECT (payload->>'owner_offer_facts_confirmed')::boolean
             FROM public.approval_requests
             WHERE id = v_completed.approval_request_id)
     OR (SELECT payload->>'owner_offer_facts_confirmed_by'
         FROM public.approval_requests
         WHERE id = v_completed.approval_request_id) <> v_owner::text THEN
    RAISE EXCEPTION 'owner-confirmed promo edit failed: %', v_update;
  END IF;

  SELECT * INTO v_transition
  FROM public.decide_ai_approval_request_as_actor(
    v_completed.approval_request_id, 'approved', v_owner
  );
  IF v_transition.outcome <> 'approved_queued'
     OR v_transition.execution_status <> 'waiting_input'
     OR NOT EXISTS (
       SELECT 1 FROM public.ai_execution_jobs job
       WHERE job.id = v_transition.execution_job_id
         AND job.status = 'waiting_input'
         AND job.result->>'blocker' = 'recipient_selection_required'
     )
     OR EXISTS (
       SELECT 1 FROM public.approval_requests ar
       WHERE ar.id = v_completed.approval_request_id
         AND ar.notified_at IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'promo draft approval gained dispatch: %', row_to_json(v_transition);
  END IF;

  SELECT * INTO v_other_salon FROM public.claim_promo_campaign_draft(
    v_salon_b, 'weekly_strategist', date '2026-08-17'
  );
  IF v_other_salon.outcome <> 'claimed' THEN
    RAISE EXCEPTION 'salon-scoped promo claim isolation failed: %', row_to_json(v_other_salon);
  END IF;

  SELECT * INTO v_retry FROM public.claim_promo_campaign_draft(
    v_salon_a, 'weekly_strategist', date '2026-08-24'
  );
  PERFORM public.fail_promo_campaign_draft(
    v_retry.claim_id, v_retry.claim_token, 'provider_timeout'
  );
  SELECT * INTO v_retry FROM public.claim_promo_campaign_draft(
    v_salon_a, 'weekly_strategist', date '2026-08-24'
  );
  IF v_retry.outcome <> 'claimed' OR v_retry.attempt_count <> 2 THEN
    RAISE EXCEPTION 'promo attempt two failed';
  END IF;
  PERFORM public.fail_promo_campaign_draft(
    v_retry.claim_id, v_retry.claim_token, 'provider_timeout'
  );
  SELECT * INTO v_retry FROM public.claim_promo_campaign_draft(
    v_salon_a, 'weekly_strategist', date '2026-08-24'
  );
  IF v_retry.outcome <> 'claimed' OR v_retry.attempt_count <> 3 THEN
    RAISE EXCEPTION 'promo attempt three failed';
  END IF;
  PERFORM public.fail_promo_campaign_draft(
    v_retry.claim_id, v_retry.claim_token, 'provider_timeout'
  );
  SELECT * INTO v_retry FROM public.claim_promo_campaign_draft(
    v_salon_a, 'weekly_strategist', date '2026-08-24'
  );
  IF v_retry.outcome <> 'exhausted' OR v_retry.attempt_count <> 3 THEN
    RAISE EXCEPTION 'promo retry ceiling drifted: %', row_to_json(v_retry);
  END IF;
END;
$promo_behavior$;

ROLLBACK;

DO $promo_cleanup$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.salons
    WHERE id IN (
      '17900000-0000-4000-8000-000000000001',
      '17900000-0000-4000-8000-000000000002'
    )
  ) OR EXISTS (
    SELECT 1 FROM auth.users
    WHERE id = '17900000-0000-4000-8000-000000000011'
  ) THEN
    RAISE EXCEPTION 'promo rehearsal left fixture rows';
  END IF;
END;
$promo_cleanup$;

SELECT 'promo_campaign_draft_rehearsal_pass' AS result;
