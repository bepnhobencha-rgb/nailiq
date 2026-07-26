-- Pre-live hardening (audit follow-up).
--
-- (1) client_profiles had always-true RLS for anon/authenticated INSERT/UPDATE,
-- so any visitor could write ANY column via PostgREST — incl. forging is_vip or
-- poisoning no_show_count (the no-show risk-engine signal). The public booking
-- upsert only ever writes these 5 columns, so restrict writes to exactly them.
REVOKE INSERT, UPDATE ON public.client_profiles FROM anon, authenticated;
GRANT INSERT (phone, name, preferred_staff_id, last_service_date, visit_count)
  ON public.client_profiles TO anon, authenticated;
GRANT UPDATE (name, preferred_staff_id, last_service_date, visit_count)
  ON public.client_profiles TO anon, authenticated;

-- (2) Backend-only SECURITY DEFINER functions were anon-callable via PostgREST.
-- Real callers: pg_cron (cleanup), a trigger (auto_stamp), and service-role API
-- routes (voice/referral). Lock to service_role.
REVOKE ALL ON FUNCTION public.cleanup_test_salons() FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.auto_stamp_on_booking_complete() FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.increment_voice_session_if_under_limit(uuid) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_referral_code(uuid, text, integer, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_test_salons() TO service_role;
GRANT EXECUTE ON FUNCTION public.increment_voice_session_if_under_limit(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.create_referral_code(uuid, text, integer, integer) TO service_role;
