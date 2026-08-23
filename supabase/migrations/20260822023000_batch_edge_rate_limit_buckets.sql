-- MQA-0147: consume the minute/hour edge buckets in one PostgREST request.
-- The existing rate_limit_hit function remains the canonical atomic counter;
-- this wrapper validates the complete batch before performing any write and is
-- callable only by service_role.

CREATE OR REPLACE FUNCTION public.rate_limit_hit_many(p_buckets jsonb)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_bucket record;
  v_bucket_count integer;
  v_bucket_allowed boolean;
  v_all_allowed boolean := true;
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

  FOR v_bucket IN
    SELECT bucket.p_key, bucket.p_limit, bucket.p_window_seconds
    FROM pg_catalog.jsonb_to_recordset(p_buckets)
      AS bucket(p_key text, p_limit integer, p_window_seconds integer)
  LOOP
    v_bucket_allowed := public.rate_limit_hit(
      v_bucket.p_key,
      v_bucket.p_limit,
      v_bucket.p_window_seconds
    );
    IF v_bucket_allowed IS DISTINCT FROM true THEN
      v_all_allowed := false;
    END IF;
  END LOOP;

  RETURN v_all_allowed;
END;
$$;

REVOKE ALL ON FUNCTION public.rate_limit_hit_many(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rate_limit_hit_many(jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.rate_limit_hit_many(jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.rate_limit_hit_many(jsonb) TO service_role;

COMMENT ON FUNCTION public.rate_limit_hit_many(jsonb) IS
  'Validates and consumes up to four durable rate-limit buckets in one service-role-only transaction.';
