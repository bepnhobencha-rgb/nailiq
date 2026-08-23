\set ON_ERROR_STOP on

BEGIN;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', true);

INSERT INTO public.salons(id, slug, name, phone, timezone, is_beta)
VALUES
  ('18100000-0000-4000-8000-000000000001', 'reactivation-qa-a',
   'Reactivation QA A', '+16045551811', 'UTC', true),
  ('18100000-0000-4000-8000-000000000002', 'reactivation-qa-b',
   'Reactivation QA B', '+16045551812', 'UTC', true);

INSERT INTO auth.users(
  id, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at
) VALUES (
  '18100000-0000-4000-8000-000000000011',
  'reactivation-owner@nailiq.invalid', '', statement_timestamp(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb, statement_timestamp()
);
INSERT INTO public.salon_members(salon_id, user_id, role)
VALUES (
  '18100000-0000-4000-8000-000000000001',
  '18100000-0000-4000-8000-000000000011',
  'owner'
);

INSERT INTO public.client_profiles(id, phone, name, email)
VALUES (
  '18100000-0000-4000-8000-000000000021',
  '16045551821', 'Manifest Fixture', 'manifest@nailiq.invalid'
);

DO $reactivation_behavior$
DECLARE
  v_salon_a uuid := '18100000-0000-4000-8000-000000000001';
  v_salon_b uuid := '18100000-0000-4000-8000-000000000002';
  v_owner uuid := '18100000-0000-4000-8000-000000000011';
  v_outsider uuid := '18100000-0000-4000-8000-000000000012';
  v_profile uuid := '18100000-0000-4000-8000-000000000021';
  v_first record;
  v_duplicate record;
  v_other record;
  v_transition record;
  v_manifest record;
  v_release record;
  v_approval public.approval_requests%rowtype;
  v_update text;
  v_fingerprint text;
  v_summary jsonb;
BEGIN
  SELECT * INTO v_first
  FROM public.create_reactivation_campaign_draft(
    v_salon_a, 'winback', date '2026-08-17',
    'Win-back campaign draft',
    'We would love to welcome you back when you are ready to visit.',
    'Tiệm rất mong được đón bạn quay lại khi bạn thấy thuận tiện.'
  );
  IF v_first.outcome <> 'created' OR v_first.approval_request_id IS NULL THEN
    RAISE EXCEPTION 'first reactivation draft failed: %', row_to_json(v_first);
  END IF;

  SELECT * INTO v_duplicate
  FROM public.create_reactivation_campaign_draft(
    v_salon_a, 'winback', date '2026-08-17',
    'Win-back campaign draft',
    'We would love to welcome you back when you are ready to visit.',
    'Tiệm rất mong được đón bạn quay lại khi bạn thấy thuận tiện.'
  );
  IF v_duplicate.outcome <> 'existing'
     OR v_duplicate.approval_request_id <> v_first.approval_request_id
     OR (SELECT count(*) FROM public.approval_requests
         WHERE reactivation_campaign_claim_id IS NOT NULL) <> 1 THEN
    RAISE EXCEPTION 'reactivation replay duplicated approval: %', row_to_json(v_duplicate);
  END IF;

  SELECT * INTO v_approval FROM public.approval_requests
  WHERE id = v_first.approval_request_id;
  IF v_approval.status <> 'pending'
     OR v_approval.notified_at IS NOT NULL
     OR v_approval.payload->>'proposal_source' <> 'reactivation_campaign'
     OR v_approval.payload->>'reactivation_kind' <> 'winback'
     OR v_approval.payload->>'notification_mode' <> 'dashboard_only_no_email'
     OR v_approval.payload->>'delivery_mode' <> 'no_dispatch'
     OR (v_approval.payload->>'dispatch_enabled')::boolean IS NOT FALSE
     OR (v_approval.payload->>'recipient_selection_required')::boolean IS NOT TRUE
     OR (v_approval.payload->>'no_messages_sent')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'reactivation dashboard-only contract drifted: %', row_to_json(v_approval);
  END IF;

  v_update := public.update_reactivation_campaign_draft_as_actor(
    v_first.approval_request_id, v_outsider,
    'We would love to welcome you back when you are ready to visit.',
    'Tiệm rất mong được đón bạn quay lại khi bạn thấy thuận tiện.'
  );
  IF v_update <> 'forbidden' THEN
    RAISE EXCEPTION 'outsider reactivation edit accepted: %', v_update;
  END IF;

  v_update := public.update_reactivation_campaign_draft_as_actor(
    v_first.approval_request_id, v_owner,
    'Come back for a free service when you are ready to visit.',
    'Tiệm rất mong được đón bạn quay lại khi bạn thấy thuận tiện.'
  );
  IF v_update <> 'invalid_draft' THEN
    RAISE EXCEPTION 'unsafe reactivation offer accepted: %', v_update;
  END IF;

  v_update := public.update_reactivation_campaign_draft_as_actor(
    v_first.approval_request_id, v_owner,
    'We would be happy to welcome you back whenever you are ready.',
    'Tiệm rất vui được đón bạn quay lại bất cứ khi nào thuận tiện.'
  );
  IF v_update <> 'updated' THEN
    RAISE EXCEPTION 'owner reactivation edit failed: %', v_update;
  END IF;

  SELECT * INTO v_transition
  FROM public.decide_ai_approval_request_as_actor(
    v_first.approval_request_id, 'approved', v_owner
  );
  IF v_transition.outcome <> 'approved_queued'
     OR v_transition.execution_status <> 'waiting_input'
     OR NOT EXISTS (
       SELECT 1 FROM public.ai_execution_jobs job
       WHERE job.id = v_transition.execution_job_id
         AND job.result->>'blocker' = 'recipient_selection_required'
     ) THEN
    RAISE EXCEPTION 'first approval gained dispatch: %', row_to_json(v_transition);
  END IF;

  v_fingerprint := left(encode(extensions.digest(convert_to(
    lower(v_profile::text) || ':se', 'UTF8'
  ), 'sha256'), 'hex'), 24);
  v_summary := jsonb_build_object(
    'prepared_at', statement_timestamp(),
    'segment', 'winback_lapsed_regulars_45_365_days',
    'candidate_count', 1,
    'eligible_count', 1,
    'sms_recipient_count', 1,
    'email_recipient_count', 1,
    'dual_channel_count', 1,
    'excluded_no_consent', 0,
    'excluded_no_channel', 0,
    'excluded_recent_contact', 0,
    'estimated_cost_usd_cents', 0.89,
    'candidate_limit', 500,
    'may_have_more_candidates', false,
    'audience_fingerprint', v_fingerprint,
    'no_messages_sent', true
  );

  SELECT * INTO v_manifest
  FROM public.record_reactivation_campaign_manifest(
    v_transition.execution_job_id,
    v_salon_a,
    v_summary,
    jsonb_build_array(jsonb_build_object(
      'client_profile_id', v_profile,
      'sms', true,
      'email', true
    )),
    statement_timestamp()
  );
  IF v_manifest.outcome <> 'created'
     OR v_manifest.manifest_id IS NULL
     OR v_manifest.release_approval_id IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM public.approval_requests release_request
       WHERE release_request.id = v_manifest.release_approval_id
         AND release_request.status = 'pending'
         AND release_request.payload->>'notification_mode' = 'dashboard_only_no_email'
         AND (release_request.payload->>'dispatch_enabled')::boolean IS FALSE
         AND (release_request.payload->>'no_messages_sent')::boolean IS TRUE
     ) THEN
    RAISE EXCEPTION 'reactivation manifest/release failed: %', row_to_json(v_manifest);
  END IF;

  SELECT * INTO v_release
  FROM public.decide_ai_approval_request_as_actor(
    v_manifest.release_approval_id, 'approved', v_owner
  );
  IF v_release.outcome <> 'approved_queued'
     OR v_release.execution_status <> 'waiting_input'
     OR NOT EXISTS (
       SELECT 1 FROM public.ai_execution_jobs release_job
       WHERE release_job.id = v_release.execution_job_id
         AND release_job.result->>'blocker' = 'dispatch_not_enabled'
     ) THEN
    RAISE EXCEPTION 'second approval enabled dispatch: %', row_to_json(v_release);
  END IF;

  SELECT * INTO v_other
  FROM public.create_reactivation_campaign_draft(
    v_salon_b, 'rebook', date '2026-08-17',
    'Rebook campaign draft',
    'It may be time for your next visit when you are ready.',
    'Có thể đã đến lúc cho lần ghé tiếp theo khi bạn thấy thuận tiện.'
  );
  IF v_other.outcome <> 'created' THEN
    RAISE EXCEPTION 'salon/kind isolation failed: %', row_to_json(v_other);
  END IF;

  PERFORM * FROM public.marketing_rebook_audience_candidates(
    v_salon_a, 3, 14, 30, 500
  );
END;
$reactivation_behavior$;

ROLLBACK;

DO $reactivation_cleanup$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.salons
    WHERE id IN (
      '18100000-0000-4000-8000-000000000001',
      '18100000-0000-4000-8000-000000000002'
    )
  ) OR EXISTS (
    SELECT 1 FROM auth.users
    WHERE id = '18100000-0000-4000-8000-000000000011'
  ) OR EXISTS (
    SELECT 1 FROM public.client_profiles
    WHERE id = '18100000-0000-4000-8000-000000000021'
  ) THEN
    RAISE EXCEPTION 'reactivation rehearsal left fixture rows';
  END IF;
END;
$reactivation_cleanup$;

SELECT 'reactivation_campaign_draft_rehearsal_pass' AS result;
