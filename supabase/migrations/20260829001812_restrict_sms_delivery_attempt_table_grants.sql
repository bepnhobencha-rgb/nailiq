-- Phase D exposes the delivery-truth state machine only through narrow,
-- SECURITY DEFINER RPCs. The edge runtime never needs direct table access.
-- Keep the ledger unreachable even to PostgREST's service_role while retaining
-- service_role EXECUTE on the claim, completion, and receipt functions.
revoke all on table public.sms_delivery_attempts from service_role;
