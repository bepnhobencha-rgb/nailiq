\set ON_ERROR_STOP on

DO $preflight$
DECLARE
  v_rows bigint;
  v_bytes bigint;
  v_tokenized bigint;
  v_envelopes bigint;
  v_unsafe_envelopes bigint;
BEGIN
  SELECT greatest(coalesce(c.reltuples, 0)::bigint, 0), pg_total_relation_size(c.oid)
  INTO v_rows, v_bytes
  FROM pg_class c WHERE c.oid='public.booking_notifications'::regclass;

  SELECT count(*) INTO v_tokenized
  FROM public.booking_notifications WHERE attempt_token IS NOT NULL;

  SELECT count(*), count(*) FILTER (WHERE
    n.id IS NULL
    OR e.booking_id IS DISTINCT FROM n.booking_id
    OR e.salon_id IS DISTINCT FROM n.salon_id
    OR e.channel IS DISTINCT FROM n.channel
    OR e.payload_fingerprint IS DISTINCT FROM n.payload_fingerprint
    OR e.recipient_fingerprint IS DISTINCT FROM n.recipient_fingerprint
    OR NOT (
      n.status='sending'
      OR (n.status='failed' AND n.failure_disposition='retryable_pre_acceptance'
          AND n.attempt_count<2 AND n.next_attempt_at IS NOT NULL)
    )
  ) INTO v_envelopes, v_unsafe_envelopes
  FROM public.booking_confirmation_dispatch_envelopes e
  LEFT JOIN public.booking_notifications n ON n.id=e.claim_id;

  RAISE NOTICE 'booking_notifications estimated_rows=%, total_bytes=%, tokenized_rows=%, active_envelopes=%',
    v_rows, v_bytes, v_tokenized, v_envelopes;

  -- The migration builds a partial index whose initial predicate is empty, but
  -- PostgreSQL must still scan and briefly lock the table. Larger production
  -- tables require a separately reviewed CREATE INDEX CONCURRENTLY rollout.
  IF v_rows > 500000 OR v_bytes > 134217728 THEN
    RAISE EXCEPTION 'booking_notifications exceeds non-concurrent rollout budget; use separately reviewed concurrent index design';
  END IF;
  IF v_unsafe_envelopes <> 0 THEN
    RAISE EXCEPTION 'unsafe/orphan/terminal confirmation envelopes found: %', v_unsafe_envelopes;
  END IF;
END;
$preflight$;

SELECT
  count(*) FILTER (WHERE notification_type='booking_confirmation' AND status='sending' AND attempt_token IS NULL) AS legacy_sending,
  count(*) FILTER (WHERE notification_type='booking_confirmation' AND status='failed' AND attempt_token IS NULL) AS legacy_failed,
  count(*) FILTER (WHERE failure_disposition='retryable_pre_acceptance') AS retryable_rows
FROM public.booking_notifications;
