-- Prelude — run BEFORE schema.sql on an empty database.
--
-- schema.sql is a straight pg_dump of production. It is applied VERBATIM: never
-- hand-edit it, or it drifts from production the moment anyone re-dumps, and the
-- drift is silent. Everything the dump ASSUMES already exists goes here instead.
--
-- What the dump brings itself (checked, do NOT duplicate here):
--   • CREATE SCHEMA auth, CREATE SCHEMA public
--   • auth.uid(), auth.role(), auth.jwt(), auth.email()
--   • every table, policy, index, trigger, constraint
--
-- What it does NOT bring, and why:
--   • ROLES — a Supabase project ships anon / authenticated / service_role.
--   • EXTENSIONS — they live in the `extensions` schema, which was not dumped.
--
-- Keep this file boring. If it starts doing anything clever, the test database
-- has stopped being a copy of production and the suite has stopped meaning
-- anything.

-- ── public schema ───────────────────────────────────────────────────────────
-- The dump contains `CREATE SCHEMA public;`, which collides with the one every
-- fresh database already has. Dropping it first is the standard way to restore a
-- pg_dump, and it keeps the dump byte-identical to what came off production.
DROP SCHEMA IF EXISTS public CASCADE;

-- ── Roles ───────────────────────────────────────────────────────────────────
-- The dump has 60 `TO authenticated`, 5 `TO anon` and 1 `TO service_role` in its
-- RLS policies. A policy naming a role that does not exist is a hard error, so
-- CREATE POLICY fails and the schema lands half-built — tables present, isolation
-- missing. That is the worst outcome available: the suite goes green against a
-- database that isolates nothing.
-- The full set, taken from the dump itself rather than guessed:
--   grep -ohE '^(GRANT|REVOKE) .* (TO|FROM) …' schema.sql
-- gives anon, authenticated, service_role, dashboard_user, supabase_auth_admin,
-- postgres and PUBLIC. `postgres` and `PUBLIC` exist in every cluster; the rest
-- are Supabase's, and have to be made here.
DO $$
DECLARE
  r text;
BEGIN
  -- `supabase_admin` only shows up in ALTER DEFAULT PRIVILEGES near the end of
  -- the dump, so grepping GRANT/REVOKE lines alone missed it and the apply died
  -- 13,712 lines in. Both greps are in the note above; use both.
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'dashboard_user',
                           'supabase_auth_admin', 'supabase_admin']
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOINHERIT', r);
    END IF;
  END LOOP;

  -- service_role bypasses RLS on Supabase; the E2E helpers seed through it, and
  -- without BYPASSRLS every seed would be filtered by the very policies the
  -- suite is meant to be testing.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;

  -- PostgREST logs in as `authenticator` and switches to anon/authenticated per
  -- request, so it must be a member of both.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator LOGIN NOINHERIT;
  END IF;
END
$$;

GRANT anon, authenticated, service_role TO authenticator;

-- ── Extensions ──────────────────────────────────────────────────────────────
-- gen_random_uuid(), the trigram search on client names, and the GIST exclusion
-- constraint on bookings all come from these. btree_gist in particular carries
-- `bookings_no_overlap` — the constraint that stops two customers being booked
-- into the same tech at the same time. A database missing it would let the
-- double-booking specs pass while double-booking is possible.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto    WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS btree_gist  WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm     WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
