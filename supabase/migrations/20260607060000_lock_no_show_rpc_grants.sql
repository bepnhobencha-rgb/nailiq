-- CRITICAL: these SECURITY DEFINER no-show functions were EXECUTE-able by anon/
-- authenticated via PostgREST (default PUBLIC grant) → anyone could poison
-- client_profiles.no_show_count, fire the global sweep, or rotate waitlist
-- claim tokens. Lock to service_role only. The authorized server actions call
-- them via the service-role client (after role/salon auth), and pg_cron runs
-- auto_mark_no_shows as the job owner (unaffected by role grants).
REVOKE ALL ON FUNCTION public.auto_mark_no_shows() FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.bump_client_no_show(text) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.unbump_client_no_show(text) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.notify_waitlist_for_no_show(uuid) FROM public, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.auto_mark_no_shows() TO service_role;
GRANT EXECUTE ON FUNCTION public.bump_client_no_show(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.unbump_client_no_show(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.notify_waitlist_for_no_show(uuid) TO service_role;
