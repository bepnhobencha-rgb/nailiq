-- Production recorded this migration version when the waitlist Realtime
-- publication change was applied during PR #1210. The committed, idempotent
-- schema change lives in 20260809231500_enable_waitlist_realtime.sql.
--
-- Keep this marker so local and production migration histories remain aligned.
-- It is intentionally a no-op on a fresh database because the preceding
-- migration already performs and verifies the publication change.
SELECT 1;
