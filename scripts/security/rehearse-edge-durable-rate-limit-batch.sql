\set ON_ERROR_STOP on

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SELECT set_config('request.jwt.claim.role', 'service_role', true);

DO $rehearsal$
DECLARE
  v_key_a text := 'public-edge:mqa-0148:minute:' || repeat('a', 64);
  v_key_b text := 'public-edge:mqa-0148:hour:' || repeat('b', 64);
  v_payload jsonb;
  v_result boolean;
  v_count_a integer;
  v_count_b integer;
  v_gc_remaining integer;
BEGIN
  IF pg_catalog.has_function_privilege(
       'anon', 'public.rate_limit_hit_many(jsonb)', 'EXECUTE'
     ) OR pg_catalog.has_function_privilege(
       'authenticated', 'public.rate_limit_hit_many(jsonb)', 'EXECUTE'
     ) OR NOT pg_catalog.has_function_privilege(
       'service_role', 'public.rate_limit_hit_many(jsonb)', 'EXECUTE'
     ) OR pg_catalog.has_table_privilege(
       'anon', 'public.rate_limits', 'SELECT,INSERT,UPDATE,DELETE'
     ) OR pg_catalog.has_table_privilege(
       'authenticated', 'public.rate_limits', 'SELECT,INSERT,UPDATE,DELETE'
     ) THEN
    RAISE EXCEPTION 'edge rate-limit ACL boundary mismatch';
  END IF;

  DELETE FROM public.rate_limits
  WHERE bucket LIKE 'public-edge:mqa-0148:%';

  IF public.rate_limit_hit_many(NULL) IS NOT NULL
     OR public.rate_limit_hit_many('[]'::jsonb) IS NOT NULL
     OR public.rate_limit_hit_many(jsonb_build_array(
       jsonb_build_object(
         'p_key', v_key_a, 'p_limit', 2, 'p_window_seconds', 60
       ),
       jsonb_build_object(
         'p_key', v_key_a, 'p_limit', 2, 'p_window_seconds', 60
       )
     )) IS NOT NULL
     OR public.rate_limit_hit_many(jsonb_build_array(
       jsonb_build_object(
         'p_key', v_key_a, 'p_limit', 0, 'p_window_seconds', 60
       )
     )) IS NOT NULL THEN
    RAISE EXCEPTION 'invalid batch input did not fail closed';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.rate_limits
    WHERE bucket LIKE 'public-edge:mqa-0148:%'
  ) THEN
    RAISE EXCEPTION 'invalid batch input wrote rate-limit state';
  END IF;

  v_payload := jsonb_build_array(
    jsonb_build_object(
      'p_key', v_key_a, 'p_limit', 2, 'p_window_seconds', 60
    ),
    jsonb_build_object(
      'p_key', v_key_b, 'p_limit', 2, 'p_window_seconds', 3600
    )
  );

  v_result := public.rate_limit_hit_many(v_payload);
  IF v_result IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'first batch hit was not allowed';
  END IF;
  v_result := public.rate_limit_hit_many(v_payload);
  IF v_result IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'at-limit batch hit was not allowed';
  END IF;

  v_payload := jsonb_build_array(
    jsonb_build_object(
      'p_key', v_key_a, 'p_limit', 2, 'p_window_seconds', 60
    ),
    jsonb_build_object(
      'p_key', v_key_b, 'p_limit', 100, 'p_window_seconds', 3600
    )
  );
  v_result := public.rate_limit_hit_many(v_payload);
  IF v_result IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'mixed-threshold batch did not limit';
  END IF;

  SELECT count INTO v_count_a
  FROM public.rate_limits
  WHERE bucket LIKE v_key_a || ':%';
  SELECT count INTO v_count_b
  FROM public.rate_limits
  WHERE bucket LIKE v_key_b || ':%';
  IF v_count_a <> 3 OR v_count_b <> 3 THEN
    RAISE EXCEPTION 'batch did not consume every bucket exactly once: %, %',
      v_count_a, v_count_b;
  END IF;

  v_payload := jsonb_build_array(
    jsonb_build_object(
      'p_key', v_key_b, 'p_limit', 100, 'p_window_seconds', 3600
    ),
    jsonb_build_object(
      'p_key', v_key_a, 'p_limit', 100, 'p_window_seconds', 60
    )
  );
  v_result := public.rate_limit_hit_many(v_payload);
  IF v_result IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'reversed valid batch was not allowed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.rate_limits
    WHERE (bucket LIKE v_key_a || ':%' OR bucket LIKE v_key_b || ':%')
      AND (
        count <> 4 OR expires_at <= now()
        OR expires_at > now() + interval '2 hours 1 minute'
      )
  ) OR (
    SELECT count(*)
    FROM public.rate_limits
    WHERE bucket LIKE v_key_a || ':%' OR bucket LIKE v_key_b || ':%'
  ) <> 2 THEN
    RAISE EXCEPTION 'fixed-window count or expiry shape mismatch';
  END IF;

  INSERT INTO public.rate_limits(bucket, count, expires_at)
  SELECT
    'public-edge:mqa-0148:gc:' || lpad(series::text, 3, '0'),
    1,
    now() - interval '100 years'
  FROM generate_series(1, 140) AS series;

  v_result := public.rate_limit_hit_many(v_payload);
  IF v_result IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'GC trigger hit unexpectedly limited';
  END IF;
  SELECT count(*) INTO v_gc_remaining
  FROM public.rate_limits
  WHERE bucket LIKE 'public-edge:mqa-0148:gc:%';
  IF v_gc_remaining <> 12 THEN
    RAISE EXCEPTION 'bounded GC deleted an unexpected row count: % remain',
      v_gc_remaining;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.rate_limits
    WHERE (bucket LIKE v_key_a || ':%' OR bucket LIKE v_key_b || ':%')
      AND bucket !~ '^public-edge:mqa-0148:(minute|hour):[0-9a-f]{64}:[0-9]+$'
  ) THEN
    RAISE EXCEPTION 'persisted edge key was not hash-only';
  END IF;
END;
$rehearsal$;

ROLLBACK;
