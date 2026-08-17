-- Follow-up to 20260815190000_add_salon_closure_notice.sql: anonymous public
-- booking reads use a column-level allowlist grant on salons directly (see
-- 20260722214100_harden_public_salon_reads.sql), not just view membership —
-- public_salon_profiles runs with security_invoker=true, so the invoking
-- role (anon) needs SELECT on each underlying column it reads through the
-- view. Forgetting this grant here broke the entire public booking page for
-- every salon (caught in local verification before this ever reached
-- production/main).
GRANT SELECT (closure_notice) ON public.salons TO anon;
