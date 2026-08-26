\set ON_ERROR_STOP on

-- Read-only rollout report. The migration rebuilds two booking GiST exclusion
-- constraints non-concurrently, so a large bookings relation needs an explicit
-- maintenance-window review instead of an automatic deploy.
SELECT
  c.reltuples::bigint AS estimated_booking_rows,
  pg_catalog.pg_relation_size(c.oid) AS booking_table_bytes,
  pg_catalog.pg_indexes_size(c.oid) AS booking_index_bytes,
  pg_catalog.pg_total_relation_size(c.oid) AS booking_total_bytes
FROM pg_catalog.pg_class c
WHERE c.oid = 'public.bookings'::regclass;

SELECT
  s.id,
  s.slug,
  s.name,
  s.archived_at,
  s.is_beta,
  s.feature_flags->'multi_service_booking_enabled' AS stored_gate
FROM public.salons s
WHERE s.feature_flags ? 'multi_service_booking_enabled'
   OR lower(trim(s.slug)) IN ('hilite-anaheim', 'hilite-studio')
   OR lower(trim(s.name)) IN ('hi-lite head spa', 'hi-lite studio')
ORDER BY s.slug, s.id;

DO $sequence_rollout_preflight$
DECLARE
  v_estimated_rows bigint;
  v_table_bytes bigint;
  v_index_bytes bigint;
BEGIN
  SELECT c.reltuples::bigint,
         pg_catalog.pg_relation_size(c.oid),
         pg_catalog.pg_indexes_size(c.oid)
  INTO v_estimated_rows, v_table_bytes, v_index_bytes
  FROM pg_catalog.pg_class c WHERE c.oid = 'public.bookings'::regclass;

  -- Conservative local policy. Exceeding it is not proof that the migration is
  -- unsafe; it deliberately fails so lock timing is reviewed on a production-
  -- shaped copy and a maintenance window is approved before deployment.
  IF coalesce(v_estimated_rows, 0) > 250000
     OR coalesce(v_table_bytes, 0) + coalesce(v_index_bytes, 0) > 2147483648 THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'sequence rollout requires reviewed maintenance window for booking GiST rebuild',
      DETAIL = pg_catalog.format(
        'estimated_rows=%s table_bytes=%s index_bytes=%s',
        v_estimated_rows, v_table_bytes, v_index_bytes
      );
  END IF;

  IF EXISTS (SELECT 1 FROM public.platform_flags p
      WHERE p.key = 'feature_multi_service_booking' AND p.enabled IS TRUE) THEN
    RAISE EXCEPTION 'platform multi-service gate must be OFF before schema/app Phase A deploy';
  END IF;
  IF EXISTS (SELECT 1 FROM public.platform_settings ps
      WHERE ps.id = 'platform'
        AND nullif(pg_catalog.to_jsonb(ps)->>'multi_service_booking_qa_salon_id', '') IS NOT NULL) THEN
    RAISE EXCEPTION 'sequence QA allowlist must be empty before Phase A deploy';
  END IF;
  IF EXISTS (SELECT 1 FROM public.salons s
      WHERE s.archived_at IS NULL
        AND s.feature_flags @> '{"multi_service_booking_enabled":true}'::jsonb) THEN
    RAISE EXCEPTION 'every active salon multi-service gate must be OFF before Phase A deploy';
  END IF;
  IF EXISTS (SELECT 1 FROM public.salons s
      WHERE s.feature_flags ? 'multi_service_booking_enabled'
        AND pg_catalog.jsonb_typeof(
          s.feature_flags->'multi_service_booking_enabled'
        ) <> 'boolean') THEN
    RAISE EXCEPTION 'malformed multi-service salon gate requires cleanup before deploy';
  END IF;
  IF EXISTS (SELECT 1 FROM public.salons s
      WHERE (
        lower(trim(s.slug)) IN ('hilite-anaheim', 'hilite-studio')
        OR lower(trim(s.name)) IN ('hi-lite head spa', 'hi-lite studio')
      ) AND s.feature_flags @> '{"multi_service_booking_enabled":true}'::jsonb) THEN
    RAISE EXCEPTION 'Hi-Lite production salons must remain flag-off';
  END IF;
END;
$sequence_rollout_preflight$;

SELECT 'booking_service_sequence_rollout_preflight_pass' AS result;
