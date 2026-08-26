\set ON_ERROR_STOP on

DO $preflight$
DECLARE v_booking_rows bigint; v_waitlist_rows bigint;
BEGIN
  SELECT count(*) INTO v_booking_rows FROM public.bookings;
  SELECT count(*) INTO v_waitlist_rows FROM public.booking_waitlist_entries;
  IF EXISTS(SELECT 1 FROM public.booking_management_capabilities
    WHERE consumed_at IS NULL AND revoked_at IS NULL)
     OR EXISTS(SELECT 1 FROM public.waitlist_claim_capabilities
    WHERE consumed_at IS NULL AND revoked_at IS NULL) THEN
    RAISE NOTICE 'active additive capability rows exist; app rollback must revoke them explicitly';
  END IF;
  RAISE NOTICE 'preflight rows bookings=% waitlist=%; migrations add empty tables and small indexes only',
    v_booking_rows,v_waitlist_rows;
END;
$preflight$;
