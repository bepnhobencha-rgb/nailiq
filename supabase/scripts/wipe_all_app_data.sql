-- One-shot wipe of NailIQ application data in `public` schema.
-- Run in Supabase Dashboard → SQL Editor (postgres role).
-- IRREVERSIBLE. Backup first if unsure.
--
-- Round 1: salon graph (salons → members, services, staff, bookings, waitlist, …).
-- Round 2: OTP / registration tokens (no FK to salons).

begin;

truncate table public.salons restart identity cascade;

truncate table public.otps, public.register_completion_tokens restart identity cascade;

commit;

-- Optional — only if you want brand-new logins (owners must register again):
-- Dashboard → Authentication → Users → delete users,
-- or follow Supabase docs for bulk-deleting auth.users safely.
