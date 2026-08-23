-- MQA-0148: keep the edge limiter fail-closed while reducing each validated
-- multi-bucket request from two upserts plus two unbounded GC statements to one
-- ordered set-based upsert plus one bounded, skip-locked GC statement.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.rate_limit_hit_many(p_buckets jsonb)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_bucket_count integer;
  v_upserted_count integer;
  v_all_allowed boolean;
BEGIN
  IF p_buckets IS NULL OR pg_catalog.jsonb_typeof(p_buckets) <> 'array' THEN
    RETURN NULL;
  END IF;

  v_bucket_count := pg_catalog.jsonb_array_length(p_buckets);
  IF v_bucket_count < 1 OR v_bucket_count > 4 THEN
    RETURN NULL;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_to_recordset(p_buckets)
      AS bucket(p_key text, p_limit integer, p_window_seconds integer)
    WHERE bucket.p_key IS NULL
       OR pg_catalog.length(bucket.p_key) < 1
       OR pg_catalog.length(bucket.p_key) > 300
       OR bucket.p_limit IS NULL
       OR bucket.p_limit < 1
       OR bucket.p_window_seconds IS NULL
       OR bucket.p_window_seconds < 1
  ) THEN
    RETURN NULL;
  END IF;

  IF (
    SELECT pg_catalog.count(DISTINCT bucket.p_key)
    FROM pg_catalog.jsonb_to_recordset(p_buckets)
      AS bucket(p_key text, p_limit integer, p_window_seconds integer)
  ) <> v_bucket_count THEN
    RETURN NULL;
  END IF;

  WITH prepared AS MATERIALIZED (
    SELECT
      bucket.p_key || ':' || window_value.window_id::text AS bucket,
      bucket.p_limit,
      pg_catalog.to_timestamp(
        (window_value.window_id + 2) * bucket.p_window_seconds
      ) AS expires_at
    FROM pg_catalog.jsonb_to_recordset(p_buckets)
      AS bucket(p_key text, p_limit integer, p_window_seconds integer)
    CROSS JOIN LATERAL (
      SELECT pg_catalog.floor(
        pg_catalog.date_part('epoch', v_now) / bucket.p_window_seconds
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
  )
  SELECT
    pg_catalog.bool_and(upserted.count <= prepared.p_limit),
    pg_catalog.count(*)::integer
  INTO v_all_allowed, v_upserted_count
  FROM upserted
  JOIN prepared USING(bucket);

  IF v_upserted_count IS DISTINCT FROM v_bucket_count THEN
    RAISE EXCEPTION 'rate-limit batch write cardinality mismatch';
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

  RETURN v_all_allowed;
END;
$$;

REVOKE ALL ON FUNCTION public.rate_limit_hit_many(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rate_limit_hit_many(jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.rate_limit_hit_many(jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.rate_limit_hit_many(jsonb) TO service_role;

COMMENT ON FUNCTION public.rate_limit_hit_many(jsonb) IS
  'Atomically consumes one to four hashed edge buckets with one ordered set-based upsert and bounded skip-locked GC; service-role only.';

DO $proof$
DECLARE
  v_oid regprocedure := pg_catalog.to_regprocedure(
    'public.rate_limit_hit_many(jsonb)'
  );
  v_definition text;
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'rate_limit_hit_many(jsonb) is missing';
  END IF;

  SELECT pg_catalog.pg_get_functiondef(v_oid)
    INTO v_definition;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc
    WHERE oid = v_oid
      AND prosecdef
      AND proconfig @> ARRAY['search_path=""']::text[]
  ) OR pg_catalog.has_function_privilege(
    'anon', v_oid, 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated', v_oid, 'EXECUTE'
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role', v_oid, 'EXECUTE'
  ) OR pg_catalog.strpos(v_definition, 'INSERT INTO public.rate_limits') = 0
    OR pg_catalog.strpos(v_definition, 'FOR UPDATE SKIP LOCKED') = 0 THEN
    RAISE EXCEPTION 'optimized batch edge limiter boundary mismatch';
  END IF;
END;
$proof$;

COMMIT;
