\set ON_ERROR_STOP on

BEGIN;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', true);

INSERT INTO public.salons(id, slug, name, phone, timezone, is_beta)
VALUES
  ('17800000-0000-4000-8000-000000000001', 'review-reply-qa-a',
   'Review Reply QA A', '+16045551801', 'UTC', true),
  ('17800000-0000-4000-8000-000000000002', 'review-reply-qa-b',
   'Review Reply QA B', '+16045551802', 'UTC', true);

INSERT INTO auth.users(
  id, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at
) VALUES (
  '17800000-0000-4000-8000-000000000011',
  'review-reply-owner@nailiq.invalid', '', statement_timestamp(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb, statement_timestamp()
);
INSERT INTO public.salon_members(salon_id, user_id, role)
VALUES (
  '17800000-0000-4000-8000-000000000001',
  '17800000-0000-4000-8000-000000000011',
  'owner'
);

DO $review_reply_behavior$
DECLARE
  v_salon_a uuid := '17800000-0000-4000-8000-000000000001';
  v_salon_b uuid := '17800000-0000-4000-8000-000000000002';
  v_owner uuid := '17800000-0000-4000-8000-000000000011';
  v_outsider uuid := '17800000-0000-4000-8000-000000000012';
  v_key text := repeat('a', 64);
  v_retry_key text := repeat('b', 64);
  v_first record;
  v_duplicate record;
  v_completed record;
  v_replayed record;
  v_retry record;
  v_other_salon record;
  v_approval public.approval_requests%ROWTYPE;
  v_transition record;
  v_update text;
BEGIN
  SELECT * INTO v_first FROM public.claim_review_reply_draft(
    v_salon_a, 'google', v_key, v_key
  );
  IF v_first.outcome <> 'claimed' OR v_first.attempt_count <> 1
     OR v_first.claim_token IS NULL THEN
    RAISE EXCEPTION 'first review claim failed: %', row_to_json(v_first);
  END IF;

  SELECT * INTO v_duplicate FROM public.claim_review_reply_draft(
    v_salon_a, 'google', v_key, v_key
  );
  IF v_duplicate.outcome <> 'in_progress'
     OR v_duplicate.claim_token IS NOT NULL THEN
    RAISE EXCEPTION 'duplicate in-flight review was claimed: %', row_to_json(v_duplicate);
  END IF;

  SELECT * INTO v_completed FROM public.complete_review_reply_draft(
    v_first.claim_id,
    v_first.claim_token,
    'QA Guest',
    2,
    'Dịch vụ chưa như mong đợi.',
    'Cảm ơn bạn đã chia sẻ phản hồi. Chúng tôi mong được hiểu rõ hơn về trải nghiệm của bạn.',
    'vi'
  );
  IF v_completed.outcome <> 'created' OR v_completed.approval_request_id IS NULL THEN
    RAISE EXCEPTION 'review draft completion failed: %', row_to_json(v_completed);
  END IF;

  SELECT * INTO v_approval FROM public.approval_requests
  WHERE id = v_completed.approval_request_id;
  IF v_approval.action_type <> 'review_reply_draft'
     OR v_approval.urgency <> 'urgent'
     OR v_approval.status <> 'pending'
     OR v_approval.notified_at IS NOT NULL
     OR v_approval.review_reply_claim_id <> v_first.claim_id
     OR v_approval.payload->>'notification_mode' <> 'dashboard_only_no_email'
     OR v_approval.payload->>'execution_mode' <> 'manual_copy_only'
     OR v_approval.payload->>'delivery_mode' <> 'draft_only_human_copy_required'
     OR (v_approval.payload->>'dispatch_enabled')::boolean IS NOT FALSE THEN
    RAISE EXCEPTION 'dashboard-only draft policy drifted: %', row_to_json(v_approval);
  END IF;

  SELECT * INTO v_replayed FROM public.complete_review_reply_draft(
    v_first.claim_id,
    v_first.claim_token,
    'QA Guest', 2, 'Dịch vụ chưa như mong đợi.',
    'Cảm ơn bạn đã chia sẻ phản hồi. Chúng tôi mong được hiểu rõ hơn về trải nghiệm của bạn.',
    'vi'
  );
  IF v_replayed.outcome <> 'existing'
     OR v_replayed.approval_request_id <> v_completed.approval_request_id
     OR (SELECT count(*) FROM public.approval_requests
         WHERE review_reply_claim_id = v_first.claim_id) <> 1 THEN
    RAISE EXCEPTION 'review completion replay duplicated approval';
  END IF;

  v_update := public.update_review_reply_draft_as_actor(
    v_completed.approval_request_id, v_outsider,
    'Cảm ơn bạn. Chúng tôi mong được hiểu rõ hơn về trải nghiệm của bạn.'
  );
  IF v_update <> 'forbidden' THEN
    RAISE EXCEPTION 'cross-salon/outsider draft edit accepted: %', v_update;
  END IF;
  v_update := public.update_review_reply_draft_as_actor(
    v_completed.approval_request_id, v_owner,
    'Cảm ơn bạn đã góp ý. Chúng tôi mong được trao đổi để hiểu rõ hơn trải nghiệm của bạn.'
  );
  IF v_update <> 'updated'
     OR (SELECT payload->>'draft_reply' FROM public.approval_requests
         WHERE id = v_completed.approval_request_id)
        <> 'Cảm ơn bạn đã góp ý. Chúng tôi mong được trao đổi để hiểu rõ hơn trải nghiệm của bạn.' THEN
    RAISE EXCEPTION 'owner draft edit failed: %', v_update;
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
         AND job.result->>'blocker' = 'dispatch_not_enabled'
     )
     OR EXISTS (
       SELECT 1 FROM public.approval_requests ar
       WHERE ar.id = v_completed.approval_request_id
         AND ar.notified_at IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'manual-copy approval gained dispatch capability: %', row_to_json(v_transition);
  END IF;

  -- The same opaque key is independent across salons.
  SELECT * INTO v_other_salon FROM public.claim_review_reply_draft(
    v_salon_b, 'google', v_key, v_key
  );
  IF v_other_salon.outcome <> 'claimed' THEN
    RAISE EXCEPTION 'salon-scoped claim isolation failed: %', row_to_json(v_other_salon);
  END IF;

  -- Failed claims retry at most three total attempts.
  SELECT * INTO v_retry FROM public.claim_review_reply_draft(
    v_salon_a, 'google', v_retry_key, v_retry_key
  );
  IF NOT public.fail_review_reply_draft(
    v_retry.claim_id, v_retry.claim_token, 'provider_timeout'
  ) THEN RAISE EXCEPTION 'attempt 1 failure was not recorded'; END IF;
  SELECT * INTO v_retry FROM public.claim_review_reply_draft(
    v_salon_a, 'google', v_retry_key, v_retry_key
  );
  IF v_retry.outcome <> 'claimed' OR v_retry.attempt_count <> 2 THEN
    RAISE EXCEPTION 'attempt 2 was not claimed';
  END IF;
  PERFORM public.fail_review_reply_draft(
    v_retry.claim_id, v_retry.claim_token, 'provider_timeout'
  );
  SELECT * INTO v_retry FROM public.claim_review_reply_draft(
    v_salon_a, 'google', v_retry_key, v_retry_key
  );
  IF v_retry.outcome <> 'claimed' OR v_retry.attempt_count <> 3 THEN
    RAISE EXCEPTION 'attempt 3 was not claimed';
  END IF;
  PERFORM public.fail_review_reply_draft(
    v_retry.claim_id, v_retry.claim_token, 'provider_timeout'
  );
  SELECT * INTO v_retry FROM public.claim_review_reply_draft(
    v_salon_a, 'google', v_retry_key, v_retry_key
  );
  IF v_retry.outcome <> 'exhausted' OR v_retry.attempt_count <> 3 THEN
    RAISE EXCEPTION 'retry ceiling drifted: %', row_to_json(v_retry);
  END IF;
END;
$review_reply_behavior$;

ROLLBACK;

DO $review_reply_cleanup$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.salons
    WHERE id IN (
      '17800000-0000-4000-8000-000000000001',
      '17800000-0000-4000-8000-000000000002'
    )
  ) OR EXISTS (
    SELECT 1 FROM auth.users
    WHERE id = '17800000-0000-4000-8000-000000000011'
  ) THEN
    RAISE EXCEPTION 'review reply rehearsal left fixture rows';
  END IF;
END;
$review_reply_cleanup$;

SELECT 'review_reply_draft_rehearsal_pass' AS result;
