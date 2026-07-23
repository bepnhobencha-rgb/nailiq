-- Follow-up to 20260615001000: the app now calls the salon-scoped
-- get_booking_client_snapshot(uuid,text) (deployed in #488), so drop the legacy
-- unscoped (text) overload that was the anon cross-tenant phone→PII oracle.
DROP FUNCTION IF EXISTS public.get_booking_client_snapshot(text);
