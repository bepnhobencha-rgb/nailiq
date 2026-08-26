-- MQA-0178: every Google review response is a dashboard-only draft. The
-- provider call is claimed before generation, and no approval can email,
-- auto-post, or dispatch the draft.

CREATE TABLE public.review_reply_draft_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  source text NOT NULL,
  review_key text NOT NULL,
  content_fingerprint text NOT NULL,
  status text NOT NULL DEFAULT 'processing',
  claim_token uuid NOT NULL DEFAULT gen_random_uuid(),
  attempt_count integer NOT NULL DEFAULT 1,
  claimed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  drafted_at timestamptz,
  failed_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT review_reply_draft_claims_source_check
    CHECK (source IN ('google')),
  CONSTRAINT review_reply_draft_claims_review_key_check
    CHECK (review_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT review_reply_draft_claims_content_fingerprint_check
    CHECK (content_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT review_reply_draft_claims_status_check
    CHECK (status IN ('processing', 'drafted', 'failed')),
  CONSTRAINT review_reply_draft_claims_attempt_count_check
    CHECK (attempt_count BETWEEN 1 AND 3),
  CONSTRAINT review_reply_draft_claims_last_error_check
    CHECK (last_error_code IS NULL OR (
      length(last_error_code) BETWEEN 1 AND 120
      AND last_error_code ~ '^[a-z0-9_:-]+$'
    )),
  CONSTRAINT review_reply_draft_claims_source_key_unique
    UNIQUE (salon_id, source, review_key)
);

CREATE INDEX review_reply_draft_claims_processing_idx
  ON public.review_reply_draft_claims (status, claimed_at, id)
  WHERE status = 'processing';

ALTER TABLE public.review_reply_draft_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.review_reply_draft_claims FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.review_reply_draft_claims
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.review_reply_draft_claims TO service_role;

ALTER TABLE public.approval_requests
  ADD COLUMN review_reply_claim_id uuid
    REFERENCES public.review_reply_draft_claims(id);

CREATE UNIQUE INDEX approval_requests_review_reply_claim_once_idx
  ON public.approval_requests (review_reply_claim_id)
  WHERE review_reply_claim_id IS NOT NULL;

COMMENT ON TABLE public.review_reply_draft_claims IS
  'PII-free atomic claim ledger for dashboard-only Google review reply drafts. No provider payload or reply text is stored here.';
COMMENT ON COLUMN public.approval_requests.review_reply_claim_id IS
  'Links one dashboard-only review reply draft to its single-winner provider claim.';

CREATE OR REPLACE FUNCTION public.claim_review_reply_draft(
  p_salon_id uuid,
  p_source text,
  p_review_key text,
  p_content_fingerprint text
)
RETURNS TABLE (
  outcome text,
  claim_id uuid,
  claim_token uuid,
  attempt_count integer
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO ''
AS $claim_review_reply$
DECLARE
  v_now timestamptz := statement_timestamp();
  v_claim public.review_reply_draft_claims%ROWTYPE;
BEGIN
  IF p_salon_id IS NULL
     OR p_source <> 'google'
     OR p_review_key !~ '^[0-9a-f]{64}$'
     OR p_content_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RETURN QUERY SELECT 'invalid_input'::text, NULL::uuid, NULL::uuid, NULL::integer;
    RETURN;
  END IF;

  INSERT INTO public.review_reply_draft_claims (
    salon_id, source, review_key, content_fingerprint,
    status, claim_token, attempt_count, claimed_at, updated_at
  ) VALUES (
    p_salon_id, p_source, p_review_key, p_content_fingerprint,
    'processing', extensions.gen_random_uuid(), 1, v_now, v_now
  )
  ON CONFLICT (salon_id, source, review_key) DO NOTHING
  RETURNING * INTO v_claim;

  IF FOUND THEN
    RETURN QUERY
      SELECT 'claimed'::text, v_claim.id, v_claim.claim_token, v_claim.attempt_count;
    RETURN;
  END IF;

  SELECT claim.* INTO v_claim
  FROM public.review_reply_draft_claims claim
  WHERE claim.salon_id = p_salon_id
    AND claim.source = p_source
    AND claim.review_key = p_review_key
  FOR UPDATE;

  IF v_claim.status = 'drafted' THEN
    RETURN QUERY
      SELECT 'existing'::text, v_claim.id, NULL::uuid, v_claim.attempt_count;
    RETURN;
  END IF;

  IF v_claim.status = 'processing'
     AND v_claim.claimed_at > v_now - interval '20 minutes' THEN
    RETURN QUERY
      SELECT 'in_progress'::text, v_claim.id, NULL::uuid, v_claim.attempt_count;
    RETURN;
  END IF;

  IF v_claim.attempt_count >= 3 THEN
    RETURN QUERY
      SELECT 'exhausted'::text, v_claim.id, NULL::uuid, v_claim.attempt_count;
    RETURN;
  END IF;

  UPDATE public.review_reply_draft_claims claim
  SET status = 'processing',
      content_fingerprint = p_content_fingerprint,
      claim_token = extensions.gen_random_uuid(),
      attempt_count = claim.attempt_count + 1,
      claimed_at = v_now,
      failed_at = NULL,
      last_error_code = NULL,
      updated_at = v_now
  WHERE claim.id = v_claim.id
  RETURNING * INTO v_claim;

  RETURN QUERY
    SELECT 'claimed'::text, v_claim.id, v_claim.claim_token, v_claim.attempt_count;
END;
$claim_review_reply$;

CREATE OR REPLACE FUNCTION public.complete_review_reply_draft(
  p_claim_id uuid,
  p_claim_token uuid,
  p_reviewer_name text,
  p_rating integer,
  p_review_excerpt text,
  p_draft_reply text,
  p_language text
)
RETURNS TABLE (
  outcome text,
  approval_request_id uuid
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO ''
AS $complete_review_reply$
DECLARE
  v_now timestamptz := statement_timestamp();
  v_claim public.review_reply_draft_claims%ROWTYPE;
  v_approval_id uuid;
  v_urgency text;
BEGIN
  IF p_claim_id IS NULL OR p_claim_token IS NULL
     OR p_rating NOT BETWEEN 1 AND 5
     OR p_language NOT IN ('en', 'vi', 'fr')
     OR length(trim(coalesce(p_reviewer_name, ''))) NOT BETWEEN 1 AND 120
     OR length(coalesce(p_review_excerpt, '')) > 1200
     OR length(trim(coalesce(p_draft_reply, ''))) NOT BETWEEN 10 AND 800
     OR p_draft_reply ~ '[[:cntrl:]]'
     OR p_draft_reply ~* '(https?://|www\.|[[:alnum:]._%+-]+@[[:alnum:].-]+\.[[:alpha:]]{2,})'
     OR p_draft_reply ~ '\+?[0-9][0-9 ()-]{6,}[0-9]' THEN
    RETURN QUERY SELECT 'invalid_input'::text, NULL::uuid;
    RETURN;
  END IF;

  SELECT claim.* INTO v_claim
  FROM public.review_reply_draft_claims claim
  WHERE claim.id = p_claim_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid;
    RETURN;
  END IF;

  SELECT ar.id INTO v_approval_id
  FROM public.approval_requests ar
  WHERE ar.review_reply_claim_id = v_claim.id;
  IF FOUND THEN
    IF v_claim.status <> 'drafted' THEN
      UPDATE public.review_reply_draft_claims
      SET status = 'drafted', drafted_at = coalesce(drafted_at, v_now),
          updated_at = v_now
      WHERE id = v_claim.id;
    END IF;
    RETURN QUERY SELECT 'existing'::text, v_approval_id;
    RETURN;
  END IF;

  IF v_claim.status <> 'processing'
     OR v_claim.claim_token IS DISTINCT FROM p_claim_token THEN
    RETURN QUERY SELECT 'claim_lost'::text, NULL::uuid;
    RETURN;
  END IF;

  v_urgency := CASE WHEN p_rating <= 3 THEN 'urgent' ELSE 'normal' END;

  INSERT INTO public.approval_requests (
    salon_id, action_type, summary, payload, urgency, status, expires_at,
    review_reply_claim_id
  ) VALUES (
    v_claim.salon_id,
    'review_reply_draft',
    format(
      'Review %s-star Google reply draft. No reply or email will be sent automatically.',
      p_rating
    ),
    pg_catalog.jsonb_build_object(
      'proposal_source', 'google_review_responder',
      'review_source', v_claim.source,
      'review_key', v_claim.review_key,
      'reviewer_name', left(trim(p_reviewer_name), 120),
      'rating', p_rating,
      'review_excerpt', left(p_review_excerpt, 1200),
      'draft_reply', trim(p_draft_reply),
      'language', p_language,
      'notification_mode', 'dashboard_only_no_email',
      'execution_mode', 'manual_copy_only',
      'delivery_mode', 'draft_only_human_copy_required',
      'dispatch_enabled', false,
      'reason', 'Prepare a same-language response for owner/admin review.',
      'evidence', pg_catalog.jsonb_build_array(
        'Draft is grounded only in the bounded public review excerpt.'
      ),
      'expected_impact', 'No public or outbound action occurs; owner/admin may edit and copy the draft manually.',
      'confidence', 0.6,
      'reversible', true
    ),
    v_urgency,
    'pending',
    v_now + interval '7 days',
    v_claim.id
  )
  ON CONFLICT (review_reply_claim_id)
    WHERE review_reply_claim_id IS NOT NULL
    DO NOTHING
  RETURNING id INTO v_approval_id;

  IF v_approval_id IS NULL THEN
    SELECT ar.id INTO v_approval_id
    FROM public.approval_requests ar
    WHERE ar.review_reply_claim_id = v_claim.id;
  END IF;

  UPDATE public.review_reply_draft_claims
  SET status = 'drafted', drafted_at = v_now, last_error_code = NULL,
      updated_at = v_now
  WHERE id = v_claim.id;

  RETURN QUERY SELECT 'created'::text, v_approval_id;
END;
$complete_review_reply$;

CREATE OR REPLACE FUNCTION public.fail_review_reply_draft(
  p_claim_id uuid,
  p_claim_token uuid,
  p_error_code text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO ''
AS $fail_review_reply$
DECLARE
  v_now timestamptz := statement_timestamp();
BEGIN
  IF p_claim_id IS NULL OR p_claim_token IS NULL
     OR p_error_code !~ '^[a-z0-9_:-]{1,120}$' THEN
    RETURN false;
  END IF;

  UPDATE public.review_reply_draft_claims claim
  SET status = 'failed', failed_at = v_now,
      last_error_code = p_error_code, updated_at = v_now
  WHERE claim.id = p_claim_id
    AND claim.status = 'processing'
    AND claim.claim_token = p_claim_token;
  RETURN FOUND;
END;
$fail_review_reply$;

CREATE OR REPLACE FUNCTION public.update_review_reply_draft_as_actor(
  p_approval_id uuid,
  p_actor_user_id uuid,
  p_draft_reply text
)
RETURNS text
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO ''
AS $update_review_reply$
DECLARE
  v_now timestamptz := statement_timestamp();
  v_request public.approval_requests%ROWTYPE;
BEGIN
  IF p_approval_id IS NULL OR p_actor_user_id IS NULL
     OR length(trim(coalesce(p_draft_reply, ''))) NOT BETWEEN 10 AND 800
     OR p_draft_reply ~ '[[:cntrl:]]'
     OR p_draft_reply ~* '(https?://|www\.|[[:alnum:]._%+-]+@[[:alnum:].-]+\.[[:alpha:]]{2,})'
     OR p_draft_reply ~ '\+?[0-9][0-9 ()-]{6,}[0-9]' THEN
    RETURN 'invalid_input';
  END IF;

  SELECT ar.* INTO v_request
  FROM public.approval_requests ar
  WHERE ar.id = p_approval_id
  FOR UPDATE;

  IF NOT FOUND OR v_request.action_type <> 'review_reply_draft'
     OR v_request.review_reply_claim_id IS NULL THEN
    RETURN 'not_found';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.salon_members sm
    WHERE sm.salon_id = v_request.salon_id
      AND sm.user_id = p_actor_user_id
      AND sm.role IN ('owner', 'admin')
  ) THEN
    RETURN 'forbidden';
  END IF;
  IF v_request.status <> 'pending' THEN
    RETURN 'already_decided';
  END IF;
  IF v_request.expires_at < v_now THEN
    UPDATE public.approval_requests SET status = 'expired'
    WHERE id = v_request.id;
    RETURN 'expired';
  END IF;

  UPDATE public.approval_requests
  SET payload = pg_catalog.jsonb_set(
    pg_catalog.jsonb_set(
      pg_catalog.jsonb_set(payload, '{draft_reply}', pg_catalog.to_jsonb(trim(p_draft_reply))),
      '{edited_at}', pg_catalog.to_jsonb(v_now)
    ),
    '{edited_by}', pg_catalog.to_jsonb(p_actor_user_id)
  )
  WHERE id = v_request.id;

  RETURN 'updated';
END;
$update_review_reply$;

REVOKE ALL ON FUNCTION public.claim_review_reply_draft(uuid, text, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_review_reply_draft(
  uuid, uuid, text, integer, text, text, text
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_review_reply_draft(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.update_review_reply_draft_as_actor(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_review_reply_draft(uuid, text, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_review_reply_draft(
  uuid, uuid, text, integer, text, text, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_review_reply_draft(uuid, uuid, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.update_review_reply_draft_as_actor(uuid, uuid, text)
  TO service_role;

COMMENT ON FUNCTION public.claim_review_reply_draft(uuid, text, text, text) IS
  'Single-winner claim before any review-reply provider generation; retries failed/stale work at most three times.';
COMMENT ON FUNCTION public.complete_review_reply_draft(
  uuid, uuid, text, integer, text, text, text
) IS 'Creates exactly one dashboard-only manual-copy approval draft and performs no send or public post.';
COMMENT ON FUNCTION public.update_review_reply_draft_as_actor(uuid, uuid, text) IS
  'Allows only a same-salon owner/admin to edit a still-pending review reply draft.';

DO $review_reply_privilege_proof$
BEGIN
  IF NOT (
    has_table_privilege('service_role', 'public.review_reply_draft_claims', 'SELECT,INSERT,UPDATE,DELETE')
    AND NOT has_table_privilege('anon', 'public.review_reply_draft_claims', 'SELECT')
    AND NOT has_table_privilege('authenticated', 'public.review_reply_draft_claims', 'SELECT')
    AND has_function_privilege('service_role', 'public.claim_review_reply_draft(uuid,text,text,text)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.claim_review_reply_draft(uuid,text,text,text)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.claim_review_reply_draft(uuid,text,text,text)', 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'review reply least-privilege proof failed';
  END IF;
END;
$review_reply_privilege_proof$;
