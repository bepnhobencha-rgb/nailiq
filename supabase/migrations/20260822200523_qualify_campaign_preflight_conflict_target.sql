-- Keep the immutable campaign preflight evidence writer executable under
-- PL/pgSQL's default variable-conflict rules. The RETURNS TABLE output variable
-- `preflight_id` otherwise makes the column-list conflict target ambiguous.
-- Naming the existing primary-key constraint preserves the same idempotent
-- semantics without weakening the insert or changing any dispatch gate.

CREATE OR REPLACE FUNCTION public.record_ai_campaign_preflight_evidence(
  p_job_id uuid,
  p_salon_id uuid,
  p_summary jsonb,
  p_decisions jsonb
)
RETURNS TABLE (
  outcome text,
  preflight_id uuid,
  preflight_status text,
  preflight_fingerprint text,
  valid_until timestamptz,
  decision_count integer
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_result record;
  v_inserted_count integer;
  v_stored_count integer;
BEGIN
  SELECT *
    INTO v_result
    FROM public.record_ai_campaign_dispatch_preflight_fresh(
      p_job_id,
      p_salon_id,
      p_summary,
      p_decisions
    );

  IF v_result.outcome NOT IN ('created', 'unchanged', 'refreshed')
     OR v_result.preflight_id IS NULL THEN
    RETURN QUERY
      SELECT
        v_result.outcome,
        v_result.preflight_id,
        v_result.preflight_status,
        v_result.preflight_fingerprint,
        v_result.valid_until,
        NULL::integer;
    RETURN;
  END IF;

  INSERT INTO public.ai_campaign_dispatch_preflight_decisions (
    preflight_id,
    salon_id,
    client_profile_id,
    sms,
    email,
    exclusion,
    created_at
  )
  SELECT
    v_result.preflight_id,
    p_salon_id,
    (item ->> 'client_profile_id')::uuid,
    (item ->> 'sms')::boolean,
    (item ->> 'email')::boolean,
    item ->> 'exclusion',
    statement_timestamp()
  FROM jsonb_array_elements(p_decisions) item
  ON CONFLICT ON CONSTRAINT ai_campaign_dispatch_preflight_decisions_pkey
    DO NOTHING;

  GET DIAGNOSTICS v_inserted_count = ROW_COUNT;

  SELECT count(*)
    INTO v_stored_count
    FROM public.ai_campaign_dispatch_preflight_decisions decision_row
   WHERE decision_row.preflight_id = v_result.preflight_id
     AND decision_row.salon_id = p_salon_id;

  IF v_stored_count <> jsonb_array_length(p_decisions)
     OR EXISTS (
       (
         SELECT
           decision_row.client_profile_id::text,
           decision_row.sms,
           decision_row.email,
           decision_row.exclusion
         FROM public.ai_campaign_dispatch_preflight_decisions decision_row
         WHERE decision_row.preflight_id = v_result.preflight_id
       )
       EXCEPT
       (
         SELECT
           item ->> 'client_profile_id',
           (item ->> 'sms')::boolean,
           (item ->> 'email')::boolean,
           item ->> 'exclusion'
         FROM jsonb_array_elements(p_decisions) item
       )
     )
     OR EXISTS (
       (
         SELECT
           item ->> 'client_profile_id',
           (item ->> 'sms')::boolean,
           (item ->> 'email')::boolean,
           item ->> 'exclusion'
         FROM jsonb_array_elements(p_decisions) item
       )
       EXCEPT
       (
         SELECT
           decision_row.client_profile_id::text,
           decision_row.sms,
           decision_row.email,
           decision_row.exclusion
         FROM public.ai_campaign_dispatch_preflight_decisions decision_row
         WHERE decision_row.preflight_id = v_result.preflight_id
       )
     ) THEN
    RAISE EXCEPTION 'campaign_preflight_decisions_mismatch'
      USING ERRCODE = '40001';
  END IF;

  IF v_inserted_count > 0 THEN
    INSERT INTO public.ai_actions_log (
      salon_id,
      agent,
      action_type,
      target_id,
      payload,
      created_at
    ) VALUES (
      p_salon_id,
      'execution_worker',
      'campaign_dispatch_preflight_decisions_recorded',
      p_job_id,
      jsonb_build_object(
        'preflight_id', v_result.preflight_id,
        'decision_count', v_stored_count,
        'dispatch_enabled', false,
        'no_messages_sent', true
      ),
      statement_timestamp()
    );
  END IF;

  RETURN QUERY
    SELECT
      v_result.outcome,
      v_result.preflight_id,
      v_result.preflight_status,
      v_result.preflight_fingerprint,
      v_result.valid_until,
      v_stored_count;
END;
$$;

REVOKE ALL ON FUNCTION public.record_ai_campaign_preflight_evidence(
  uuid, uuid, jsonb, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_ai_campaign_preflight_evidence(
  uuid, uuid, jsonb, jsonb
) TO service_role;

COMMENT ON FUNCTION public.record_ai_campaign_preflight_evidence(
  uuid, uuid, jsonb, jsonb
) IS
  'Records fresh campaign preflight evidence plus exact PII-free recipient/channel decisions.';
