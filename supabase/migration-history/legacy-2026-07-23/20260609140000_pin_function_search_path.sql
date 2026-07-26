-- Security hardening — pin search_path on 6 functions flagged by the Supabase
-- linter (`function_search_path_mutable`). A mutable search_path lets the
-- caller's session search_path influence object resolution inside the function;
-- it is a real privilege-escalation vector for SECURITY DEFINER functions
-- (here: increment_voice_session_if_under_limit) and a hardening best-practice
-- for the rest (the phone-canonicalisation trigger fns + canonical_phone).
--
-- ALTER ... SET search_path = public pins resolution to the schema these
-- functions already use, with no behaviour change.

alter function public.canonical_phone(p text)                          set search_path = public;
alter function public.increment_voice_session_if_under_limit(p_salon_id uuid) set search_path = public;
alter function public.tg_canon_client_phone()                          set search_path = public;
alter function public.tg_canon_member_phone()                          set search_path = public;
alter function public.tg_canon_phone()                                 set search_path = public;
alter function public.tg_canon_voucher_phones()                        set search_path = public;
