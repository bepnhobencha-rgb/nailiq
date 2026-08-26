\set ON_ERROR_STOP on

-- Read-only production gate for the transactional partial unique index.
-- PASS is not deployment approval. If the table/duplicate/name budget fails,
-- keep this migration in design phase and use a separately reviewed
-- CREATE UNIQUE INDEX CONCURRENTLY rollout.
--
-- `feature_flags.group_booking_enabled` is the exact registry-backed Beta key.
-- Any non-archived production row with that boolean enabled means legacy browser
-- assets may still call insert_group_bookings directly, so this preflight fails.
-- Safe staged alternative: first disable the flag for those salons, apply and
-- verify the DB+app canonical boundary, then re-enable only after runtime proof.
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '60s';

WITH metrics AS (
  SELECT
    (SELECT count(*) FROM public.bookings) AS bookings_rows,
    pg_catalog.pg_total_relation_size('public.bookings'::regclass)
      AS bookings_bytes,
    (SELECT count(*)
     FROM public.salons s
     WHERE s.archived_at IS NULL
       AND s.feature_flags -> 'group_booking_enabled' = 'true'::jsonb)
      AS enabled_group_salons,
    (SELECT coalesce(
       pg_catalog.jsonb_agg(
         pg_catalog.jsonb_build_object('id', sample.id, 'slug', sample.slug)
         ORDER BY sample.slug
       ),
       '[]'::jsonb
     )
     FROM (
       SELECT s.id, s.slug
       FROM public.salons s
       WHERE s.archived_at IS NULL
         AND s.feature_flags -> 'group_booking_enabled' = 'true'::jsonb
       ORDER BY s.slug
       LIMIT 10
     ) sample) AS enabled_group_salon_sample,
    (SELECT count(*) FROM (
       SELECT b.salon_id, b.idempotency_key
       FROM public.bookings b
       WHERE b.idempotency_key IS NOT NULL
         AND b.group_id IS NOT NULL
         AND b.is_group_organizer IS TRUE
       GROUP BY b.salon_id, b.idempotency_key
       HAVING count(*) > 1
     ) duplicate_keys) AS organizer_duplicate_keys
), index_state AS (
  SELECT (
    pg_catalog.to_regclass('public.idx_bookings_group_idempotency_once') IS NULL
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_index i
      WHERE i.indexrelid = pg_catalog.to_regclass(
          'public.idx_bookings_group_idempotency_once'
        )
        AND i.indrelid = 'public.bookings'::regclass
        AND i.indisunique AND i.indisvalid
        AND i.indnkeyatts = 2
        AND i.indkey::text = pg_catalog.format(
          '%s %s',
          (SELECT a.attnum FROM pg_catalog.pg_attribute a
           WHERE a.attrelid = 'public.bookings'::regclass
             AND a.attname = 'salon_id'),
          (SELECT a.attnum FROM pg_catalog.pg_attribute a
           WHERE a.attrelid = 'public.bookings'::regclass
             AND a.attname = 'idempotency_key')
        )
        AND pg_catalog.pg_get_expr(i.indpred, i.indrelid) =
          '((idempotency_key IS NOT NULL) AND (group_id IS NOT NULL) AND (is_group_organizer IS TRUE))'
    )
  ) AS index_name_safe
), decision AS (
  SELECT
    m.*,
    i.index_name_safe,
    (
      m.bookings_rows <= 50000
      AND m.bookings_bytes <= 134217728
      AND m.enabled_group_salons = 0
      AND m.organizer_duplicate_keys = 0
      AND i.index_name_safe
    ) AS preflight_pass
  FROM metrics m CROSS JOIN index_state i
)
SELECT
  pg_catalog.jsonb_pretty(pg_catalog.to_jsonb(decision.*)) AS rollout_report,
  preflight_pass
FROM decision
\gset

\echo :rollout_report
\if :preflight_pass
  \echo 'PASS: approved low-traffic rollout may use the reviewed transactional index build.'
  ROLLBACK;
\else
  \echo 'BLOCKED: active Group flag, duplicate, size, or index-definition gate failed; stage flag disablement or use the concurrent-index design.'
  ROLLBACK;
  SELECT 1 / 0 AS rollout_preflight_blocked;
\endif
