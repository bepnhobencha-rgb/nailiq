-- Make the RPC-only contract explicit to the database linter as well as ACLs.
-- SECURITY DEFINER functions are the sole entry points; browser/data API roles
-- cannot read or mutate decision receipts directly.

DROP POLICY IF EXISTS no_direct_booking_no_show_decision_access
  ON public.booking_no_show_decisions;
CREATE POLICY no_direct_booking_no_show_decision_access
  ON public.booking_no_show_decisions
  AS RESTRICTIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);
