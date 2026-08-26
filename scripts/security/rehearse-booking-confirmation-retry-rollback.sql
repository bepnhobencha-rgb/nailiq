\set ON_ERROR_STOP on

-- Rehearse only the strictly-later immutable-envelope migration.  The prior
-- retry contract remains untouched and is restored by renaming its private
-- implementation helpers back to their original signatures.
BEGIN;

DROP FUNCTION public.lease_due_booking_confirmation_retries(integer);
ALTER FUNCTION public.lease_due_booking_confirmation_retries_without_envelope_legacy(integer)
  RENAME TO lease_due_booking_confirmation_retries;

DROP FUNCTION public.claim_booking_confirmation_delivery(uuid,uuid,text,text,text,text);
DROP FUNCTION public.claim_booking_confirmation_delivery(uuid,uuid,text,text,text);
ALTER FUNCTION public.claim_booking_confirmation_delivery_without_envelope_legacy(uuid,uuid,text,text,text)
  RENAME TO claim_booking_confirmation_delivery;

DROP TRIGGER cleanup_terminal_booking_confirmation_dispatch_envelope
  ON public.booking_notifications;
DROP FUNCTION public.cleanup_terminal_booking_confirmation_dispatch_envelope();
DROP TABLE public.booking_confirmation_dispatch_envelopes;
DROP FUNCTION public.prevent_booking_confirmation_dispatch_envelope_update();

DO $down_verify$
BEGIN
  IF to_regprocedure('public.claim_booking_confirmation_delivery(uuid,uuid,text,text,text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'six-argument envelope claim survived rollback rehearsal';
  END IF;
END;
$down_verify$;

ROLLBACK;

DO $verify$
BEGIN
  IF to_regprocedure('public.claim_booking_confirmation_delivery(uuid,uuid,text,text,text,text)') IS NULL
     OR to_regprocedure('public.claim_booking_confirmation_delivery_without_envelope_legacy(uuid,uuid,text,text,text)') IS NULL
     OR to_regprocedure('public.lease_due_booking_confirmation_retries_without_envelope_legacy(integer)') IS NULL
     OR to_regclass('public.booking_confirmation_dispatch_envelopes') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM pg_trigger
       WHERE tgrelid='public.booking_notifications'::regclass
         AND tgname='cleanup_terminal_booking_confirmation_dispatch_envelope'
         AND NOT tgisinternal
     ) THEN
    RAISE EXCEPTION 'rollback rehearsal did not restore immutable envelope contract';
  END IF;
END;
$verify$;

SELECT 'PASS immutable confirmation envelope schema rollback is transactional' AS result;
