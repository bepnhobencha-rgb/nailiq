\set ON_ERROR_STOP on
BEGIN;
UPDATE public.booking_management_capabilities SET revoked_at=transaction_timestamp(),
  revoke_reason=coalesce(revoke_reason,'manual_revoke'),updated_at=transaction_timestamp()
WHERE consumed_at IS NULL AND revoked_at IS NULL;
UPDATE public.waitlist_claim_capabilities SET revoked_at=transaction_timestamp(),updated_at=transaction_timestamp()
WHERE consumed_at IS NULL AND revoked_at IS NULL;
DO $rollback$
BEGIN
  IF EXISTS(SELECT 1 FROM public.booking_management_capabilities
    WHERE consumed_at IS NULL AND revoked_at IS NULL)
     OR EXISTS(SELECT 1 FROM public.waitlist_claim_capabilities
    WHERE consumed_at IS NULL AND revoked_at IS NULL) THEN
    RAISE EXCEPTION 'capability rollback left active bearer';
  END IF;
END;
$rollback$;
ROLLBACK;
