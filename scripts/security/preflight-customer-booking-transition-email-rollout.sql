\set ON_ERROR_STOP on

DO $preflight$
DECLARE
  v_booking_rows bigint;
  v_booking_bytes bigint;
  v_active bigint;
  v_bad_inputs bigint;
BEGIN
  SELECT greatest(coalesce(c.reltuples,0)::bigint,0),pg_total_relation_size(c.oid)
  INTO v_booking_rows,v_booking_bytes
  FROM pg_class c WHERE c.oid='public.bookings'::regclass;
  SELECT count(*) INTO v_active
  FROM public.customer_booking_transition_email_outbox
  WHERE status IN ('pending','sending','sent','failed','unknown');
  SELECT count(*) INTO v_bad_inputs FROM public.bookings
  WHERE customer_transition_email_requested<>false
     OR customer_transition_email_not_before IS NOT NULL;

  RAISE NOTICE 'bookings estimated_rows=%, total_bytes=%, active_transition_email_rows=%',
    v_booking_rows,v_booking_bytes,v_active;

  -- New indexes are built only on newly-created empty outbox/event tables.
  -- The bookings changes are metadata/default columns plus NOT VALID checks;
  -- this budget protects trigger rollout review on unusually large tenants.
  IF v_booking_rows>1000000 OR v_booking_bytes>1073741824 THEN
    RAISE EXCEPTION 'bookings exceeds reviewed transition-trigger rollout budget';
  END IF;
  IF v_active<>0 THEN
    RAISE EXCEPTION 'transition email delivery already active before default-off adoption: %',v_active;
  END IF;
  IF v_bad_inputs<>0 THEN
    RAISE EXCEPTION 'transient transition email inputs persisted unexpectedly: %',v_bad_inputs;
  END IF;
END;
$preflight$;

SELECT status,count(*) AS rows
FROM public.customer_booking_transition_email_outbox
GROUP BY status ORDER BY status;
