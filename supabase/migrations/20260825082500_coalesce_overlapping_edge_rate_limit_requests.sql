-- MQA-0148: atomically consume ordered requests that share limiter keys.
-- Every logical request still increments each bucket once; only the physical
-- PostgREST round trip is coalesced so permitted per-IP bursts do not queue.

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
  v_distinct_bucket_count integer;
  v_upserted_count integer;
  v_returned_bucket_count integer;
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

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_requests)
      AS request(request_json)
    WHERE pg_catalog.jsonb_typeof(request.request_json) IS DISTINCT FROM 'array'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_requests)
      AS request(request_json)
    WHERE pg_catalog.jsonb_array_length(request.request_json) < 1
       OR pg_catalog.jsonb_array_length(request.request_json) > 4
  ) THEN
    RETURN NULL;
  END IF;

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

  SELECT pg_catalog.count(*)::integer
  INTO v_bucket_count
  FROM pg_catalog.jsonb_array_elements(p_requests)
    AS request(request_json)
  CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(request.request_json)
    AS bucket(bucket_json);

  IF v_bucket_count < 1 OR v_bucket_count > 128 THEN
    RETURN NULL;
  END IF;

  -- A logical request may not repeat one key. Repetition across ordered
  -- requests is valid only when every occurrence has the same contract.
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_requests) WITH ORDINALITY
      AS request(request_json, request_ordinal)
    CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(request.request_json)
      AS bucket(bucket_json)
    GROUP BY request.request_ordinal, bucket.bucket_json ->> 'p_key'
    HAVING pg_catalog.count(*) > 1
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_requests)
      AS request(request_json)
    CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(request.request_json)
      AS bucket(bucket_json)
    GROUP BY bucket.bucket_json ->> 'p_key'
    HAVING pg_catalog.min((bucket.bucket_json ->> 'p_limit')::integer)
           IS DISTINCT FROM
           pg_catalog.max((bucket.bucket_json ->> 'p_limit')::integer)
        OR pg_catalog.min(
             (bucket.bucket_json ->> 'p_window_seconds')::integer
           ) IS DISTINCT FROM pg_catalog.max(
             (bucket.bucket_json ->> 'p_window_seconds')::integer
           )
  ) THEN
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
  ), increments AS MATERIALIZED (
    SELECT
      prepared.bucket,
      pg_catalog.count(*)::integer AS delta,
      pg_catalog.max(prepared.expires_at) AS expires_at
    FROM prepared
    GROUP BY prepared.bucket
  ), upserted AS (
    INSERT INTO public.rate_limits(bucket, count, expires_at)
    SELECT increments.bucket, increments.delta, increments.expires_at
    FROM increments
    ORDER BY increments.bucket
    ON CONFLICT(bucket) DO UPDATE
      SET count = public.rate_limits.count + EXCLUDED.count,
          expires_at = GREATEST(
            public.rate_limits.expires_at,
            EXCLUDED.expires_at
          )
    RETURNING bucket, count
  ), observed AS MATERIALIZED (
    SELECT
      prepared.request_ordinal,
      prepared.bucket_ordinal,
      prepared.p_limit,
      upserted.count - increments.delta +
        pg_catalog.row_number() OVER (
          PARTITION BY prepared.bucket
          ORDER BY prepared.request_ordinal, prepared.bucket_ordinal
        ) AS observed_count
    FROM prepared
    JOIN increments USING(bucket)
    JOIN upserted USING(bucket)
  ), per_request AS (
    SELECT
      observed.request_ordinal,
      pg_catalog.bool_and(
        observed.observed_count <= observed.p_limit
      ) AS allowed,
      pg_catalog.count(*)::integer AS bucket_count
    FROM observed
    GROUP BY observed.request_ordinal
  )
  SELECT
    pg_catalog.jsonb_agg(
      per_request.allowed ORDER BY per_request.request_ordinal
    ),
    COALESCE(pg_catalog.sum(per_request.bucket_count), 0)::integer,
    pg_catalog.count(*)::integer,
    (SELECT pg_catalog.count(*)::integer FROM upserted),
    (SELECT pg_catalog.count(*)::integer FROM increments)
  INTO
    v_results,
    v_returned_bucket_count,
    v_returned_request_count,
    v_upserted_count,
    v_distinct_bucket_count
  FROM per_request;

  IF v_returned_bucket_count IS DISTINCT FROM v_bucket_count
     OR v_returned_request_count IS DISTINCT FROM v_request_count
     OR v_upserted_count IS DISTINCT FROM v_distinct_bucket_count
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
  'Atomically consumes up to 32 ordered edge request bucket arrays, including repeated keys with one increment per request; service-role only.';

COMMIT;
