-- MQA-0148: consume several independent edge requests in one PostgREST call
-- without weakening the existing fail-closed, fixed-window limiter. The input
-- is an ordered JSON array of request arrays; overlapping logical keys are
-- rejected before the first write so every returned boolean remains positional.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.rate_limit_hit_request_batch(
  p_requests jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_request_count integer;
  v_bucket_count integer;
  v_distinct_key_count integer;
  v_upserted_count integer;
  v_returned_request_count integer;
  v_results jsonb;
BEGIN
  IF p_requests IS NULL
     OR pg_catalog.jsonb_typeof(p_requests) <> 'array' THEN
    RETURN NULL;
  END IF;

  v_request_count := pg_catalog.jsonb_array_length(p_requests);
  IF v_request_count < 1 OR v_request_count > 32 THEN
    RETURN NULL;
  END IF;

  -- Prove every request is an array before calling jsonb_array_length on it.
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_requests)
      AS request(request_json)
    WHERE pg_catalog.jsonb_typeof(request.request_json) IS DISTINCT FROM 'array'
  ) THEN
    RETURN NULL;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_requests)
      AS request(request_json)
    WHERE pg_catalog.jsonb_array_length(request.request_json) < 1
       OR pg_catalog.jsonb_array_length(request.request_json) > 4
  ) THEN
    RETURN NULL;
  END IF;

  -- Prove every bucket is an object before inspecting its fields.
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_requests)
      AS request(request_json)
    CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(request.request_json)
      AS bucket(bucket_json)
    WHERE pg_catalog.jsonb_typeof(bucket.bucket_json) IS DISTINCT FROM 'object'
  ) THEN
    RETURN NULL;
  END IF;

  -- CASE guards every bigint cast. The strict decimal form accepts only
  -- positive JSON integers representable by the declared int4 parameters.
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_requests)
      AS request(request_json)
    CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(request.request_json)
      AS bucket(bucket_json)
    WHERE CASE
      WHEN pg_catalog.jsonb_typeof(bucket.bucket_json -> 'p_key') = 'string'
        THEN pg_catalog.length(bucket.bucket_json ->> 'p_key') NOT BETWEEN 1 AND 300
      ELSE true
    END
    OR CASE
      WHEN pg_catalog.jsonb_typeof(bucket.bucket_json -> 'p_limit') = 'number'
       AND (bucket.bucket_json ->> 'p_limit') ~ '^[1-9][0-9]{0,9}$'
        THEN (bucket.bucket_json ->> 'p_limit')::bigint > 2147483647
      ELSE true
    END
    OR CASE
      WHEN pg_catalog.jsonb_typeof(
        bucket.bucket_json -> 'p_window_seconds'
      ) = 'number'
       AND (bucket.bucket_json ->> 'p_window_seconds') ~ '^[1-9][0-9]{0,9}$'
        THEN (bucket.bucket_json ->> 'p_window_seconds')::bigint > 2147483647
      ELSE true
    END
  ) THEN
    RETURN NULL;
  END IF;

  SELECT
    pg_catalog.count(*)::integer,
    pg_catalog.count(DISTINCT bucket.bucket_json ->> 'p_key')::integer
  INTO v_bucket_count, v_distinct_key_count
  FROM pg_catalog.jsonb_array_elements(p_requests)
    AS request(request_json)
  CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(request.request_json)
    AS bucket(bucket_json);

  IF v_bucket_count < 1 OR v_bucket_count > 128 THEN
    RETURN NULL;
  END IF;

  -- This RPC deliberately accepts only disjoint logical request sets. Besides
  -- avoiding ambiguous per-request ordering, the global uniqueness proof also
  -- prevents one INSERT .. ON CONFLICT statement from touching a row twice.
  IF v_distinct_key_count IS DISTINCT FROM v_bucket_count THEN
    RETURN NULL;
  END IF;

  WITH flat AS MATERIALIZED (
    SELECT
      request.request_ordinal::integer AS request_ordinal,
      bucket.bucket_ordinal::integer AS bucket_ordinal,
      bucket.bucket_json ->> 'p_key' AS p_key,
      (bucket.bucket_json ->> 'p_limit')::integer AS p_limit,
      (bucket.bucket_json ->> 'p_window_seconds')::integer
        AS p_window_seconds
    FROM pg_catalog.jsonb_array_elements(p_requests) WITH ORDINALITY
      AS request(request_json, request_ordinal)
    CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(request.request_json)
      WITH ORDINALITY AS bucket(bucket_json, bucket_ordinal)
  ), prepared AS MATERIALIZED (
    SELECT
      flat.request_ordinal,
      flat.bucket_ordinal,
      flat.p_limit,
      flat.p_key || ':' || window_value.window_id::text AS bucket,
      pg_catalog.to_timestamp(
        (window_value.window_id + 2) * flat.p_window_seconds
      ) AS expires_at
    FROM flat
    CROSS JOIN LATERAL (
      SELECT pg_catalog.floor(
        pg_catalog.date_part('epoch', v_now) / flat.p_window_seconds
      )::bigint AS window_id
    ) AS window_value
  ), upserted AS (
    INSERT INTO public.rate_limits(bucket, count, expires_at)
    SELECT prepared.bucket, 1, prepared.expires_at
    FROM prepared
    ORDER BY prepared.bucket
    ON CONFLICT(bucket) DO UPDATE
      SET count = public.rate_limits.count + 1
    RETURNING bucket, count
  ), per_request AS (
    SELECT
      prepared.request_ordinal,
      pg_catalog.bool_and(
        upserted.count <= prepared.p_limit
      ) AS allowed,
      pg_catalog.count(*)::integer AS bucket_count
    FROM prepared
    JOIN upserted USING(bucket)
    GROUP BY prepared.request_ordinal
  )
  SELECT
    pg_catalog.jsonb_agg(
      per_request.allowed ORDER BY per_request.request_ordinal
    ),
    COALESCE(pg_catalog.sum(per_request.bucket_count), 0)::integer,
    pg_catalog.count(*)::integer
  INTO v_results, v_upserted_count, v_returned_request_count
  FROM per_request;

  IF v_upserted_count IS DISTINCT FROM v_bucket_count
     OR v_returned_request_count IS DISTINCT FROM v_request_count
     OR pg_catalog.jsonb_array_length(v_results) IS DISTINCT FROM v_request_count
  THEN
    RAISE EXCEPTION 'rate-limit request batch write cardinality mismatch';
  END IF;

  WITH expired AS (
    SELECT rate_limits.bucket
    FROM public.rate_limits
    WHERE rate_limits.expires_at < v_now - interval '1 hour'
    ORDER BY rate_limits.expires_at, rate_limits.bucket
    LIMIT 128
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.rate_limits
  USING expired
  WHERE rate_limits.bucket = expired.bucket;

  RETURN v_results;
END;
$$;

REVOKE ALL ON FUNCTION public.rate_limit_hit_request_batch(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rate_limit_hit_request_batch(jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.rate_limit_hit_request_batch(jsonb)
  FROM authenticated;
GRANT EXECUTE ON FUNCTION public.rate_limit_hit_request_batch(jsonb)
  TO service_role;

COMMENT ON FUNCTION public.rate_limit_hit_request_batch(jsonb) IS
  'Atomically consumes up to 32 ordered, globally disjoint edge request bucket arrays and returns one positional boolean per request; service-role only.';

DO $proof$
DECLARE
  v_oid regprocedure := pg_catalog.to_regprocedure(
    'public.rate_limit_hit_request_batch(jsonb)'
  );
  v_definition text;
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'rate_limit_hit_request_batch(jsonb) is missing';
  END IF;

  SELECT pg_catalog.pg_get_functiondef(v_oid)
    INTO v_definition;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc
    WHERE oid = v_oid
      AND prosecdef
      AND prorettype = 'jsonb'::pg_catalog.regtype
      AND proconfig @> ARRAY['search_path=""']::text[]
  ) OR pg_catalog.has_function_privilege(
    'anon', v_oid, 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated', v_oid, 'EXECUTE'
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role', v_oid, 'EXECUTE'
  ) OR pg_catalog.strpos(v_definition, 'INSERT INTO public.rate_limits') = 0
    OR pg_catalog.strpos(v_definition, 'ORDER BY prepared.bucket') = 0
    OR pg_catalog.strpos(v_definition, 'FOR UPDATE SKIP LOCKED') = 0
    OR pg_catalog.strpos(v_definition, 'jsonb_agg') = 0 THEN
    RAISE EXCEPTION 'request-batch edge limiter boundary mismatch';
  END IF;
END;
$proof$;

COMMIT;
