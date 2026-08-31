-- Supabase default table privileges can grant service_role more access than a
-- later narrow GRANT implies. Revoke the defaults explicitly, then restore only
-- the operations required by the Smart Checkout server boundary.

REVOKE ALL PRIVILEGES ON TABLE
  public.smart_checkout_devices,
  public.smart_checkout_sessions,
  public.smart_checkout_lines
  FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT, INSERT, UPDATE ON TABLE
  public.smart_checkout_devices,
  public.smart_checkout_sessions
  TO service_role;

GRANT SELECT, INSERT ON TABLE
  public.smart_checkout_lines
  TO service_role;
