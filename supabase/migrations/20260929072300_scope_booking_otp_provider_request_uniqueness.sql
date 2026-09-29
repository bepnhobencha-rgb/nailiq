-- Twilio Verify can reuse one Verification SID (VE...) for multiple sends
-- during the code's validity window. Each send has its own attempt SID (VL...)
-- and its own NailIQ delivery-attempt row. A global unique VE constraint made
-- the later completion fail with provider_identity_conflict even when Twilio
-- accepted the SMS. Resend message IDs remain one-to-one and unique.
--
-- This changes indexes only. It does not expose the ledger, alter RLS/RPC ACL,
-- send a message, or rewrite historical rows. Apply in one transaction after
-- a QA rehearsal. Rollback is not a blind reverse migration: once repeated VE
-- IDs are stored, the old global unique index cannot be recreated without
-- resolving those historical rows. Roll back application code independently;
-- preserve the ledger and plan any schema reversal from an inspected snapshot.

CREATE UNIQUE INDEX booking_otp_delivery_resend_request_once
  ON public.booking_otp_delivery_attempts (provider_name, provider_request_id)
  WHERE provider_name = 'resend' AND provider_request_id IS NOT NULL;

CREATE INDEX booking_otp_delivery_twilio_request_lookup
  ON public.booking_otp_delivery_attempts (provider_request_id, created_at DESC, id)
  WHERE provider_name = 'twilio_verify' AND provider_request_id IS NOT NULL;

DROP INDEX public.booking_otp_delivery_provider_request_once;
