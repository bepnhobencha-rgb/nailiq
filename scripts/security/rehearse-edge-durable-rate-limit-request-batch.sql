\set ON_ERROR_STOP on

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SELECT set_config('request.jwt.claim.role', 'service_role', true);

DO $rehearsal$
DECLARE
  v_prefix text := 'public-edge:mqa-0148-request-batch:';
  v_key_a text := v_prefix || 'valid-a:' || repeat('a', 64);
  v_key_b text := v_prefix || 'valid-b:' || repeat('b', 64);
  v_key_c text := v_prefix || 'valid-c:' || repeat('c', 64);
  v_key_d text := v_prefix || 'valid-d:' || repeat('d', 64);
  v_duplicate_key text := v_prefix || 'duplicate:' || repeat('e', 64);
  v_rollback_new_key text := v_prefix || 'rollback-a-new:' || repeat('f', 64);
  v_rollback_overflow_key text :=
    v_prefix || 'rollback-z-overflow:' || repeat('0', 64);
  v_payload jsonb;
  v_invalid_payload jsonb;
  v_result jsonb;
  v_row_count integer;
  v_min_count integer;
  v_max_count integer;
  v_window bigint;
  v_overflow_bucket text;
  v_saw_overflow boolean := false;
  v_gc_remaining integer;
BEGIN
  IF pg_catalog.has_function_privilege(
       'anon', 'public.rate_limit_hit_request_batch(jsonb)', 'EXECUTE'
     ) OR pg_catalog.has_function_privilege(
       'authenticated',
       'public.rate_limit_hit_request_batch(jsonb)',
       'EXECUTE'
     ) OR NOT pg_catalog.has_function_privilege(
       'service_role',
       'public.rate_limit_hit_request_batch(jsonb)',
       'EXECUTE'
     ) OR pg_catalog.has_table_privilege(
       'anon', 'public.rate_limits', 'SELECT,INSERT,UPDATE,DELETE'
     ) OR pg_catalog.has_table_privilege(
       'authenticated',
       'public.rate_limits',
       'SELECT,INSERT,UPDATE,DELETE'
     ) OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc
       WHERE oid = pg_catalog.to_regprocedure(
         'public.rate_limit_hit_request_batch(jsonb)'
       )
         AND prosecdef
         AND prorettype = 'jsonb'::pg_catalog.regtype
         AND proconfig @> ARRAY['search_path=""']::text[]
     ) THEN
    RAISE EXCEPTION 'request-batch edge limiter ACL boundary mismatch';
  END IF;

  DELETE FROM public.rate_limits
  WHERE bucket LIKE v_prefix || '%';

  IF public.rate_limit_hit_request_batch(NULL) IS NOT NULL
     OR public.rate_limit_hit_request_batch('{}'::jsonb) IS NOT NULL
     OR public.rate_limit_hit_request_batch('[]'::jsonb) IS NOT NULL
     OR public.rate_limit_hit_request_batch('[{}]'::jsonb) IS NOT NULL
     OR public.rate_limit_hit_request_batch('[[]]'::jsonb) IS NOT NULL
     OR public.rate_limit_hit_request_batch('[[1]]'::jsonb) IS NOT NULL
     OR public.rate_limit_hit_request_batch(jsonb_build_array(
       jsonb_build_array(
         jsonb_build_object(
           'p_key', 123,
           'p_limit', 1,
           'p_window_seconds', 60
         )
       )
     )) IS NOT NULL
     OR public.rate_limit_hit_request_batch(jsonb_build_array(
       jsonb_build_array(
         jsonb_build_object(
           'p_key', repeat('x', 301),
           'p_limit', 1,
           'p_window_seconds', 60
         )
       )
     )) IS NOT NULL
     OR public.rate_limit_hit_request_batch(jsonb_build_array(
       jsonb_build_array(
         jsonb_build_object(
           'p_key', v_prefix || 'typed-limit',
           'p_limit', '1',
           'p_window_seconds', 60
         )
       )
     )) IS NOT NULL
     OR public.rate_limit_hit_request_batch(jsonb_build_array(
       jsonb_build_array(
         jsonb_build_object(
           'p_key', v_prefix || 'decimal-limit',
           'p_limit', 1.5,
           'p_window_seconds', 60
         )
       )
     )) IS NOT NULL
     OR public.rate_limit_hit_request_batch(jsonb_build_array(
       jsonb_build_array(
         jsonb_build_object(
           'p_key', v_prefix || 'overflow-limit',
           'p_limit', 2147483648,
           'p_window_seconds', 60
         )
       )
     )) IS NOT NULL
     OR public.rate_limit_hit_request_batch(jsonb_build_array(
       jsonb_build_array(
         jsonb_build_object(
           'p_key', v_prefix || 'zero-window',
           'p_limit', 1,
           'p_window_seconds', 0
         )
       )
     )) IS NOT NULL THEN
    RAISE EXCEPTION 'invalid request-batch input did not fail closed';
  END IF;

  SELECT pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'p_key', v_prefix || 'too-many-requests-' || series::text,
        'p_limit', 1,
        'p_window_seconds', 60
      )
    ) ORDER BY series
  )
  INTO v_invalid_payload
  FROM pg_catalog.generate_series(1, 33) AS series;

  IF public.rate_limit_hit_request_batch(v_invalid_payload) IS NOT NULL
     OR public.rate_limit_hit_request_batch(jsonb_build_array(
       jsonb_build_array(
         jsonb_build_object(
           'p_key', v_prefix || 'too-many-buckets-1',
           'p_limit', 1,
           'p_window_seconds', 60
         ),
         jsonb_build_object(
           'p_key', v_prefix || 'too-many-buckets-2',
           'p_limit', 1,
           'p_window_seconds', 60
         ),
         jsonb_build_object(
           'p_key', v_prefix || 'too-many-buckets-3',
           'p_limit', 1,
           'p_window_seconds', 60
         ),
         jsonb_build_object(
           'p_key', v_prefix || 'too-many-buckets-4',
           'p_limit', 1,
           'p_window_seconds', 60
         ),
         jsonb_build_object(
           'p_key', v_prefix || 'too-many-buckets-5',
           'p_limit', 1,
           'p_window_seconds', 60
         )
       )
     )) IS NOT NULL
     OR public.rate_limit_hit_request_batch(jsonb_build_array(
       jsonb_build_array(
         jsonb_build_object(
           'p_key', v_duplicate_key,
           'p_limit', 2,
           'p_window_seconds', 60
         )
       ),
       jsonb_build_array(
         jsonb_build_object(
           'p_key', v_duplicate_key,
           'p_limit', 1,
           'p_window_seconds', 60
         )
       )
     )) IS NOT NULL THEN
    RAISE EXCEPTION 'bounded or inconsistent request batch did not fail closed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.rate_limits
    WHERE bucket LIKE v_prefix || '%'
  ) THEN
    RAISE EXCEPTION 'invalid request-batch input wrote rate-limit state';
  END IF;

  v_result := public.rate_limit_hit_request_batch(jsonb_build_array(
    jsonb_build_array(
      jsonb_build_object(
        'p_key', v_duplicate_key,
        'p_limit', 1,
        'p_window_seconds', 60
      )
    ),
    jsonb_build_array(
      jsonb_build_object(
        'p_key', v_duplicate_key,
        'p_limit', 1,
        'p_window_seconds', 60
      )
    )
  ));
  IF v_result IS DISTINCT FROM '[true, false]'::jsonb OR (
    SELECT count
    FROM public.rate_limits
    WHERE bucket LIKE v_duplicate_key || ':%'
  ) IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'overlapping request batch ordering mismatch: %', v_result;
  END IF;

  DELETE FROM public.rate_limits
  WHERE bucket LIKE v_duplicate_key || ':%';

  v_payload := jsonb_build_array(
    jsonb_build_array(
      jsonb_build_object(
        'p_key', v_key_a,
        'p_limit', 1,
        'p_window_seconds', 60
      ),
      jsonb_build_object(
        'p_key', v_key_b,
        'p_limit', 1,
        'p_window_seconds', 3600
      )
    ),
    jsonb_build_array(
      jsonb_build_object(
        'p_key', v_key_d,
        'p_limit', 2,
        'p_window_seconds', 3600
      ),
      jsonb_build_object(
        'p_key', v_key_c,
        'p_limit', 2,
        'p_window_seconds', 60
      )
    )
  );

  v_result := public.rate_limit_hit_request_batch(v_payload);
  IF v_result IS DISTINCT FROM '[true, true]'::jsonb THEN
    RAISE EXCEPTION 'first positional request batch mismatch: %', v_result;
  END IF;

  v_result := public.rate_limit_hit_request_batch(v_payload);
  IF v_result IS DISTINCT FROM '[false, true]'::jsonb THEN
    RAISE EXCEPTION 'mixed positional request batch mismatch: %', v_result;
  END IF;

  v_payload := jsonb_build_array(
    jsonb_build_array(
      jsonb_build_object(
        'p_key', v_key_c,
        'p_limit', 3,
        'p_window_seconds', 60
      ),
      jsonb_build_object(
        'p_key', v_key_d,
        'p_limit', 3,
        'p_window_seconds', 3600
      )
    ),
    jsonb_build_array(
      jsonb_build_object(
        'p_key', v_key_b,
        'p_limit', 1,
        'p_window_seconds', 3600
      ),
      jsonb_build_object(
        'p_key', v_key_a,
        'p_limit', 1,
        'p_window_seconds', 60
      )
    )
  );

  v_result := public.rate_limit_hit_request_batch(v_payload);
  IF v_result IS DISTINCT FROM '[true, false]'::jsonb THEN
    RAISE EXCEPTION 'reordered positional request batch mismatch: %', v_result;
  END IF;

  SELECT
    pg_catalog.count(*)::integer,
    pg_catalog.min(count),
    pg_catalog.max(count)
  INTO v_row_count, v_min_count, v_max_count
  FROM public.rate_limits
  WHERE bucket LIKE v_prefix || 'valid-%';

  IF v_row_count <> 4 OR v_min_count <> 3 OR v_max_count <> 3 THEN
    RAISE EXCEPTION 'request batch write cardinality/count mismatch: %, %, %',
      v_row_count, v_min_count, v_max_count;
  END IF;

  SELECT pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'p_key', v_prefix || 'boundary-' || series::text,
        'p_limit', 1,
        'p_window_seconds', 60
      )
    ) ORDER BY series
  )
  INTO v_payload
  FROM pg_catalog.generate_series(1, 32) AS series;

  v_result := public.rate_limit_hit_request_batch(v_payload);
  IF pg_catalog.jsonb_array_length(v_result) <> 32 OR EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(v_result) AS result(value)
    WHERE result.value IS DISTINCT FROM 'true'::jsonb
  ) THEN
    RAISE EXCEPTION '32-request boundary result mismatch';
  END IF;

  v_window := pg_catalog.floor(
    pg_catalog.date_part('epoch', pg_catalog.clock_timestamp()) / 2147483647
  )::bigint;
  v_overflow_bucket := v_rollback_overflow_key || ':' || v_window::text;
  INSERT INTO public.rate_limits(bucket, count, expires_at)
  VALUES (
    v_overflow_bucket,
    2147483647,
    pg_catalog.to_timestamp((v_window + 2) * 2147483647)
  );

  BEGIN
    PERFORM public.rate_limit_hit_request_batch(jsonb_build_array(
      jsonb_build_array(
        jsonb_build_object(
          'p_key', v_rollback_new_key,
          'p_limit', 1,
          'p_window_seconds', 2147483647
        ),
        jsonb_build_object(
          'p_key', v_rollback_overflow_key,
          'p_limit', 2147483647,
          'p_window_seconds', 2147483647
        )
      )
    ));
    RAISE EXCEPTION 'expected request-batch counter overflow';
  EXCEPTION
    WHEN numeric_value_out_of_range THEN
      v_saw_overflow := true;
  END;

  IF NOT v_saw_overflow OR EXISTS (
    SELECT 1
    FROM public.rate_limits
    WHERE bucket LIKE v_rollback_new_key || ':%'
  ) OR (
    SELECT count
    FROM public.rate_limits
    WHERE bucket = v_overflow_bucket
  ) <> 2147483647 THEN
    RAISE EXCEPTION 'request-batch failure did not roll back every bucket';
  END IF;

  INSERT INTO public.rate_limits(bucket, count, expires_at)
  SELECT
    v_prefix || 'gc:' || pg_catalog.lpad(series::text, 3, '0'),
    1,
    '-infinity'::timestamptz
  FROM pg_catalog.generate_series(1, 140) AS series;

  v_result := public.rate_limit_hit_request_batch(jsonb_build_array(
    jsonb_build_array(
      jsonb_build_object(
        'p_key', v_prefix || 'gc-trigger-a',
        'p_limit', 1,
        'p_window_seconds', 60
      )
    ),
    jsonb_build_array(
      jsonb_build_object(
        'p_key', v_prefix || 'gc-trigger-b',
        'p_limit', 1,
        'p_window_seconds', 3600
      )
    )
  ));
  IF v_result IS DISTINCT FROM '[true, true]'::jsonb THEN
    RAISE EXCEPTION 'GC trigger request batch mismatch: %', v_result;
  END IF;

  SELECT pg_catalog.count(*)::integer
  INTO v_gc_remaining
  FROM public.rate_limits
  WHERE bucket LIKE v_prefix || 'gc:%';
  IF v_gc_remaining <> 12 THEN
    RAISE EXCEPTION 'bounded request-batch GC left % rows, expected 12',
      v_gc_remaining;
  END IF;
END;
$rehearsal$;

ROLLBACK;
