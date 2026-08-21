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

-- ── auth schema ─────────────────────────────────────────────────────────────
-- The baseline covers `public` ONLY. `auth` belongs to GoTrue, which creates and
-- owns it on a Supabase stack — carrying production's copy of it would fight
-- whatever GoTrue version the local stack runs, and no public table has a FK
-- into auth.users anyway (checked).
--
-- But nearly every RLS policy calls auth.uid(). On a bare Postgres (used to
-- verify the baseline rebuilds from nothing) that function does not exist, and
-- every policy referencing it would fail to create.
--
-- So: create it only when it is ABSENT. Never CREATE OR REPLACE — on a Supabase
-- stack that would overwrite the real implementation with this stub, and RLS
-- would then read a claim that is never set. Every policy would quietly evaluate
-- to false, or worse, to true.
CREATE SCHEMA IF NOT EXISTS auth;

DO $prelude$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'auth' AND p.proname = 'uid'
  ) THEN
    EXECUTE $fn$
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
        $body$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $body$;
    $fn$;
    EXECUTE $fn$
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS
        $body$ SELECT nullif(current_setting('request.jwt.claim.role', true), '')::text $body$;
    $fn$;
    EXECUTE $fn$
      CREATE FUNCTION auth.email() RETURNS text LANGUAGE sql STABLE AS
        $body$ SELECT nullif(current_setting('request.jwt.claim.email', true), '')::text $body$;
    $fn$;
    EXECUTE $fn$
      CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS
        $body$ SELECT coalesce(nullif(current_setting('request.jwt.claim', true), ''), '{}')::jsonb $body$;
    $fn$;
  END IF;
END
$prelude$;

-- ── auth.users (stub, only on a bare Postgres) ──────────────────────────────
-- `public` depends on auth.users in 21 places: foreign keys (e.g.
-- approval_requests.decided_by), policies, and functions that read the owner's
-- email. A first pass here concluded there were no such FKs — that was a bad
-- query, and the schema apply failed on the truth 7,874 lines in.
--
-- On any Supabase stack GoTrue owns this table and it already exists, so the
-- guard below skips. This stub exists purely so the baseline can be proven to
-- rebuild on an empty Postgres with nothing else installed — the check that
-- caught the missing GRANTs and would catch the next silent gap.
--
-- Only the columns `public` actually touches. It is not, and must not become, a
-- reimplementation of GoTrue.
DO $prelude$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'auth' AND c.relname = 'users'
  ) THEN
    CREATE TABLE auth.users (
      id                  uuid PRIMARY KEY,
      email               text,
      phone               text,
      encrypted_password  text,
      email_confirmed_at  timestamptz,
      phone_confirmed_at  timestamptz,
      banned_until        timestamptz,
      raw_app_meta_data   jsonb,
      raw_user_meta_data  jsonb,
      created_at          timestamptz DEFAULT now(),
      last_sign_in_at     timestamptz
    );
  END IF;
END
$prelude$;

-- `current_auth_session_is_active()` is the one public contract that must
-- correlate a JWT session_id with GoTrue's server-owned session row. A bare
-- Postgres history rehearsal has no GoTrue process, so provide only the two
-- identity columns plus timestamps used by fixtures. The guard never replaces
-- the real auth.sessions table on a Supabase stack.
DO $prelude$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'auth' AND c.relname = 'sessions'
  ) THEN
    CREATE TABLE auth.sessions (
      id          uuid PRIMARY KEY,
      user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      created_at  timestamptz DEFAULT now(),
      updated_at  timestamptz DEFAULT now()
    );
  END IF;
END
$prelude$;

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
