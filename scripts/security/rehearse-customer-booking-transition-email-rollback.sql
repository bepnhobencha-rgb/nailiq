\set ON_ERROR_STOP on

BEGIN;
DROP FUNCTION public.cancel_booking_as_customer_with_transition_email(uuid);
DROP FUNCTION public.reschedule_booking_as_customer_with_transition_email(uuid,timestamptz,timestamptz);
DROP FUNCTION public.claim_customer_booking_transition_email(uuid,uuid,text,bigint,text,text);
DROP FUNCTION public.complete_customer_booking_transition_email(uuid,uuid,text,text,text,text);
DROP FUNCTION public.discover_due_customer_booking_transition_emails(integer);
DROP FUNCTION public.lease_due_customer_booking_transition_email_retries(integer);
DROP FUNCTION public.reconcile_stale_customer_booking_transition_email_claims(integer);
DROP FUNCTION public.activate_customer_booking_transition_email(uuid,uuid,text,bigint,timestamptz);
DROP FUNCTION public.load_customer_booking_transition_email_material(uuid,uuid,text,bigint);
DROP TRIGGER track_customer_booking_transition_email_occurrence ON public.bookings;
DROP FUNCTION public.track_customer_booking_transition_email_occurrence();
DROP TABLE public.customer_booking_transition_email_events;
DROP TABLE public.customer_booking_transition_email_outbox;
ALTER TABLE public.bookings
  DROP COLUMN customer_transition_email_not_before,
  DROP COLUMN customer_transition_email_requested,
  DROP COLUMN customer_transition_previous_start_time_utc,
  DROP COLUMN customer_transition_previous_status,
  DROP COLUMN customer_transitioned_at,
  DROP COLUMN customer_transition_kind,
  DROP COLUMN customer_transition_version;
ROLLBACK;

DO $verify$
BEGIN
  IF to_regclass('public.customer_booking_transition_email_outbox') IS NULL
     OR to_regclass('public.customer_booking_transition_email_events') IS NULL
     OR to_regprocedure('public.claim_customer_booking_transition_email(uuid,uuid,text,bigint,text,text)') IS NULL
     OR NOT EXISTS(SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='bookings'
         AND column_name='customer_transition_version') THEN
    RAISE EXCEPTION 'transactional rollback did not restore customer transition contract';
  END IF;
END;
$verify$;

SELECT 'PASS customer transition email rollback is transactional' AS result;
