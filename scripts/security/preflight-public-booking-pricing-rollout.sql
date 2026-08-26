\set ON_ERROR_STOP on

-- Read-only production gate for the Phase-A transactional index build.
-- PASS means only that the reviewed small-table/duplicate/index-definition
-- criteria hold. Deployment still needs a low-traffic window and approval.
-- Any budget failure keeps this change in design phase: build the indexes in a
-- separately reviewed CREATE UNIQUE INDEX CONCURRENTLY rollout instead.
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '60s';

WITH metrics AS (
  SELECT
    (SELECT count(*) FROM public.bookings) AS bookings_rows,
    pg_catalog.pg_total_relation_size('public.bookings'::regclass)
      AS bookings_bytes,
    (SELECT count(*) FROM public.voucher_redemptions) AS redemptions_rows,
    pg_catalog.pg_total_relation_size('public.voucher_redemptions'::regclass)
      AS redemptions_bytes,
    (SELECT count(*) FROM (
       SELECT b.salon_id, b.idempotency_key
       FROM public.bookings b
       WHERE b.idempotency_key IS NOT NULL
         AND b.group_id IS NULL
         AND b.recovered_from_booking_id IS NULL
       GROUP BY b.salon_id, b.idempotency_key
       HAVING count(*) > 1
     ) duplicate_keys) AS booking_duplicate_keys,
    (SELECT count(*) FROM (
       SELECT vr.voucher_id, vr.booking_id
       FROM public.voucher_redemptions vr
       WHERE vr.booking_id IS NOT NULL
       GROUP BY vr.voucher_id, vr.booking_id
       HAVING count(*) > 1
     ) duplicate_keys) AS redemption_duplicate_keys
), index_state AS (
  SELECT
    (
      pg_catalog.to_regclass('public.idx_bookings_public_idempotency_once')
        IS NULL
      OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_index i
        WHERE i.indexrelid = pg_catalog.to_regclass(
            'public.idx_bookings_public_idempotency_once'
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
            '((idempotency_key IS NOT NULL) AND (group_id IS NULL) AND (recovered_from_booking_id IS NULL))'
      )
    ) AS booking_index_name_safe,
    (
      pg_catalog.to_regclass('public.idx_voucher_redemptions_booking_once')
        IS NULL
      OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_index i
        WHERE i.indexrelid = pg_catalog.to_regclass(
            'public.idx_voucher_redemptions_booking_once'
          )
          AND i.indrelid = 'public.voucher_redemptions'::regclass
          AND i.indisunique AND i.indisvalid
          AND i.indnkeyatts = 2
          AND i.indkey::text = pg_catalog.format(
            '%s %s',
            (SELECT a.attnum FROM pg_catalog.pg_attribute a
             WHERE a.attrelid = 'public.voucher_redemptions'::regclass
               AND a.attname = 'voucher_id'),
            (SELECT a.attnum FROM pg_catalog.pg_attribute a
             WHERE a.attrelid = 'public.voucher_redemptions'::regclass
               AND a.attname = 'booking_id')
          )
          AND pg_catalog.pg_get_expr(i.indpred, i.indrelid) =
            '(booking_id IS NOT NULL)'
      )
    ) AS redemption_index_name_safe
), decision AS (
  SELECT
    m.*,
    i.*,
    (
      m.bookings_rows <= 50000
      AND m.bookings_bytes <= 134217728
      AND m.redemptions_rows <= 100000
      AND m.redemptions_bytes <= 67108864
      AND m.booking_duplicate_keys = 0
      AND m.redemption_duplicate_keys = 0
      AND i.booking_index_name_safe
      AND i.redemption_index_name_safe
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
  \echo 'PASS: small-table transactional index design is eligible for an approved low-traffic rollout.'
  ROLLBACK;
\else
  \echo 'BLOCKED: duplicate, size, or index-definition gate failed; keep rollout in design phase and use the concurrent-index plan.'
  ROLLBACK;
  -- ON_ERROR_STOP turns this deliberate read-only error into a non-zero gate.
  SELECT 1 / 0 AS rollout_preflight_blocked;
\endif
