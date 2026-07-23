-- Pre-live hardening: two orphaned (no app caller) SECURITY DEFINER queue
-- functions were anon-callable via PostgREST with NO auth/salon scoping:
--   get_salon_queue(uuid)            → leaked walk-in PII (name+phone) of ANY salon
--   update_queue_entry_status(...)   → let anyone tamper with ANY queue entry
-- The live receptionist queue uses direct table reads, not these RPCs, so locking
-- to service_role breaks nothing.
REVOKE ALL ON FUNCTION public.get_salon_queue(uuid) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.update_queue_entry_status(uuid, text, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_salon_queue(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.update_queue_entry_status(uuid, text, uuid) TO service_role;
