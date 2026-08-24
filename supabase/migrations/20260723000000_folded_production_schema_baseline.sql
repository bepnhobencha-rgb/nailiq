-- Generated folded schema baseline. Never execute this migration on the
-- existing production schema; production must record its version through
-- a separately approved migration-history repair after rehearsal.

-- BEGIN bootstrap prelude
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
-- END bootstrap prelude

-- BEGIN verified schema-only production snapshot
--
-- PostgreSQL database dump
--


-- Dumped from database version 17.10 (Homebrew)
-- Dumped by pg_dump version 17.10 (Homebrew)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: add_booking_addons(uuid, uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.add_booking_addons(p_booking_id uuid, p_service_ids uuid[]) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_salon_id uuid;
  v_count int := 0;
BEGIN
  SELECT salon_id INTO v_salon_id FROM public.bookings WHERE id = p_booking_id;
  IF v_salon_id IS NULL THEN
    RETURN 0;
  END IF;

  INSERT INTO public.booking_addons (booking_id, service_id, name, price_cents, duration_minutes)
  SELECT p_booking_id, s.id, s.name, s.price_cents,
         COALESCE(s.duration_minutes, 0) + COALESCE(s.buffer_minutes, 0)
  FROM public.services s
  JOIN unnest(p_service_ids) WITH ORDINALITY AS req(service_id, ord)
    ON req.service_id = s.id
  WHERE s.salon_id = v_salon_id
    AND s.is_addon = true
    AND s.deleted_at IS NULL
  ORDER BY req.ord;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;


--
-- Name: add_queue_entry(uuid, text, text, uuid, uuid, text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.add_queue_entry(p_salon_id uuid, p_client_name text, p_client_phone text, p_service_id uuid, p_requested_staff_id uuid DEFAULT NULL::uuid, p_client_notes text DEFAULT NULL::text, p_price_cents integer DEFAULT NULL::integer) RETURNS json
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
declare
  v_id uuid;
begin
  insert into queue_entries (
    salon_id, client_name, client_phone, service_id,
    requested_staff_id, client_notes, price_cents
  ) values (
    p_salon_id, p_client_name, p_client_phone, p_service_id,
    p_requested_staff_id, p_client_notes, p_price_cents
  )
  returning id into v_id;

  return json_build_object('id', v_id);
end;
$$;


--
-- Name: advance_waitlist_notifications(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.advance_waitlist_notifications(p_window_minutes integer DEFAULT 20) RETURNS TABLE(salon_id uuid, service_id uuid, booking_date date, salon_name text, service_name text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare r record;
begin
  for r in
    update public.booking_waitlist_entries w set status = 'expired'
     where w.status = 'notified' and w.claimed_at is null
       and w.notified_at < now() - make_interval(mins => p_window_minutes)
    returning w.salon_id as sid, w.service_id as svc, w.booking_date as bd
  loop
    update public.booking_waitlist_entries nx
       set status = 'notified', notified_at = now(), claim_token = gen_random_uuid()
     where nx.id = (select bw.id from public.booking_waitlist_entries bw
        where bw.salon_id = r.sid and bw.service_id = r.svc and bw.booking_date = r.bd
          and bw.status = 'waiting'
        order by bw.created_at limit 1 for update skip locked);
    if found then return query select r.sid, r.svc, r.bd,
      (select s.name from public.salons s where s.id = r.sid),
      (select sv.name from public.services sv where sv.id = r.svc);
    end if;
  end loop;
end; $$;


--
-- Name: auto_mark_no_shows(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auto_mark_no_shows() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_count integer := 0;
BEGIN
  WITH marked AS (
    UPDATE public.bookings b
       SET status = 'no_show', updated_at = now()
      FROM public.salons s
     WHERE b.salon_id = s.id
       AND s.auto_no_show_minutes IS NOT NULL
       AND s.auto_no_show_minutes > 0
       AND b.status = 'confirmed'
       AND b.start_time_utc < now() - (s.auto_no_show_minutes || ' minutes')::interval
    RETURNING b.client_phone
  ),
  counts AS (
    SELECT client_phone, count(*)::int AS n
    FROM marked
    WHERE client_phone IS NOT NULL AND btrim(client_phone) <> ''
    GROUP BY client_phone
  ),
  bumped AS (
    UPDATE public.client_profiles cp
       SET no_show_count = coalesce(cp.no_show_count, 0) + c.n,
           updated_at = now()
      FROM counts c
     WHERE cp.phone = c.client_phone
    RETURNING 1
  )
  SELECT coalesce((SELECT count(*) FROM marked), 0) INTO v_count;
  RETURN v_count;
END;
$$;


--
-- Name: auto_stamp_on_booking_complete(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auto_stamp_on_booking_complete() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
  v_program loyalty_programs%ROWTYPE;
  v_card    loyalty_cards%ROWTYPE;
  v_new_stamps integer;
BEGIN
  IF NEW.status != 'completed' OR OLD.status = 'completed' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_program
  FROM loyalty_programs
  WHERE salon_id = NEW.salon_id AND is_active = true
  LIMIT 1;

  IF NOT FOUND THEN RETURN NEW; END IF;

  IF NEW.client_phone IS NULL OR trim(NEW.client_phone) = '' THEN
    RETURN NEW;
  END IF;

  IF v_program.min_spend_cents > 0
    AND COALESCE(NEW.price_cents, 0) < v_program.min_spend_cents THEN
    RETURN NEW;
  END IF;

  INSERT INTO loyalty_cards (salon_id, program_id, client_phone)
  VALUES (NEW.salon_id, v_program.id, NEW.client_phone)
  ON CONFLICT (salon_id, client_phone) DO NOTHING;

  SELECT * INTO v_card
  FROM loyalty_cards
  WHERE salon_id = NEW.salon_id AND client_phone = NEW.client_phone;

  v_new_stamps := v_card.stamps_current + v_program.stamps_per_visit;

  IF v_new_stamps >= v_program.stamps_required THEN
    UPDATE loyalty_cards SET
      stamps_current  = 0,
      stamps_lifetime = stamps_lifetime + v_program.stamps_per_visit,
      rewards_earned  = rewards_earned + 1,
      last_stamp_at   = now(),
      updated_at      = now()
    WHERE id = v_card.id;

    INSERT INTO loyalty_stamp_events (
      salon_id, card_id, booking_id, event_type, stamps_delta, stamps_after
    ) VALUES (
      NEW.salon_id, v_card.id, NEW.id, 'earn',
      v_program.stamps_per_visit, 0
    );
  ELSE
    UPDATE loyalty_cards SET
      stamps_current  = v_new_stamps,
      stamps_lifetime = stamps_lifetime + v_program.stamps_per_visit,
      last_stamp_at   = now(),
      updated_at      = now()
    WHERE id = v_card.id;

    INSERT INTO loyalty_stamp_events (
      salon_id, card_id, booking_id, event_type, stamps_delta, stamps_after
    ) VALUES (
      NEW.salon_id, v_card.id, NEW.id, 'earn',
      v_program.stamps_per_visit, v_new_stamps
    );
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: bump_client_no_show(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bump_client_no_show(p_phone text) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  update public.client_profiles
     set no_show_count = coalesce(no_show_count, 0) + 1,
         updated_at = now()
   where phone = p_phone;
$$;


--
-- Name: cancel_booking_as_customer(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cancel_booking_as_customer(p_token_id uuid) RETURNS TABLE(ok boolean, code text, booking_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_token   booking_reminder_tokens%ROWTYPE;
  v_booking bookings%ROWTYPE;
  v_tz text;
  v_future boolean;
BEGIN
  SELECT * INTO v_token
  FROM   booking_reminder_tokens
  WHERE  id = p_token_id AND used_at IS NULL AND expires_at > now()
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'token_invalid'::text, NULL::uuid;
    RETURN;
  END IF;

  SELECT * INTO v_booking
  FROM   bookings
  WHERE  id = v_token.booking_id AND status IN ('pending','confirmed')
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'booking_not_cancellable'::text, NULL::uuid;
    RETURN;
  END IF;

  UPDATE bookings SET status = 'cancelled' WHERE id = v_booking.id;

  UPDATE booking_reminder_tokens
  SET used_at = now(), used_action = 'cancel'
  WHERE id = v_token.id;

  SELECT coalesce(nullif(trim(s.timezone), ''), 'America/Los_Angeles')
    INTO v_tz FROM salons s WHERE s.id = v_booking.salon_id;
  v_tz := coalesce(v_tz, 'America/Los_Angeles');
  v_future := v_booking.start_time_utc > now();

  UPDATE booking_waitlist_entries
  SET status = 'notified', notified_at = now(), claim_token = gen_random_uuid(),
      offered_staff_id  = CASE WHEN v_future THEN v_booking.staff_id END,
      offered_start_utc = CASE WHEN v_future THEN v_booking.start_time_utc END,
      offered_end_utc   = CASE WHEN v_future THEN v_booking.end_time_utc END
  WHERE id = (
    SELECT id FROM booking_waitlist_entries
    WHERE  salon_id = v_booking.salon_id
      AND  service_id = v_booking.service_id
      AND  booking_date = (v_booking.start_time_utc AT TIME ZONE v_tz)::date
      AND  status = 'waiting'
    ORDER BY created_at
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  );

  RETURN QUERY SELECT true, 'ok'::text, v_booking.id;
END;
$$;


--
-- Name: cancel_booking_by_id(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cancel_booking_by_id(p_booking_id uuid) RETURNS TABLE(ok boolean, code text, booking_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_booking bookings%ROWTYPE;
  v_tz text;
  v_future boolean;
BEGIN
  SELECT * INTO v_booking FROM bookings
  WHERE id = p_booking_id AND status IN ('pending','confirmed') FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT false,'booking_not_cancellable'::text,NULL::uuid; RETURN; END IF;

  UPDATE bookings SET status = 'cancelled' WHERE id = v_booking.id;

  SELECT coalesce(nullif(trim(s.timezone), ''), 'America/Los_Angeles')
    INTO v_tz FROM salons s WHERE s.id = v_booking.salon_id;
  v_tz := coalesce(v_tz, 'America/Los_Angeles');
  v_future := v_booking.start_time_utc > now();

  UPDATE booking_waitlist_entries
  SET status = 'notified', notified_at = now(), claim_token = gen_random_uuid(),
      offered_staff_id  = CASE WHEN v_future THEN v_booking.staff_id END,
      offered_start_utc = CASE WHEN v_future THEN v_booking.start_time_utc END,
      offered_end_utc   = CASE WHEN v_future THEN v_booking.end_time_utc END
  WHERE id = (
    SELECT id FROM booking_waitlist_entries
    WHERE salon_id = v_booking.salon_id AND service_id = v_booking.service_id
      AND booking_date = (v_booking.start_time_utc AT TIME ZONE v_tz)::date AND status = 'waiting'
    ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
  );

  RETURN QUERY SELECT true,'ok'::text, v_booking.id;
END;
$$;


--
-- Name: canonical_phone(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.canonical_phone(p text) RETURNS text
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO 'public'
    AS $$
declare d text;
begin
  if p is null then return null; end if;
  d := regexp_replace(p, '\D', '', 'g');
  if d = '' then return p; end if;             -- no digits → keep original
  if length(d) = 10 then return '1' || d; end if; -- bare NANP 10-digit
  return d;                                    -- already carries a country code
end; $$;


--
-- Name: check_group_slots_available(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.check_group_slots_available(p_slots jsonb) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_slot JSONB;
  v_conflicts INT[] := ARRAY[]::INT[];
  v_member_index INT;
  v_salon_id UUID;
  v_staff_id UUID;
  v_start TIMESTAMPTZ;
  v_end TIMESTAMPTZ;
  v_exists BOOLEAN;
BEGIN
  IF p_slots IS NULL OR jsonb_array_length(p_slots) = 0 THEN
    RETURN jsonb_build_object('available', true);
  END IF;

  FOR v_slot IN SELECT * FROM jsonb_array_elements(p_slots)
  LOOP
    v_member_index := (v_slot->>'member_index')::INT;
    v_salon_id := (v_slot->>'salon_id')::UUID;
    v_staff_id := (v_slot->>'staff_id')::UUID;
    v_start := (v_slot->>'start_time_utc')::TIMESTAMPTZ;
    v_end := (v_slot->>'end_time_utc')::TIMESTAMPTZ;

    SELECT EXISTS (
      SELECT 1
      FROM public.bookings b
      WHERE b.salon_id = v_salon_id
        AND b.staff_id = v_staff_id
        AND b.status <> 'cancelled'
        AND b.deleted_at IS NULL
        AND b.start_time_utc < v_end
        AND b.end_time_utc > v_start
    ) INTO v_exists;

    IF v_exists THEN
      v_conflicts := array_append(v_conflicts, v_member_index);
    END IF;
  END LOOP;

  IF array_length(v_conflicts, 1) IS NULL THEN
    RETURN jsonb_build_object('available', true);
  END IF;

  RETURN jsonb_build_object(
    'available', false,
    'conflicting_members', to_jsonb(v_conflicts)
  );
END;
$$;


--
-- Name: claim_party_slot(text, uuid, text, text, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_party_slot(p_token text, p_claim_id uuid, p_member_name text, p_member_phone text, p_reminder_opted_in boolean) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_link_id    UUID;
  v_expires    TIMESTAMPTZ;
  v_claimed    TIMESTAMPTZ;
  v_booking_id UUID;
  v_digits     TEXT;
  v_existing_fk UUID;
  v_profile_id UUID;
BEGIN
  SELECT id, expires_at INTO v_link_id, v_expires FROM party_links WHERE token = p_token;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'code', 'not_found'); END IF;
  IF v_expires < now() THEN RETURN jsonb_build_object('success', false, 'code', 'expired'); END IF;

  SELECT claimed_at, booking_id INTO v_claimed, v_booking_id
    FROM party_link_claims WHERE id = p_claim_id AND party_link_id = v_link_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'code', 'claim_not_found'); END IF;
  IF v_claimed IS NOT NULL THEN RETURN jsonb_build_object('success', false, 'code', 'already_claimed'); END IF;

  UPDATE party_link_claims
     SET member_name = p_member_name, member_phone = p_member_phone,
         reminder_opted_in = p_reminder_opted_in, claimed_at = now()
   WHERE id = p_claim_id;

  IF v_booking_id IS NOT NULL THEN
    UPDATE bookings SET client_name = p_member_name, client_phone = p_member_phone WHERE id = v_booking_id;
    v_digits := regexp_replace(coalesce(public.canonical_phone(p_member_phone), ''), '\D', '', 'g');
    IF length(v_digits) >= 7 THEN
      SELECT client_profile_id INTO v_existing_fk FROM bookings WHERE id = v_booking_id;
      IF v_existing_fk IS NULL THEN
        v_profile_id := public.resolve_client_profile(p_member_phone, p_member_name, NULL, NULL);
        UPDATE bookings SET client_profile_id = v_profile_id, is_party_member = false WHERE id = v_booking_id;
      ELSE
        UPDATE bookings SET is_party_member = false WHERE id = v_booking_id;
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object('success', true);
EXCEPTION
  WHEN others THEN RETURN jsonb_build_object('success', false, 'code', 'server_error');
END;
$$;


--
-- Name: claim_salon_memberships_by_email(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_salon_memberships_by_email(p_user_id uuid) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_email text;
  v_count integer := 0;
begin
  select email into v_email from auth.users where id = p_user_id;
  if v_email is null or v_email = '' then
    return 0;
  end if;

  -- The caller must have PROVEN control of this email (confirmed).
  if not exists (
    select 1 from auth.users
    where id = p_user_id and email_confirmed_at is not null
  ) then
    return 0;
  end if;

  update public.salon_members m
  set user_id = p_user_id
  from auth.users ou
  where m.user_id = ou.id
    and ou.id <> p_user_id
    and lower(ou.email) = lower(v_email)
    and not exists (
      select 1 from public.salon_members m2
      where m2.salon_id = m.salon_id and m2.user_id = p_user_id
    );
  get diagnostics v_count = row_count;

  update public.staff s
  set user_id = p_user_id
  from auth.users ou
  where s.user_id = ou.id
    and ou.id <> p_user_id
    and lower(ou.email) = lower(v_email)
    and not exists (
      select 1 from public.staff s2
      where s2.salon_id = s.salon_id and s2.user_id = p_user_id
    );

  return v_count;
end;
$$;


--
-- Name: claim_waitlist_slot(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_waitlist_slot(p_claim_token uuid) RETURNS TABLE(id uuid, client_name text, client_phone text, client_email text, auto_booked boolean, booking_id uuid, booked_start_utc timestamp with time zone, staff_name text, service_name text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_e        booking_waitlist_entries%ROWTYPE;
  v_auto     boolean;
  v_price    integer;
  v_res      jsonb;
  v_bid      uuid;
BEGIN
  SELECT * INTO v_e
  FROM   booking_waitlist_entries w
  WHERE  w.claim_token = p_claim_token
    AND  w.status      = 'notified'
    AND  w.claimed_at  IS NULL
  FOR UPDATE SKIP LOCKED;

  IF v_e.id IS NULL THEN
    RETURN;
  END IF;

  v_auto := COALESCE(
    (SELECT (s.feature_flags ->> 'waitlist_auto_book')::boolean
       FROM salons s WHERE s.id = v_e.salon_id),
    false
  );

  IF v_auto
     AND v_e.offered_staff_id  IS NOT NULL
     AND v_e.offered_start_utc IS NOT NULL
     AND v_e.offered_end_utc   IS NOT NULL THEN

    SELECT sv.price_cents INTO v_price
    FROM services sv WHERE sv.id = v_e.service_id;

    v_res := public.create_public_booking(
      v_e.salon_id, v_e.service_id, v_e.offered_staff_id,
      v_e.client_name, v_e.client_phone,
      v_e.offered_start_utc, v_e.offered_end_utc,
      'confirmed', v_price, NULL, NULL, NULL, v_e.client_email
    );

    IF COALESCE((v_res ->> 'success')::boolean, false) THEN
      v_bid := (v_res ->> 'booking_id')::uuid;
      UPDATE booking_waitlist_entries
         SET status = 'claimed', claimed_at = now(), booked_booking_id = v_bid
       WHERE booking_waitlist_entries.id = v_e.id;

      RETURN QUERY SELECT
        v_e.id, v_e.client_name, v_e.client_phone, v_e.client_email,
        true, v_bid, v_e.offered_start_utc,
        (SELECT st.name FROM staff st WHERE st.id = v_e.offered_staff_id),
        (SELECT sv.name FROM services sv WHERE sv.id = v_e.service_id);
      RETURN;
    ELSE
      UPDATE booking_waitlist_entries
         SET status = 'waiting', notified_at = NULL, claim_token = NULL,
             offered_staff_id = NULL, offered_start_utc = NULL, offered_end_utc = NULL
       WHERE booking_waitlist_entries.id = v_e.id;
      RETURN;
    END IF;
  END IF;

  UPDATE booking_waitlist_entries
     SET status = 'claimed', claimed_at = now()
   WHERE booking_waitlist_entries.id = v_e.id;

  RETURN QUERY SELECT
    v_e.id, v_e.client_name, v_e.client_phone, v_e.client_email,
    false, NULL::uuid, NULL::timestamptz, NULL::text,
    (SELECT sv.name FROM services sv WHERE sv.id = v_e.service_id);
END;
$$;


--
-- Name: cleanup_test_salons(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cleanup_test_salons() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  deleted_count integer;
  target_ids uuid[];
begin
  select array_agg(id) into target_ids
  from public.salons
  where (slug like 'e2e-%' or slug like 'test-%' or slug like 'probe-%')
    and created_at < now() - interval '2 hours';

  if target_ids is null then
    return 0;
  end if;

  -- NO ACTION FK children must go before the salon delete; the rest cascade.
  delete from public.loyalty_stamp_events where salon_id = any(target_ids);
  delete from public.loyalty_cards        where salon_id = any(target_ids);
  delete from public.loyalty_programs     where salon_id = any(target_ids);
  delete from public.voice_ai_sessions    where salon_id = any(target_ids);

  delete from public.salons where id = any(target_ids);
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;


--
-- Name: compute_no_show_risk(integer, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.compute_no_show_risk(p_no_show_count integer, p_visit_count integer, p_subtotal_cents integer) RETURNS integer
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
  v_score int := 30;
BEGIN
  IF    p_no_show_count >= 3 THEN v_score := v_score + 40;
  ELSIF p_no_show_count  = 2 THEN v_score := v_score + 30;
  ELSIF p_no_show_count  = 1 THEN v_score := v_score + 20;
  END IF;

  IF    p_visit_count  = 0  THEN v_score := v_score + 15;
  ELSIF p_visit_count >= 10 THEN v_score := v_score - 25;
  ELSIF p_visit_count >=  5 THEN v_score := v_score - 15;
  ELSIF p_visit_count >=  2 THEN v_score := v_score -  5;
  END IF;

  IF p_subtotal_cents >= 15000 THEN v_score := v_score - 10; END IF;

  RETURN greatest(0, least(100, v_score));
END;
$$;


--
-- Name: confirm_booking_as_customer(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.confirm_booking_as_customer(p_token_id uuid) RETURNS TABLE(ok boolean, code text, booking_id uuid, service_name text, staff_name text, start_utc timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_token   booking_reminder_tokens%ROWTYPE;
  v_booking bookings%ROWTYPE;
  v_svc text; v_stf text;
BEGIN
  SELECT * INTO v_token
  FROM   booking_reminder_tokens
  WHERE  id         = p_token_id
    AND  used_at    IS NULL
    AND  expires_at > now()
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false,'token_invalid'::text,NULL::uuid,NULL::text,NULL::text,NULL::timestamptz;
    RETURN;
  END IF;

  SELECT * INTO v_booking
  FROM   bookings
  WHERE  id     = v_token.booking_id
    AND  status IN ('pending','confirmed')
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false,'booking_not_found'::text,NULL::uuid,NULL::text,NULL::text,NULL::timestamptz;
    RETURN;
  END IF;

  UPDATE bookings
  SET status       = 'confirmed',
      confirmed_at = now()
  WHERE id = v_booking.id;

  UPDATE booking_reminder_tokens
  SET used_at     = now(),
      used_action = 'confirm'
  WHERE id = v_token.id;

  SELECT name INTO v_svc FROM services WHERE id = v_booking.service_id;
  SELECT name INTO v_stf FROM staff    WHERE id = v_booking.staff_id;

  RETURN QUERY SELECT true,'ok'::text, v_booking.id, v_svc, v_stf, v_booking.start_time_utc;
END;
$$;


--
-- Name: confirm_booking_with_otp(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.confirm_booking_with_otp(p_booking_id uuid, p_otp_session_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_session record;
  v_booking record;
BEGIN
  SELECT * INTO v_session
  FROM phone_otp_sessions
  WHERE id = p_otp_session_id
    AND consumed_at IS NULL
    AND expires_at > now();

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'otp_invalid_or_expired');
  END IF;

  SELECT * INTO v_booking
  FROM bookings
  WHERE id = p_booking_id
    AND client_phone = v_session.phone;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'phone_mismatch');
  END IF;

  UPDATE phone_otp_sessions SET consumed_at = now() WHERE id = p_otp_session_id;

  UPDATE bookings
  SET status                    = 'confirmed',
      verification_method       = 'otp',
      verification_completed_at = now(),
      otp_session_id            = p_otp_session_id,
      confirmed_at              = now()
  WHERE id = p_booking_id;

  INSERT INTO booking_events(booking_id, salon_id, event_type, payload)
  VALUES (
    p_booking_id,
    v_booking.salon_id,
    'verified_via_otp',
    jsonb_build_object('otp_session_id', p_otp_session_id)
  );

  RETURN jsonb_build_object('ok', true, 'booking_id', p_booking_id);
END;
$$;


--
-- Name: confirm_party_member(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.confirm_party_member(p_booking_id uuid, p_token text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_row RECORD;
BEGIN
  SELECT booking_id, expires_at
    INTO v_row
    FROM booking_reminder_tokens
   WHERE id = p_token::uuid;

  IF NOT FOUND                           THEN RETURN jsonb_build_object('ok', false, 'code', 'not_found');   END IF;
  IF v_row.booking_id != p_booking_id    THEN RETURN jsonb_build_object('ok', false, 'code', 'mismatch');    END IF;
  IF v_row.expires_at  < now()           THEN RETURN jsonb_build_object('ok', false, 'code', 'expired');     END IF;

  UPDATE bookings SET attendance_status = 'confirmed' WHERE id = p_booking_id;

  RETURN jsonb_build_object('ok', true);
EXCEPTION WHEN others THEN
  RETURN jsonb_build_object('ok', false, 'code', 'server_error');
END;
$$;


--
-- Name: create_public_booking(uuid, uuid, uuid, text, text, timestamp with time zone, timestamp with time zone, text, integer, text, uuid, integer, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_public_booking(p_salon_id uuid, p_service_id uuid, p_staff_id uuid, p_client_name text, p_client_phone text, p_start_time_utc timestamp with time zone, p_end_time_utc timestamp with time zone, p_status text DEFAULT 'pending'::text, p_price_cents integer DEFAULT NULL::integer, p_client_notes text DEFAULT NULL::text, p_addon_service_id uuid DEFAULT NULL::uuid, p_addon_price_cents integer DEFAULT NULL::integer, p_client_email text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_booking_id uuid;
  v_start timestamptz;
  v_end timestamptz;
  v_hours jsonb;
  v_closed_dates jsonb;
  v_tz_raw text;
  v_tz text;
  v_start_local timestamp;
  v_end_local timestamp;
  v_dow numeric;
  v_day text;
  v_day_cfg jsonb;
  v_ymd text;
  v_open time;
  v_close time;
  v_booking_time time;
  v_end_booking_time time;
  v_phone_trim text;
  v_digits text;
  v_email text;
  v_profile_id uuid;
begin
  raise notice 'create_public_booking v2.8 (profile-link restored)';

  if p_client_name is null or length(trim(p_client_name)) = 0 then
    raise exception 'missing_client_name' using errcode = 'P0001';
  end if;

  v_phone_trim := trim(coalesce(p_client_phone, ''));
  if v_phone_trim = '' then
    raise exception 'missing_phone' using errcode = 'P0001';
  end if;

  v_digits := regexp_replace(v_phone_trim, '\D', '', 'g');
  if length(v_digits) < 7 then
    raise exception 'missing_phone' using errcode = 'P0001';
  end if;

  v_email := nullif(trim(coalesce(p_client_email, '')), '');

  if p_start_time_utc is null or p_end_time_utc is null then
    raise exception 'invalid_time' using errcode = 'P0001';
  end if;

  if p_start_time_utc >= p_end_time_utc then
    raise exception 'invalid_time' using errcode = 'P0001';
  end if;

  if p_start_time_utc < (clock_timestamp() + interval '2 minutes') then
    raise exception 'invalid_time' using errcode = 'P0001';
  end if;

  select
    s.opening_hours,
    coalesce(s.booking_closed_dates, '[]'::jsonb),
    coalesce(nullif(trim(s.timezone), ''), 'America/Los_Angeles')
  into v_hours, v_closed_dates, v_tz_raw
  from public.salons s
  where s.id = p_salon_id;

  if not found then
    raise exception 'invalid_reference' using errcode = 'P0001';
  end if;

  if exists (select 1 from pg_timezone_names n where n.name = v_tz_raw) then
    v_tz := v_tz_raw;
  else
    v_tz := 'America/Los_Angeles';
  end if;

  if v_hours is null or v_hours = '{}'::jsonb then
    raise exception 'outside_hours' using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from public.services sv
    where sv.id = p_service_id and sv.salon_id = p_salon_id
  ) then
    raise exception 'invalid_reference' using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from public.staff st
    where st.id = p_staff_id and st.salon_id = p_salon_id
  ) then
    raise exception 'invalid_reference' using errcode = 'P0001';
  end if;

  if p_addon_service_id is not null then
    if not exists (
      select 1 from public.services s
      where s.id = p_addon_service_id and s.salon_id = p_salon_id
    ) then
      raise exception 'invalid_reference' using errcode = 'P0001';
    end if;
  end if;

  v_start_local := p_start_time_utc at time zone v_tz;
  v_end_local := p_end_time_utc at time zone v_tz;

  if date(v_start_local) <> date(v_end_local) then
    raise exception 'outside_hours' using errcode = 'P0001';
  end if;

  v_ymd := to_char(v_start_local, 'YYYY-MM-DD');
  if jsonb_typeof(v_closed_dates) = 'array'
     and exists (
       select 1 from jsonb_array_elements_text(v_closed_dates) as el(t)
       where el.t = v_ymd
     ) then
    raise exception 'outside_hours' using errcode = 'P0001';
  end if;

  v_dow := extract(dow from v_start_local);

  case v_dow::int
    when 0 then v_day := 'sun';
    when 1 then v_day := 'mon';
    when 2 then v_day := 'tue';
    when 3 then v_day := 'wed';
    when 4 then v_day := 'thu';
    when 5 then v_day := 'fri';
    when 6 then v_day := 'sat';
    else raise exception 'outside_hours' using errcode = 'P0001';
  end case;

  if (v_hours -> v_day) is null then
    raise exception 'outside_hours' using errcode = 'P0001';
  end if;

  if jsonb_typeof(v_hours -> v_day) <> 'object' then
    raise exception 'outside_hours' using errcode = 'P0001';
  end if;

  v_day_cfg := v_hours -> v_day;

  if (v_day_cfg -> 'closed') is not null and (v_day_cfg -> 'closed')::text = 'true' then
    raise exception 'outside_hours' using errcode = 'P0001';
  end if;

  if v_day_cfg->>'open' is null or v_day_cfg->>'close' is null
    or trim(v_day_cfg->>'open') = '' or trim(v_day_cfg->>'close') = '' then
    raise exception 'outside_hours' using errcode = 'P0001';
  end if;

  v_open := (v_day_cfg->>'open')::time;
  v_close := (v_day_cfg->>'close')::time;

  if v_close <= v_open then
    raise exception 'outside_hours' using errcode = 'P0001';
  end if;

  v_booking_time := (p_start_time_utc at time zone v_tz)::time;
  v_end_booking_time := (p_end_time_utc at time zone v_tz)::time;

  if v_booking_time < v_open or v_booking_time >= v_close then
    raise exception 'outside_hours' using errcode = 'P0001';
  end if;

  if v_end_booking_time > v_close or v_end_booking_time <= v_booking_time then
    raise exception 'outside_hours' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(
    hashtext(p_salon_id::text || chr(255) || p_staff_id::text)::bigint
  );

  if exists (
    select 1 from public.bookings b
    where b.salon_id = p_salon_id
      and b.staff_id = p_staff_id
      and b.status not in ('cancelled', 'waiting')
      and b.start_time_utc < p_end_time_utc
      and b.end_time_utc > p_start_time_utc
    limit 1
  ) then
    raise exception 'slot_conflict' using errcode = '23P01';
  end if;

  begin
    insert into public.bookings (
      salon_id, service_id, staff_id, client_name, client_phone, client_email,
      start_time_utc, end_time_utc, status, price_cents, client_notes,
      addon_service_id, addon_price_cents
    )
    values (
      p_salon_id, p_service_id, p_staff_id, trim(p_client_name), v_digits, v_email,
      p_start_time_utc, p_end_time_utc, 'confirmed', p_price_cents,
      nullif(trim(p_client_notes), ''), p_addon_service_id, p_addon_price_cents
    )
    returning public.bookings.id, public.bookings.start_time_utc, public.bookings.end_time_utc
    into v_booking_id, v_start, v_end;
  exception
    when exclusion_violation then
      return jsonb_build_object('success', false, 'code', 'slot_conflict');
    when unique_violation then
      return jsonb_build_object('success', false, 'code', 'duplicate_booking');
    when check_violation then
      return jsonb_build_object('success', false, 'code', 'invalid_email');
  end;

  v_profile_id := public.resolve_client_profile(v_digits, p_client_name, v_email, p_staff_id);
  if v_profile_id is not null then
    update public.bookings set client_profile_id = v_profile_id where id = v_booking_id;
  end if;

  return jsonb_build_object(
    'success', true,
    'booking_id', v_booking_id,
    'start_time_utc', v_start,
    'end_time_utc', v_end
  );

exception
  when exclusion_violation then
    return jsonb_build_object('success', false, 'code', 'slot_conflict');
  when sqlstate 'P0001' then
    if sqlerrm = 'invalid_time' then
      return jsonb_build_object('success', false, 'code', 'invalid_time');
    elsif sqlerrm = 'missing_phone' then
      return jsonb_build_object('success', false, 'code', 'missing_phone');
    elsif sqlerrm = 'invalid_reference' then
      return jsonb_build_object('success', false, 'code', 'invalid_reference');
    elsif sqlerrm = 'outside_hours' then
      return jsonb_build_object('success', false, 'code', 'outside_hours');
    elsif sqlerrm = 'missing_client_name' then
      return jsonb_build_object('success', false, 'code', 'missing_client_name');
    else
      return jsonb_build_object('success', false, 'code', 'unknown_error');
    end if;
  when others then
    return jsonb_build_object('success', false, 'code', 'unknown_error');
end;
$$;


--
-- Name: create_public_waitlist_entry(uuid, uuid, uuid, date, text, text, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_public_waitlist_entry(p_salon_id uuid, p_service_id uuid, p_staff_id uuid, p_booking_date date, p_preferred_slot_label text, p_client_name text, p_client_phone text, p_source text, p_client_email text DEFAULT NULL::text) RETURNS TABLE(id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_service_salon uuid;
  v_staff_salon   uuid;
  v_src           text := lower(trim(coalesce(p_source, '')));
begin
  if v_src not in ('slot_unavailable', 'booking_conflict') then
    raise exception 'invalid_waitlist_source';
  end if;

  select s.salon_id into v_service_salon
  from public.services s
  where s.id = p_service_id;

  if v_service_salon is null or v_service_salon <> p_salon_id then
    raise exception 'invalid_service_for_salon';
  end if;

  if p_staff_id is not null then
    select st.salon_id into v_staff_salon
    from public.staff st
    where st.id = p_staff_id;

    if v_staff_salon is null or v_staff_salon <> p_salon_id then
      raise exception 'invalid_staff_for_salon';
    end if;
  end if;

  return query
  insert into public.booking_waitlist_entries (
    salon_id,
    service_id,
    staff_id,
    booking_date,
    preferred_slot_label,
    client_name,
    client_phone,
    client_email,
    source
  )
  values (
    p_salon_id,
    p_service_id,
    p_staff_id,
    p_booking_date,
    nullif(trim(p_preferred_slot_label), ''),
    trim(p_client_name),
    trim(p_client_phone),
    nullif(trim(coalesce(p_client_email, '')), ''),
    v_src
  )
  returning public.booking_waitlist_entries.id;
end;
$$;


--
-- Name: create_referral_code(uuid, text, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_referral_code(p_salon_id uuid, p_referrer_phone text, p_referrer_reward integer DEFAULT 10, p_referee_reward integer DEFAULT 10) RETURNS json
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
  v_code text;
  v_id uuid;
  v_attempts int := 0;
BEGIN
  LOOP
    v_code := upper(substring(md5(random()::text) from 1 for 6));
    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM public.referrals
      WHERE salon_id = p_salon_id AND code = v_code
    );
    v_attempts := v_attempts + 1;
    IF v_attempts > 10 THEN
      RAISE EXCEPTION 'code_collision';
    END IF;
  END LOOP;

  INSERT INTO public.referrals (
    salon_id,
    referrer_phone,
    code,
    referrer_reward_percent_off,
    referee_reward_percent_off,
    status,
    expires_at
  )
  VALUES (
    p_salon_id,
    p_referrer_phone,
    v_code,
    p_referrer_reward,
    p_referee_reward,
    'pending',
    now() + interval '1 year'
  )
  RETURNING id INTO v_id;

  RETURN json_build_object('id', v_id, 'code', v_code);
END;
$$;


--
-- Name: decline_party_member(uuid, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.decline_party_member(p_booking_id uuid, p_token text, p_suggested_name text DEFAULT NULL::text, p_suggested_phone text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_token_row RECORD;
  v_booking   RECORD;
BEGIN
  -- 1. Validate token
  SELECT booking_id, expires_at
    INTO v_token_row
    FROM booking_reminder_tokens
   WHERE id = p_token::uuid;

  IF NOT FOUND                               THEN RETURN jsonb_build_object('ok', false, 'code', 'not_found'); END IF;
  IF v_token_row.booking_id != p_booking_id  THEN RETURN jsonb_build_object('ok', false, 'code', 'mismatch'); END IF;
  IF v_token_row.expires_at  < now()         THEN RETURN jsonb_build_object('ok', false, 'code', 'expired');  END IF;

  -- 2. Get booking start time + salon's configured cutoff in one join
  SELECT b.start_time_utc, COALESCE(s.group_decline_cutoff_hours, 2) AS cutoff
    INTO v_booking
    FROM bookings b
    JOIN salons   s ON s.id = b.salon_id
   WHERE b.id = p_booking_id;

  -- 3. Cutoff check → return too_late so the client routes to Minh flow
  IF v_booking.start_time_utc < (now() + (v_booking.cutoff || ' hours')::interval) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'too_late', 'cutoff_hours', v_booking.cutoff);
  END IF;

  -- 4. Self-serve decline
  UPDATE bookings SET attendance_status = 'declined' WHERE id = p_booking_id;

  UPDATE party_link_claims
     SET member_name       = NULL,
         member_phone      = NULL,
         reminder_opted_in = false,
         claimed_at        = NULL,
         declined_at       = now(),
         suggested_name    = p_suggested_name,
         suggested_phone   = p_suggested_phone
   WHERE booking_id = p_booking_id;

  RETURN jsonb_build_object('ok', true);
EXCEPTION WHEN others THEN
  RETURN jsonb_build_object('ok', false, 'code', 'server_error');
END;
$$;


--
-- Name: determine_booking_verification(uuid, text, uuid[], integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.determine_booking_verification(p_salon_id uuid, p_client_phone text, p_service_ids uuid[], p_subtotal_cents integer) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE v_salon record; v_client record; v_risk int; v_deposit_amount_cents int := 0; v_action text;
BEGIN
  SELECT booking_verification_mode, verification_risk_threshold_otp, verification_risk_threshold_deposit, deposit_high_value_cents, deposit_default_amount_cents
  INTO v_salon FROM salons WHERE id = p_salon_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('action','none','reason','salon_not_found','risk_score',0); END IF;
  IF v_salon.booking_verification_mode = 'never' THEN RETURN jsonb_build_object('action','none','reason','mode_never','risk_score',0); END IF;
  SELECT is_vip, coalesce(visit_count,0) AS visit_count, coalesce(no_show_count,0) AS no_show_count, phone_verified_at
  INTO v_client FROM client_profiles WHERE phone = p_client_phone;
  IF FOUND AND v_client.is_vip = true THEN RETURN jsonb_build_object('action','none','reason','vip_skip','risk_score',0); END IF;
  IF FOUND AND coalesce(v_client.visit_count,0) >= 5 AND coalesce(v_client.no_show_count,0) = 0 THEN RETURN jsonb_build_object('action','none','reason','trusted_returning','risk_score',0); END IF;
  IF FOUND AND v_client.phone_verified_at IS NOT NULL AND coalesce(v_client.no_show_count,0) = 0 AND v_client.phone_verified_at > now() - interval '12 months' THEN
    RETURN jsonb_build_object('action','none','reason','phone_already_verified','risk_score',0); END IF;
  v_risk := public.compute_no_show_risk(coalesce(CASE WHEN FOUND THEN v_client.no_show_count ELSE 0 END,0), coalesce(CASE WHEN FOUND THEN v_client.visit_count ELSE 0 END,0), p_subtotal_cents);
  CASE v_salon.booking_verification_mode
    WHEN 'always_otp' THEN v_action := 'otp_required';
    WHEN 'always_deposit' THEN v_action := 'deposit_required'; v_deposit_amount_cents := coalesce(v_salon.deposit_default_amount_cents, p_subtotal_cents * 30 / 100);
    WHEN 'deposit_first' THEN
      IF v_risk >= v_salon.verification_risk_threshold_otp THEN v_action := 'deposit_or_otp'; v_deposit_amount_cents := coalesce(v_salon.deposit_default_amount_cents, p_subtotal_cents * 30 / 100);
      ELSE v_action := 'none'; END IF;
    ELSE
      IF v_risk < v_salon.verification_risk_threshold_otp THEN v_action := 'none';
      ELSIF v_risk < v_salon.verification_risk_threshold_deposit THEN v_action := 'otp_optional';
      ELSE IF p_subtotal_cents >= coalesce(v_salon.deposit_high_value_cents, 5000) THEN v_action := 'deposit_required'; v_deposit_amount_cents := coalesce(v_salon.deposit_default_amount_cents, p_subtotal_cents * 30 / 100);
        ELSE v_action := 'otp_required'; END IF;
      END IF;
  END CASE;
  RETURN jsonb_build_object('action', v_action, 'risk_score', v_risk, 'deposit_amount_cents', v_deposit_amount_cents,
    'reason', CASE v_action WHEN 'none' THEN 'low_risk_or_trusted' WHEN 'otp_optional' THEN 'medium_risk' WHEN 'otp_required' THEN 'high_risk_no_deposit' WHEN 'deposit_required' THEN 'high_risk_high_value' WHEN 'deposit_or_otp' THEN 'customer_choice' ELSE 'salon_policy' END);
END; $$;


--
-- Name: determine_booking_verification(uuid, text, uuid[], integer, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.determine_booking_verification(p_salon_id uuid, p_client_phone text, p_service_ids uuid[], p_subtotal_cents integer, p_has_email boolean DEFAULT false) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_salon  record;
  v_client record;
  v_risk   int;
  v_has_email boolean;
  v_deposit_amount_cents int := 0;
  v_action text;
BEGIN
  SELECT booking_verification_mode,
         verification_risk_threshold_otp,
         verification_risk_threshold_deposit,
         deposit_high_value_cents,
         deposit_default_amount_cents
  INTO v_salon
  FROM salons
  WHERE id = p_salon_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('action', 'none', 'reason', 'salon_not_found', 'risk_score', 0);
  END IF;

  -- Mode 'never' → skip immediately
  IF v_salon.booking_verification_mode = 'never' THEN
    RETURN jsonb_build_object('action', 'none', 'reason', 'mode_never', 'risk_score', 0);
  END IF;

  -- Look up client profile by phone
  SELECT is_vip,
         coalesce(visit_count, 0)   AS visit_count,
         coalesce(no_show_count, 0) AS no_show_count,
         phone_verified_at,
         email
  INTO v_client
  FROM client_profiles
  WHERE phone = p_client_phone;

  -- Email: accept from the booking form OR from the stored profile
  v_has_email := p_has_email OR (FOUND AND v_client.email IS NOT NULL AND v_client.email <> '');

  -- VIP bypass
  IF FOUND AND v_client.is_vip = true THEN
    RETURN jsonb_build_object('action', 'none', 'reason', 'vip_skip', 'risk_score', 0);
  END IF;

  -- Trusted returning customer (5+ visits, no no-shows)
  IF FOUND AND coalesce(v_client.visit_count, 0) >= 5
           AND coalesce(v_client.no_show_count, 0) = 0 THEN
    RETURN jsonb_build_object('action', 'none', 'reason', 'trusted_returning', 'risk_score', 0);
  END IF;

  -- "Verify once, trust": phone already passed OTP, no no-show, not stale
  IF FOUND AND v_client.phone_verified_at IS NOT NULL
           AND coalesce(v_client.no_show_count, 0) = 0
           AND v_client.phone_verified_at > now() - interval '12 months' THEN
    RETURN jsonb_build_object('action', 'none', 'reason', 'phone_already_verified', 'risk_score', 0);
  END IF;

  -- Compute base risk score
  v_risk := public.compute_no_show_risk(
    coalesce(CASE WHEN FOUND THEN v_client.no_show_count ELSE 0 END, 0),
    coalesce(CASE WHEN FOUND THEN v_client.visit_count   ELSE 0 END, 0),
    p_subtotal_cents
  );

  -- No email = higher risk: SMS is the only OTP channel, which may be unreliable
  IF NOT v_has_email THEN
    v_risk := least(100, v_risk + 10);
  END IF;

  -- Apply mode
  CASE v_salon.booking_verification_mode

    WHEN 'always_otp' THEN
      v_action := 'otp_required';

    WHEN 'always_deposit' THEN
      v_action := 'deposit_required';
      v_deposit_amount_cents := coalesce(
        v_salon.deposit_default_amount_cents,
        p_subtotal_cents * 30 / 100
      );

    WHEN 'deposit_first' THEN
      IF v_risk >= v_salon.verification_risk_threshold_otp THEN
        v_action := 'deposit_or_otp';
        v_deposit_amount_cents := coalesce(
          v_salon.deposit_default_amount_cents,
          p_subtotal_cents * 30 / 100
        );
      ELSE
        v_action := 'none';
      END IF;

    ELSE -- 'auto'
      IF v_risk < v_salon.verification_risk_threshold_otp THEN
        v_action := 'none';
      ELSIF v_risk < v_salon.verification_risk_threshold_deposit THEN
        v_action := 'otp_optional';
      ELSE
        IF p_subtotal_cents >= coalesce(v_salon.deposit_high_value_cents, 5000) THEN
          v_action := 'deposit_required';
          v_deposit_amount_cents := coalesce(
            v_salon.deposit_default_amount_cents,
            p_subtotal_cents * 30 / 100
          );
        ELSE
          v_action := 'otp_required';
        END IF;
      END IF;
  END CASE;

  RETURN jsonb_build_object(
    'action',               v_action,
    'risk_score',           v_risk,
    'deposit_amount_cents', v_deposit_amount_cents,
    'reason',
      CASE v_action
        WHEN 'none'             THEN 'low_risk_or_trusted'
        WHEN 'otp_optional'     THEN 'medium_risk'
        WHEN 'otp_required'     THEN 'high_risk_no_deposit'
        WHEN 'deposit_required' THEN 'high_risk_high_value'
        WHEN 'deposit_or_otp'   THEN 'customer_choice'
        ELSE                          'salon_policy'
      END
  );
END;
$$;


--
-- Name: get_booking_client_snapshot(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_booking_client_snapshot(p_salon_id uuid, p_phone text) RETURNS TABLE(visit_count integer, name text, no_show_count integer, is_vip boolean)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select cp.visit_count, cp.name, cp.no_show_count, cp.is_vip
  from public.client_profiles cp
  where cp.phone = p_phone
    and cp.deleted_at is null
    and exists (
      select 1 from public.bookings b
      where b.salon_id = p_salon_id
        and (b.client_profile_id = cp.id or b.client_phone = cp.phone)
    )
  limit 1;
$$;


--
-- Name: get_host_groups(uuid, text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_host_groups(p_salon_id uuid, p_phone text, p_limit integer DEFAULT 20) RETURNS TABLE(group_id uuid, started_at timestamp with time zone, status text, service text, size integer, attendees text[])
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
  WITH ph AS (
    SELECT regexp_replace(coalesce(public.canonical_phone(p_phone), ''), '\D', '', 'g') AS d
  ),
  og AS (
    SELECT b.group_id, b.start_time_utc, b.status, b.service_id
    FROM public.bookings b
    WHERE b.salon_id = p_salon_id AND b.is_group_organizer = true AND b.group_id IS NOT NULL
      AND b.status <> 'cancelled'
      AND (SELECT d FROM ph) <> ''
      AND regexp_replace(coalesce(b.client_phone, ''), '\D', '', 'g') = (SELECT d FROM ph)
  )
  SELECT
    og.group_id, og.start_time_utc AS started_at, og.status,
    (SELECT s.name FROM public.services s WHERE s.id = og.service_id) AS service,
    (SELECT count(*) FROM public.bookings m WHERE m.group_id = og.group_id AND m.status <> 'cancelled')::int AS size,
    (SELECT array_agg(DISTINCT btrim(m.client_name))
       FROM public.bookings m
      WHERE m.group_id = og.group_id AND m.status <> 'cancelled'
        AND m.is_group_organizer IS NOT TRUE
        AND btrim(coalesce(m.client_name, '')) <> ''
        AND m.client_name !~* '^(guest|kh[aá]ch|khach)\s*[0-9]+$') AS attendees
  FROM og ORDER BY og.start_time_utc DESC
  LIMIT greatest(1, least(coalesce(p_limit, 20), 50));
$_$;


--
-- Name: get_host_stats(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_host_stats(p_salon_id uuid, p_phone text) RETURNS TABLE(groups_organized integer, guests_brought integer)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  WITH ph AS (
    SELECT regexp_replace(coalesce(public.canonical_phone(p_phone), ''), '\D', '', 'g') AS d
  ),
  og AS (
    SELECT DISTINCT b.group_id
    FROM public.bookings b
    WHERE b.salon_id = p_salon_id
      AND b.is_group_organizer = true
      AND b.group_id IS NOT NULL
      AND b.status <> 'cancelled'
      AND (SELECT d FROM ph) <> ''
      AND regexp_replace(coalesce(b.client_phone, ''), '\D', '', 'g') = (SELECT d FROM ph)
  ),
  sizes AS (
    SELECT b.group_id, count(*) AS sz
    FROM public.bookings b
    JOIN og ON og.group_id = b.group_id
    WHERE b.status <> 'cancelled'
    GROUP BY b.group_id
  )
  SELECT
    coalesce((SELECT count(*) FROM og), 0)::int AS groups_organized,
    coalesce((SELECT sum(sz - 1) FROM sizes), 0)::int AS guests_brought;
$$;


--
-- Name: get_salon_queue(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_salon_queue(p_salon_id uuid) RETURNS TABLE(id uuid, client_name text, client_phone text, service_id uuid, service_name text, service_duration_minutes integer, requested_staff_id uuid, requested_staff_name text, assigned_staff_id uuid, arrived_at timestamp with time zone, position_in_queue integer, estimated_wait_minutes integer, status text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
begin
  return query
  with waiting as (
    select
      q.id, q.client_name, q.client_phone, q.service_id,
      q.requested_staff_id, q.assigned_staff_id, q.arrived_at, q.status,
      s.name as service_name,
      s.duration_minutes,
      st.name as staff_name,
      row_number() over (order by q.arrived_at) as position
    from queue_entries q
    join services s on s.id = q.service_id
    left join staff st on st.id = q.requested_staff_id
    where q.salon_id = p_salon_id
      and q.status in ('waiting', 'in_service')
  )
  select
    w.id, w.client_name, w.client_phone, w.service_id,
    w.service_name, w.duration_minutes,
    w.requested_staff_id, w.staff_name, w.assigned_staff_id,
    w.arrived_at,
    w.position::integer,
    -- naive estimate: sum durations of entries ahead
    (sum(w.duration_minutes) over (order by w.arrived_at) - w.duration_minutes)::integer,
    w.status
  from waiting w;
end;
$$;


--
-- Name: increment_voice_session_if_under_limit(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.increment_voice_session_if_under_limit(p_salon_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  updated_count integer;
BEGIN
  UPDATE public.salons
  SET voice_ai_sessions_this_month = voice_ai_sessions_this_month + 1
  WHERE id = p_salon_id
    AND voice_ai_sessions_this_month < voice_ai_sessions_limit;
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count > 0;
END;
$$;


--
-- Name: increment_voucher_used_count(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.increment_voucher_used_count() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_catalog'
    AS $$
BEGIN
  UPDATE public.vouchers
  SET used_count = used_count + 1
  WHERE id = NEW.voucher_id;
  RETURN NEW;
END;
$$;


--
-- Name: insert_group_bookings(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.insert_group_bookings(p_bookings jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_group_id UUID := gen_random_uuid();
  v_group_size SMALLINT := jsonb_array_length(p_bookings);
  v_booking JSONB;
  v_inserted UUID[] := ARRAY[]::UUID[];
  v_new_id UUID;
  v_digits TEXT;
  v_is_party BOOLEAN;
  v_profile_id UUID;
  v_idx INT := 0;
BEGIN
  IF v_group_size IS NULL OR v_group_size < 2 OR v_group_size > 20 THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_group_size');
  END IF;

  FOR v_booking IN SELECT * FROM jsonb_array_elements(p_bookings)
  LOOP
    v_digits := regexp_replace(
      coalesce(public.canonical_phone(v_booking->>'client_phone'), ''), '\D', '', 'g');
    v_is_party := length(v_digits) < 7;

    INSERT INTO public.bookings (
      salon_id, staff_id, service_id, client_name, client_phone, client_email,
      client_notes, start_time_utc, end_time_utc, status, price_cents,
      staff_requested_by_client, group_id, group_size, wave_number,
      seat_together, idempotency_key, client_locale, is_party_member,
      is_group_organizer
    )
    VALUES (
      (v_booking->>'salon_id')::UUID,
      (v_booking->>'staff_id')::UUID,
      (v_booking->>'service_id')::UUID,
      v_booking->>'client_name',
      CASE WHEN v_is_party THEN NULL ELSE v_digits END,
      v_booking->>'client_email',
      v_booking->>'client_notes',
      (v_booking->>'start_time_utc')::TIMESTAMPTZ,
      (v_booking->>'end_time_utc')::TIMESTAMPTZ,
      'confirmed',
      CASE WHEN v_booking ? 'price_cents' AND v_booking->>'price_cents' IS NOT NULL
        THEN (v_booking->>'price_cents')::INTEGER ELSE NULL END,
      COALESCE((v_booking->>'staff_requested_by_client')::BOOLEAN, false),
      v_group_id,
      v_group_size,
      COALESCE((v_booking->>'wave_number')::SMALLINT, 1),
      COALESCE((v_booking->>'seat_together')::BOOLEAN, false),
      (v_booking->>'idempotency_key')::UUID,
      NULLIF(TRIM(COALESCE(v_booking->>'client_locale', '')), ''),
      v_is_party,
      (v_idx = 0)
    )
    RETURNING id INTO v_new_id;
    v_inserted := array_append(v_inserted, v_new_id);

    IF NOT v_is_party THEN
      v_profile_id := public.resolve_client_profile(
        v_digits,
        v_booking->>'client_name',
        v_booking->>'client_email',
        (v_booking->>'staff_id')::UUID
      );
      IF v_profile_id IS NOT NULL THEN
        UPDATE public.bookings SET client_profile_id = v_profile_id WHERE id = v_new_id;
      END IF;
    END IF;

    v_idx := v_idx + 1;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'group_id', v_group_id, 'booking_ids', to_jsonb(v_inserted));
EXCEPTION
  WHEN exclusion_violation THEN
    RETURN jsonb_build_object('success', false, 'code', 'slot_conflict');
  WHEN unique_violation THEN
    RETURN jsonb_build_object('success', false, 'code', 'duplicate_submission');
END;
$$;


--
-- Name: list_salon_client_identities(uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.list_salon_client_identities(p_salon_id uuid, p_limit integer DEFAULT 2000) RETURNS TABLE(id uuid, phone text, name text, email text, is_vip boolean, visit_count integer, last_visit_at timestamp with time zone)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT
    cp.id,
    cp.phone,
    cp.name,
    cp.email,
    coalesce(cp.is_vip, false) AS is_vip,
    count(b.*) FILTER (WHERE b.status <> 'cancelled')::int AS visit_count,
    max(b.start_time_utc) AS last_visit_at
  FROM public.client_profiles cp
  JOIN public.bookings b
    ON b.client_phone = cp.phone
   AND b.salon_id = p_salon_id
  WHERE cp.deleted_at IS NULL
  GROUP BY cp.id, cp.phone, cp.name, cp.email, cp.is_vip
  ORDER BY max(b.start_time_utc) DESC NULLS LAST
  LIMIT greatest(1, least(coalesce(p_limit, 2000), 5000));
$$;


--
-- Name: log_error(text, text, text, text, text, uuid, uuid, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.log_error(p_fingerprint text, p_level text, p_message text, p_surface text, p_route text, p_salon_id uuid, p_user_id uuid, p_stack text, p_context jsonb) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_id uuid;
begin
  update public.error_logs
     set occurrence_count = occurrence_count + 1,
         last_seen_at = now(),
         context = coalesce(p_context, context),
         stack = coalesce(nullif(p_stack,''), stack)
   where fingerprint = p_fingerprint and status = 'open'
   returning id into v_id;
  if v_id is null then
    insert into public.error_logs(fingerprint, level, message, surface, route, salon_id, user_id, stack, context)
    values (p_fingerprint, coalesce(nullif(p_level,''),'error'), left(p_message,2000), p_surface,
            p_route, p_salon_id, p_user_id, left(p_stack,8000), coalesce(p_context,'{}'::jsonb))
    returning id into v_id;
  end if;
  return v_id;
end $$;


--
-- Name: log_system_audit(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.log_system_audit() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_salon   uuid;
  v_entity  text;
  v_actor   uuid;
  v_changed jsonb := '{}'::jsonb;
  v_old     jsonb;
  v_new     jsonb;
  k         text;
  v_ignore  text[] := array[
    'updated_at','created_at','last_run_at','cursor_synced_at','last_error',
    'last_synced_at','local_updated_at'
  ];
begin
  if TG_TABLE_NAME = 'salons' then
    v_salon := (case when TG_OP = 'DELETE' then OLD.id else NEW.id end);
  else
    begin
      v_salon := (case when TG_OP = 'DELETE' then OLD.salon_id else NEW.salon_id end);
    exception when others then v_salon := null;
    end;
  end if;

  -- Resolve entity id via jsonb so a table without an `id` column (e.g.
  -- square_integrations, PK = salon_id) never throws; fall back to salon_id.
  if TG_OP = 'DELETE' then v_old := to_jsonb(OLD); else v_new := to_jsonb(NEW); end if;
  v_entity := coalesce(
    (case when TG_OP = 'DELETE' then v_old else v_new end) ->> 'id',
    v_salon::text
  );

  begin
    v_actor := nullif(current_setting('app.actor_user_id', true), '')::uuid;
  exception when others then v_actor := null;
  end;

  if TG_OP = 'UPDATE' then
    v_old := to_jsonb(OLD);
    for k in select jsonb_object_keys(v_new) loop
      if k = any(v_ignore)
         or k ~~* '%token%' or k ~~* '%secret%'
         or k ~~* '%password%' or k ~~* '%access_key%' then
        continue;
      end if;
      if v_old -> k is distinct from v_new -> k then
        v_changed := v_changed || jsonb_build_object(
          k, jsonb_build_object('old', v_old -> k, 'new', v_new -> k));
      end if;
    end loop;
    if v_changed = '{}'::jsonb then
      return null;
    end if;
  elsif TG_OP = 'INSERT' then
    v_changed := jsonb_build_object('_action', 'created');
  else
    v_changed := jsonb_build_object('_action', 'deleted');
  end if;

  insert into system_audit (salon_id, table_name, entity_id, action, actor_user_id, changed_fields)
  values (v_salon, TG_TABLE_NAME, v_entity, TG_OP, v_actor, v_changed);

  return null;
exception when others then
  return null;
end;
$$;


--
-- Name: merge_client_profiles(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.merge_client_profiles(p_keep_id uuid, p_drop_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_keep public.client_profiles%ROWTYPE;
  v_drop public.client_profiles%ROWTYPE;
  v_reassigned int := 0;
BEGIN
  IF p_keep_id IS NULL OR p_drop_id IS NULL OR p_keep_id = p_drop_id THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_args');
  END IF;

  SELECT * INTO v_keep FROM public.client_profiles WHERE id = p_keep_id;
  IF NOT FOUND OR v_keep.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'keep_not_found');
  END IF;

  SELECT * INTO v_drop FROM public.client_profiles WHERE id = p_drop_id;
  IF NOT FOUND OR v_drop.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'drop_not_found');
  END IF;

  UPDATE public.bookings
     SET client_profile_id = p_keep_id
   WHERE client_profile_id = p_drop_id
      OR (client_profile_id IS NULL AND client_phone = v_drop.phone);
  GET DIAGNOSTICS v_reassigned = ROW_COUNT;

  UPDATE public.client_profiles
     SET visit_count       = coalesce(v_keep.visit_count, 0) + coalesce(v_drop.visit_count, 0),
         total_spent_cents = coalesce(v_keep.total_spent_cents, 0) + coalesce(v_drop.total_spent_cents, 0),
         no_show_count     = coalesce(v_keep.no_show_count, 0) + coalesce(v_drop.no_show_count, 0),
         is_vip            = coalesce(v_keep.is_vip, false) OR coalesce(v_drop.is_vip, false),
         name              = coalesce(nullif(btrim(coalesce(v_keep.name, '')), ''), v_drop.name),
         email             = coalesce(v_keep.email, v_drop.email),
         preferred_staff_id = coalesce(v_keep.preferred_staff_id, v_drop.preferred_staff_id),
         square_customer_id = coalesce(v_keep.square_customer_id, v_drop.square_customer_id),
         last_service_date  = greatest(v_keep.last_service_date, v_drop.last_service_date),
         notes = nullif(btrim(
                   coalesce(v_keep.notes, '') ||
                   CASE WHEN coalesce(btrim(v_drop.notes), '') <> ''
                     THEN E'\n' || v_drop.notes ELSE '' END
                 ), ''),
         updated_at = now()
   WHERE id = p_keep_id;

  UPDATE public.client_profiles
     SET deleted_at = now(),
         phone = 'merged:' || p_drop_id::text,
         updated_at = now()
   WHERE id = p_drop_id;

  RETURN jsonb_build_object('success', true, 'reassigned', v_reassigned);
EXCEPTION
  WHEN others THEN
    RETURN jsonb_build_object('success', false, 'code', 'merge_failed', 'detail', SQLERRM);
END;
$$;


--
-- Name: notify_waitlist_for_no_show(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_waitlist_for_no_show(p_booking_id uuid) RETURNS TABLE(entry_id uuid, service_name text, salon_name text, booking_date date)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_b public.bookings%ROWTYPE;
  v_id uuid;
  v_date date;
  v_tz text;
  v_future boolean;
BEGIN
  SELECT * INTO v_b FROM public.bookings WHERE id = p_booking_id;
  IF NOT FOUND OR v_b.service_id IS NULL THEN
    RETURN;
  END IF;
  SELECT coalesce(nullif(trim(s.timezone), ''), 'America/Los_Angeles')
    INTO v_tz FROM public.salons s WHERE s.id = v_b.salon_id;
  v_tz := coalesce(v_tz, 'America/Los_Angeles');
  v_date := (v_b.start_time_utc AT TIME ZONE v_tz)::date;
  v_future := v_b.start_time_utc > now();

  UPDATE public.booking_waitlist_entries
     SET status = 'notified', notified_at = now(), claim_token = gen_random_uuid(),
         offered_staff_id  = CASE WHEN v_future THEN v_b.staff_id END,
         offered_start_utc = CASE WHEN v_future THEN v_b.start_time_utc END,
         offered_end_utc   = CASE WHEN v_future THEN v_b.end_time_utc END
   WHERE booking_waitlist_entries.id = (
     SELECT bwe.id FROM public.booking_waitlist_entries bwe
      WHERE bwe.salon_id = v_b.salon_id
        AND bwe.service_id = v_b.service_id
        AND bwe.booking_date = v_date
        AND bwe.status = 'waiting'
      ORDER BY bwe.created_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
   )
   RETURNING booking_waitlist_entries.id INTO v_id;

  IF v_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
    SELECT v_id,
           (SELECT name FROM public.services WHERE id = v_b.service_id),
           (SELECT name FROM public.salons WHERE id = v_b.salon_id),
           v_date;
END;
$$;


--
-- Name: public_booking_occupancy_for_range(uuid, timestamp with time zone, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.public_booking_occupancy_for_range(p_salon_id uuid, p_start timestamp with time zone, p_end timestamp with time zone) RETURNS TABLE(staff_id uuid, start_time_utc timestamp with time zone, end_time_utc timestamp with time zone)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select b.staff_id, b.start_time_utc, b.end_time_utc
  from public.bookings b
  where b.salon_id = p_salon_id
    and b.start_time_utc < p_end
    and b.end_time_utc > p_start
    and b.status in ('pending', 'confirmed', 'in_progress', 'completed')
$$;


--
-- Name: FUNCTION public_booking_occupancy_for_range(p_salon_id uuid, p_start timestamp with time zone, p_end timestamp with time zone); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.public_booking_occupancy_for_range(p_salon_id uuid, p_start timestamp with time zone, p_end timestamp with time zone) IS 'Returns booked intervals per staff for overlap checks in public booking UI; no client fields.';


--
-- Name: public_resolve_domain(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.public_resolve_domain(p_host text) RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT s.slug
  FROM public.salon_custom_domains d
  JOIN public.salons s ON s.id = d.salon_id
  WHERE d.domain = lower(p_host)
  LIMIT 1;
$$;


--
-- Name: rate_limit_hit(text, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rate_limit_hit(p_key text, p_limit integer, p_window_seconds integer) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_window bigint := floor(extract(epoch FROM clock_timestamp()) / p_window_seconds);
  v_bucket text := p_key || ':' || v_window::text;
  v_count integer;
BEGIN
  INSERT INTO public.rate_limits (bucket, count, expires_at)
  VALUES (v_bucket, 1, to_timestamp((v_window + 2) * p_window_seconds))
  ON CONFLICT (bucket) DO UPDATE SET count = public.rate_limits.count + 1
  RETURNING count INTO v_count;

  -- Cheap opportunistic GC of long-expired buckets (bounded, indexed).
  DELETE FROM public.rate_limits WHERE expires_at < now() - interval '1 hour';

  RETURN v_count <= p_limit;
END;
$$;


--
-- Name: rebook_due_candidates(uuid, integer, integer, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rebook_due_candidates(p_salon_id uuid, p_min_visits integer, p_lookahead_days integer, p_overdue_days integer, p_limit integer) RETURNS TABLE(client_phone text, client_name text, client_email text, visits integer, last_visit date, cadence_days integer, predicted_next date, usual_service text)
    LANGUAGE sql STABLE
    AS $$
  WITH visit_days AS (
    SELECT b.client_phone, (b.start_time_utc AT TIME ZONE 'America/Los_Angeles')::date AS vday
    FROM bookings b
    WHERE b.salon_id = p_salon_id
      AND coalesce(b.client_phone, '') <> ''
      AND b.start_time_utc < now()
      AND b.status NOT IN ('cancelled', 'pending')
    GROUP BY b.client_phone, (b.start_time_utc AT TIME ZONE 'America/Los_Angeles')::date
  ),
  gaps AS (
    SELECT client_phone, vday,
      (vday - lag(vday) OVER (PARTITION BY client_phone ORDER BY vday)) AS gap
    FROM visit_days
  ),
  agg AS (
    SELECT client_phone,
      count(*) AS ndays,
      max(vday) AS last_visit,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY gap) FILTER (WHERE gap BETWEEN 1 AND 183) AS cadence
    FROM gaps
    GROUP BY client_phone
  )
  SELECT a.client_phone,
    (SELECT max(b.client_name) FROM bookings b WHERE b.salon_id = p_salon_id AND b.client_phone = a.client_phone) AS client_name,
    (SELECT max(b.client_email) FROM bookings b WHERE b.salon_id = p_salon_id AND b.client_phone = a.client_phone AND coalesce(b.client_email,'') <> '') AS client_email,
    a.ndays::int AS visits,
    a.last_visit,
    round(a.cadence)::int AS cadence_days,
    (a.last_visit + round(a.cadence)::int) AS predicted_next,
    (SELECT mode() WITHIN GROUP (ORDER BY s.name)
       FROM bookings b2 JOIN services s ON s.id = b2.service_id
       WHERE b2.salon_id = p_salon_id AND b2.client_phone = a.client_phone) AS usual_service
  FROM agg a
  WHERE a.ndays >= p_min_visits
    AND a.cadence IS NOT NULL
    AND (a.last_visit + round(a.cadence)::int) <= current_date + p_lookahead_days
    AND (a.last_visit + round(a.cadence)::int) >= current_date - p_overdue_days
    AND NOT EXISTS (
      SELECT 1 FROM bookings f
      WHERE f.salon_id = p_salon_id AND f.client_phone = a.client_phone
        AND f.status IN ('confirmed', 'pending') AND f.start_time_utc > now()
    )
    AND EXISTS (
      SELECT 1 FROM client_profiles cp
      WHERE cp.phone = a.client_phone
        AND cp.marketing_consent_at IS NOT NULL
    )
  ORDER BY (a.last_visit + round(a.cadence)::int) ASC
  LIMIT p_limit;
$$;


--
-- Name: reschedule_booking_as_customer(uuid, timestamp with time zone, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reschedule_booking_as_customer(p_token_id uuid, p_new_start_utc timestamp with time zone, p_new_end_utc timestamp with time zone) RETURNS TABLE(ok boolean, code text, booking_id uuid, service_name text, staff_name text, new_start_utc timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_token   booking_reminder_tokens%ROWTYPE;
  v_booking bookings%ROWTYPE;
  v_svc text; v_stf text;
  v_tz  text;
BEGIN
  SELECT * INTO v_token FROM booking_reminder_tokens
  WHERE id = p_token_id AND used_at IS NULL AND expires_at > now()
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false,'token_invalid'::text,NULL::uuid,NULL::text,NULL::text,NULL::timestamptz; RETURN;
  END IF;

  SELECT * INTO v_booking FROM bookings
  WHERE id = v_token.booking_id AND status IN ('pending','confirmed') AND start_time_utc > now()
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false,'booking_not_reschedulable'::text,NULL::uuid,NULL::text,NULL::text,NULL::timestamptz; RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM bookings b
    WHERE b.id <> v_booking.id AND b.salon_id = v_booking.salon_id
      AND b.staff_id = v_booking.staff_id AND b.status NOT IN ('cancelled')
      AND b.start_time_utc < p_new_end_utc AND b.end_time_utc > p_new_start_utc
  ) THEN
    RETURN QUERY SELECT false,'slot_conflict'::text,NULL::uuid,NULL::text,NULL::text,NULL::timestamptz; RETURN;
  END IF;

  UPDATE bookings SET
    rescheduled_from_time_utc = start_time_utc,
    start_time_utc  = p_new_start_utc, end_time_utc = p_new_end_utc,
    rescheduled_at  = now(), rescheduled_by = 'customer',
    reminder_24h_sent_at = NULL, reminder_3h_sent_at = NULL,
    status = 'confirmed'
  WHERE id = v_booking.id;

  UPDATE booking_reminder_tokens SET used_at = now(), used_action = 'reschedule' WHERE id = v_token.id;

  SELECT coalesce(nullif(trim(s.timezone), ''), 'America/Los_Angeles')
    INTO v_tz FROM salons s WHERE s.id = v_booking.salon_id;
  v_tz := coalesce(v_tz, 'America/Los_Angeles');

  UPDATE booking_waitlist_entries SET status = 'notified', notified_at = now(), claim_token = gen_random_uuid()
  WHERE id = (
    SELECT id FROM booking_waitlist_entries
    WHERE salon_id = v_booking.salon_id AND service_id = v_booking.service_id
      AND booking_date = (v_booking.start_time_utc AT TIME ZONE v_tz)::date AND status = 'waiting'
    ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
  );

  SELECT name INTO v_svc FROM services WHERE id = v_booking.service_id;
  SELECT name INTO v_stf FROM staff    WHERE id = v_booking.staff_id;
  RETURN QUERY SELECT true,'ok'::text, v_booking.id, v_svc, v_stf, p_new_start_utc;
END;
$$;


--
-- Name: resolve_client_profile(text, text, text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.resolve_client_profile(p_phone text, p_name text DEFAULT NULL::text, p_email text DEFAULT NULL::text, p_preferred_staff_id uuid DEFAULT NULL::uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
DECLARE
  v_digits text;
  v_name text;
  v_email text;
  v_is_placeholder boolean;
  v_id uuid;
BEGIN
  v_digits := regexp_replace(coalesce(public.canonical_phone(p_phone), ''), '\D', '', 'g');
  IF length(v_digits) < 7 THEN
    RETURN NULL;
  END IF;

  v_name  := nullif(trim(coalesce(p_name, '')), '');
  v_email := nullif(lower(trim(coalesce(p_email, ''))), '');
  v_is_placeholder := v_name IS NULL OR v_name ~* '^(guest|kh[aá]ch)\s*[0-9]+$';

  INSERT INTO public.client_profiles (phone, name, email, preferred_staff_id, last_service_date, visit_count)
  VALUES (
    v_digits,
    CASE WHEN v_is_placeholder THEN NULL ELSE v_name END,
    v_email,
    p_preferred_staff_id,
    now(),
    1
  )
  ON CONFLICT (phone) DO UPDATE SET
    name = CASE
             WHEN v_is_placeholder THEN public.client_profiles.name
             WHEN public.client_profiles.name IS NULL OR public.client_profiles.name = ''
               THEN excluded.name
             ELSE public.client_profiles.name
           END,
    email = COALESCE(public.client_profiles.email, excluded.email),
    preferred_staff_id = COALESCE(excluded.preferred_staff_id, public.client_profiles.preferred_staff_id),
    last_service_date = now(),
    visit_count = COALESCE(public.client_profiles.visit_count, 0) + 1,
    updated_at = now()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$_$;


--
-- Name: salon_has_staff_services(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.salon_has_staff_services(p_salon_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    select exists (
      select 1
      from public.staff_services ss
      join public.staff s on s.id = ss.staff_id
      where s.salon_id = p_salon_id
      limit 1
    );
  $$;


--
-- Name: salon_multi_name_phones(uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.salon_multi_name_phones(p_salon_id uuid, p_limit integer DEFAULT 25) RETURNS TABLE(phone text, profile_name text, is_vip boolean, distinct_names integer, total_visits integer, variants jsonb)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
  WITH rows AS (
    SELECT
      regexp_replace(coalesce(b.client_phone, ''), '\D', '', 'g') AS phone,
      btrim(b.client_name) AS nm
    FROM public.bookings b
    WHERE b.salon_id = p_salon_id AND b.status <> 'cancelled'
      AND regexp_replace(coalesce(b.client_phone, ''), '\D', '', 'g') <> ''
      AND btrim(coalesce(b.client_name, '')) <> ''
      AND b.client_name !~* '^(guest|kh[aá]ch|khach)\s*[0-9]+$'
  ),
  byname AS (SELECT phone, nm, count(*) AS c FROM rows GROUP BY phone, nm),
  agg AS (
    SELECT phone, count(*) AS distinct_names, sum(c) AS total,
      jsonb_agg(jsonb_build_object('name', nm, 'count', c) ORDER BY c DESC, nm) AS variants
    FROM byname GROUP BY phone HAVING count(*) >= 2
  )
  SELECT a.phone, cp.name AS profile_name, coalesce(cp.is_vip, false) AS is_vip,
    a.distinct_names::int, a.total::int, a.variants
  FROM agg a LEFT JOIN public.client_profiles cp ON cp.phone = a.phone AND cp.deleted_at IS NULL
  ORDER BY a.distinct_names DESC, a.total DESC, a.phone
  LIMIT greatest(1, least(coalesce(p_limit, 25), 100));
$_$;


--
-- Name: search_salon_client_typeahead(uuid, text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.search_salon_client_typeahead(p_salon_id uuid, p_query text, p_limit integer DEFAULT 8) RETURNS TABLE(phone text, name text, is_vip boolean, visit_count integer, last_visit_at timestamp with time zone)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  with q as (
    select nullif(btrim(p_query), '') as raw
  ),
  d as (
    select regexp_replace(coalesce((select raw from q), ''), '\D', '', 'g') as digits
  )
  select
    cp.phone,
    coalesce(scn.display_name, cp.name) as name,
    coalesce(cp.is_vip, false) as is_vip,
    count(b.*) filter (where b.status <> 'cancelled')::int as visit_count,
    max(b.start_time_utc) as last_visit_at
  from public.client_profiles cp
  join public.bookings b
    on b.client_phone = cp.phone
   and b.salon_id = p_salon_id
  left join public.salon_client_names scn
    on scn.salon_id = p_salon_id
   and scn.phone = cp.phone
  where cp.deleted_at is null
    and (select raw from q) is not null
    and (
      ( (select digits from d) <> '' and cp.phone like '%' || (select digits from d) || '%' )
      or ( coalesce(scn.display_name, cp.name) ilike '%' || (select raw from q) || '%' )
    )
  group by cp.phone, cp.name, cp.is_vip, scn.display_name
  order by max(b.start_time_utc) desc nulls last
  limit greatest(1, least(coalesce(p_limit, 8), 20));
$$;


--
-- Name: search_salon_clients(uuid, text, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.search_salon_clients(p_salon_id uuid, p_search text, p_limit integer, p_offset integer) RETURNS TABLE(client_profile_id uuid, phone text, name text, email text, is_vip boolean, notes text, visit_count integer, last_visit timestamp with time zone, total_spent_cents bigint, total_count bigint)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  with bphones as (
    select distinct nullif(trim(b.client_phone), '') as phone
    from public.bookings b where b.salon_id = p_salon_id
  ),
  ids as (
    select bp.phone, cp.id as client_profile_id
    from bphones bp
    left join public.client_profiles cp on cp.phone = bp.phone and cp.deleted_at is null
    where bp.phone is not null
    union
    select cp.phone, cp.id
    from public.salon_clients sc
    join public.client_profiles cp on cp.id = sc.client_profile_id and cp.deleted_at is null
    where sc.salon_id = p_salon_id
  ),
  uniq as (
    select i.phone, max(i.client_profile_id::text)::uuid as client_profile_id
    from ids i where i.phone is not null group by i.phone
  ),
  named as (
    select u.client_profile_id, u.phone,
      coalesce(cp.name, (select b.client_name from public.bookings b
         where b.salon_id = p_salon_id and b.client_phone = u.phone and b.client_name is not null
         order by b.start_time_utc desc nulls last limit 1)) as name,
      cp.email, cp.is_vip, cp.notes
    from uniq u left join public.client_profiles cp on cp.id = u.client_profile_id
  ),
  filtered as (
    select * from named n
    where p_search is null or p_search = ''
      or n.name ilike '%' || p_search || '%'
      or n.phone ilike '%' || p_search || '%'
      or (regexp_replace(p_search, '[^0-9]', '', 'g') <> ''
        and regexp_replace(coalesce(n.phone, ''), '[^0-9]', '', 'g') ilike '%' || regexp_replace(p_search, '[^0-9]', '', 'g') || '%')
  ),
  counted as (select count(*)::bigint as total from filtered),
  page as (
    select * from filtered order by name nulls last, phone
    limit greatest(p_limit, 0) offset greatest(p_offset, 0)
  )
  select pg.client_profile_id, pg.phone, pg.name, pg.email, pg.is_vip, pg.notes,
    coalesce(agg.visits, 0)::integer, agg.last_visit, coalesce(agg.spent, 0)::bigint,
    (select total from counted)
  from page pg
  left join lateral (
    select count(*) filter (where b.status in ('completed', 'confirmed')) as visits,
      max(b.start_time_utc) filter (where b.status in ('completed', 'confirmed')) as last_visit,
      sum(coalesce(b.price_cents, 0) + coalesce(b.addon_price_cents, 0)) filter (where b.status = 'completed') as spent
    from public.bookings b where b.salon_id = p_salon_id and b.client_phone = pg.phone
  ) agg on true
  order by pg.name nulls last, pg.phone;
$$;


--
-- Name: seed_default_page_sections(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.seed_default_page_sections(p_salon_id uuid) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_catalog'
    AS $$
BEGIN
  INSERT INTO public.salon_page_sections (salon_id, type, title, is_visible, sort_order, content)
  VALUES
    (p_salon_id, 'hero',       'Hero',       true,  0, '{"heading":"Welcome","subheading":"","cta_text":"Book now","bg_image_url":null}'),
    (p_salon_id, 'services',   'Dịch vụ',    true,  1, '{"section_title":"Our services","description":"","show_price":"full","display_count":"all"}'),
    (p_salon_id, 'about',      'About',      true,  2, '{"section_title":"About us","body":"","image_url":null,"layout":"image-left"}'),
    (p_salon_id, 'gallery',    'Gallery',    true,  3, '{"section_title":"Our work","images":[],"grid_style":"3-col"}'),
    (p_salon_id, 'promotions', 'Khuyến mãi', false, 4, '{"section_title":"Special offers","body":"","expires_at":null,"bg_style":"brand"}'),
    (p_salon_id, 'contact',    'Liên hệ',    false, 5, '{"address":"","phone":"","email":"","show_map":true}'),
    (p_salon_id, 'blog',       'Blog',       false, 6, '{"section_title":"Tips & care","post_count":3}')
  ON CONFLICT DO NOTHING;
END;
$$;


--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_catalog'
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


--
-- Name: staff_services_same_salon_trg(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.staff_services_same_salon_trg() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_catalog'
    AS $$
  declare
    ss_salon uuid;
    sv_salon uuid;
  begin
    select salon_id into ss_salon from public.staff    where id = new.staff_id;
    select salon_id into sv_salon from public.services where id = new.service_id;
    if ss_salon is null or sv_salon is null or ss_salon <> sv_salon then
      raise exception 'staff_services_cross_salon: staff % / service %',
        new.staff_id, new.service_id;
    end if;
    return new;
  end;
  $$;


--
-- Name: tg_canon_client_phone(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.tg_canon_client_phone() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
begin NEW.client_phone := public.canonical_phone(NEW.client_phone); return NEW; end; $$;


--
-- Name: tg_canon_member_phone(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.tg_canon_member_phone() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
begin NEW.member_phone := public.canonical_phone(NEW.member_phone); return NEW; end; $$;


--
-- Name: tg_canon_phone(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.tg_canon_phone() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
begin NEW.phone := public.canonical_phone(NEW.phone); return NEW; end; $$;


--
-- Name: tg_canon_voucher_phones(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.tg_canon_voucher_phones() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
begin
  NEW.client_phone := public.canonical_phone(NEW.client_phone);
  NEW.gift_card_purchaser_phone := public.canonical_phone(NEW.gift_card_purchaser_phone);
  return NEW;
end; $$;


--
-- Name: top_salon_hosts(uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.top_salon_hosts(p_salon_id uuid, p_limit integer DEFAULT 10) RETURNS TABLE(phone text, name text, is_vip boolean, groups_organized integer, guests_brought integer)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
  WITH og AS (
    SELECT
      regexp_replace(coalesce(b.client_phone, ''), '\D', '', 'g') AS phone,
      b.group_id, b.client_name, b.start_time_utc
    FROM public.bookings b
    WHERE b.salon_id = p_salon_id AND b.is_group_organizer = true
      AND b.group_id IS NOT NULL AND b.status <> 'cancelled'
      AND regexp_replace(coalesce(b.client_phone, ''), '\D', '', 'g') <> ''
  ),
  names AS (
    SELECT DISTINCT ON (phone) phone, client_name FROM og
    ORDER BY phone, start_time_utc DESC NULLS LAST
  ),
  sizes AS (
    SELECT DISTINCT og.phone, og.group_id,
      (SELECT count(*) FROM public.bookings x WHERE x.group_id = og.group_id AND x.status <> 'cancelled') AS sz
    FROM og
  ),
  agg AS (
    SELECT phone, count(*) AS groups_organized, coalesce(sum(sz - 1), 0) AS guests_brought
    FROM sizes GROUP BY phone
  )
  SELECT a.phone, n.client_name AS name, coalesce(cp.is_vip, false) AS is_vip,
    a.groups_organized::int, a.guests_brought::int
  FROM agg a
  JOIN names n ON n.phone = a.phone
  LEFT JOIN public.client_profiles cp ON cp.phone = a.phone AND cp.deleted_at IS NULL
  WHERE a.guests_brought > 0
    AND coalesce(btrim(n.client_name), '') <> ''
    AND coalesce(n.client_name, '') !~* '^(guest|kh[aá]ch|khach)\s*[0-9]+$'
  ORDER BY a.guests_brought DESC, a.groups_organized DESC, a.phone
  LIMIT greatest(1, least(coalesce(p_limit, 10), 50));
$_$;


--
-- Name: touch_booking_patterns_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.touch_booking_patterns_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_catalog'
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


--
-- Name: touch_customer_photo_consents_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.touch_customer_photo_consents_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_catalog'
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


--
-- Name: touch_customer_preferences_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.touch_customer_preferences_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_catalog'
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


--
-- Name: touch_referrals_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.touch_referrals_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_catalog'
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


--
-- Name: touch_vouchers_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.touch_vouchers_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_catalog'
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


--
-- Name: unbump_client_no_show(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.unbump_client_no_show(p_phone text) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  UPDATE public.client_profiles
     SET no_show_count = GREATEST(coalesce(no_show_count, 0) - 1, 0),
         updated_at = now()
   WHERE phone = p_phone;
$$;


--
-- Name: update_party_claim_details(text, uuid, text, text, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_party_claim_details(p_token text, p_claim_id uuid, p_member_name text, p_member_phone text, p_reminder_opted_in boolean) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_link_id    UUID;
  v_expires    TIMESTAMPTZ;
  v_claimed    TIMESTAMPTZ;
  v_booking_id UUID;
  v_digits     TEXT;
  v_existing_fk UUID;
  v_profile_id UUID;
BEGIN
  SELECT id, expires_at INTO v_link_id, v_expires FROM party_links WHERE token = p_token;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'code', 'not_found'); END IF;
  IF v_expires < now() THEN RETURN jsonb_build_object('success', false, 'code', 'expired'); END IF;

  SELECT claimed_at, booking_id INTO v_claimed, v_booking_id
    FROM party_link_claims WHERE id = p_claim_id AND party_link_id = v_link_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'code', 'claim_not_found'); END IF;
  IF v_claimed IS NULL THEN RETURN jsonb_build_object('success', false, 'code', 'not_claimed'); END IF;

  UPDATE party_link_claims
     SET member_name = p_member_name, member_phone = p_member_phone, reminder_opted_in = p_reminder_opted_in
   WHERE id = p_claim_id;

  IF v_booking_id IS NOT NULL THEN
    UPDATE bookings SET client_name = p_member_name, client_phone = p_member_phone WHERE id = v_booking_id;
    v_digits := regexp_replace(coalesce(public.canonical_phone(p_member_phone), ''), '\D', '', 'g');
    IF length(v_digits) >= 7 THEN
      SELECT client_profile_id INTO v_existing_fk FROM bookings WHERE id = v_booking_id;
      IF v_existing_fk IS NULL THEN
        v_profile_id := public.resolve_client_profile(p_member_phone, p_member_name, NULL, NULL);
        UPDATE bookings SET client_profile_id = v_profile_id, is_party_member = false WHERE id = v_booking_id;
      ELSE
        UPDATE bookings SET is_party_member = false WHERE id = v_booking_id;
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object('success', true);
EXCEPTION
  WHEN others THEN RETURN jsonb_build_object('success', false, 'code', 'server_error');
END;
$$;


--
-- Name: update_queue_entry_status(uuid, text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_queue_entry_status(p_id uuid, p_status text, p_assigned_staff_id uuid DEFAULT NULL::uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
begin
  update queue_entries
  set
    status = p_status,
    assigned_staff_id = coalesce(p_assigned_staff_id, assigned_staff_id),
    started_at = case when p_status = 'in_service' and started_at is null then now() else started_at end,
    completed_at = case when p_status in ('completed', 'cancelled', 'no_show') then now() else completed_at end
  where id = p_id;
end;
$$;


--
-- Name: update_salon_page_sections_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_salon_page_sections_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_catalog'
    AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;


--
-- Name: update_website_import_jobs_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_website_import_jobs_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_catalog'
    AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;


--
-- Name: winback_candidates(uuid, integer, integer, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.winback_candidates(p_salon_id uuid, p_min_visits integer, p_lapse_days integer, p_max_days integer, p_limit integer) RETURNS TABLE(client_phone text, client_name text, client_email text, visits integer, last_visit timestamp with time zone, no_shows integer, usual_service text)
    LANGUAGE sql STABLE
    AS $$
  WITH
  square_candidates AS (
    SELECT
      cp.phone                       AS client_phone,
      cp.name                        AS client_name,
      COUNT(svh.id)::int             AS visits,
      MAX(svh.square_created_at)     AS last_visit
    FROM square_visit_history svh
    JOIN client_profiles cp ON cp.id = svh.client_profile_id
    WHERE svh.salon_id = p_salon_id AND coalesce(cp.phone, '') <> ''
    GROUP BY cp.id, cp.phone, cp.name
  ),
  booking_candidates AS (
    SELECT
      b.client_phone,
      max(b.client_name)                                   AS client_name,
      count(*) FILTER (WHERE b.status <> 'cancelled')::int AS visits,
      max(b.start_time_utc)                                AS last_visit
    FROM bookings b
    WHERE b.salon_id = p_salon_id
      AND coalesce(b.client_phone, '') <> ''
      AND NOT EXISTS (
        SELECT 1 FROM square_visit_history svh2
        JOIN client_profiles cp2 ON cp2.id = svh2.client_profile_id
        WHERE svh2.salon_id = p_salon_id AND cp2.phone = b.client_phone
      )
    GROUP BY b.client_phone
  ),
  combined AS (
    SELECT client_phone, client_name, visits, last_visit FROM square_candidates
    UNION ALL
    SELECT client_phone, client_name, visits, last_visit FROM booking_candidates
  ),
  noshow_stats AS (
    SELECT b.client_phone,
      count(*) FILTER (WHERE b.status = 'no_show')::int AS no_shows
    FROM bookings b
    WHERE b.salon_id = p_salon_id AND coalesce(b.client_phone, '') <> ''
    GROUP BY b.client_phone
  ),
  email_lookup AS (
    SELECT DISTINCT ON (b.client_phone) b.client_phone, b.client_email
    FROM bookings b
    WHERE b.salon_id = p_salon_id AND coalesce(b.client_email, '') <> ''
    ORDER BY b.client_phone, b.created_at DESC
  ),
  usual_svc_booking AS (
    SELECT b.client_phone,
      mode() WITHIN GROUP (ORDER BY s.name) AS usual_service
    FROM bookings b
    JOIN services s ON s.id = b.service_id
    WHERE b.salon_id = p_salon_id AND b.status NOT IN ('cancelled', 'no_show')
    GROUP BY b.client_phone
  ),
  usual_svc_square AS (
    SELECT cp.phone AS client_phone,
      mode() WITHIN GROUP (ORDER BY svc_name) AS usual_service
    FROM square_visit_history svh
    JOIN client_profiles cp ON cp.id = svh.client_profile_id,
    LATERAL unnest(svh.service_names) AS svc_name
    WHERE svh.salon_id = p_salon_id
      AND svc_name NOT ILIKE '%fee%'
      AND svc_name NOT ILIKE '%product%'
      AND svc_name NOT ILIKE '%tip%'
      AND svc_name NOT ILIKE '%tax%'
      AND svc_name NOT ILIKE '%discount%'
      AND svc_name NOT ILIKE '%gift%'
      AND svc_name NOT ILIKE '%card%'
    GROUP BY cp.phone
  )
  SELECT
    c.client_phone,
    c.client_name,
    el.client_email,
    c.visits,
    c.last_visit,
    coalesce(ns.no_shows, 0)                        AS no_shows,
    coalesce(usb.usual_service, uss.usual_service)  AS usual_service
  FROM combined c
  LEFT JOIN noshow_stats ns       ON ns.client_phone  = c.client_phone
  LEFT JOIN email_lookup el       ON el.client_phone  = c.client_phone
  LEFT JOIN usual_svc_booking usb ON usb.client_phone = c.client_phone
  LEFT JOIN usual_svc_square  uss ON uss.client_phone = c.client_phone
  WHERE c.visits >= p_min_visits
    AND c.last_visit < now() - make_interval(days => p_lapse_days)
    AND c.last_visit > now() - make_interval(days => p_max_days)
    AND NOT EXISTS (
      SELECT 1 FROM bookings f
      WHERE f.salon_id = p_salon_id
        AND f.client_phone = c.client_phone
        AND f.status IN ('confirmed', 'pending')
        AND f.start_time_utc > now()
    )
    AND EXISTS (
      SELECT 1 FROM client_profiles cp3
      WHERE cp3.phone = c.client_phone
        AND cp3.marketing_consent_at IS NOT NULL
    )
  ORDER BY c.visits DESC, c.last_visit DESC
  LIMIT p_limit;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: ai_actions_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_actions_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    salon_id uuid NOT NULL,
    agent text NOT NULL,
    action_type text NOT NULL,
    target_id uuid,
    payload jsonb,
    undo_deadline timestamp with time zone,
    undone_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    outcome text,
    outcome_at timestamp with time zone,
    outcome_booking_id uuid,
    CONSTRAINT ai_actions_log_outcome_check CHECK ((outcome = ANY (ARRAY['converted'::text, 'no_conversion'::text])))
);


--
-- Name: ai_chats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_chats (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    salon_id uuid NOT NULL,
    session_id text NOT NULL,
    client_phone text,
    client_profile_id uuid,
    language text DEFAULT 'vi'::text,
    messages jsonb DEFAULT '[]'::jsonb NOT NULL,
    message_count integer DEFAULT 0 NOT NULL,
    total_tokens_used integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    resulting_booking_id uuid,
    resulting_waitlist_id uuid,
    customer_helpful_rating smallint,
    customer_helpful_at timestamp with time zone,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    last_message_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    deleted_at timestamp with time zone,
    CONSTRAINT ai_chats_customer_helpful_rating_check CHECK (((customer_helpful_rating IS NULL) OR ((customer_helpful_rating >= 1) AND (customer_helpful_rating <= 5)))),
    CONSTRAINT ai_chats_language_check CHECK ((language = ANY (ARRAY['vi'::text, 'en'::text, 'fr'::text]))),
    CONSTRAINT ai_chats_status_check CHECK ((status = ANY (ARRAY['active'::text, 'converted'::text, 'abandoned'::text, 'escalated_to_staff'::text])))
);


--
-- Name: TABLE ai_chats; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.ai_chats IS 'AI chatbot conversations. Each row = one session. Tracks conversion to booking and customer helpfulness rating.';


--
-- Name: COLUMN ai_chats.messages; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_chats.messages IS 'JSONB array of {role, content, timestamp} objects. role IN (user, assistant, tool).';


--
-- Name: COLUMN ai_chats.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_chats.status IS 'active=ongoing; converted=led to booking; abandoned=customer left without booking; escalated_to_staff=transferred to human.';


--
-- Name: ai_policy_decisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_policy_decisions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    salon_id uuid,
    booking_id uuid,
    agent text NOT NULL,
    mode text NOT NULL,
    ai_protection text,
    ai_fee_percent integer,
    ai_reason text,
    ai_message text,
    ai_confidence text,
    rule_protection text,
    applied boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    actor_user_id uuid
);


--
-- Name: ai_trend_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_trend_cache (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    salon_id uuid NOT NULL,
    period text NOT NULL,
    trends jsonb DEFAULT '[]'::jsonb NOT NULL,
    trend_count integer DEFAULT 0 NOT NULL,
    computed_at timestamp with time zone DEFAULT now() NOT NULL,
    computed_by text DEFAULT 'cron'::text,
    next_refresh_at timestamp with time zone DEFAULT (now() + '24:00:00'::interval) NOT NULL,
    served_count integer DEFAULT 0 NOT NULL,
    click_through_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_trend_cache_period_check CHECK ((period = ANY (ARRAY['this_week'::text, 'this_month'::text, 'all_time'::text])))
);


--
-- Name: TABLE ai_trend_cache; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.ai_trend_cache IS 'Cached "trending now" suggestions per salon, per period. Refreshed daily. Served on public booking page.';


--
-- Name: COLUMN ai_trend_cache.trends; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_trend_cache.trends IS 'Array of trend items. Each: {photo_id, service_id, style, color, booking_count, suggested_price_cents, sort_score}.';


--
-- Name: ai_upsell_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_upsell_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    salon_id uuid NOT NULL,
    booking_id uuid,
    client_phone text,
    session_id text,
    suggested_service_id uuid NOT NULL,
    suggestion_position text NOT NULL,
    suggestion_reason text,
    confidence_score numeric(3,2),
    outcome text DEFAULT 'shown'::text NOT NULL,
    outcome_at timestamp with time zone,
    added_revenue_cents integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_upsell_log_outcome_check CHECK ((outcome = ANY (ARRAY['shown'::text, 'accepted'::text, 'dismissed'::text, 'ignored'::text, 'timeout'::text]))),
    CONSTRAINT ai_upsell_log_suggestion_position_check CHECK ((suggestion_position = ANY (ARRAY['after_service_select'::text, 'on_slot_picker'::text, 'review_screen'::text])))
);


--
-- Name: TABLE ai_upsell_log; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.ai_upsell_log IS 'Tracks AI upsell suggestions and outcomes. Used for conversion analytics + dismissal-based opt-out.';


--
-- Name: COLUMN ai_upsell_log.outcome; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_upsell_log.outcome IS 'shown=just displayed; accepted=added to booking; dismissed=customer closed it; ignored=no interaction; timeout=session ended.';


--
-- Name: approval_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.approval_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    salon_id uuid NOT NULL,
    action_type text NOT NULL,
    summary text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    urgency text DEFAULT 'normal'::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    approve_token text DEFAULT encode(extensions.gen_random_bytes(32), 'hex'::text) NOT NULL,
    decline_token text DEFAULT encode(extensions.gen_random_bytes(32), 'hex'::text) NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    notified_at timestamp with time zone,
    reminded_at timestamp with time zone,
    decided_by uuid,
    decided_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT approval_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'declined'::text, 'expired'::text]))),
    CONSTRAINT approval_requests_urgency_check CHECK ((urgency = ANY (ARRAY['urgent'::text, 'normal'::text])))
);


--
-- Name: auth_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    salon_id uuid,
    user_id uuid,
    event_type text NOT NULL,
    actor_role text,
    ip text,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: booking_addons; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.booking_addons (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    booking_id uuid NOT NULL,
    service_id uuid,
    name text NOT NULL,
    price_cents integer,
    duration_minutes integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: booking_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.booking_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    booking_id uuid NOT NULL,
    salon_id uuid NOT NULL,
    actor_user_id uuid,
    actor_role text NOT NULL,
    event_type text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE booking_events; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.booking_events IS 'Append-only audit log for booking mutations. Reads gated to owner/senior per PERMISSION_MATRIX §3. Writes via service-role client (auditLog.ts).';


--
-- Name: booking_notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.booking_notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    booking_id uuid,
    salon_id uuid NOT NULL,
    notification_type text NOT NULL,
    channel text DEFAULT 'sms'::text NOT NULL,
    status text DEFAULT 'sent'::text NOT NULL,
    client_phone text,
    twilio_message_sid text,
    body_preview text,
    sent_at timestamp with time zone DEFAULT now(),
    delivered_at timestamp with time zone,
    failed_at timestamp with time zone,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: booking_photos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.booking_photos (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    salon_id uuid NOT NULL,
    booking_id uuid NOT NULL,
    staff_id uuid,
    storage_path text NOT NULL,
    thumbnail_path text,
    width_px integer,
    height_px integer,
    file_size_bytes integer,
    ai_processed_at timestamp with time zone,
    ai_detected_services text[],
    ai_detected_colors text[],
    ai_detected_style text,
    ai_quality_score numeric(3,2),
    ai_tags jsonb DEFAULT '{}'::jsonb,
    manual_tags text[],
    sms_sent_at timestamp with time zone,
    customer_viewed_at timestamp with time zone,
    customer_rating smallint,
    customer_rated_at timestamp with time zone,
    customer_feedback text,
    posted_to_website boolean DEFAULT false NOT NULL,
    posted_to_instagram boolean DEFAULT false NOT NULL,
    posted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT booking_photos_ai_quality_score_check CHECK (((ai_quality_score IS NULL) OR ((ai_quality_score >= (0)::numeric) AND (ai_quality_score <= (1)::numeric)))),
    CONSTRAINT booking_photos_customer_rating_check CHECK (((customer_rating IS NULL) OR ((customer_rating >= 1) AND (customer_rating <= 5))))
);


--
-- Name: TABLE booking_photos; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.booking_photos IS 'Photos taken by staff after service. AI auto-tags. Customer rates via SMS link. Pro+ tier feature.';


--
-- Name: COLUMN booking_photos.ai_quality_score; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.booking_photos.ai_quality_score IS '0.00-1.00 quality score from Claude vision. Used to flag retakes and feature in gallery.';


--
-- Name: COLUMN booking_photos.posted_to_instagram; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.booking_photos.posted_to_instagram IS 'TRUE when this photo was published to salon IG. Requires customer_photo_consents.consent_use_marketing=true.';


--
-- Name: booking_reminder_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.booking_reminder_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    booking_id uuid NOT NULL,
    salon_id uuid NOT NULL,
    used_action text,
    used_at timestamp with time zone,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE booking_reminder_tokens; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.booking_reminder_tokens IS 'One row per reminder send. UUID is the capability: embed in confirm/reschedule/cancel URLs.';


--
-- Name: booking_waitlist_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.booking_waitlist_entries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    salon_id uuid NOT NULL,
    service_id uuid NOT NULL,
    staff_id uuid,
    booking_date date NOT NULL,
    preferred_slot_label text,
    client_name text NOT NULL,
    client_phone text NOT NULL,
    source text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    status text DEFAULT 'waiting'::text NOT NULL,
    client_email text,
    notified_at timestamp with time zone,
    claimed_at timestamp with time zone,
    claim_token uuid,
    offered_staff_id uuid,
    offered_start_utc timestamp with time zone,
    offered_end_utc timestamp with time zone,
    booked_booking_id uuid,
    CONSTRAINT booking_waitlist_entries_source_check CHECK ((source = ANY (ARRAY['slot_unavailable'::text, 'booking_conflict'::text]))),
    CONSTRAINT bwe_status_check CHECK ((status = ANY (ARRAY['waiting'::text, 'notified'::text, 'claimed'::text, 'expired'::text])))
);


--
-- Name: TABLE booking_waitlist_entries; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.booking_waitlist_entries IS 'Waitlist requests: slot_unavailable (no slots in UI) or booking_conflict (insert/race lost).';


--
-- Name: bookings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bookings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    salon_id uuid NOT NULL,
    service_id uuid NOT NULL,
    staff_id uuid,
    client_name text NOT NULL,
    client_phone text,
    start_time_utc timestamp with time zone,
    end_time_utc timestamp with time zone,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    price_cents integer,
    client_notes text,
    addon_service_id uuid,
    addon_price_cents integer,
    source text DEFAULT 'appointment'::text NOT NULL,
    joined_queue_at timestamp with time zone,
    started_at timestamp with time zone,
    staff_request_note text,
    client_email text,
    walkin_source text,
    walkin_priority text,
    walkin_request_tags jsonb,
    party_size integer,
    deleted_at timestamp with time zone,
    staff_requested_by_client boolean DEFAULT false NOT NULL,
    soft_hold_until timestamp with time zone,
    group_id uuid,
    group_size smallint,
    idempotency_key uuid,
    reminder_24h_sent_at timestamp with time zone,
    reminder_3h_sent_at timestamp with time zone,
    confirmed_at timestamp with time zone,
    rescheduled_from_time_utc timestamp with time zone,
    rescheduled_at timestamp with time zone,
    rescheduled_by text,
    deposit_required boolean DEFAULT false NOT NULL,
    deposit_amount_cents integer,
    deposit_reason text,
    deposit_status text DEFAULT 'not_required'::text NOT NULL,
    no_show_risk_score integer,
    reference_image_path text,
    reconfirm_sent_at timestamp with time zone,
    service_combo_id uuid,
    verification_method text,
    verification_completed_at timestamp with time zone,
    otp_session_id uuid,
    sms_confirmation_sent_at timestamp with time zone,
    sms_confirmation_failed_at timestamp with time zone,
    sms_confirmation_error text,
    wave_number smallint DEFAULT 1 NOT NULL,
    wix_booking_id text,
    seat_together boolean DEFAULT false NOT NULL,
    stripe_payment_intent_id text,
    deposit_paid_at timestamp with time zone,
    square_booking_id text,
    square_payment_link_id text,
    square_deposit_order_id text,
    square_payment_id text,
    deposit_link_url text,
    resource_id uuid,
    sms_consent_at timestamp with time zone,
    noshow_card_id text,
    noshow_customer_id text,
    noshow_fee_cents integer,
    noshow_charge_status text,
    noshow_payment_id text,
    booking_channel text,
    client_locale text,
    noshow_consent_at timestamp with time zone,
    noshow_card_required boolean DEFAULT false NOT NULL,
    client_profile_id uuid,
    is_party_member boolean DEFAULT false NOT NULL,
    is_group_organizer boolean DEFAULT false NOT NULL,
    noshow_card_last4 text,
    noshow_card_brand text,
    noshow_consent_meta jsonb,
    deposit_hold boolean DEFAULT false NOT NULL,
    deposit_requested_at timestamp with time zone,
    health_ack_at timestamp with time zone,
    local_updated_at timestamp with time zone,
    noshow_charge_attempts integer DEFAULT 0 NOT NULL,
    noshow_last_charge_attempt_at timestamp with time zone,
    noshow_fee_link_url text,
    noshow_fee_order_id text,
    noshow_charge_error text,
    promo_id uuid,
    original_price_cents integer,
    subtotal_cents integer,
    tax_amount_cents integer DEFAULT 0,
    attendance_status text,
    noshow_card_reminder_sent_at timestamp with time zone,
    sms_consent_meta jsonb,
    CONSTRAINT bookings_attendance_status_check CHECK ((attendance_status = ANY (ARRAY['pending'::text, 'confirmed'::text, 'declined'::text]))),
    CONSTRAINT bookings_booking_channel_check CHECK (((booking_channel IS NULL) OR (booking_channel = ANY (ARRAY['online'::text, 'square'::text, 'wix'::text, 'voice'::text, 'walkin'::text, 'desk'::text])))),
    CONSTRAINT bookings_client_email_check CHECK (((client_email IS NULL) OR ((length(client_email) >= 3) AND (length(client_email) <= 254) AND (client_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'::text)))),
    CONSTRAINT bookings_client_name_safe_check CHECK (((client_name IS NULL) OR ((length(client_name) >= 1) AND (length(client_name) <= 100) AND (client_name !~ '[<>{}=&;]'::text)))),
    CONSTRAINT bookings_deposit_status_check CHECK ((deposit_status = ANY (ARRAY['not_required'::text, 'required'::text, 'paid'::text, 'waived'::text, 'refunded'::text]))),
    CONSTRAINT bookings_party_size_check CHECK (((party_size IS NULL) OR ((party_size >= 1) AND (party_size <= 50)))),
    CONSTRAINT bookings_risk_score_range CHECK (((no_show_risk_score >= 0) AND (no_show_risk_score <= 100))),
    CONSTRAINT bookings_source_check CHECK ((source = ANY (ARRAY['appointment'::text, 'walkin'::text, 'voice'::text]))),
    CONSTRAINT bookings_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'confirmed'::text, 'completed'::text, 'cancelled'::text, 'waiting'::text, 'in_progress'::text, 'no_show'::text]))),
    CONSTRAINT bookings_verification_method_check CHECK (((verification_method IS NULL) OR (verification_method = ANY (ARRAY['none'::text, 'otp'::text, 'deposit'::text, 'both'::text, 'vip_skip'::text])))),
    CONSTRAINT bookings_walkin_priority_check CHECK (((walkin_priority IS NULL) OR (walkin_priority = ANY (ARRAY['high'::text, 'medium'::text, 'low'::text])))),
    CONSTRAINT bookings_walkin_source_check CHECK (((walkin_source IS NULL) OR (walkin_source = ANY (ARRAY['online'::text, 'walk_in'::text, 'instagram'::text, 'google'::text, 'phone'::text, 'tiktok'::text, 'repeat'::text, 'vip'::text]))))
);


--
-- Name: COLUMN bookings.source; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bookings.source IS 'appointment = normal booking row; walkin = Receptionist queue + chair flow.';


--
-- Name: COLUMN bookings.joined_queue_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bookings.joined_queue_at IS 'Walk-in enqueue time (unscheduled / in-queue row; status uses existing booking lifecycle values).';


--
-- Name: COLUMN bookings.started_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bookings.started_at IS 'When service starts (e.g. chair occupied); optional operational timestamp.';


--
-- Name: COLUMN bookings.client_email; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bookings.client_email IS 'Optional customer email for confirmation. NULL when guest skipped. RFC-ish format check at DB level.';


--
-- Name: COLUMN bookings.deposit_status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bookings.deposit_status IS 'not_required | required | paid | waived';


--
-- Name: COLUMN bookings.no_show_risk_score; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bookings.no_show_risk_score IS 'AI-computed 0–100 risk. NULL = not yet scored.';


--
-- Name: COLUMN bookings.reference_image_path; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bookings.reference_image_path IS 'Path in booking-refs Storage bucket for client inspiration image uploaded at booking time.';


--
-- Name: COLUMN bookings.reconfirm_sent_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bookings.reconfirm_sent_at IS 'Timestamp when the 24h auto re-confirmation SMS was sent. NULL = not yet sent.';


--
-- Name: COLUMN bookings.service_combo_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bookings.service_combo_id IS 'When booked as a combo bundle, references the service_combos row.';


--
-- Name: COLUMN bookings.verification_method; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bookings.verification_method IS 'none=trusted/skipped, otp=phone verified, deposit=paid, vip_skip=VIP bypass';


--
-- Name: COLUMN bookings.sms_confirmation_sent_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bookings.sms_confirmation_sent_at IS 'When Twilio accepted the confirmation SMS. NULL = not yet sent or failed.';


--
-- Name: COLUMN bookings.seat_together; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bookings.seat_together IS 'Group/couple wants to be seated adjacently (head-spa curtain couple space). Set by submitGroupBooking; surfaced as a badge on the receptionist board.';


--
-- Name: COLUMN bookings.client_locale; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bookings.client_locale IS 'BCP-47 locale the customer was browsing when they booked (e.g. en, vi, es, fr, zh). Drives the language of transactional SMS. No CHECK by design — scales to any number of languages.';


--
-- Name: COLUMN bookings.noshow_consent_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bookings.noshow_consent_at IS 'When the customer agreed to the no-show policy + card-on-file authorization (consent for charging the saved card). Null = never charge.';


--
-- Name: COLUMN bookings.noshow_card_required; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bookings.noshow_card_required IS 'True when booking must leave a card-on-file (new/high-risk). Auto-released by release-pending cron if no card past grace.';


--
-- Name: COLUMN bookings.client_profile_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bookings.client_profile_id IS 'Durable FK to the customer identity (client_profiles). NULL for un-backfilled rows and for party members without their own contact.';


--
-- Name: COLUMN bookings.is_party_member; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bookings.is_party_member IS 'True when this row is a group guest who has no phone/profile of their own (must NOT inherit the booker''s phone). Excluded from the booker''s visit/spend roll-up.';


--
-- Name: COLUMN bookings.is_group_organizer; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bookings.is_group_organizer IS 'True on the organizer (member 0) row of a group booking. Powers the "guests brought" host stat. NULL/false for solo bookings and party guests.';


--
-- Name: COLUMN bookings.noshow_card_last4; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bookings.noshow_card_last4 IS 'Last 4 of the saved no-show card (display only; PCI-allowed).';


--
-- Name: COLUMN bookings.noshow_card_brand; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bookings.noshow_card_brand IS 'Brand of the saved no-show card (e.g. VISA) — display only.';


--
-- Name: COLUMN bookings.noshow_consent_meta; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bookings.noshow_consent_meta IS 'Server-authored record of the no-show policy the customer agreed to (text + amount + locale + timestamp) for dispute evidence.';


--
-- Name: COLUMN bookings.deposit_hold; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bookings.deposit_hold IS 'Slot held only until the deposit is paid; release-pending cron cancels it if unpaid past the grace window. Cleared on payment.';


--
-- Name: COLUMN bookings.deposit_requested_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bookings.deposit_requested_at IS 'When the deposit pay-link was created — start of the pay-or-release grace window.';


--
-- Name: COLUMN bookings.health_ack_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bookings.health_ack_at IS 'When the customer ticked the health acknowledgment at booking (duty-of-care evidence).';


--
-- Name: COLUMN bookings.noshow_charge_attempts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bookings.noshow_charge_attempts IS 'Number of auto-retry charge attempts made by the noshow-charge-retry cron (capped at 3).';


--
-- Name: COLUMN bookings.noshow_last_charge_attempt_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bookings.noshow_last_charge_attempt_at IS 'Timestamp of the last auto-retry charge attempt — enforces once-per-day pacing.';


--
-- Name: COLUMN bookings.noshow_fee_order_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bookings.noshow_fee_order_id IS 'Square order id of the customer-facing no-show-fee payment link; reconcile key for marking the fee charged.';


--
-- Name: campaign_schedules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.campaign_schedules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    salon_id uuid NOT NULL,
    campaign_type text DEFAULT 'reoptin'::text NOT NULL,
    send_limit integer DEFAULT 200 NOT NULL,
    scheduled_at timestamp with time zone NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_by uuid,
    last_summary jsonb,
    processed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT campaign_schedules_campaign_type_check CHECK ((campaign_type = 'reoptin'::text)),
    CONSTRAINT campaign_schedules_send_limit_check CHECK (((send_limit >= 1) AND (send_limit <= 5000))),
    CONSTRAINT campaign_schedules_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'sent'::text, 'canceled'::text, 'failed'::text])))
);


--
-- Name: client_ai_summaries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client_ai_summaries (
    salon_id uuid NOT NULL,
    client_profile_id uuid NOT NULL,
    summary_text text NOT NULL,
    next_action text,
    visit_count integer DEFAULT 0 NOT NULL,
    computed_at timestamp with time zone DEFAULT now() NOT NULL,
    lang text DEFAULT 'vi'::text NOT NULL
);


--
-- Name: client_email_optouts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client_email_optouts (
    email text NOT NULL,
    opted_out_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE client_email_optouts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.client_email_optouts IS 'CASL email suppression: emails that unsubscribed; optional emails skip these.';


--
-- Name: client_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client_profiles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    phone text NOT NULL,
    name text,
    preferred_staff_id uuid,
    last_service_date timestamp with time zone,
    visit_count integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    email text,
    total_spent_cents bigint DEFAULT 0 NOT NULL,
    notes text,
    is_vip boolean DEFAULT false NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    no_show_count integer DEFAULT 0 NOT NULL,
    birthday date,
    birthday_voucher_sent_year integer,
    square_customer_id text,
    phone_verified_at timestamp with time zone,
    date_of_birth date,
    marketing_consent_at timestamp with time zone,
    email_discount_claimed_at timestamp with time zone,
    marketing_email_consent_at timestamp with time zone,
    CONSTRAINT client_profiles_name_safe_check CHECK (((name IS NULL) OR ((length(name) >= 1) AND (length(name) <= 100) AND (name !~ '[<>{}=&;]'::text))))
);


--
-- Name: COLUMN client_profiles.is_vip; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.client_profiles.is_vip IS 'VIP customers are exempt from deposit requirements.';


--
-- Name: COLUMN client_profiles.no_show_count; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.client_profiles.no_show_count IS 'Incremented when booking for this phone is marked no_show.';


--
-- Name: COLUMN client_profiles.birthday; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.client_profiles.birthday IS 'Optional date of birth (MM-DD used for voucher trigger; YYYY for analytics). NULL when not collected.';


--
-- Name: COLUMN client_profiles.birthday_voucher_sent_year; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.client_profiles.birthday_voucher_sent_year IS 'Last year (YYYY) the birthday voucher was issued. Cron uses this to avoid double-sending.';


--
-- Name: COLUMN client_profiles.phone_verified_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.client_profiles.phone_verified_at IS 'Last time this phone passed OTP; determine_booking_verification skips OTP for a verified+clean+<12mo phone.';


--
-- Name: COLUMN client_profiles.date_of_birth; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.client_profiles.date_of_birth IS 'Birthday (date only, no year required) — used by VIP Care to send personalised messages 7 days before each birthday.';


--
-- Name: COLUMN client_profiles.marketing_email_consent_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.client_profiles.marketing_email_consent_at IS 'EMAIL-only marketing consent (e.g. synced from Square email-subscription). Never gates SMS — SMS requires marketing_consent_at.';


--
-- Name: customer_booking_patterns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_booking_patterns (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    salon_id uuid NOT NULL,
    client_phone text NOT NULL,
    client_profile_id uuid,
    recurring_weekday smallint,
    recurring_hour smallint,
    recurring_minute smallint,
    recurrence_frequency_days integer,
    pattern_confidence numeric(3,2),
    usual_service_ids uuid[],
    usual_addon_service_id uuid,
    usual_staff_id uuid,
    usual_total_cents integer,
    bookings_analyzed integer DEFAULT 0 NOT NULL,
    last_booking_at timestamp with time zone,
    next_predicted_at timestamp with time zone,
    last_computed_at timestamp with time zone DEFAULT now() NOT NULL,
    next_refresh_at timestamp with time zone DEFAULT (now() + '7 days'::interval) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT customer_booking_patterns_pattern_confidence_check CHECK (((pattern_confidence IS NULL) OR ((pattern_confidence >= (0)::numeric) AND (pattern_confidence <= (1)::numeric)))),
    CONSTRAINT customer_booking_patterns_recurring_hour_check CHECK (((recurring_hour IS NULL) OR ((recurring_hour >= 0) AND (recurring_hour <= 23)))),
    CONSTRAINT customer_booking_patterns_recurring_minute_check CHECK (((recurring_minute IS NULL) OR ((recurring_minute >= 0) AND (recurring_minute <= 59)))),
    CONSTRAINT customer_booking_patterns_recurring_weekday_check CHECK (((recurring_weekday IS NULL) OR ((recurring_weekday >= 0) AND (recurring_weekday <= 6))))
);


--
-- Name: TABLE customer_booking_patterns; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.customer_booking_patterns IS 'AI-detected booking patterns per customer. Powers Quick Rebook 1-tap UX. Refreshed weekly or after each completed booking.';


--
-- Name: COLUMN customer_booking_patterns.pattern_confidence; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.customer_booking_patterns.pattern_confidence IS '0.00-1.00. App shows Quick Rebook button only when confidence >= 0.70 to avoid wrong suggestions.';


--
-- Name: customer_photo_consents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_photo_consents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    salon_id uuid NOT NULL,
    client_phone text NOT NULL,
    client_profile_id uuid,
    consent_receive_sms boolean DEFAULT true NOT NULL,
    consent_save_to_profile boolean DEFAULT true NOT NULL,
    consent_share_public boolean DEFAULT false NOT NULL,
    consent_use_marketing boolean DEFAULT false NOT NULL,
    granted_at timestamp with time zone DEFAULT now() NOT NULL,
    granted_via text DEFAULT 'in_salon'::text NOT NULL,
    granted_by_staff_id uuid,
    revoked_at timestamp with time zone,
    revoked_reason text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT customer_photo_consents_granted_via_check CHECK ((granted_via = ANY (ARRAY['in_salon'::text, 'sms_link'::text, 'booking_form'::text, 'phone_call'::text, 'email'::text])))
);


--
-- Name: TABLE customer_photo_consents; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.customer_photo_consents IS 'PIPEDA-compliant consent tracking for using customer photos. One row per (salon, phone). Customers can revoke any time.';


--
-- Name: COLUMN customer_photo_consents.consent_share_public; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.customer_photo_consents.consent_share_public IS 'When TRUE: photo can appear in public salon gallery / website. App code MUST check revoked_at IS NULL before display.';


--
-- Name: COLUMN customer_photo_consents.consent_use_marketing; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.customer_photo_consents.consent_use_marketing IS 'When TRUE: photo can be used on Instagram, ads, promo materials. Customer rewarded with small gift on next visit.';


--
-- Name: customer_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_preferences (
    client_profile_id uuid NOT NULL,
    salon_id uuid NOT NULL,
    preferred_language text DEFAULT 'vi'::text,
    preferred_communication_channel text DEFAULT 'sms'::text,
    preferred_sms_time_window text,
    allergies text[] DEFAULT '{}'::text[],
    favorite_colors text[] DEFAULT '{}'::text[],
    favorite_styles text[] DEFAULT '{}'::text[],
    extra jsonb DEFAULT '{}'::jsonb NOT NULL,
    consent_marketing_sms boolean DEFAULT false NOT NULL,
    consent_marketing_email boolean DEFAULT false NOT NULL,
    consent_ai_personalization boolean DEFAULT true NOT NULL,
    last_updated_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT customer_preferences_last_updated_by_check CHECK (((last_updated_by IS NULL) OR (last_updated_by = ANY (ARRAY['customer'::text, 'staff'::text, 'ai_detected'::text])))),
    CONSTRAINT customer_preferences_preferred_communication_channel_check CHECK ((preferred_communication_channel = ANY (ARRAY['sms'::text, 'email'::text, 'both'::text, 'none'::text]))),
    CONSTRAINT customer_preferences_preferred_language_check CHECK ((preferred_language = ANY (ARRAY['vi'::text, 'en'::text, 'fr'::text]))),
    CONSTRAINT customer_preferences_preferred_sms_time_window_check CHECK (((preferred_sms_time_window IS NULL) OR (preferred_sms_time_window = ANY (ARRAY['morning'::text, 'afternoon'::text, 'evening'::text, 'anytime'::text]))))
);


--
-- Name: TABLE customer_preferences; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.customer_preferences IS 'Structured customer preferences — allergies, colors, styles, communication. AI can write here via service-role.';


--
-- Name: COLUMN customer_preferences.extra; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.customer_preferences.extra IS 'JSONB bucket for arbitrary preferences. Examples: {"preferred_chair":"window","drink":"tea","music":"jazz"}.';


--
-- Name: COLUMN customer_preferences.consent_ai_personalization; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.customer_preferences.consent_ai_personalization IS 'When FALSE, AI must not use history for upsell/recommendation. Customer-controlled (PIPEDA-friendly).';


--
-- Name: email_otp_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_otp_codes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    salon_id uuid NOT NULL,
    phone text NOT NULL,
    email text NOT NULL,
    code_hash text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '00:10:00'::interval) NOT NULL,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: email_verification_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_verification_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    salon_id uuid NOT NULL,
    email text NOT NULL,
    token text NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '24:00:00'::interval) NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE email_verification_tokens; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.email_verification_tokens IS 'Email verification tokens. RLS enabled with no policies — service-role only access. Tokens are issued and consumed exclusively by backend code.';


--
-- Name: error_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.error_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    fingerprint text NOT NULL,
    level text DEFAULT 'error'::text NOT NULL,
    message text NOT NULL,
    surface text,
    route text,
    salon_id uuid,
    user_id uuid,
    stack text,
    context jsonb DEFAULT '{}'::jsonb NOT NULL,
    occurrence_count integer DEFAULT 1 NOT NULL,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    ai_summary text,
    ai_suggested_fix text,
    resolved_at timestamp with time zone,
    resolved_by uuid,
    alerted_at timestamp with time zone,
    fix_proposal text,
    fix_file text,
    fix_pr_url text,
    CONSTRAINT error_logs_level_check CHECK ((level = ANY (ARRAY['fatal'::text, 'error'::text, 'warning'::text]))),
    CONSTRAINT error_logs_status_check CHECK ((status = ANY (ARRAY['open'::text, 'resolved'::text, 'ignored'::text])))
);


--
-- Name: TABLE error_logs; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.error_logs IS 'Self-hosted error monitor. Writes via service-role log_error() (dedup by fingerprint while open); reads gated to superadmins.';


--
-- Name: first_visit_sequences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.first_visit_sequences (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    salon_id uuid NOT NULL,
    client_phone text NOT NULL,
    client_name text DEFAULT ''::text NOT NULL,
    client_email text,
    first_booking_id uuid,
    first_service text,
    first_visit_date date NOT NULL,
    channel text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    step integer DEFAULT 0 NOT NULL,
    next_action_date date,
    converted_booking_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT first_visit_sequences_channel_check CHECK ((channel = ANY (ARRAY['sms'::text, 'email'::text]))),
    CONSTRAINT first_visit_sequences_status_check CHECK ((status = ANY (ARRAY['active'::text, 'converted'::text, 'expired'::text])))
);


--
-- Name: loyalty_cards; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.loyalty_cards (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    salon_id uuid NOT NULL,
    program_id uuid NOT NULL,
    client_phone text NOT NULL,
    client_profile_id uuid,
    stamps_current integer DEFAULT 0 NOT NULL,
    stamps_lifetime integer DEFAULT 0 NOT NULL,
    rewards_earned integer DEFAULT 0 NOT NULL,
    rewards_redeemed integer DEFAULT 0 NOT NULL,
    last_stamp_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT loyalty_cards_stamps_current_check CHECK ((stamps_current >= 0))
);


--
-- Name: loyalty_programs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.loyalty_programs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    salon_id uuid NOT NULL,
    name text DEFAULT 'Loyalty Rewards'::text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    stamps_required integer DEFAULT 10 NOT NULL,
    reward_type text DEFAULT 'free_service'::text NOT NULL,
    reward_service_id uuid,
    reward_percent_off smallint,
    reward_amount_off_cents integer,
    stamps_per_visit integer DEFAULT 1 NOT NULL,
    min_spend_cents integer DEFAULT 0 NOT NULL,
    description text,
    color text DEFAULT '#D4AF37'::text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    voucher_valid_days integer,
    CONSTRAINT loyalty_programs_color_check CHECK ((color ~ '^#[0-9A-Fa-f]{6}$'::text)),
    CONSTRAINT loyalty_programs_reward_amount_off_cents_check CHECK ((reward_amount_off_cents > 0)),
    CONSTRAINT loyalty_programs_reward_percent_off_check CHECK (((reward_percent_off >= 1) AND (reward_percent_off <= 100))),
    CONSTRAINT loyalty_programs_reward_type_check CHECK ((reward_type = ANY (ARRAY['free_service'::text, 'percent_off'::text, 'amount_off'::text]))),
    CONSTRAINT loyalty_programs_stamps_per_visit_check CHECK (((stamps_per_visit >= 1) AND (stamps_per_visit <= 5))),
    CONSTRAINT loyalty_programs_stamps_required_check CHECK (((stamps_required >= 3) AND (stamps_required <= 50)))
);


--
-- Name: COLUMN loyalty_programs.voucher_valid_days; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.loyalty_programs.voucher_valid_days IS 'Days a redeemed reward voucher stays valid. NULL = platform default (90). App clamps 7..365.';


--
-- Name: loyalty_stamp_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.loyalty_stamp_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    salon_id uuid NOT NULL,
    card_id uuid NOT NULL,
    booking_id uuid,
    event_type text NOT NULL,
    stamps_delta integer NOT NULL,
    stamps_after integer NOT NULL,
    note text,
    actor_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT loyalty_stamp_events_event_type_check CHECK ((event_type = ANY (ARRAY['earn'::text, 'redeem'::text, 'manual_add'::text, 'manual_remove'::text, 'expire'::text])))
);


--
-- Name: minh_lessons; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.minh_lessons (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    salon_id uuid,
    scope text NOT NULL,
    condition jsonb DEFAULT '{}'::jsonb NOT NULL,
    rule text NOT NULL,
    source text DEFAULT 'admin'::text NOT NULL,
    confidence numeric(4,3) DEFAULT 0.900 NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT minh_lessons_confidence_check CHECK (((confidence >= (0)::numeric) AND (confidence <= (1)::numeric))),
    CONSTRAINT minh_lessons_scope_check CHECK ((scope = ANY (ARRAY['channel'::text, 'cost'::text, 'timing'::text, 'segment'::text, 'policy'::text, 'general'::text])))
);


--
-- Name: notification_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_templates (
    template_key text NOT NULL,
    locale text NOT NULL,
    channel text DEFAULT 'sms'::text NOT NULL,
    body text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE notification_templates; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.notification_templates IS 'Localized bodies for transactional notifications. Keyed by (template_key, locale, channel). Placeholders: {name} {salon} {when} {service}. Locale has no CHECK so any BCP-47 code scales without migration. Sender resolves locale -> base language -> default with graceful fallback.';


--
-- Name: otp_send_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.otp_send_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    salon_id uuid NOT NULL,
    phone text NOT NULL,
    channel text DEFAULT 'sms'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: otps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.otps (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    phone text NOT NULL,
    code text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: party_link_change_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.party_link_change_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    party_link_id uuid NOT NULL,
    booking_id uuid NOT NULL,
    claim_id uuid,
    request_type text NOT NULL,
    requested_service_id uuid,
    requested_staff_id uuid,
    note text,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    CONSTRAINT party_link_change_requests_request_type_check CHECK ((request_type = ANY (ARRAY['service_change'::text, 'staff_preference'::text, 'note'::text]))),
    CONSTRAINT party_link_change_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'auto_applied'::text, 'approved'::text, 'declined'::text])))
);


--
-- Name: party_link_claims; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.party_link_claims (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    party_link_id uuid NOT NULL,
    booking_id uuid NOT NULL,
    member_name text,
    member_phone text,
    reminder_opted_in boolean DEFAULT false NOT NULL,
    claimed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    declined_at timestamp with time zone,
    suggested_name text,
    suggested_phone text,
    organizer_notified_at timestamp with time zone
);


--
-- Name: party_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.party_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    group_id uuid NOT NULL,
    salon_id uuid NOT NULL,
    token text NOT NULL,
    mode text DEFAULT 'sync_start'::text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    organizer_name text,
    organizer_phone text,
    CONSTRAINT party_links_mode_check CHECK ((mode = ANY (ARRAY['sync_start'::text, 'sync_finish'::text]))),
    CONSTRAINT party_links_token_check CHECK ((length(token) >= 8))
);


--
-- Name: payment_disputes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_disputes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    salon_id uuid,
    provider text NOT NULL,
    provider_dispute_id text NOT NULL,
    payment_ref text,
    booking_id uuid,
    client_phone text,
    amount_cents integer,
    currency text,
    reason text,
    status text,
    evidence_due_at timestamp with time zone,
    raw jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: phone_otp_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.phone_otp_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    phone text NOT NULL,
    salon_id uuid NOT NULL,
    verified_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '00:15:00'::interval) NOT NULL,
    consumed_at timestamp with time zone
);


--
-- Name: platform_announcements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_announcements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    severity text DEFAULT 'info'::text NOT NULL,
    target text DEFAULT 'all'::text NOT NULL,
    published_at timestamp with time zone,
    expires_at timestamp with time zone,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT platform_announcements_severity_check CHECK ((severity = ANY (ARRAY['info'::text, 'warning'::text, 'urgent'::text]))),
    CONSTRAINT platform_announcements_target_check CHECK ((target = ANY (ARRAY['all'::text, 'owners'::text, 'staff'::text, 'superadmins'::text])))
);


--
-- Name: TABLE platform_announcements; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.platform_announcements IS 'Broadcast banners to operators. Surfaces in dashboards filtered by target, severity, and (published_at, expires_at) window.';


--
-- Name: COLUMN platform_announcements.published_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.platform_announcements.published_at IS 'NULL = draft. Set to publish.';


--
-- Name: COLUMN platform_announcements.expires_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.platform_announcements.expires_at IS 'NULL = no expiry. Past expires_at = hidden by app filter; row retained for audit.';


--
-- Name: platform_feature_flags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_feature_flags (
    key text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);


--
-- Name: TABLE platform_feature_flags; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.platform_feature_flags IS 'Platform-wide feature flags. Distinct from salons.feature_flags JSONB. Read by all authenticated; write by service-role only.';


--
-- Name: platform_flags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_flags (
    key text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    description text,
    updated_at timestamp with time zone DEFAULT now(),
    updated_by uuid
);


--
-- Name: platform_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_settings (
    id text DEFAULT 'platform'::text NOT NULL,
    twilio_account_sid text,
    twilio_auth_token text,
    twilio_verify_service_sid text,
    resend_api_key text,
    resend_from text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    twilio_phone_number text,
    error_alert_email text,
    github_fix_token text
);


--
-- Name: promotion_services; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.promotion_services (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    promotion_id uuid NOT NULL,
    service_id uuid NOT NULL,
    discount_type text,
    discount_value integer,
    CONSTRAINT promotion_services_discount_type_check CHECK ((discount_type = ANY (ARRAY['fixed_price'::text, 'percent'::text, 'amount'::text])))
);


--
-- Name: promotions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.promotions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    salon_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    starts_at timestamp with time zone NOT NULL,
    ends_at timestamp with time zone NOT NULL,
    days_of_week integer[],
    time_start time without time zone,
    time_end time without time zone,
    discount_type text NOT NULL,
    discount_value integer NOT NULL,
    applies_to text DEFAULT 'specific'::text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT promotions_applies_to_check CHECK ((applies_to = ANY (ARRAY['all'::text, 'specific'::text]))),
    CONSTRAINT promotions_discount_type_check CHECK ((discount_type = ANY (ARRAY['fixed_price'::text, 'percent'::text, 'amount'::text])))
);


--
-- Name: queue_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.queue_entries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    salon_id uuid NOT NULL,
    client_name text NOT NULL,
    client_phone text NOT NULL,
    client_notes text,
    service_id uuid NOT NULL,
    requested_staff_id uuid,
    assigned_staff_id uuid,
    arrived_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    status text DEFAULT 'waiting'::text NOT NULL,
    price_cents integer,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: rate_limits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rate_limits (
    bucket text NOT NULL,
    count integer DEFAULT 0 NOT NULL,
    expires_at timestamp with time zone NOT NULL
);


--
-- Name: referrals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.referrals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    salon_id uuid NOT NULL,
    referrer_phone text NOT NULL,
    referrer_profile_id uuid,
    referee_phone text,
    referee_profile_id uuid,
    code text NOT NULL,
    share_url text,
    referrer_reward_percent_off smallint DEFAULT 10,
    referee_reward_percent_off smallint DEFAULT 10,
    status text DEFAULT 'pending'::text NOT NULL,
    referee_booking_id uuid,
    referrer_voucher_id uuid,
    referee_voucher_id uuid,
    expires_at timestamp with time zone DEFAULT (now() + '90 days'::interval) NOT NULL,
    used_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT referrals_referee_reward_percent_off_check CHECK (((referee_reward_percent_off >= 0) AND (referee_reward_percent_off <= 100))),
    CONSTRAINT referrals_referrer_reward_percent_off_check CHECK (((referrer_reward_percent_off >= 0) AND (referrer_reward_percent_off <= 100))),
    CONSTRAINT referrals_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'used'::text, 'completed'::text, 'expired'::text, 'revoked'::text])))
);


--
-- Name: TABLE referrals; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.referrals IS 'Bring-a-Friend referrals. Referrer gets voucher when referee completes first service. Anti-abuse: 1 referee per salon.';


--
-- Name: COLUMN referrals.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.referrals.status IS 'pending → used (referee booked) → completed (service done, vouchers issued). expired/revoked are terminal.';


--
-- Name: register_completion_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.register_completion_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    phone text NOT NULL,
    token text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    payload jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: reoptin_sends; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reoptin_sends (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    salon_id uuid NOT NULL,
    client_profile_id uuid NOT NULL,
    email text NOT NULL,
    token text NOT NULL,
    voucher_id uuid,
    code text,
    status text DEFAULT 'pending'::text NOT NULL,
    sent_at timestamp with time zone,
    confirmed_at timestamp with time zone,
    booked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT reoptin_sends_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sent'::text, 'confirmed'::text, 'booked'::text, 'failed'::text, 'suppressed'::text])))
);


--
-- Name: reviews; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reviews (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    salon_id uuid NOT NULL,
    booking_id uuid NOT NULL,
    staff_id uuid,
    service_id uuid,
    client_phone text,
    client_email text,
    request_token text NOT NULL,
    request_sent_at timestamp with time zone,
    rating integer,
    message text,
    submitted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT reviews_rating_check CHECK (((rating >= 1) AND (rating <= 5)))
);


--
-- Name: TABLE reviews; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.reviews IS 'Auto review requests + customer submissions. Pro+ tier feature; rows are created by updateBookingStatus when a booking flips to `completed` (idempotent on booking_id). request_token is the public form key — never expose elsewhere.';


--
-- Name: salon_client_names; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.salon_client_names (
    salon_id uuid NOT NULL,
    phone text NOT NULL,
    display_name text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: salon_client_spend; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.salon_client_spend (
    salon_id uuid NOT NULL,
    client_profile_id uuid NOT NULL,
    total_spend_cents bigint DEFAULT 0 NOT NULL,
    payment_count integer DEFAULT 0 NOT NULL,
    last_payment_at timestamp with time zone,
    synced_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: salon_clients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.salon_clients (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    salon_id uuid NOT NULL,
    client_profile_id uuid NOT NULL,
    source text DEFAULT 'manual'::text NOT NULL,
    external_ref text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: salon_custom_domains; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.salon_custom_domains (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    salon_id uuid NOT NULL,
    domain text NOT NULL,
    verified boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT salon_custom_domains_domain_fmt_chk CHECK ((domain ~ '^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$'::text)),
    CONSTRAINT salon_custom_domains_domain_lower_chk CHECK ((domain = lower(domain)))
);


--
-- Name: TABLE salon_custom_domains; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.salon_custom_domains IS 'Maps an external hostname to a salon for serving the public booking page on the salon''s own domain. Resolved at the proxy via public_resolve_domain().';


--
-- Name: salon_invite_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.salon_invite_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    token text DEFAULT encode(extensions.gen_random_bytes(16), 'hex'::text) NOT NULL,
    salon_id uuid NOT NULL,
    staff_id uuid NOT NULL,
    role text NOT NULL,
    created_by uuid,
    expires_at timestamp with time zone DEFAULT (now() + '48:00:00'::interval) NOT NULL,
    used_at timestamp with time zone,
    used_by_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT salon_invite_tokens_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'receptionist'::text])))
);


--
-- Name: salon_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.salon_members (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    salon_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text DEFAULT 'owner'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT salon_members_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'receptionist'::text])))
);


--
-- Name: COLUMN salon_members.role; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.salon_members.role IS 'owner: full access to salon | admin: manage staff/operations | receptionist: front-desk only';


--
-- Name: salon_page_sections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.salon_page_sections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    salon_id uuid NOT NULL,
    type text NOT NULL,
    title text DEFAULT ''::text NOT NULL,
    is_visible boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    content jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT salon_page_sections_type_check CHECK ((type = ANY (ARRAY['hero'::text, 'services'::text, 'about'::text, 'gallery'::text, 'promotions'::text, 'contact'::text, 'blog'::text])))
);


--
-- Name: salon_resources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.salon_resources (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    salon_id uuid NOT NULL,
    name text NOT NULL,
    kind text DEFAULT 'station'::text NOT NULL,
    display_order integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    square_team_member_id text,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT salon_resources_kind_check CHECK ((kind = ANY (ARRAY['station'::text, 'chair'::text, 'bed'::text, 'backwash'::text, 'room'::text, 'other'::text]))),
    CONSTRAINT salon_resources_status_check CHECK ((status = ANY (ARRAY['active'::text, 'inactive'::text])))
);


--
-- Name: salons; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.salons (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    phone text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    email text,
    email_verified boolean DEFAULT false,
    address text,
    salon_phone text,
    opening_hours jsonb DEFAULT '{"fri": {"open": "09:00", "close": "18:00", "closed": false}, "mon": {"open": "09:00", "close": "18:00", "closed": false}, "sat": {"open": "09:00", "close": "18:00", "closed": false}, "sun": {"open": "09:00", "close": "18:00", "closed": true}, "thu": {"open": "09:00", "close": "18:00", "closed": false}, "tue": {"open": "09:00", "close": "18:00", "closed": false}, "wed": {"open": "09:00", "close": "18:00", "closed": false}}'::jsonb,
    profile_complete boolean DEFAULT false,
    booking_closed_dates jsonb DEFAULT '[]'::jsonb NOT NULL,
    timezone text DEFAULT 'America/Vancouver'::text NOT NULL,
    dashboard_modules jsonb DEFAULT '{"alerts": true, "kpi_bar": true, "quick_add": true, "wait_time": true, "queue_panel": true, "revenue_today": false, "ai_suggestions": false, "vip_indicators": true, "timeline_heatmap": false, "staff_performance": false}'::jsonb NOT NULL,
    dashboard_preset text DEFAULT 'reception'::text NOT NULL,
    dashboard_density text DEFAULT 'balanced'::text NOT NULL,
    contact_email text,
    stripe_customer_id text,
    stripe_subscription_id text,
    subscription_plan text DEFAULT 'free'::text NOT NULL,
    subscription_status text DEFAULT 'active'::text NOT NULL,
    subscription_current_period_end timestamp with time zone,
    setup_wizard_completed_at timestamp with time zone,
    plan_override text,
    feature_flags jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_beta boolean DEFAULT false NOT NULL,
    admin_notes text,
    superadmin_locked_at timestamp with time zone,
    archived_at timestamp with time zone,
    walkin_auto_assign boolean DEFAULT true NOT NULL,
    brand_color text DEFAULT '#D4AF37'::text,
    theme_mode text DEFAULT 'dark'::text,
    currency_code text DEFAULT 'CAD'::text,
    description text,
    phone_otp_enabled boolean DEFAULT false NOT NULL,
    reminders_enabled boolean DEFAULT false NOT NULL,
    reminder_24h_enabled boolean DEFAULT true NOT NULL,
    reminder_3h_enabled boolean DEFAULT true NOT NULL,
    deposit_high_value_cents integer DEFAULT 10000 NOT NULL,
    sms_reminders_enabled boolean DEFAULT false NOT NULL,
    booking_verification_mode text DEFAULT 'never'::text NOT NULL,
    verification_risk_threshold_otp smallint DEFAULT 30 NOT NULL,
    verification_risk_threshold_deposit smallint DEFAULT 70 NOT NULL,
    deposit_default_amount_cents integer,
    queue_display_mode text DEFAULT 'full'::text NOT NULL,
    google_review_url text,
    voice_ai_enabled boolean DEFAULT false NOT NULL,
    voice_ai_persona_name text DEFAULT 'Lily'::text NOT NULL,
    voice_ai_persona_voice text DEFAULT 'marin'::text NOT NULL,
    voice_ai_reasoning_effort text DEFAULT 'low'::text NOT NULL,
    voice_ai_sessions_this_month integer DEFAULT 0 NOT NULL,
    voice_ai_sessions_limit integer DEFAULT 200 NOT NULL,
    voice_ai_sessions_reset_at timestamp with time zone DEFAULT (date_trunc('month'::text, now()) + '1 mon'::interval) NOT NULL,
    party_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    basic_mode_forced boolean DEFAULT false,
    vertical text DEFAULT 'nail_salon'::text NOT NULL,
    public_sections_enabled boolean DEFAULT false NOT NULL,
    booking_images jsonb,
    staff_selection_enabled boolean DEFAULT true NOT NULL,
    booking_lead_minutes integer DEFAULT 15 NOT NULL,
    reference_image_enabled boolean,
    auto_no_show_minutes integer,
    winback_enabled boolean DEFAULT true NOT NULL,
    stripe_connect_account_id text,
    stripe_connect_charges_enabled boolean DEFAULT false NOT NULL,
    stripe_connect_details_submitted boolean DEFAULT false NOT NULL,
    deposit_pct_no_show smallint DEFAULT 50 NOT NULL,
    deposit_pct_high_value smallint DEFAULT 30 NOT NULL,
    deposit_pct_new_customer smallint DEFAULT 20 NOT NULL,
    group_together_threshold_minutes integer DEFAULT 30 NOT NULL,
    resources_enabled boolean DEFAULT false NOT NULL,
    primary_grid_axis text DEFAULT 'staff'::text NOT NULL,
    owner_notification_settings jsonb,
    staff_notification_settings jsonb,
    default_notification_locale text DEFAULT 'en'::text NOT NULL,
    payment_provider text,
    noshow_protection_enabled boolean DEFAULT false NOT NULL,
    noshow_fee_percent integer DEFAULT 20 NOT NULL,
    noshow_risk_threshold integer DEFAULT 60 NOT NULL,
    client_segment_settings jsonb,
    deposit_hold_grace_minutes integer DEFAULT 30 NOT NULL,
    cancellation_policy jsonb,
    health_ack_required boolean,
    email_links_enabled boolean DEFAULT true NOT NULL,
    noshow_group_whole_party boolean DEFAULT true NOT NULL,
    noshow_deposit_escalation_threshold smallint,
    noshow_require_new_customer boolean DEFAULT true NOT NULL,
    noshow_require_prior_noshow boolean DEFAULT true NOT NULL,
    noshow_min_noshow_count integer DEFAULT 1 NOT NULL,
    noshow_require_high_risk boolean DEFAULT true NOT NULL,
    vip_spend_tiers jsonb,
    ai_profile jsonb,
    owner_notification_channel text DEFAULT 'email'::text NOT NULL,
    owner_phone text,
    google_place_id text,
    sms_a2p_registered boolean DEFAULT false NOT NULL,
    customer_channel text DEFAULT 'smart'::text NOT NULL,
    sms_outbound_enabled boolean DEFAULT true NOT NULL,
    email_outbound_enabled boolean DEFAULT true NOT NULL,
    ai_manager_instructions text,
    yelp_business_id text,
    tax_lines jsonb,
    group_decline_cutoff_hours integer DEFAULT 2 NOT NULL,
    self_cancel_window_hours integer DEFAULT 24 NOT NULL,
    self_cancel_fee_enabled boolean DEFAULT false NOT NULL,
    self_cancel_fee_percent integer,
    birthday_reward_type text DEFAULT 'none'::text NOT NULL,
    birthday_reward_percent integer,
    birthday_reward_amount_cents integer,
    birthday_reward_valid_days integer DEFAULT 30 NOT NULL,
    milestone_reward_type text DEFAULT 'none'::text NOT NULL,
    milestone_reward_percent integer,
    milestone_reward_amount_cents integer,
    milestone_reward_valid_days integer DEFAULT 30 NOT NULL,
    privacy_url text,
    terms_url text,
    default_language text,
    logo_url text,
    CONSTRAINT salons_auto_no_show_minutes_check CHECK (((auto_no_show_minutes IS NULL) OR ((auto_no_show_minutes >= 0) AND (auto_no_show_minutes <= 240)))),
    CONSTRAINT salons_birthday_reward_type_check CHECK ((birthday_reward_type = ANY (ARRAY['none'::text, 'percent'::text, 'amount'::text]))),
    CONSTRAINT salons_booking_lead_minutes_check CHECK (((booking_lead_minutes >= 0) AND (booking_lead_minutes <= 1440))),
    CONSTRAINT salons_booking_verification_mode_check CHECK ((booking_verification_mode = ANY (ARRAY['auto'::text, 'always_otp'::text, 'always_deposit'::text, 'deposit_first'::text, 'never'::text]))),
    CONSTRAINT salons_brand_color_check CHECK ((brand_color ~ '^#[0-9A-Fa-f]{6}$'::text)),
    CONSTRAINT salons_currency_code_check CHECK ((currency_code = ANY (ARRAY['CAD'::text, 'USD'::text, 'VND'::text]))),
    CONSTRAINT salons_customer_channel_check CHECK ((customer_channel = ANY (ARRAY['smart'::text, 'sms_only'::text, 'email_only'::text, 'sms_and_email'::text]))),
    CONSTRAINT salons_dashboard_density_check CHECK ((dashboard_density = ANY (ARRAY['simple'::text, 'balanced'::text, 'pro'::text]))),
    CONSTRAINT salons_dashboard_preset_check CHECK ((dashboard_preset = ANY (ARRAY['minimal'::text, 'reception'::text, 'rush_hour'::text, 'owner'::text, 'training'::text, 'tv'::text]))),
    CONSTRAINT salons_default_language_check CHECK ((default_language = ANY (ARRAY['en'::text, 'vi'::text]))),
    CONSTRAINT salons_deposit_hold_grace_minutes_range CHECK (((deposit_hold_grace_minutes >= 5) AND (deposit_hold_grace_minutes <= 1440))),
    CONSTRAINT salons_deposit_pct_high_value_check CHECK (((deposit_pct_high_value >= 0) AND (deposit_pct_high_value <= 100))),
    CONSTRAINT salons_deposit_pct_new_customer_check CHECK (((deposit_pct_new_customer >= 0) AND (deposit_pct_new_customer <= 100))),
    CONSTRAINT salons_deposit_pct_no_show_check CHECK (((deposit_pct_no_show >= 0) AND (deposit_pct_no_show <= 100))),
    CONSTRAINT salons_description_len CHECK (((description IS NULL) OR (char_length(description) <= 400))),
    CONSTRAINT salons_group_decline_cutoff_hours_check CHECK (((group_decline_cutoff_hours >= 0) AND (group_decline_cutoff_hours <= 72))),
    CONSTRAINT salons_group_together_threshold_minutes_check CHECK (((group_together_threshold_minutes >= 0) AND (group_together_threshold_minutes <= 240))),
    CONSTRAINT salons_milestone_reward_type_check CHECK ((milestone_reward_type = ANY (ARRAY['none'::text, 'percent'::text, 'amount'::text]))),
    CONSTRAINT salons_noshow_deposit_escalation_threshold_check CHECK (((noshow_deposit_escalation_threshold IS NULL) OR ((noshow_deposit_escalation_threshold >= 1) AND (noshow_deposit_escalation_threshold <= 10)))),
    CONSTRAINT salons_owner_notification_channel_check CHECK ((owner_notification_channel = ANY (ARRAY['email'::text, 'sms'::text, 'both'::text]))),
    CONSTRAINT salons_payment_provider_check CHECK ((payment_provider = ANY (ARRAY['square'::text, 'stripe'::text]))),
    CONSTRAINT salons_plan_override_check CHECK ((plan_override = ANY (ARRAY['free'::text, 'pro'::text, 'premium'::text]))),
    CONSTRAINT salons_primary_grid_axis_check CHECK ((primary_grid_axis = ANY (ARRAY['staff'::text, 'resource'::text]))),
    CONSTRAINT salons_queue_display_mode_check CHECK ((queue_display_mode = ANY (ARRAY['full'::text, 'simple'::text]))),
    CONSTRAINT salons_subscription_plan_check CHECK ((subscription_plan = ANY (ARRAY['free'::text, 'pro'::text, 'premium'::text]))),
    CONSTRAINT salons_subscription_status_check CHECK ((subscription_status = ANY (ARRAY['active'::text, 'trialing'::text, 'past_due'::text, 'canceled'::text]))),
    CONSTRAINT salons_theme_mode_check CHECK ((theme_mode = ANY (ARRAY['dark'::text, 'light'::text]))),
    CONSTRAINT salons_verification_risk_threshold_deposit_check CHECK (((verification_risk_threshold_deposit >= 0) AND (verification_risk_threshold_deposit <= 100))),
    CONSTRAINT salons_verification_risk_threshold_otp_check CHECK (((verification_risk_threshold_otp >= 0) AND (verification_risk_threshold_otp <= 100))),
    CONSTRAINT salons_voice_ai_persona_voice_check CHECK ((voice_ai_persona_voice = ANY (ARRAY['alloy'::text, 'ash'::text, 'ballad'::text, 'cedar'::text, 'coral'::text, 'echo'::text, 'fable'::text, 'marin'::text, 'nova'::text, 'onyx'::text, 'sage'::text, 'shimmer'::text, 'verse'::text]))),
    CONSTRAINT salons_voice_ai_reasoning_effort_check CHECK ((voice_ai_reasoning_effort = ANY (ARRAY['minimal'::text, 'low'::text, 'medium'::text, 'high'::text, 'xhigh'::text])))
);


--
-- Name: COLUMN salons.booking_closed_dates; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.salons.booking_closed_dates IS 'Salon-specific dates with no booking (YYYY-MM-DD strings, local day).';


--
-- Name: COLUMN salons.timezone; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.salons.timezone IS 'IANA zone id for Receptionist grid + date picker (stored times remain UTC).';


--
-- Name: COLUMN salons.dashboard_density; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.salons.dashboard_density IS 'UI density preference for the receptionist desk. simple=less chrome / larger spacing; balanced=current default; pro=tighter spacing / more labels. Orthogonal to dashboard_preset + dashboard_modules.';


--
-- Name: COLUMN salons.walkin_auto_assign; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.salons.walkin_auto_assign IS 'TRUE = receptionist''s "Assign immediately" path is enabled. When a walk-in is added and the chosen staff is isAvailableNow, the booking is created confirmed at start_time = now(). FALSE = every walk-in lands in status=waiting first; the receptionist must manually assign from the queue panel even when staff is free.';


--
-- Name: COLUMN salons.phone_otp_enabled; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.salons.phone_otp_enabled IS 'When true, public booking flow requires SMS OTP to verify the customer phone.';


--
-- Name: COLUMN salons.reminders_enabled; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.salons.reminders_enabled IS 'Master switch for automated reminder emails.';


--
-- Name: COLUMN salons.reminder_24h_enabled; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.salons.reminder_24h_enabled IS 'Send reminder 24 h before appointment.';


--
-- Name: COLUMN salons.reminder_3h_enabled; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.salons.reminder_3h_enabled IS 'Send reminder 3 h before appointment.';


--
-- Name: COLUMN salons.deposit_high_value_cents; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.salons.deposit_high_value_cents IS 'Service price ≥ this triggers a deposit. Default $100.';


--
-- Name: COLUMN salons.booking_verification_mode; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.salons.booking_verification_mode IS 'auto=smart risk-based, always_otp=force OTP, always_deposit=force deposit, deposit_first=deposit then OTP, never=no friction';


--
-- Name: COLUMN salons.verification_risk_threshold_otp; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.salons.verification_risk_threshold_otp IS 'In auto mode: risk >= this triggers optional OTP (default 30)';


--
-- Name: COLUMN salons.verification_risk_threshold_deposit; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.salons.verification_risk_threshold_deposit IS 'In auto mode: risk >= this triggers required deposit (default 70)';


--
-- Name: COLUMN salons.basic_mode_forced; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.salons.basic_mode_forced IS 'When true, receptionist auto-enables Basic Mode (localStorage) on login';


--
-- Name: COLUMN salons.vertical; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.salons.vertical IS 'Business vertical slug (nail_salon | head_spa | …). Drives schema.org type, AI prompt descriptors, staff-role label, hero tagline, and seed catalogue via src/shared/verticals/registry.ts. Unknown values fall back to nail_salon.';


--
-- Name: COLUMN salons.public_sections_enabled; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.salons.public_sections_enabled IS 'When true, the salon''s visible salon_page_sections render on the public booking page (/[slug]) above the booking flow. Default false.';


--
-- Name: COLUMN salons.booking_images; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.salons.booking_images IS 'Optional {hero, thumbA, thumbB} base image URLs for the public booking page hero/ambient. Overrides the vertical default (resolveVertical().bookingImagery).';


--
-- Name: COLUMN salons.staff_selection_enabled; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.salons.staff_selection_enabled IS 'When false, customers do not pick a provider — the booking wizard hides the staff step and auto-assigns (Any). Default true.';


--
-- Name: COLUMN salons.booking_lead_minutes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.salons.booking_lead_minutes IS 'Minimum lead time (minutes) for same-day online bookings — slots starting sooner than now()+this are hidden. Default 15.';


--
-- Name: COLUMN salons.reference_image_enabled; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.salons.reference_image_enabled IS 'Override for the booking reference-image upload. NULL = vertical default (nail on, head_spa off).';


--
-- Name: COLUMN salons.auto_no_show_minutes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.salons.auto_no_show_minutes IS 'Opt-in auto no-show: minutes past start before a still-confirmed booking is auto-marked no_show. NULL/0 = disabled.';


--
-- Name: COLUMN salons.winback_enabled; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.salons.winback_enabled IS 'When true, a no-show triggers a friendly win-back/rebook email to the guest. Default true.';


--
-- Name: COLUMN salons.stripe_connect_account_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.salons.stripe_connect_account_id IS 'Stripe Connect (Express) account id (acct_…) for this salon; deposits are charged on it.';


--
-- Name: COLUMN salons.stripe_connect_charges_enabled; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.salons.stripe_connect_charges_enabled IS 'Mirror of Stripe account.charges_enabled — true once the salon can accept charges.';


--
-- Name: COLUMN salons.deposit_pct_no_show; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.salons.deposit_pct_no_show IS 'Deposit % of service price required for a repeat-no-show customer. Default 50.';


--
-- Name: COLUMN salons.group_together_threshold_minutes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.salons.group_together_threshold_minutes IS 'Group booking "togetherness" threshold (minutes): members within this spread are treated as arriving together. Default 30.';


--
-- Name: COLUMN salons.payment_provider; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.salons.payment_provider IS 'Customer-payment provider: square | stripe (null = not chosen). All money flows use this. Lock after first saved card.';


--
-- Name: COLUMN salons.noshow_protection_enabled; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.salons.noshow_protection_enabled IS 'No-show protection on/off (provider-agnostic).';


--
-- Name: COLUMN salons.client_segment_settings; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.salons.client_segment_settings IS 'Clients lifecycle thresholds: {"new_max_visits":1,"at_risk_days":60}. NULL = app defaults.';


--
-- Name: COLUMN salons.deposit_hold_grace_minutes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.salons.deposit_hold_grace_minutes IS 'Minutes a deposit-held slot waits for payment before the release-pending cron cancels it. Admin-set, default 30.';


--
-- Name: COLUMN salons.cancellation_policy; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.salons.cancellation_policy IS 'Admin-editable cancellation/no-show/deposit policy, bilingual { en, vi }. Shown at /[slug]/policy and linked from the booking consent + confirmation email.';


--
-- Name: COLUMN salons.health_ack_required; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.salons.health_ack_required IS 'Override the per-vertical health-acknowledgment default (NULL = vertical default).';


--
-- Name: COLUMN salons.email_links_enabled; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.salons.email_links_enabled IS 'When true (default), desk-sent links (save-card / deposit / waitlist invite) are also emailed to the customer when an email is on file, alongside the SMS. Resilient fallback for US A2P 10DLC SMS link filtering.';


--
-- Name: COLUMN salons.noshow_group_whole_party; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.salons.noshow_group_whole_party IS 'When true (default), a group organizer''s card-on-file no-show fee is a % of the WHOLE party total (one card protects the whole group). When false, only the organizer''s own service.';


--
-- Name: COLUMN salons.noshow_deposit_escalation_threshold; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.salons.noshow_deposit_escalation_threshold IS 'Prior-no-show count that escalates a customer from card-on-file to upfront pay-to-confirm deposit. NULL = escalation off (opt-in).';


--
-- Name: COLUMN salons.noshow_require_new_customer; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.salons.noshow_require_new_customer IS 'Ask first-time customers to leave a card (default true).';


--
-- Name: COLUMN salons.noshow_require_prior_noshow; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.salons.noshow_require_prior_noshow IS 'Ask customers with prior no-shows to leave a card (default true).';


--
-- Name: COLUMN salons.noshow_min_noshow_count; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.salons.noshow_min_noshow_count IS 'How many prior no-shows trigger the card requirement (default 1).';


--
-- Name: COLUMN salons.noshow_require_high_risk; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.salons.noshow_require_high_risk IS 'Ask high AI-risk bookings to leave a card (default true).';


--
-- Name: COLUMN salons.vip_spend_tiers; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.salons.vip_spend_tiers IS 'VIP spend tier thresholds in cents: {"gold":N,"silver":N,"bronze":N}. A customer''s lifetime Square spend >= a threshold earns that tier. NULL -> code defaults (gold $1000 / silver $500 / bronze $200).';


--
-- Name: COLUMN salons.ai_profile; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.salons.ai_profile IS 'SalonIntelligenceProfile — AI Manager configuration built via Manager Briefing';


--
-- Name: COLUMN salons.owner_notification_channel; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.salons.owner_notification_channel IS 'How the AI Manager delivers alerts to owner: email | sms | both';


--
-- Name: COLUMN salons.owner_phone; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.salons.owner_phone IS 'Owner SMS number in E.164 format (+16045550100); used by daily reports + ACT+UNDO';


--
-- Name: COLUMN salons.google_place_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.salons.google_place_id IS 'Google Maps Place ID (e.g. ChIJN1t_tDeuEmsRUsoyG83frY4). Used by Review Responder to poll new reviews via Google Places API.';


--
-- Name: COLUMN salons.self_cancel_window_hours; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.salons.self_cancel_window_hours IS 'Hours before appointment start within which a customer self-cancel counts as a late cancel (fee-eligible). Default 24.';


--
-- Name: COLUMN salons.self_cancel_fee_enabled; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.salons.self_cancel_fee_enabled IS 'When true, a late self-cancel on a booking with a saved card + consent is charged the no-show fee %. Default off (opt-in).';


--
-- Name: COLUMN salons.self_cancel_fee_percent; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.salons.self_cancel_fee_percent IS 'Late self-cancel fee percent. NULL = use noshow_fee_percent. When set, scales the no-show fee snapshot for late cancellations only.';


--
-- Name: COLUMN salons.birthday_reward_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.salons.birthday_reward_type IS 'AI VIP Care birthday gift: none | percent | amount. When not none, the birthday email attaches a voucher.';


--
-- Name: COLUMN salons.milestone_reward_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.salons.milestone_reward_type IS 'AI VIP Care milestone gift (10/25/50 visits): none | percent | amount. When not none, the milestone email attaches a voucher.';


--
-- Name: scheduled_notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scheduled_notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    salon_id uuid NOT NULL,
    booking_id uuid NOT NULL,
    event text NOT NULL,
    channels jsonb NOT NULL,
    send_after timestamp with time zone DEFAULT now() NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_at timestamp with time zone,
    CONSTRAINT scheduled_notifications_event_check CHECK ((event = ANY (ARRAY['create'::text, 'reschedule'::text, 'cancel'::text]))),
    CONSTRAINT scheduled_notifications_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sent'::text, 'cancelled'::text, 'failed'::text])))
);


--
-- Name: service_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.service_categories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    name_en text NOT NULL,
    name_vi text NOT NULL,
    sort_order integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    deleted_at timestamp with time zone
);


--
-- Name: service_combos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.service_combos (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    salon_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    service_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    price_cents integer DEFAULT 0 NOT NULL,
    discount_cents integer DEFAULT 0 NOT NULL,
    duration_minutes integer DEFAULT 60 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: services; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.services (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    salon_id uuid NOT NULL,
    name text NOT NULL,
    price_cents integer NOT NULL,
    duration_minutes integer NOT NULL,
    buffer_minutes integer DEFAULT 10 NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    deleted_at timestamp with time zone,
    category text DEFAULT 'other'::text,
    description text,
    is_popular boolean DEFAULT false NOT NULL,
    is_featured boolean DEFAULT false NOT NULL,
    wix_service_id text,
    wix_schedule_id text,
    price_type text DEFAULT 'fixed'::text NOT NULL,
    price_max_cents integer,
    is_addon boolean DEFAULT false NOT NULL,
    addon_timing text DEFAULT 'sequential'::text NOT NULL,
    square_catalog_item_id text,
    CONSTRAINT services_addon_timing_check CHECK ((addon_timing = ANY (ARRAY['concurrent'::text, 'sequential'::text]))),
    CONSTRAINT services_price_type_check CHECK ((price_type = ANY (ARRAY['fixed'::text, 'from'::text, 'range'::text])))
);


--
-- Name: COLUMN services.description; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.services.description IS 'One-line marketing description shown under the service name on the public booking page. Recommended <=100 chars; enforced in the app layer (addService/updateService).';


--
-- Name: COLUMN services.is_popular; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.services.is_popular IS 'When true, the public booking page renders a small "Popular" badge on this service. Owner-toggled from the setup wizard.';


--
-- Name: COLUMN services.is_featured; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.services.is_featured IS 'When true, the public booking page renders this service in a larger, subtly-glowing tile. Reserved for hero services.';


--
-- Name: COLUMN services.is_addon; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.services.is_addon IS 'When true, the service is an add-on: excluded from the main service picker, suggested only as an upsell on the booking review step.';


--
-- Name: COLUMN services.addon_timing; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.services.addon_timing IS 'Add-on scheduling: concurrent = runs alongside the main service (+0 time), sequential = runs after (adds duration). Only used when is_addon.';


--
-- Name: square_integrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.square_integrations (
    salon_id uuid NOT NULL,
    merchant_id text NOT NULL,
    location_id text NOT NULL,
    access_token text,
    enabled boolean DEFAULT true NOT NULL,
    cursor_synced_at timestamp with time zone DEFAULT now() NOT NULL,
    last_run_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deposit_enabled boolean DEFAULT false NOT NULL,
    deposit_percent integer DEFAULT 30 NOT NULL,
    deposit_risk_threshold integer DEFAULT 60 NOT NULL,
    application_id text,
    environment text DEFAULT 'production'::text NOT NULL,
    reverse_create_enabled boolean DEFAULT false NOT NULL,
    sync_pull_create boolean DEFAULT true NOT NULL,
    sync_pull_update boolean DEFAULT true NOT NULL,
    sync_pull_cancel boolean DEFAULT true NOT NULL,
    sync_push_create boolean DEFAULT false NOT NULL,
    sync_push_update boolean DEFAULT false NOT NULL,
    sync_push_cancel boolean DEFAULT false NOT NULL
);


--
-- Name: COLUMN square_integrations.deposit_percent; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.square_integrations.deposit_percent IS 'Deposit = round(service price * this%)';


--
-- Name: COLUMN square_integrations.deposit_risk_threshold; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.square_integrations.deposit_risk_threshold IS 'Require a deposit only when booking.no_show_risk_score >= this (0-100)';


--
-- Name: square_visit_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.square_visit_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    salon_id uuid NOT NULL,
    client_profile_id uuid,
    square_customer_id text NOT NULL,
    square_payment_id text NOT NULL,
    square_created_at timestamp with time zone NOT NULL,
    visit_date date NOT NULL,
    amount_cents integer DEFAULT 0 NOT NULL,
    order_id text,
    service_names text[],
    synced_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: staff; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    salon_id uuid NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    job_role text DEFAULT 'nail_tech'::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    deleted_at timestamp with time zone,
    wix_resource_id text,
    user_id uuid,
    square_team_member_id text,
    CONSTRAINT staff_job_role_check CHECK ((job_role = ANY (ARRAY['owner'::text, 'senior'::text, 'nail_tech'::text]))),
    CONSTRAINT staff_status_check CHECK ((status = ANY (ARRAY['active'::text, 'pending'::text, 'inactive'::text])))
);


--
-- Name: COLUMN staff.job_role; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.staff.job_role IS 'Display/station role for booking UX: owner, senior, nail_tech (not auth membership role).';


--
-- Name: COLUMN staff.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.staff.status IS 'active=visible to customers; pending=owner-added but not yet verified; inactive=on leave / disabled.';


--
-- Name: COLUMN staff.user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.staff.user_id IS 'Optional login account (auth.users) for this team member. NULL = booking-only provider with no dashboard access. Permission level lives in salon_members.role.';


--
-- Name: staff_services; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_services (
    staff_id uuid NOT NULL,
    service_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE staff_services; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.staff_services IS 'Per-staff capability whitelist. Empty for a salon == all-capable (see app fallback).';


--
-- Name: staff_shifts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_shifts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    staff_id uuid NOT NULL,
    salon_id uuid NOT NULL,
    day_of_week text NOT NULL,
    start_time text NOT NULL,
    end_time text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT staff_shifts_day_of_week_check CHECK ((day_of_week = ANY (ARRAY['mon'::text, 'tue'::text, 'wed'::text, 'thu'::text, 'fri'::text, 'sat'::text, 'sun'::text]))),
    CONSTRAINT staff_shifts_end_time_check CHECK ((end_time ~ '^\d{2}:\d{2}$'::text)),
    CONSTRAINT staff_shifts_start_time_check CHECK ((start_time ~ '^\d{2}:\d{2}$'::text))
);


--
-- Name: TABLE staff_shifts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.staff_shifts IS 'Recurring weekly shift schedule per staff member. Salons with no rows use full salon opening hours (backward-compat).';


--
-- Name: staff_unavailability; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_unavailability (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    staff_id uuid NOT NULL,
    salon_id uuid NOT NULL,
    date date NOT NULL,
    reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE staff_unavailability; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.staff_unavailability IS 'One-off blocked dates per staff member (PTO, sick day, training).';


--
-- Name: superadmin_audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.superadmin_audit_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    actor_user_id uuid,
    actor_role text NOT NULL,
    action text NOT NULL,
    target_kind text,
    target_id uuid,
    before_jsonb jsonb,
    after_jsonb jsonb,
    reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE superadmin_audit_logs; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.superadmin_audit_logs IS 'Append-only audit trail for /superadmin/* mutations + impersonation. PERMISSION_MATRIX.md §8.5 requires audit-or-rollback.';


--
-- Name: COLUMN superadmin_audit_logs.action; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.superadmin_audit_logs.action IS 'Action verb: impersonate_enter, impersonate_exit, flag_set, flag_unset, announcement_publish, announcement_expire, salon_lock, salon_unlock, plan_override_set, feature_flag_set. Unknown values accepted.';


--
-- Name: COLUMN superadmin_audit_logs.target_kind; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.superadmin_audit_logs.target_kind IS 'Polymorphic: salon, user, flag, announcement. NULL for session-level events.';


--
-- Name: COLUMN superadmin_audit_logs.reason; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.superadmin_audit_logs.reason IS 'Required for impersonation (PERMISSION_MATRIX.md §8.4); optional elsewhere.';


--
-- Name: superadmins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.superadmins (
    user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    role text DEFAULT 'founder'::text NOT NULL,
    revoked_at timestamp with time zone,
    created_by uuid,
    CONSTRAINT superadmins_role_check CHECK ((role = ANY (ARRAY['founder'::text, 'ops_admin'::text, 'support_admin'::text, 'billing_admin'::text, 'ai_admin'::text, 'readonly_analyst'::text])))
);


--
-- Name: COLUMN superadmins.role; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.superadmins.role IS 'Platform-scoped role (PERMISSION_MATRIX.md §8.2). Defaults to founder so PR #82 rows backfill.';


--
-- Name: COLUMN superadmins.revoked_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.superadmins.revoked_at IS 'Soft delete. Non-null rows are inert — getSuperadminRole returns null.';


--
-- Name: COLUMN superadmins.created_by; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.superadmins.created_by IS 'Audit — which superadmin promoted this row. NULL if seeded out-of-band.';


--
-- Name: system_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.system_audit (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    salon_id uuid,
    table_name text NOT NULL,
    entity_id text,
    action text NOT NULL,
    actor_user_id uuid,
    changed_fields jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: tax_presets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tax_presets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    timezone text NOT NULL,
    label text NOT NULL,
    tax_lines jsonb DEFAULT '[]'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: user_presence; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_presence (
    user_id uuid NOT NULL,
    salon_id uuid NOT NULL,
    ip_address text,
    user_agent text,
    device_type text,
    browser text,
    current_path text,
    battery_level integer,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_presence_battery_level_check CHECK (((battery_level >= 0) AND (battery_level <= 100)))
);


--
-- Name: voice_ai_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.voice_ai_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    salon_id uuid NOT NULL,
    openai_session_id text,
    status text DEFAULT 'active'::text NOT NULL,
    language text DEFAULT 'vi'::text NOT NULL,
    duration_seconds integer DEFAULT 0 NOT NULL,
    booking_id uuid,
    upsell_accepted boolean DEFAULT false,
    transcript jsonb DEFAULT '[]'::jsonb NOT NULL,
    estimated_cost_usd numeric(8,4) DEFAULT 0,
    client_phone text,
    client_name text,
    service_changed boolean DEFAULT false,
    time_changed boolean DEFAULT false,
    error_message text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT voice_ai_sessions_language_check CHECK ((language = ANY (ARRAY['vi'::text, 'en'::text, 'fr'::text, 'zh'::text]))),
    CONSTRAINT voice_ai_sessions_status_check CHECK ((status = ANY (ARRAY['active'::text, 'completed'::text, 'failed'::text, 'abandoned'::text])))
);


--
-- Name: voucher_redemptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.voucher_redemptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    voucher_id uuid NOT NULL,
    salon_id uuid NOT NULL,
    booking_id uuid,
    client_phone text NOT NULL,
    discount_applied_cents integer NOT NULL,
    original_price_cents integer,
    final_price_cents integer,
    redeemed_at timestamp with time zone DEFAULT now() NOT NULL,
    redeemed_by_user_id uuid
);


--
-- Name: TABLE voucher_redemptions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.voucher_redemptions IS 'Append-only log of voucher usage. Updates vouchers.used_count via trigger.';


--
-- Name: vouchers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vouchers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    salon_id uuid NOT NULL,
    code text NOT NULL,
    kind text NOT NULL,
    client_phone text,
    client_profile_id uuid,
    amount_off_cents integer,
    percent_off smallint,
    free_service_id uuid,
    min_spend_cents integer DEFAULT 0,
    applicable_service_ids uuid[],
    applicable_service_category text,
    max_uses integer DEFAULT 1 NOT NULL,
    used_count integer DEFAULT 0 NOT NULL,
    valid_from timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    revoked_reason text,
    created_by_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    gift_card_value_cents integer,
    gift_card_from_name text,
    gift_card_message text,
    gift_card_purchaser_phone text,
    gift_card_stripe_payment_intent_id text,
    CONSTRAINT vouchers_amount_off_cents_check CHECK (((amount_off_cents IS NULL) OR (amount_off_cents > 0))),
    CONSTRAINT vouchers_has_discount CHECK (((amount_off_cents IS NOT NULL) OR (percent_off IS NOT NULL) OR (free_service_id IS NOT NULL))),
    CONSTRAINT vouchers_kind_check CHECK ((kind = ANY (ARRAY['birthday'::text, 'welcome_back'::text, 'referral_reward'::text, 'promo'::text, 'gift'::text, 'milestone'::text, 'reoptin'::text]))),
    CONSTRAINT vouchers_max_uses_check CHECK ((max_uses >= 1)),
    CONSTRAINT vouchers_percent_off_check CHECK (((percent_off IS NULL) OR ((percent_off > 0) AND (percent_off <= 100))))
);


--
-- Name: TABLE vouchers; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.vouchers IS 'Discount codes: birthday, welcome-back, referral reward, manual promo. Code unique per salon.';


--
-- Name: COLUMN vouchers.client_phone; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.vouchers.client_phone IS 'NULL = open promo code anyone can use. Set = personal voucher tied to this phone.';


--
-- Name: COLUMN vouchers.max_uses; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.vouchers.max_uses IS '1 = single-use (default for personal vouchers). >1 = multi-use promo (e.g. MOTHERSDAY10).';


--
-- Name: COLUMN vouchers.gift_card_value_cents; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.vouchers.gift_card_value_cents IS 'Original loaded value of the gift card (kind=gift). amount_off_cents tracks remaining balance.';


--
-- Name: COLUMN vouchers.gift_card_from_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.vouchers.gift_card_from_name IS 'Sender name on the gift card';


--
-- Name: COLUMN vouchers.gift_card_message; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.vouchers.gift_card_message IS 'Personal message on the gift card';


--
-- Name: COLUMN vouchers.gift_card_purchaser_phone; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.vouchers.gift_card_purchaser_phone IS 'Phone of person who purchased the gift card';


--
-- Name: COLUMN vouchers.gift_card_stripe_payment_intent_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.vouchers.gift_card_stripe_payment_intent_id IS 'Stripe PaymentIntent for the gift card purchase';


--
-- Name: watchdog_alerts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.watchdog_alerts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    salon_id uuid,
    kind text NOT NULL,
    severity text NOT NULL,
    title text NOT NULL,
    body text,
    dedupe_key text,
    snapshot jsonb,
    acknowledged_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: watchdog_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.watchdog_state (
    salon_id uuid NOT NULL,
    last_run_at timestamp with time zone
);


--
-- Name: website_import_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.website_import_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    salon_id uuid NOT NULL,
    source_url text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    progress integer DEFAULT 0 NOT NULL,
    result jsonb,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT website_import_jobs_progress_check CHECK (((progress >= 0) AND (progress <= 100))),
    CONSTRAINT website_import_jobs_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'scraping'::text, 'extracting'::text, 'building'::text, 'done'::text, 'failed'::text])))
);


--
-- Name: winback_suggestions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.winback_suggestions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    salon_id uuid,
    client_phone text,
    client_name text,
    client_email text,
    last_visit timestamp with time zone,
    visit_count integer,
    lang text,
    channel text,
    message text,
    status text DEFAULT 'suggested'::text NOT NULL,
    sent_at timestamp with time zone,
    dismissed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    kind text DEFAULT 'lapsed'::text NOT NULL
);


--
-- Name: wix_integrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wix_integrations (
    salon_id uuid NOT NULL,
    site_id text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    cursor_updated_date timestamp with time zone DEFAULT now() NOT NULL,
    last_run_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    auto_approve boolean DEFAULT true NOT NULL,
    wix_location_id text,
    wix_default_resource_id text,
    webhook_url text,
    webhook_id text,
    webhook_registered_at timestamp with time zone,
    webhook_last_received_at timestamp with time zone,
    wix_api_key text,
    wix_webhook_public_key text
);


--
-- Name: COLUMN wix_integrations.webhook_url; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.wix_integrations.webhook_url IS 'URL Wix posts booking events to';


--
-- Name: COLUMN wix_integrations.webhook_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.wix_integrations.webhook_id IS 'Wix webhook subscription ID for management';


--
-- Name: COLUMN wix_integrations.webhook_last_received_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.wix_integrations.webhook_last_received_at IS 'Set on each real-time webhook receipt — useful for monitoring lag vs polling';


--
-- Name: ai_actions_log ai_actions_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_actions_log
    ADD CONSTRAINT ai_actions_log_pkey PRIMARY KEY (id);


--
-- Name: ai_chats ai_chats_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_chats
    ADD CONSTRAINT ai_chats_pkey PRIMARY KEY (id);


--
-- Name: ai_chats ai_chats_salon_id_session_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_chats
    ADD CONSTRAINT ai_chats_salon_id_session_id_key UNIQUE (salon_id, session_id);


--
-- Name: ai_policy_decisions ai_policy_decisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_policy_decisions
    ADD CONSTRAINT ai_policy_decisions_pkey PRIMARY KEY (id);


--
-- Name: ai_trend_cache ai_trend_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_trend_cache
    ADD CONSTRAINT ai_trend_cache_pkey PRIMARY KEY (id);


--
-- Name: ai_trend_cache ai_trend_cache_salon_id_period_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_trend_cache
    ADD CONSTRAINT ai_trend_cache_salon_id_period_key UNIQUE (salon_id, period);


--
-- Name: ai_upsell_log ai_upsell_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_upsell_log
    ADD CONSTRAINT ai_upsell_log_pkey PRIMARY KEY (id);


--
-- Name: approval_requests approval_requests_approve_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approval_requests
    ADD CONSTRAINT approval_requests_approve_token_key UNIQUE (approve_token);


--
-- Name: approval_requests approval_requests_decline_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approval_requests
    ADD CONSTRAINT approval_requests_decline_token_key UNIQUE (decline_token);


--
-- Name: approval_requests approval_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approval_requests
    ADD CONSTRAINT approval_requests_pkey PRIMARY KEY (id);


--
-- Name: auth_events auth_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_events
    ADD CONSTRAINT auth_events_pkey PRIMARY KEY (id);


--
-- Name: booking_addons booking_addons_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking_addons
    ADD CONSTRAINT booking_addons_pkey PRIMARY KEY (id);


--
-- Name: booking_events booking_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking_events
    ADD CONSTRAINT booking_events_pkey PRIMARY KEY (id);


--
-- Name: booking_notifications booking_notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking_notifications
    ADD CONSTRAINT booking_notifications_pkey PRIMARY KEY (id);


--
-- Name: booking_notifications booking_notifications_twilio_message_sid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking_notifications
    ADD CONSTRAINT booking_notifications_twilio_message_sid_key UNIQUE (twilio_message_sid);


--
-- Name: booking_photos booking_photos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking_photos
    ADD CONSTRAINT booking_photos_pkey PRIMARY KEY (id);


--
-- Name: booking_reminder_tokens booking_reminder_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking_reminder_tokens
    ADD CONSTRAINT booking_reminder_tokens_pkey PRIMARY KEY (id);


--
-- Name: booking_waitlist_entries booking_waitlist_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking_waitlist_entries
    ADD CONSTRAINT booking_waitlist_entries_pkey PRIMARY KEY (id);


--
-- Name: bookings bookings_no_overlap; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_no_overlap EXCLUDE USING gist (salon_id WITH =, staff_id WITH =, tstzrange(start_time_utc, end_time_utc, '[)'::text) WITH &&) WHERE ((status <> ALL (ARRAY['cancelled'::text, 'no_show'::text, 'completed'::text])));


--
-- Name: bookings bookings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_pkey PRIMARY KEY (id);


--
-- Name: bookings bookings_resource_no_overlap; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_resource_no_overlap EXCLUDE USING gist (salon_id WITH =, resource_id WITH =, tstzrange(start_time_utc, end_time_utc, '[)'::text) WITH &&) WHERE (((resource_id IS NOT NULL) AND (status <> ALL (ARRAY['cancelled'::text, 'no_show'::text]))));


--
-- Name: campaign_schedules campaign_schedules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_schedules
    ADD CONSTRAINT campaign_schedules_pkey PRIMARY KEY (id);


--
-- Name: client_ai_summaries client_ai_summaries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_ai_summaries
    ADD CONSTRAINT client_ai_summaries_pkey PRIMARY KEY (salon_id, client_profile_id);


--
-- Name: client_email_optouts client_email_optouts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_email_optouts
    ADD CONSTRAINT client_email_optouts_pkey PRIMARY KEY (email);


--
-- Name: client_profiles client_profiles_phone_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_profiles
    ADD CONSTRAINT client_profiles_phone_key UNIQUE (phone);


--
-- Name: client_profiles client_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_profiles
    ADD CONSTRAINT client_profiles_pkey PRIMARY KEY (id);


--
-- Name: customer_booking_patterns customer_booking_patterns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_booking_patterns
    ADD CONSTRAINT customer_booking_patterns_pkey PRIMARY KEY (id);


--
-- Name: customer_booking_patterns customer_booking_patterns_salon_id_client_phone_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_booking_patterns
    ADD CONSTRAINT customer_booking_patterns_salon_id_client_phone_key UNIQUE (salon_id, client_phone);


--
-- Name: customer_photo_consents customer_photo_consents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_photo_consents
    ADD CONSTRAINT customer_photo_consents_pkey PRIMARY KEY (id);


--
-- Name: customer_photo_consents customer_photo_consents_salon_id_client_phone_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_photo_consents
    ADD CONSTRAINT customer_photo_consents_salon_id_client_phone_key UNIQUE (salon_id, client_phone);


--
-- Name: customer_preferences customer_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_preferences
    ADD CONSTRAINT customer_preferences_pkey PRIMARY KEY (client_profile_id);


--
-- Name: email_otp_codes email_otp_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_otp_codes
    ADD CONSTRAINT email_otp_codes_pkey PRIMARY KEY (id);


--
-- Name: email_verification_tokens email_verification_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_verification_tokens
    ADD CONSTRAINT email_verification_tokens_pkey PRIMARY KEY (id);


--
-- Name: email_verification_tokens email_verification_tokens_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_verification_tokens
    ADD CONSTRAINT email_verification_tokens_token_key UNIQUE (token);


--
-- Name: error_logs error_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.error_logs
    ADD CONSTRAINT error_logs_pkey PRIMARY KEY (id);


--
-- Name: first_visit_sequences first_visit_sequences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.first_visit_sequences
    ADD CONSTRAINT first_visit_sequences_pkey PRIMARY KEY (id);


--
-- Name: loyalty_cards loyalty_cards_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.loyalty_cards
    ADD CONSTRAINT loyalty_cards_pkey PRIMARY KEY (id);


--
-- Name: loyalty_cards loyalty_cards_salon_id_client_phone_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.loyalty_cards
    ADD CONSTRAINT loyalty_cards_salon_id_client_phone_key UNIQUE (salon_id, client_phone);


--
-- Name: loyalty_programs loyalty_programs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.loyalty_programs
    ADD CONSTRAINT loyalty_programs_pkey PRIMARY KEY (id);


--
-- Name: loyalty_programs loyalty_programs_salon_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.loyalty_programs
    ADD CONSTRAINT loyalty_programs_salon_id_key UNIQUE (salon_id);


--
-- Name: loyalty_stamp_events loyalty_stamp_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.loyalty_stamp_events
    ADD CONSTRAINT loyalty_stamp_events_pkey PRIMARY KEY (id);


--
-- Name: minh_lessons minh_lessons_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.minh_lessons
    ADD CONSTRAINT minh_lessons_pkey PRIMARY KEY (id);


--
-- Name: notification_templates notification_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_templates
    ADD CONSTRAINT notification_templates_pkey PRIMARY KEY (template_key, locale, channel);


--
-- Name: otp_send_log otp_send_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.otp_send_log
    ADD CONSTRAINT otp_send_log_pkey PRIMARY KEY (id);


--
-- Name: otps otps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.otps
    ADD CONSTRAINT otps_pkey PRIMARY KEY (id);


--
-- Name: party_link_change_requests party_link_change_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.party_link_change_requests
    ADD CONSTRAINT party_link_change_requests_pkey PRIMARY KEY (id);


--
-- Name: party_link_claims party_link_claims_booking_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.party_link_claims
    ADD CONSTRAINT party_link_claims_booking_id_key UNIQUE (booking_id);


--
-- Name: party_link_claims party_link_claims_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.party_link_claims
    ADD CONSTRAINT party_link_claims_pkey PRIMARY KEY (id);


--
-- Name: party_links party_links_group_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.party_links
    ADD CONSTRAINT party_links_group_id_key UNIQUE (group_id);


--
-- Name: party_links party_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.party_links
    ADD CONSTRAINT party_links_pkey PRIMARY KEY (id);


--
-- Name: party_links party_links_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.party_links
    ADD CONSTRAINT party_links_token_key UNIQUE (token);


--
-- Name: payment_disputes payment_disputes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_disputes
    ADD CONSTRAINT payment_disputes_pkey PRIMARY KEY (id);


--
-- Name: payment_disputes payment_disputes_provider_dispute_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_disputes
    ADD CONSTRAINT payment_disputes_provider_dispute_id_key UNIQUE (provider_dispute_id);


--
-- Name: phone_otp_sessions phone_otp_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.phone_otp_sessions
    ADD CONSTRAINT phone_otp_sessions_pkey PRIMARY KEY (id);


--
-- Name: platform_announcements platform_announcements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_announcements
    ADD CONSTRAINT platform_announcements_pkey PRIMARY KEY (id);


--
-- Name: platform_feature_flags platform_feature_flags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_feature_flags
    ADD CONSTRAINT platform_feature_flags_pkey PRIMARY KEY (key);


--
-- Name: platform_flags platform_flags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_flags
    ADD CONSTRAINT platform_flags_pkey PRIMARY KEY (key);


--
-- Name: platform_settings platform_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_settings
    ADD CONSTRAINT platform_settings_pkey PRIMARY KEY (id);


--
-- Name: promotion_services promotion_services_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promotion_services
    ADD CONSTRAINT promotion_services_pkey PRIMARY KEY (id);


--
-- Name: promotion_services promotion_services_promotion_id_service_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promotion_services
    ADD CONSTRAINT promotion_services_promotion_id_service_id_key UNIQUE (promotion_id, service_id);


--
-- Name: promotions promotions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promotions
    ADD CONSTRAINT promotions_pkey PRIMARY KEY (id);


--
-- Name: queue_entries queue_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.queue_entries
    ADD CONSTRAINT queue_entries_pkey PRIMARY KEY (id);


--
-- Name: rate_limits rate_limits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rate_limits
    ADD CONSTRAINT rate_limits_pkey PRIMARY KEY (bucket);


--
-- Name: referrals referrals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referrals
    ADD CONSTRAINT referrals_pkey PRIMARY KEY (id);


--
-- Name: referrals referrals_salon_id_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referrals
    ADD CONSTRAINT referrals_salon_id_code_key UNIQUE (salon_id, code);


--
-- Name: referrals referrals_salon_id_referee_phone_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referrals
    ADD CONSTRAINT referrals_salon_id_referee_phone_key UNIQUE (salon_id, referee_phone);


--
-- Name: register_completion_tokens register_completion_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.register_completion_tokens
    ADD CONSTRAINT register_completion_tokens_pkey PRIMARY KEY (id);


--
-- Name: register_completion_tokens register_completion_tokens_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.register_completion_tokens
    ADD CONSTRAINT register_completion_tokens_token_key UNIQUE (token);


--
-- Name: reoptin_sends reoptin_sends_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reoptin_sends
    ADD CONSTRAINT reoptin_sends_pkey PRIMARY KEY (id);


--
-- Name: reoptin_sends reoptin_sends_salon_id_client_profile_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reoptin_sends
    ADD CONSTRAINT reoptin_sends_salon_id_client_profile_id_key UNIQUE (salon_id, client_profile_id);


--
-- Name: reoptin_sends reoptin_sends_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reoptin_sends
    ADD CONSTRAINT reoptin_sends_token_key UNIQUE (token);


--
-- Name: reviews reviews_booking_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reviews
    ADD CONSTRAINT reviews_booking_id_key UNIQUE (booking_id);


--
-- Name: reviews reviews_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reviews
    ADD CONSTRAINT reviews_pkey PRIMARY KEY (id);


--
-- Name: reviews reviews_request_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reviews
    ADD CONSTRAINT reviews_request_token_key UNIQUE (request_token);


--
-- Name: salon_client_names salon_client_names_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salon_client_names
    ADD CONSTRAINT salon_client_names_pkey PRIMARY KEY (salon_id, phone);


--
-- Name: salon_client_spend salon_client_spend_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salon_client_spend
    ADD CONSTRAINT salon_client_spend_pkey PRIMARY KEY (salon_id, client_profile_id);


--
-- Name: salon_clients salon_clients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salon_clients
    ADD CONSTRAINT salon_clients_pkey PRIMARY KEY (id);


--
-- Name: salon_clients salon_clients_salon_id_client_profile_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salon_clients
    ADD CONSTRAINT salon_clients_salon_id_client_profile_id_key UNIQUE (salon_id, client_profile_id);


--
-- Name: salon_custom_domains salon_custom_domains_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salon_custom_domains
    ADD CONSTRAINT salon_custom_domains_pkey PRIMARY KEY (id);


--
-- Name: salon_invite_tokens salon_invite_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salon_invite_tokens
    ADD CONSTRAINT salon_invite_tokens_pkey PRIMARY KEY (id);


--
-- Name: salon_invite_tokens salon_invite_tokens_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salon_invite_tokens
    ADD CONSTRAINT salon_invite_tokens_token_key UNIQUE (token);


--
-- Name: salon_members salon_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salon_members
    ADD CONSTRAINT salon_members_pkey PRIMARY KEY (id);


--
-- Name: salon_members salon_members_salon_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salon_members
    ADD CONSTRAINT salon_members_salon_id_user_id_key UNIQUE (salon_id, user_id);


--
-- Name: salon_page_sections salon_page_sections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salon_page_sections
    ADD CONSTRAINT salon_page_sections_pkey PRIMARY KEY (id);


--
-- Name: salon_resources salon_resources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salon_resources
    ADD CONSTRAINT salon_resources_pkey PRIMARY KEY (id);


--
-- Name: salons salons_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salons
    ADD CONSTRAINT salons_pkey PRIMARY KEY (id);


--
-- Name: salons salons_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salons
    ADD CONSTRAINT salons_slug_key UNIQUE (slug);


--
-- Name: scheduled_notifications scheduled_notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduled_notifications
    ADD CONSTRAINT scheduled_notifications_pkey PRIMARY KEY (id);


--
-- Name: service_categories service_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_categories
    ADD CONSTRAINT service_categories_pkey PRIMARY KEY (id);


--
-- Name: service_categories service_categories_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_categories
    ADD CONSTRAINT service_categories_slug_key UNIQUE (slug);


--
-- Name: service_combos service_combos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_combos
    ADD CONSTRAINT service_combos_pkey PRIMARY KEY (id);


--
-- Name: services services_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.services
    ADD CONSTRAINT services_pkey PRIMARY KEY (id);


--
-- Name: square_integrations square_integrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.square_integrations
    ADD CONSTRAINT square_integrations_pkey PRIMARY KEY (salon_id);


--
-- Name: square_visit_history square_visit_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.square_visit_history
    ADD CONSTRAINT square_visit_history_pkey PRIMARY KEY (id);


--
-- Name: square_visit_history square_visit_history_salon_payment_uniq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.square_visit_history
    ADD CONSTRAINT square_visit_history_salon_payment_uniq UNIQUE (salon_id, square_payment_id);


--
-- Name: staff staff_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff
    ADD CONSTRAINT staff_pkey PRIMARY KEY (id);


--
-- Name: staff_services staff_services_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_services
    ADD CONSTRAINT staff_services_pkey PRIMARY KEY (staff_id, service_id);


--
-- Name: staff_shifts staff_shifts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_shifts
    ADD CONSTRAINT staff_shifts_pkey PRIMARY KEY (id);


--
-- Name: staff_shifts staff_shifts_staff_id_day_of_week_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_shifts
    ADD CONSTRAINT staff_shifts_staff_id_day_of_week_key UNIQUE (staff_id, day_of_week);


--
-- Name: staff_unavailability staff_unavailability_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_unavailability
    ADD CONSTRAINT staff_unavailability_pkey PRIMARY KEY (id);


--
-- Name: staff_unavailability staff_unavailability_staff_id_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_unavailability
    ADD CONSTRAINT staff_unavailability_staff_id_date_key UNIQUE (staff_id, date);


--
-- Name: superadmin_audit_logs superadmin_audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.superadmin_audit_logs
    ADD CONSTRAINT superadmin_audit_logs_pkey PRIMARY KEY (id);


--
-- Name: superadmins superadmins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.superadmins
    ADD CONSTRAINT superadmins_pkey PRIMARY KEY (user_id);


--
-- Name: system_audit system_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_audit
    ADD CONSTRAINT system_audit_pkey PRIMARY KEY (id);


--
-- Name: tax_presets tax_presets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tax_presets
    ADD CONSTRAINT tax_presets_pkey PRIMARY KEY (id);


--
-- Name: tax_presets tax_presets_timezone_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tax_presets
    ADD CONSTRAINT tax_presets_timezone_key UNIQUE (timezone);


--
-- Name: user_presence user_presence_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_presence
    ADD CONSTRAINT user_presence_pkey PRIMARY KEY (user_id);


--
-- Name: voice_ai_sessions voice_ai_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_ai_sessions
    ADD CONSTRAINT voice_ai_sessions_pkey PRIMARY KEY (id);


--
-- Name: voucher_redemptions voucher_redemptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voucher_redemptions
    ADD CONSTRAINT voucher_redemptions_pkey PRIMARY KEY (id);


--
-- Name: vouchers vouchers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vouchers
    ADD CONSTRAINT vouchers_pkey PRIMARY KEY (id);


--
-- Name: vouchers vouchers_salon_id_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vouchers
    ADD CONSTRAINT vouchers_salon_id_code_key UNIQUE (salon_id, code);


--
-- Name: watchdog_alerts watchdog_alerts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watchdog_alerts
    ADD CONSTRAINT watchdog_alerts_pkey PRIMARY KEY (id);


--
-- Name: watchdog_state watchdog_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watchdog_state
    ADD CONSTRAINT watchdog_state_pkey PRIMARY KEY (salon_id);


--
-- Name: website_import_jobs website_import_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.website_import_jobs
    ADD CONSTRAINT website_import_jobs_pkey PRIMARY KEY (id);


--
-- Name: winback_suggestions winback_suggestions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.winback_suggestions
    ADD CONSTRAINT winback_suggestions_pkey PRIMARY KEY (id);


--
-- Name: wix_integrations wix_integrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wix_integrations
    ADD CONSTRAINT wix_integrations_pkey PRIMARY KEY (salon_id);


--
-- Name: ai_actions_log_agent_salon; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_actions_log_agent_salon ON public.ai_actions_log USING btree (agent, salon_id, created_at DESC);


--
-- Name: ai_actions_log_outcome_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_actions_log_outcome_pending_idx ON public.ai_actions_log USING btree (salon_id, agent, action_type, created_at) WHERE (outcome IS NULL);


--
-- Name: ai_actions_log_salon_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_actions_log_salon_created ON public.ai_actions_log USING btree (salon_id, created_at DESC);


--
-- Name: ai_policy_decisions_salon_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_policy_decisions_salon_created_idx ON public.ai_policy_decisions USING btree (salon_id, created_at DESC);


--
-- Name: approval_requests_approve_token_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX approval_requests_approve_token_idx ON public.approval_requests USING btree (approve_token);


--
-- Name: approval_requests_decline_token_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX approval_requests_decline_token_idx ON public.approval_requests USING btree (decline_token);


--
-- Name: approval_requests_salon_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX approval_requests_salon_status_idx ON public.approval_requests USING btree (salon_id, status);


--
-- Name: auth_events_salon_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_events_salon_created_idx ON public.auth_events USING btree (salon_id, created_at DESC);


--
-- Name: booking_events_booking_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX booking_events_booking_idx ON public.booking_events USING btree (booking_id);


--
-- Name: booking_events_salon_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX booking_events_salon_created_idx ON public.booking_events USING btree (salon_id, created_at DESC);


--
-- Name: booking_notifications_confirmation_once; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX booking_notifications_confirmation_once ON public.booking_notifications USING btree (booking_id, channel) WHERE ((notification_type = 'booking_confirmation'::text) AND (booking_id IS NOT NULL));


--
-- Name: booking_waitlist_entries_salon_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX booking_waitlist_entries_salon_date_idx ON public.booking_waitlist_entries USING btree (salon_id, booking_date);


--
-- Name: bookings_client_profile_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bookings_client_profile_id_idx ON public.bookings USING btree (client_profile_id) WHERE (client_profile_id IS NOT NULL);


--
-- Name: bookings_deleted_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bookings_deleted_at_idx ON public.bookings USING btree (deleted_at) WHERE (deleted_at IS NULL);


--
-- Name: bookings_salon_id_start_time_utc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bookings_salon_id_start_time_utc_idx ON public.bookings USING btree (salon_id, start_time_utc);


--
-- Name: bookings_salon_id_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bookings_salon_id_status_idx ON public.bookings USING btree (salon_id, status);


--
-- Name: bookings_sms_consent_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bookings_sms_consent_at_idx ON public.bookings USING btree (sms_consent_at) WHERE (sms_consent_at IS NOT NULL);


--
-- Name: bookings_square_booking_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX bookings_square_booking_id_key ON public.bookings USING btree (square_booking_id) WHERE (square_booking_id IS NOT NULL);


--
-- Name: bookings_wix_booking_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX bookings_wix_booking_id_key ON public.bookings USING btree (wix_booking_id) WHERE (wix_booking_id IS NOT NULL);


--
-- Name: brt_booking_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX brt_booking_idx ON public.booking_reminder_tokens USING btree (booking_id);


--
-- Name: brt_expires_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX brt_expires_idx ON public.booking_reminder_tokens USING btree (expires_at);


--
-- Name: bwe_claim_token_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX bwe_claim_token_idx ON public.booking_waitlist_entries USING btree (claim_token) WHERE (claim_token IS NOT NULL);


--
-- Name: bwe_status_salon_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bwe_status_salon_idx ON public.booking_waitlist_entries USING btree (salon_id, status);


--
-- Name: campaign_schedules_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX campaign_schedules_due_idx ON public.campaign_schedules USING btree (status, scheduled_at);


--
-- Name: campaign_schedules_salon_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX campaign_schedules_salon_idx ON public.campaign_schedules USING btree (salon_id);


--
-- Name: client_profiles_square_customer_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX client_profiles_square_customer_id_key ON public.client_profiles USING btree (square_customer_id) WHERE (square_customer_id IS NOT NULL);


--
-- Name: email_otp_codes_expires_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX email_otp_codes_expires_idx ON public.email_otp_codes USING btree (expires_at);


--
-- Name: email_otp_codes_lookup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX email_otp_codes_lookup_idx ON public.email_otp_codes USING btree (salon_id, phone, email, consumed_at);


--
-- Name: email_otp_codes_ratelimit_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX email_otp_codes_ratelimit_idx ON public.email_otp_codes USING btree (salon_id, phone, created_at);


--
-- Name: email_verification_tokens_salon_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX email_verification_tokens_salon_idx ON public.email_verification_tokens USING btree (salon_id);


--
-- Name: email_verification_tokens_token_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX email_verification_tokens_token_idx ON public.email_verification_tokens USING btree (token);


--
-- Name: error_logs_open_fingerprint_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX error_logs_open_fingerprint_key ON public.error_logs USING btree (fingerprint) WHERE (status = 'open'::text);


--
-- Name: error_logs_status_lastseen_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX error_logs_status_lastseen_idx ON public.error_logs USING btree (status, last_seen_at DESC);


--
-- Name: first_visit_sequences_salon_phone; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX first_visit_sequences_salon_phone ON public.first_visit_sequences USING btree (salon_id, client_phone);


--
-- Name: first_visit_sequences_salon_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX first_visit_sequences_salon_status ON public.first_visit_sequences USING btree (salon_id, status, next_action_date);


--
-- Name: idx_ai_chats_converted; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ai_chats_converted ON public.ai_chats USING btree (salon_id, started_at DESC) WHERE ((status = 'converted'::text) AND (deleted_at IS NULL));


--
-- Name: idx_ai_chats_phone; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ai_chats_phone ON public.ai_chats USING btree (client_phone, last_message_at DESC) WHERE ((client_phone IS NOT NULL) AND (deleted_at IS NULL));


--
-- Name: idx_ai_chats_salon_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ai_chats_salon_active ON public.ai_chats USING btree (salon_id, status, last_message_at DESC) WHERE (deleted_at IS NULL);


--
-- Name: idx_booking_addons_booking; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_booking_addons_booking ON public.booking_addons USING btree (booking_id);


--
-- Name: idx_booking_notif_booking; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_booking_notif_booking ON public.booking_notifications USING btree (booking_id);


--
-- Name: idx_booking_notif_salon; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_booking_notif_salon ON public.booking_notifications USING btree (salon_id, created_at DESC);


--
-- Name: idx_booking_notif_sid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_booking_notif_sid ON public.booking_notifications USING btree (twilio_message_sid) WHERE (twilio_message_sid IS NOT NULL);


--
-- Name: idx_booking_photos_booking_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_booking_photos_booking_id ON public.booking_photos USING btree (booking_id) WHERE (deleted_at IS NULL);


--
-- Name: idx_booking_photos_salon_id_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_booking_photos_salon_id_created ON public.booking_photos USING btree (salon_id, created_at DESC) WHERE (deleted_at IS NULL);


--
-- Name: idx_booking_photos_staff_portfolio; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_booking_photos_staff_portfolio ON public.booking_photos USING btree (staff_id, created_at DESC) WHERE ((deleted_at IS NULL) AND (customer_rating >= 4));


--
-- Name: idx_bookings_addon_service_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bookings_addon_service_id ON public.bookings USING btree (addon_service_id);


--
-- Name: idx_bookings_calendar_range; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bookings_calendar_range ON public.bookings USING btree (salon_id, start_time_utc) WHERE (status <> ALL (ARRAY['cancelled'::text, 'waiting'::text]));


--
-- Name: idx_bookings_deposit_hold_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bookings_deposit_hold_pending ON public.bookings USING btree (deposit_requested_at) WHERE ((deposit_hold = true) AND (deposit_status = 'required'::text));


--
-- Name: idx_bookings_deposit_pi; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bookings_deposit_pi ON public.bookings USING btree (stripe_payment_intent_id) WHERE (stripe_payment_intent_id IS NOT NULL);


--
-- Name: idx_bookings_group_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bookings_group_id ON public.bookings USING btree (group_id) WHERE (group_id IS NOT NULL);


--
-- Name: idx_bookings_idempotency; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_bookings_idempotency ON public.bookings USING btree (salon_id, idempotency_key, staff_id, start_time_utc) WHERE (idempotency_key IS NOT NULL);


--
-- Name: idx_bookings_noshow_failed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bookings_noshow_failed ON public.bookings USING btree (salon_id, noshow_charge_status) WHERE ((noshow_charge_status = 'failed'::text) AND (noshow_card_id IS NOT NULL));


--
-- Name: idx_bookings_pending_unverified; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bookings_pending_unverified ON public.bookings USING btree (created_at) WHERE ((status = 'pending'::text) AND (verification_method IS NULL));


--
-- Name: idx_bookings_resource_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bookings_resource_id ON public.bookings USING btree (resource_id) WHERE (resource_id IS NOT NULL);


--
-- Name: idx_bookings_service_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bookings_service_id ON public.bookings USING btree (service_id);


--
-- Name: idx_bookings_sms_failed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bookings_sms_failed ON public.bookings USING btree (salon_id, created_at DESC) WHERE (sms_confirmation_failed_at IS NOT NULL);


--
-- Name: idx_bookings_staff_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bookings_staff_id ON public.bookings USING btree (staff_id);


--
-- Name: idx_bookings_walkin_queue; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bookings_walkin_queue ON public.bookings USING btree (salon_id, joined_queue_at) WHERE ((source = 'walkin'::text) AND (status = 'waiting'::text));


--
-- Name: idx_client_profiles_birthday_month_day; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_client_profiles_birthday_month_day ON public.client_profiles USING btree (EXTRACT(month FROM birthday), EXTRACT(day FROM birthday)) WHERE ((birthday IS NOT NULL) AND (deleted_at IS NULL));


--
-- Name: idx_customer_prefs_allergies; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_customer_prefs_allergies ON public.customer_preferences USING gin (allergies) WHERE ((allergies IS NOT NULL) AND (array_length(allergies, 1) > 0));


--
-- Name: idx_customer_prefs_marketing; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_customer_prefs_marketing ON public.customer_preferences USING btree (salon_id) WHERE (consent_marketing_sms = true);


--
-- Name: idx_customer_prefs_salon; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_customer_prefs_salon ON public.customer_preferences USING btree (salon_id);


--
-- Name: idx_import_jobs_salon_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_import_jobs_salon_created ON public.website_import_jobs USING btree (salon_id, created_at DESC);


--
-- Name: idx_loyalty_cards_salon_phone; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_loyalty_cards_salon_phone ON public.loyalty_cards USING btree (salon_id, client_phone);


--
-- Name: idx_loyalty_stamp_events_card; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_loyalty_stamp_events_card ON public.loyalty_stamp_events USING btree (card_id, created_at DESC);


--
-- Name: idx_loyalty_stamp_events_salon; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_loyalty_stamp_events_salon ON public.loyalty_stamp_events USING btree (salon_id, created_at DESC);


--
-- Name: idx_party_claims_booking; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_party_claims_booking ON public.party_link_claims USING btree (booking_id);


--
-- Name: idx_party_claims_link; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_party_claims_link ON public.party_link_claims USING btree (party_link_id);


--
-- Name: idx_party_links_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_party_links_group ON public.party_links USING btree (group_id);


--
-- Name: idx_party_links_salon; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_party_links_salon ON public.party_links USING btree (salon_id);


--
-- Name: idx_party_links_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_party_links_token ON public.party_links USING btree (token);


--
-- Name: idx_patterns_needs_refresh; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_patterns_needs_refresh ON public.customer_booking_patterns USING btree (next_refresh_at) WHERE (next_refresh_at IS NOT NULL);


--
-- Name: idx_patterns_next_predicted; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_patterns_next_predicted ON public.customer_booking_patterns USING btree (salon_id, next_predicted_at) WHERE (next_predicted_at IS NOT NULL);


--
-- Name: idx_photo_consents_marketing_allowed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_photo_consents_marketing_allowed ON public.customer_photo_consents USING btree (salon_id) WHERE ((consent_use_marketing = true) AND (revoked_at IS NULL));


--
-- Name: idx_photo_consents_phone; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_photo_consents_phone ON public.customer_photo_consents USING btree (salon_id, client_phone) WHERE (revoked_at IS NULL);


--
-- Name: idx_plcr_booking; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_plcr_booking ON public.party_link_change_requests USING btree (booking_id);


--
-- Name: idx_plcr_party_link; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_plcr_party_link ON public.party_link_change_requests USING btree (party_link_id);


--
-- Name: idx_plcr_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_plcr_status ON public.party_link_change_requests USING btree (status) WHERE (status = 'pending'::text);


--
-- Name: idx_referrals_code_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_referrals_code_lookup ON public.referrals USING btree (salon_id, code) WHERE (status = ANY (ARRAY['pending'::text, 'used'::text]));


--
-- Name: idx_referrals_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_referrals_expiry ON public.referrals USING btree (expires_at) WHERE (status = 'pending'::text);


--
-- Name: idx_referrals_referrer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_referrals_referrer ON public.referrals USING btree (salon_id, referrer_phone, status);


--
-- Name: idx_salon_invite_tokens_salon_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_salon_invite_tokens_salon_id ON public.salon_invite_tokens USING btree (salon_id);


--
-- Name: idx_salon_invite_tokens_staff_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_salon_invite_tokens_staff_id ON public.salon_invite_tokens USING btree (staff_id);


--
-- Name: idx_salon_invite_tokens_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_salon_invite_tokens_token ON public.salon_invite_tokens USING btree (token);


--
-- Name: idx_salon_page_sections_salon_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_salon_page_sections_salon_id ON public.salon_page_sections USING btree (salon_id, sort_order);


--
-- Name: idx_salon_resources_salon; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_salon_resources_salon ON public.salon_resources USING btree (salon_id) WHERE (deleted_at IS NULL);


--
-- Name: idx_services_wix_service_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_services_wix_service_id ON public.services USING btree (wix_service_id) WHERE (wix_service_id IS NOT NULL);


--
-- Name: idx_sqvh_salon_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sqvh_salon_customer ON public.square_visit_history USING btree (salon_id, square_customer_id);


--
-- Name: idx_sqvh_salon_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sqvh_salon_date ON public.square_visit_history USING btree (salon_id, square_created_at DESC);


--
-- Name: idx_sqvh_salon_profile_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sqvh_salon_profile_date ON public.square_visit_history USING btree (salon_id, client_profile_id, square_created_at DESC);


--
-- Name: idx_sqvh_visit_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sqvh_visit_date ON public.square_visit_history USING btree (salon_id, visit_date DESC);


--
-- Name: idx_staff_services_service; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_services_service ON public.staff_services USING btree (service_id);


--
-- Name: idx_staff_services_staff; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_services_staff ON public.staff_services USING btree (staff_id);


--
-- Name: idx_staff_shifts_salon; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_shifts_salon ON public.staff_shifts USING btree (salon_id, day_of_week) WHERE (is_active = true);


--
-- Name: idx_staff_unavailability_salon_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_unavailability_salon_date ON public.staff_unavailability USING btree (salon_id, date);


--
-- Name: idx_staff_wix_resource_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_wix_resource_id ON public.staff USING btree (wix_resource_id) WHERE (wix_resource_id IS NOT NULL);


--
-- Name: idx_trend_cache_refresh; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trend_cache_refresh ON public.ai_trend_cache USING btree (next_refresh_at);


--
-- Name: idx_upsell_log_phone_recent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_upsell_log_phone_recent ON public.ai_upsell_log USING btree (client_phone, created_at DESC) WHERE (client_phone IS NOT NULL);


--
-- Name: idx_upsell_log_salon_outcome; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_upsell_log_salon_outcome ON public.ai_upsell_log USING btree (salon_id, outcome, created_at DESC);


--
-- Name: idx_upsell_log_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_upsell_log_session ON public.ai_upsell_log USING btree (session_id, created_at) WHERE (session_id IS NOT NULL);


--
-- Name: idx_voucher_redemptions_phone; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_voucher_redemptions_phone ON public.voucher_redemptions USING btree (client_phone, redeemed_at DESC);


--
-- Name: idx_voucher_redemptions_salon_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_voucher_redemptions_salon_date ON public.voucher_redemptions USING btree (salon_id, redeemed_at DESC);


--
-- Name: idx_voucher_redemptions_voucher; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_voucher_redemptions_voucher ON public.voucher_redemptions USING btree (voucher_id);


--
-- Name: idx_vouchers_expires_soon; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vouchers_expires_soon ON public.vouchers USING btree (expires_at) WHERE (revoked_at IS NULL);


--
-- Name: idx_vouchers_phone_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vouchers_phone_active ON public.vouchers USING btree (salon_id, client_phone, expires_at) WHERE ((revoked_at IS NULL) AND (used_count < max_uses));


--
-- Name: idx_vouchers_salon_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vouchers_salon_code ON public.vouchers USING btree (salon_id, code) WHERE (revoked_at IS NULL);


--
-- Name: minh_lessons_salon_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX minh_lessons_salon_idx ON public.minh_lessons USING btree (salon_id) WHERE (salon_id IS NOT NULL);


--
-- Name: minh_lessons_scope_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX minh_lessons_scope_active_idx ON public.minh_lessons USING btree (scope, active);


--
-- Name: otp_send_log_lookup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX otp_send_log_lookup_idx ON public.otp_send_log USING btree (salon_id, phone, channel, created_at DESC);


--
-- Name: otps_phone_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX otps_phone_created_idx ON public.otps USING btree (phone, created_at DESC);


--
-- Name: payment_disputes_salon_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payment_disputes_salon_idx ON public.payment_disputes USING btree (salon_id);


--
-- Name: payment_disputes_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payment_disputes_status_idx ON public.payment_disputes USING btree (status);


--
-- Name: phone_otp_sessions_expires_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX phone_otp_sessions_expires_idx ON public.phone_otp_sessions USING btree (expires_at);


--
-- Name: phone_otp_sessions_phone_salon_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX phone_otp_sessions_phone_salon_idx ON public.phone_otp_sessions USING btree (phone, salon_id, consumed_at);


--
-- Name: platform_announcements_target_published_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX platform_announcements_target_published_idx ON public.platform_announcements USING btree (target, published_at DESC);


--
-- Name: promotion_services_promotion_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX promotion_services_promotion_id_idx ON public.promotion_services USING btree (promotion_id);


--
-- Name: promotion_services_service_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX promotion_services_service_id_idx ON public.promotion_services USING btree (service_id);


--
-- Name: promotions_salon_id_starts_at_ends_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX promotions_salon_id_starts_at_ends_at_idx ON public.promotions USING btree (salon_id, starts_at, ends_at) WHERE (active = true);


--
-- Name: queue_entries_assigned_staff_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX queue_entries_assigned_staff_idx ON public.queue_entries USING btree (assigned_staff_id) WHERE (status = 'in_service'::text);


--
-- Name: queue_entries_salon_status_arrived_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX queue_entries_salon_status_arrived_idx ON public.queue_entries USING btree (salon_id, status, arrived_at);


--
-- Name: rate_limits_expires_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX rate_limits_expires_idx ON public.rate_limits USING btree (expires_at);


--
-- Name: reoptin_sends_salon_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reoptin_sends_salon_idx ON public.reoptin_sends USING btree (salon_id);


--
-- Name: reoptin_sends_token_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reoptin_sends_token_idx ON public.reoptin_sends USING btree (token);


--
-- Name: reviews_salon_submitted_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reviews_salon_submitted_idx ON public.reviews USING btree (salon_id, submitted_at DESC NULLS LAST);


--
-- Name: reviews_token_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reviews_token_idx ON public.reviews USING btree (request_token);


--
-- Name: salon_client_spend_top_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX salon_client_spend_top_idx ON public.salon_client_spend USING btree (salon_id, total_spend_cents DESC);


--
-- Name: salon_clients_profile_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX salon_clients_profile_idx ON public.salon_clients USING btree (client_profile_id);


--
-- Name: salon_clients_salon_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX salon_clients_salon_idx ON public.salon_clients USING btree (salon_id);


--
-- Name: salon_custom_domains_domain_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX salon_custom_domains_domain_key ON public.salon_custom_domains USING btree (domain);


--
-- Name: salon_custom_domains_salon_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX salon_custom_domains_salon_id_idx ON public.salon_custom_domains USING btree (salon_id);


--
-- Name: salon_members_salon_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX salon_members_salon_id_idx ON public.salon_members USING btree (salon_id);


--
-- Name: salon_members_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX salon_members_user_id_idx ON public.salon_members USING btree (user_id);


--
-- Name: scheduled_notifications_booking_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scheduled_notifications_booking_idx ON public.scheduled_notifications USING btree (booking_id);


--
-- Name: scheduled_notifications_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scheduled_notifications_due_idx ON public.scheduled_notifications USING btree (send_after) WHERE (status = 'pending'::text);


--
-- Name: service_combos_salon_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX service_combos_salon_id_idx ON public.service_combos USING btree (salon_id);


--
-- Name: services_deleted_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX services_deleted_at_idx ON public.services USING btree (deleted_at) WHERE (deleted_at IS NULL);


--
-- Name: staff_active_by_salon_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX staff_active_by_salon_idx ON public.staff USING btree (salon_id) WHERE (status = 'active'::text);


--
-- Name: staff_deleted_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX staff_deleted_at_idx ON public.staff USING btree (deleted_at) WHERE (deleted_at IS NULL);


--
-- Name: staff_salon_user_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX staff_salon_user_unique ON public.staff USING btree (salon_id, user_id) WHERE (user_id IS NOT NULL);


--
-- Name: staff_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX staff_user_id_idx ON public.staff USING btree (user_id) WHERE (user_id IS NOT NULL);


--
-- Name: superadmin_audit_logs_action_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX superadmin_audit_logs_action_created_idx ON public.superadmin_audit_logs USING btree (action, created_at DESC);


--
-- Name: superadmin_audit_logs_actor_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX superadmin_audit_logs_actor_created_idx ON public.superadmin_audit_logs USING btree (actor_user_id, created_at DESC);


--
-- Name: superadmin_audit_logs_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX superadmin_audit_logs_created_idx ON public.superadmin_audit_logs USING btree (created_at DESC);


--
-- Name: superadmin_audit_logs_target_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX superadmin_audit_logs_target_created_idx ON public.superadmin_audit_logs USING btree (target_kind, target_id, created_at DESC);


--
-- Name: system_audit_salon_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX system_audit_salon_created_idx ON public.system_audit USING btree (salon_id, created_at DESC);


--
-- Name: user_presence_salon_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_presence_salon_idx ON public.user_presence USING btree (salon_id, last_seen_at DESC);


--
-- Name: watchdog_alerts_salon_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX watchdog_alerts_salon_created_idx ON public.watchdog_alerts USING btree (salon_id, created_at DESC);


--
-- Name: winback_suggestions_salon_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX winback_suggestions_salon_created_idx ON public.winback_suggestions USING btree (salon_id, created_at DESC);


--
-- Name: winback_suggestions_salon_phone_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX winback_suggestions_salon_phone_idx ON public.winback_suggestions USING btree (salon_id, client_phone);


--
-- Name: salon_page_sections salon_page_sections_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER salon_page_sections_updated_at BEFORE UPDATE ON public.salon_page_sections FOR EACH ROW EXECUTE FUNCTION public.update_salon_page_sections_updated_at();


--
-- Name: platform_announcements set_platform_announcements_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_platform_announcements_updated_at BEFORE UPDATE ON public.platform_announcements FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: platform_feature_flags set_platform_flags_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_platform_flags_updated_at BEFORE UPDATE ON public.platform_feature_flags FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: salons trg_audit_salons; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_audit_salons AFTER INSERT OR DELETE OR UPDATE ON public.salons FOR EACH ROW EXECUTE FUNCTION public.log_system_audit();


--
-- Name: services trg_audit_services; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_audit_services AFTER INSERT OR DELETE OR UPDATE ON public.services FOR EACH ROW EXECUTE FUNCTION public.log_system_audit();


--
-- Name: square_integrations trg_audit_square; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_audit_square AFTER INSERT OR DELETE OR UPDATE ON public.square_integrations FOR EACH ROW EXECUTE FUNCTION public.log_system_audit();


--
-- Name: staff trg_audit_staff; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_audit_staff AFTER INSERT OR DELETE OR UPDATE ON public.staff FOR EACH ROW EXECUTE FUNCTION public.log_system_audit();


--
-- Name: bookings trg_auto_stamp_on_complete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_auto_stamp_on_complete AFTER UPDATE ON public.bookings FOR EACH ROW EXECUTE FUNCTION public.auto_stamp_on_booking_complete();


--
-- Name: bookings trg_canon_client_phone; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_canon_client_phone BEFORE INSERT OR UPDATE OF client_phone ON public.bookings FOR EACH ROW EXECUTE FUNCTION public.tg_canon_client_phone();


--
-- Name: voice_ai_sessions trg_canon_client_phone; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_canon_client_phone BEFORE INSERT OR UPDATE OF client_phone ON public.voice_ai_sessions FOR EACH ROW EXECUTE FUNCTION public.tg_canon_client_phone();


--
-- Name: voucher_redemptions trg_canon_client_phone; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_canon_client_phone BEFORE INSERT OR UPDATE OF client_phone ON public.voucher_redemptions FOR EACH ROW EXECUTE FUNCTION public.tg_canon_client_phone();


--
-- Name: party_link_claims trg_canon_member_phone; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_canon_member_phone BEFORE INSERT OR UPDATE OF member_phone ON public.party_link_claims FOR EACH ROW EXECUTE FUNCTION public.tg_canon_member_phone();


--
-- Name: client_profiles trg_canon_phone; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_canon_phone BEFORE INSERT OR UPDATE OF phone ON public.client_profiles FOR EACH ROW EXECUTE FUNCTION public.tg_canon_phone();


--
-- Name: vouchers trg_canon_voucher_phones; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_canon_voucher_phones BEFORE INSERT OR UPDATE OF client_phone, gift_card_purchaser_phone ON public.vouchers FOR EACH ROW EXECUTE FUNCTION public.tg_canon_voucher_phones();


--
-- Name: voucher_redemptions trg_increment_voucher_used_count; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_increment_voucher_used_count AFTER INSERT ON public.voucher_redemptions FOR EACH ROW EXECUTE FUNCTION public.increment_voucher_used_count();


--
-- Name: loyalty_cards trg_loyalty_cards_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_loyalty_cards_updated_at BEFORE UPDATE ON public.loyalty_cards FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: loyalty_programs trg_loyalty_programs_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_loyalty_programs_updated_at BEFORE UPDATE ON public.loyalty_programs FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: staff_services trg_staff_services_same_salon; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_staff_services_same_salon BEFORE INSERT OR UPDATE ON public.staff_services FOR EACH ROW EXECUTE FUNCTION public.staff_services_same_salon_trg();


--
-- Name: customer_booking_patterns trg_touch_booking_patterns; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_touch_booking_patterns BEFORE UPDATE ON public.customer_booking_patterns FOR EACH ROW EXECUTE FUNCTION public.touch_booking_patterns_updated_at();


--
-- Name: customer_photo_consents trg_touch_customer_photo_consents; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_touch_customer_photo_consents BEFORE UPDATE ON public.customer_photo_consents FOR EACH ROW EXECUTE FUNCTION public.touch_customer_photo_consents_updated_at();


--
-- Name: customer_preferences trg_touch_customer_preferences; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_touch_customer_preferences BEFORE UPDATE ON public.customer_preferences FOR EACH ROW EXECUTE FUNCTION public.touch_customer_preferences_updated_at();


--
-- Name: referrals trg_touch_referrals; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_touch_referrals BEFORE UPDATE ON public.referrals FOR EACH ROW EXECUTE FUNCTION public.touch_referrals_updated_at();


--
-- Name: vouchers trg_touch_vouchers; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_touch_vouchers BEFORE UPDATE ON public.vouchers FOR EACH ROW EXECUTE FUNCTION public.touch_vouchers_updated_at();


--
-- Name: website_import_jobs website_import_jobs_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER website_import_jobs_updated_at BEFORE UPDATE ON public.website_import_jobs FOR EACH ROW EXECUTE FUNCTION public.update_website_import_jobs_updated_at();


--
-- Name: ai_actions_log ai_actions_log_outcome_booking_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_actions_log
    ADD CONSTRAINT ai_actions_log_outcome_booking_id_fkey FOREIGN KEY (outcome_booking_id) REFERENCES public.bookings(id) ON DELETE SET NULL;


--
-- Name: ai_actions_log ai_actions_log_salon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_actions_log
    ADD CONSTRAINT ai_actions_log_salon_id_fkey FOREIGN KEY (salon_id) REFERENCES public.salons(id) ON DELETE CASCADE;


--
-- Name: ai_chats ai_chats_client_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_chats
    ADD CONSTRAINT ai_chats_client_profile_id_fkey FOREIGN KEY (client_profile_id) REFERENCES public.client_profiles(id) ON DELETE SET NULL;


--
-- Name: ai_chats ai_chats_resulting_booking_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_chats
    ADD CONSTRAINT ai_chats_resulting_booking_id_fkey FOREIGN KEY (resulting_booking_id) REFERENCES public.bookings(id) ON DELETE SET NULL;


--
-- Name: ai_chats ai_chats_resulting_waitlist_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_chats
    ADD CONSTRAINT ai_chats_resulting_waitlist_id_fkey FOREIGN KEY (resulting_waitlist_id) REFERENCES public.booking_waitlist_entries(id) ON DELETE SET NULL;


--
-- Name: ai_chats ai_chats_salon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_chats
    ADD CONSTRAINT ai_chats_salon_id_fkey FOREIGN KEY (salon_id) REFERENCES public.salons(id) ON DELETE CASCADE;


--
-- Name: ai_policy_decisions ai_policy_decisions_booking_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_policy_decisions
    ADD CONSTRAINT ai_policy_decisions_booking_fk FOREIGN KEY (booking_id) REFERENCES public.bookings(id) ON DELETE SET NULL;


--
-- Name: ai_trend_cache ai_trend_cache_salon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_trend_cache
    ADD CONSTRAINT ai_trend_cache_salon_id_fkey FOREIGN KEY (salon_id) REFERENCES public.salons(id) ON DELETE CASCADE;


--
-- Name: ai_upsell_log ai_upsell_log_booking_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_upsell_log
    ADD CONSTRAINT ai_upsell_log_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES public.bookings(id) ON DELETE SET NULL;


--
-- Name: ai_upsell_log ai_upsell_log_salon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_upsell_log
    ADD CONSTRAINT ai_upsell_log_salon_id_fkey FOREIGN KEY (salon_id) REFERENCES public.salons(id) ON DELETE CASCADE;


--
-- Name: ai_upsell_log ai_upsell_log_suggested_service_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_upsell_log
    ADD CONSTRAINT ai_upsell_log_suggested_service_id_fkey FOREIGN KEY (suggested_service_id) REFERENCES public.services(id) ON DELETE CASCADE;


--
-- Name: approval_requests approval_requests_decided_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approval_requests
    ADD CONSTRAINT approval_requests_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES auth.users(id);


--
-- Name: approval_requests approval_requests_salon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approval_requests
    ADD CONSTRAINT approval_requests_salon_id_fkey FOREIGN KEY (salon_id) REFERENCES public.salons(id) ON DELETE CASCADE;


--
-- Name: booking_addons booking_addons_booking_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking_addons
    ADD CONSTRAINT booking_addons_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES public.bookings(id) ON DELETE CASCADE;


--
-- Name: booking_addons booking_addons_service_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking_addons
    ADD CONSTRAINT booking_addons_service_id_fkey FOREIGN KEY (service_id) REFERENCES public.services(id);


--
-- Name: booking_events booking_events_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking_events
    ADD CONSTRAINT booking_events_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES auth.users(id);


--
-- Name: booking_events booking_events_booking_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking_events
    ADD CONSTRAINT booking_events_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES public.bookings(id) ON DELETE CASCADE;


--
-- Name: booking_events booking_events_salon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking_events
    ADD CONSTRAINT booking_events_salon_id_fkey FOREIGN KEY (salon_id) REFERENCES public.salons(id) ON DELETE CASCADE;


--
-- Name: booking_notifications booking_notifications_booking_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking_notifications
    ADD CONSTRAINT booking_notifications_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES public.bookings(id) ON DELETE CASCADE;


--
-- Name: booking_notifications booking_notifications_salon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking_notifications
    ADD CONSTRAINT booking_notifications_salon_id_fkey FOREIGN KEY (salon_id) REFERENCES public.salons(id) ON DELETE CASCADE;


--
-- Name: booking_photos booking_photos_booking_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking_photos
    ADD CONSTRAINT booking_photos_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES public.bookings(id) ON DELETE CASCADE;


--
-- Name: booking_photos booking_photos_salon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking_photos
    ADD CONSTRAINT booking_photos_salon_id_fkey FOREIGN KEY (salon_id) REFERENCES public.salons(id) ON DELETE CASCADE;


--
-- Name: booking_photos booking_photos_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking_photos
    ADD CONSTRAINT booking_photos_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.staff(id) ON DELETE SET NULL;


--
-- Name: booking_reminder_tokens booking_reminder_tokens_booking_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking_reminder_tokens
    ADD CONSTRAINT booking_reminder_tokens_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES public.bookings(id) ON DELETE CASCADE;


--
-- Name: booking_reminder_tokens booking_reminder_tokens_salon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking_reminder_tokens
    ADD CONSTRAINT booking_reminder_tokens_salon_id_fkey FOREIGN KEY (salon_id) REFERENCES public.salons(id) ON DELETE CASCADE;


--
-- Name: booking_waitlist_entries booking_waitlist_entries_booked_booking_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking_waitlist_entries
    ADD CONSTRAINT booking_waitlist_entries_booked_booking_id_fkey FOREIGN KEY (booked_booking_id) REFERENCES public.bookings(id) ON DELETE SET NULL;


--
-- Name: booking_waitlist_entries booking_waitlist_entries_offered_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking_waitlist_entries
    ADD CONSTRAINT booking_waitlist_entries_offered_staff_id_fkey FOREIGN KEY (offered_staff_id) REFERENCES public.staff(id) ON DELETE SET NULL;


--
-- Name: booking_waitlist_entries booking_waitlist_entries_salon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking_waitlist_entries
    ADD CONSTRAINT booking_waitlist_entries_salon_id_fkey FOREIGN KEY (salon_id) REFERENCES public.salons(id) ON DELETE CASCADE;


--
-- Name: booking_waitlist_entries booking_waitlist_entries_service_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking_waitlist_entries
    ADD CONSTRAINT booking_waitlist_entries_service_id_fkey FOREIGN KEY (service_id) REFERENCES public.services(id) ON DELETE CASCADE;


--
-- Name: booking_waitlist_entries booking_waitlist_entries_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking_waitlist_entries
    ADD CONSTRAINT booking_waitlist_entries_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.staff(id) ON DELETE SET NULL;


--
-- Name: bookings bookings_addon_service_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_addon_service_id_fkey FOREIGN KEY (addon_service_id) REFERENCES public.services(id);


--
-- Name: bookings bookings_client_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_client_profile_id_fkey FOREIGN KEY (client_profile_id) REFERENCES public.client_profiles(id) ON DELETE SET NULL;


--
-- Name: bookings bookings_otp_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_otp_session_id_fkey FOREIGN KEY (otp_session_id) REFERENCES public.phone_otp_sessions(id) ON DELETE SET NULL;


--
-- Name: bookings bookings_promo_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_promo_id_fkey FOREIGN KEY (promo_id) REFERENCES public.promotions(id);


--
-- Name: bookings bookings_resource_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_resource_id_fkey FOREIGN KEY (resource_id) REFERENCES public.salon_resources(id);


--
-- Name: bookings bookings_salon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_salon_id_fkey FOREIGN KEY (salon_id) REFERENCES public.salons(id) ON DELETE CASCADE;


--
-- Name: bookings bookings_service_combo_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_service_combo_id_fkey FOREIGN KEY (service_combo_id) REFERENCES public.service_combos(id) ON DELETE SET NULL;


--
-- Name: bookings bookings_service_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_service_id_fkey FOREIGN KEY (service_id) REFERENCES public.services(id);


--
-- Name: bookings bookings_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.staff(id);


--
-- Name: campaign_schedules campaign_schedules_salon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_schedules
    ADD CONSTRAINT campaign_schedules_salon_id_fkey FOREIGN KEY (salon_id) REFERENCES public.salons(id) ON DELETE CASCADE;


--
-- Name: client_ai_summaries client_ai_summaries_client_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_ai_summaries
    ADD CONSTRAINT client_ai_summaries_client_profile_id_fkey FOREIGN KEY (client_profile_id) REFERENCES public.client_profiles(id) ON DELETE CASCADE;


--
-- Name: client_ai_summaries client_ai_summaries_salon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_ai_summaries
    ADD CONSTRAINT client_ai_summaries_salon_id_fkey FOREIGN KEY (salon_id) REFERENCES public.salons(id) ON DELETE CASCADE;


--
-- Name: client_profiles client_profiles_preferred_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_profiles
    ADD CONSTRAINT client_profiles_preferred_staff_id_fkey FOREIGN KEY (preferred_staff_id) REFERENCES public.staff(id);


--
-- Name: customer_booking_patterns customer_booking_patterns_client_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_booking_patterns
    ADD CONSTRAINT customer_booking_patterns_client_profile_id_fkey FOREIGN KEY (client_profile_id) REFERENCES public.client_profiles(id) ON DELETE SET NULL;


--
-- Name: customer_booking_patterns customer_booking_patterns_salon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_booking_patterns
    ADD CONSTRAINT customer_booking_patterns_salon_id_fkey FOREIGN KEY (salon_id) REFERENCES public.salons(id) ON DELETE CASCADE;


--
-- Name: customer_booking_patterns customer_booking_patterns_usual_addon_service_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_booking_patterns
    ADD CONSTRAINT customer_booking_patterns_usual_addon_service_id_fkey FOREIGN KEY (usual_addon_service_id) REFERENCES public.services(id) ON DELETE SET NULL;


--
-- Name: customer_booking_patterns customer_booking_patterns_usual_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_booking_patterns
    ADD CONSTRAINT customer_booking_patterns_usual_staff_id_fkey FOREIGN KEY (usual_staff_id) REFERENCES public.staff(id) ON DELETE SET NULL;


--
-- Name: customer_photo_consents customer_photo_consents_client_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_photo_consents
    ADD CONSTRAINT customer_photo_consents_client_profile_id_fkey FOREIGN KEY (client_profile_id) REFERENCES public.client_profiles(id) ON DELETE SET NULL;


--
-- Name: customer_photo_consents customer_photo_consents_granted_by_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_photo_consents
    ADD CONSTRAINT customer_photo_consents_granted_by_staff_id_fkey FOREIGN KEY (granted_by_staff_id) REFERENCES public.staff(id) ON DELETE SET NULL;


--
-- Name: customer_photo_consents customer_photo_consents_salon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_photo_consents
    ADD CONSTRAINT customer_photo_consents_salon_id_fkey FOREIGN KEY (salon_id) REFERENCES public.salons(id) ON DELETE CASCADE;


--
-- Name: customer_preferences customer_preferences_client_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_preferences
    ADD CONSTRAINT customer_preferences_client_profile_id_fkey FOREIGN KEY (client_profile_id) REFERENCES public.client_profiles(id) ON DELETE CASCADE;


--
-- Name: customer_preferences customer_preferences_salon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_preferences
    ADD CONSTRAINT customer_preferences_salon_id_fkey FOREIGN KEY (salon_id) REFERENCES public.salons(id) ON DELETE CASCADE;


--
-- Name: email_otp_codes email_otp_codes_salon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_otp_codes
    ADD CONSTRAINT email_otp_codes_salon_id_fkey FOREIGN KEY (salon_id) REFERENCES public.salons(id) ON DELETE CASCADE;


--
-- Name: email_verification_tokens email_verification_tokens_salon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_verification_tokens
    ADD CONSTRAINT email_verification_tokens_salon_id_fkey FOREIGN KEY (salon_id) REFERENCES public.salons(id) ON DELETE CASCADE;


--
-- Name: error_logs error_logs_resolved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.error_logs
    ADD CONSTRAINT error_logs_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: error_logs error_logs_salon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.error_logs
    ADD CONSTRAINT error_logs_salon_id_fkey FOREIGN KEY (salon_id) REFERENCES public.salons(id) ON DELETE SET NULL;


--
-- Name: error_logs error_logs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.error_logs
    ADD CONSTRAINT error_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: first_visit_sequences first_visit_sequences_converted_booking_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.first_visit_sequences
    ADD CONSTRAINT first_visit_sequences_converted_booking_id_fkey FOREIGN KEY (converted_booking_id) REFERENCES public.bookings(id) ON DELETE SET NULL;


--
-- Name: first_visit_sequences first_visit_sequences_first_booking_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.first_visit_sequences
    ADD CONSTRAINT first_visit_sequences_first_booking_id_fkey FOREIGN KEY (first_booking_id) REFERENCES public.bookings(id) ON DELETE SET NULL;


--
-- Name: first_visit_sequences first_visit_sequences_salon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.first_visit_sequences
    ADD CONSTRAINT first_visit_sequences_salon_id_fkey FOREIGN KEY (salon_id) REFERENCES public.salons(id) ON DELETE CASCADE;


--
-- Name: loyalty_cards loyalty_cards_client_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.loyalty_cards
    ADD CONSTRAINT loyalty_cards_client_profile_id_fkey FOREIGN KEY (client_profile_id) REFERENCES public.client_profiles(id);


--
-- Name: loyalty_cards loyalty_cards_program_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.loyalty_cards
    ADD CONSTRAINT loyalty_cards_program_id_fkey FOREIGN KEY (program_id) REFERENCES public.loyalty_programs(id);


--
-- Name: loyalty_cards loyalty_cards_salon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.loyalty_cards
    ADD CONSTRAINT loyalty_cards_salon_id_fkey FOREIGN KEY (salon_id) REFERENCES public.salons(id);


--
-- Name: loyalty_programs loyalty_programs_reward_service_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.loyalty_programs
    ADD CONSTRAINT loyalty_programs_reward_service_id_fkey FOREIGN KEY (reward_service_id) REFERENCES public.services(id);


--
-- Name: loyalty_programs loyalty_programs_salon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.loyalty_programs
    ADD CONSTRAINT loyalty_programs_salon_id_fkey FOREIGN KEY (salon_id) REFERENCES public.salons(id);


--
-- Name: loyalty_stamp_events loyalty_stamp_events_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.loyalty_stamp_events
    ADD CONSTRAINT loyalty_stamp_events_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES auth.users(id);


--
-- Name: loyalty_stamp_events loyalty_stamp_events_booking_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.loyalty_stamp_events
    ADD CONSTRAINT loyalty_stamp_events_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES public.bookings(id);


--
-- Name: loyalty_stamp_events loyalty_stamp_events_card_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.loyalty_stamp_events
    ADD CONSTRAINT loyalty_stamp_events_card_id_fkey FOREIGN KEY (card_id) REFERENCES public.loyalty_cards(id);


--
-- Name: loyalty_stamp_events loyalty_stamp_events_salon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.loyalty_stamp_events
    ADD CONSTRAINT loyalty_stamp_events_salon_id_fkey FOREIGN KEY (salon_id) REFERENCES public.salons(id);


--
-- Name: minh_lessons minh_lessons_salon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.minh_lessons
    ADD CONSTRAINT minh_lessons_salon_id_fkey FOREIGN KEY (salon_id) REFERENCES public.salons(id) ON DELETE CASCADE;


--
-- Name: party_link_change_requests party_link_change_requests_booking_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.party_link_change_requests
    ADD CONSTRAINT party_link_change_requests_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES public.bookings(id) ON DELETE CASCADE;


--
-- Name: party_link_change_requests party_link_change_requests_claim_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.party_link_change_requests
    ADD CONSTRAINT party_link_change_requests_claim_id_fkey FOREIGN KEY (claim_id) REFERENCES public.party_link_claims(id) ON DELETE SET NULL;


--
-- Name: party_link_change_requests party_link_change_requests_party_link_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.party_link_change_requests
    ADD CONSTRAINT party_link_change_requests_party_link_id_fkey FOREIGN KEY (party_link_id) REFERENCES public.party_links(id) ON DELETE CASCADE;


--
-- Name: party_link_change_requests party_link_change_requests_requested_service_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.party_link_change_requests
    ADD CONSTRAINT party_link_change_requests_requested_service_id_fkey FOREIGN KEY (requested_service_id) REFERENCES public.services(id) ON DELETE SET NULL;


--
-- Name: party_link_change_requests party_link_change_requests_requested_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.party_link_change_requests
    ADD CONSTRAINT party_link_change_requests_requested_staff_id_fkey FOREIGN KEY (requested_staff_id) REFERENCES public.staff(id) ON DELETE SET NULL;


--
-- Name: party_link_claims party_link_claims_booking_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.party_link_claims
    ADD CONSTRAINT party_link_claims_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES public.bookings(id) ON DELETE CASCADE;


--
-- Name: party_link_claims party_link_claims_party_link_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.party_link_claims
    ADD CONSTRAINT party_link_claims_party_link_id_fkey FOREIGN KEY (party_link_id) REFERENCES public.party_links(id) ON DELETE CASCADE;


--
-- Name: party_links party_links_salon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.party_links
    ADD CONSTRAINT party_links_salon_id_fkey FOREIGN KEY (salon_id) REFERENCES public.salons(id) ON DELETE CASCADE;


--
-- Name: payment_disputes payment_disputes_booking_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_disputes
    ADD CONSTRAINT payment_disputes_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES public.bookings(id) ON DELETE SET NULL;


--
-- Name: payment_disputes payment_disputes_salon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_disputes
    ADD CONSTRAINT payment_disputes_salon_id_fkey FOREIGN KEY (salon_id) REFERENCES public.salons(id) ON DELETE CASCADE;


--
-- Name: phone_otp_sessions phone_otp_sessions_salon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.phone_otp_sessions
    ADD CONSTRAINT phone_otp_sessions_salon_id_fkey FOREIGN KEY (salon_id) REFERENCES public.salons(id) ON DELETE CASCADE;


--
-- Name: platform_announcements platform_announcements_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_announcements
    ADD CONSTRAINT platform_announcements_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: platform_feature_flags platform_feature_flags_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_feature_flags
    ADD CONSTRAINT platform_feature_flags_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: platform_flags platform_flags_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_flags
    ADD CONSTRAINT platform_flags_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth.users(id);


--
-- Name: promotion_services promotion_services_promotion_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promotion_services
    ADD CONSTRAINT promotion_services_promotion_id_fkey FOREIGN KEY (promotion_id) REFERENCES public.promotions(id) ON DELETE CASCADE;


--
-- Name: promotion_services promotion_services_service_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promotion_services
    ADD CONSTRAINT promotion_services_service_id_fkey FOREIGN KEY (service_id) REFERENCES public.services(id) ON DELETE CASCADE;


--
-- Name: promotions promotions_salon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promotions
    ADD CONSTRAINT promotions_salon_id_fkey FOREIGN KEY (salon_id) REFERENCES public.salons(id) ON DELETE CASCADE;


--
-- Name: queue_entries queue_entries_assigned_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.queue_entries
    ADD CONSTRAINT queue_entries_assigned_staff_id_fkey FOREIGN KEY (assigned_staff_id) REFERENCES public.staff(id);


--
-- Name: queue_entries queue_entries_requested_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.queue_entries
    ADD CONSTRAINT queue_entries_requested_staff_id_fkey FOREIGN KEY (requested_staff_id) REFERENCES public.staff(id);


--
-- Name: queue_entries queue_entries_salon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.queue_entries
    ADD CONSTRAINT queue_entries_salon_id_fkey FOREIGN KEY (salon_id) REFERENCES public.salons(id) ON DELETE CASCADE;


--
-- Name: queue_entries queue_entries_service_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.queue_entries
    ADD CONSTRAINT queue_entries_service_id_fkey FOREIGN KEY (service_id) REFERENCES public.services(id);


--
-- Name: referrals referrals_referee_booking_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referrals
    ADD CONSTRAINT referrals_referee_booking_id_fkey FOREIGN KEY (referee_booking_id) REFERENCES public.bookings(id) ON DELETE SET NULL;


--
-- Name: referrals referrals_referee_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referrals
    ADD CONSTRAINT referrals_referee_profile_id_fkey FOREIGN KEY (referee_profile_id) REFERENCES public.client_profiles(id) ON DELETE SET NULL;


--
-- Name: referrals referrals_referee_voucher_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referrals
    ADD CONSTRAINT referrals_referee_voucher_id_fkey FOREIGN KEY (referee_voucher_id) REFERENCES public.vouchers(id) ON DELETE SET NULL;


--
-- Name: referrals referrals_referrer_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referrals
    ADD CONSTRAINT referrals_referrer_profile_id_fkey FOREIGN KEY (referrer_profile_id) REFERENCES public.client_profiles(id) ON DELETE SET NULL;


--
-- Name: referrals referrals_referrer_voucher_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referrals
    ADD CONSTRAINT referrals_referrer_voucher_id_fkey FOREIGN KEY (referrer_voucher_id) REFERENCES public.vouchers(id) ON DELETE SET NULL;


--
-- Name: referrals referrals_salon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referrals
    ADD CONSTRAINT referrals_salon_id_fkey FOREIGN KEY (salon_id) REFERENCES public.salons(id) ON DELETE CASCADE;


--
-- Name: reoptin_sends reoptin_sends_client_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reoptin_sends
    ADD CONSTRAINT reoptin_sends_client_profile_id_fkey FOREIGN KEY (client_profile_id) REFERENCES public.client_profiles(id) ON DELETE CASCADE;


--
-- Name: reoptin_sends reoptin_sends_salon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reoptin_sends
    ADD CONSTRAINT reoptin_sends_salon_id_fkey FOREIGN KEY (salon_id) REFERENCES public.salons(id) ON DELETE CASCADE;


--
-- Name: reoptin_sends reoptin_sends_voucher_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reoptin_sends
    ADD CONSTRAINT reoptin_sends_voucher_id_fkey FOREIGN KEY (voucher_id) REFERENCES public.vouchers(id) ON DELETE SET NULL;


--
-- Name: reviews reviews_booking_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reviews
    ADD CONSTRAINT reviews_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES public.bookings(id) ON DELETE CASCADE;


--
-- Name: reviews reviews_salon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reviews
    ADD CONSTRAINT reviews_salon_id_fkey FOREIGN KEY (salon_id) REFERENCES public.salons(id) ON DELETE CASCADE;


--
-- Name: reviews reviews_service_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reviews
    ADD CONSTRAINT reviews_service_id_fkey FOREIGN KEY (service_id) REFERENCES public.services(id) ON DELETE SET NULL;


--
-- Name: reviews reviews_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reviews
    ADD CONSTRAINT reviews_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.staff(id) ON DELETE SET NULL;


--
-- Name: salon_client_names salon_client_names_salon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salon_client_names
    ADD CONSTRAINT salon_client_names_salon_id_fkey FOREIGN KEY (salon_id) REFERENCES public.salons(id) ON DELETE CASCADE;


--
-- Name: salon_client_spend salon_client_spend_client_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salon_client_spend
    ADD CONSTRAINT salon_client_spend_client_profile_id_fkey FOREIGN KEY (client_profile_id) REFERENCES public.client_profiles(id) ON DELETE CASCADE;


--
-- Name: salon_client_spend salon_client_spend_salon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salon_client_spend
    ADD CONSTRAINT salon_client_spend_salon_id_fkey FOREIGN KEY (salon_id) REFERENCES public.salons(id) ON DELETE CASCADE;


--
-- Name: salon_clients salon_clients_client_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salon_clients
    ADD CONSTRAINT salon_clients_client_profile_id_fkey FOREIGN KEY (client_profile_id) REFERENCES public.client_profiles(id) ON DELETE CASCADE;


--
-- Name: salon_clients salon_clients_salon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salon_clients
    ADD CONSTRAINT salon_clients_salon_id_fkey FOREIGN KEY (salon_id) REFERENCES public.salons(id) ON DELETE CASCADE;


--
-- Name: salon_custom_domains salon_custom_domains_salon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salon_custom_domains
    ADD CONSTRAINT salon_custom_domains_salon_id_fkey FOREIGN KEY (salon_id) REFERENCES public.salons(id) ON DELETE CASCADE;


--
-- Name: salon_invite_tokens salon_invite_tokens_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salon_invite_tokens
    ADD CONSTRAINT salon_invite_tokens_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: salon_invite_tokens salon_invite_tokens_salon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salon_invite_tokens
    ADD CONSTRAINT salon_invite_tokens_salon_id_fkey FOREIGN KEY (salon_id) REFERENCES public.salons(id) ON DELETE CASCADE;


--
-- Name: salon_invite_tokens salon_invite_tokens_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salon_invite_tokens
    ADD CONSTRAINT salon_invite_tokens_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.staff(id) ON DELETE CASCADE;


--
-- Name: salon_invite_tokens salon_invite_tokens_used_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salon_invite_tokens
    ADD CONSTRAINT salon_invite_tokens_used_by_user_id_fkey FOREIGN KEY (used_by_user_id) REFERENCES auth.users(id);


--
-- Name: salon_members salon_members_salon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salon_members
    ADD CONSTRAINT salon_members_salon_id_fkey FOREIGN KEY (salon_id) REFERENCES public.salons(id) ON DELETE CASCADE;


--
-- Name: salon_members salon_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salon_members
    ADD CONSTRAINT salon_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: salon_page_sections salon_page_sections_salon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salon_page_sections
    ADD CONSTRAINT salon_page_sections_salon_id_fkey FOREIGN KEY (salon_id) REFERENCES public.salons(id) ON DELETE CASCADE;


--
-- Name: salon_resources salon_resources_salon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salon_resources
    ADD CONSTRAINT salon_resources_salon_id_fkey FOREIGN KEY (salon_id) REFERENCES public.salons(id) ON DELETE CASCADE;


--
-- Name: scheduled_notifications scheduled_notifications_booking_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduled_notifications
    ADD CONSTRAINT scheduled_notifications_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES public.bookings(id) ON DELETE CASCADE;


--
-- Name: scheduled_notifications scheduled_notifications_salon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduled_notifications
    ADD CONSTRAINT scheduled_notifications_salon_id_fkey FOREIGN KEY (salon_id) REFERENCES public.salons(id) ON DELETE CASCADE;


--
-- Name: service_combos service_combos_salon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_combos
    ADD CONSTRAINT service_combos_salon_id_fkey FOREIGN KEY (salon_id) REFERENCES public.salons(id) ON DELETE CASCADE;


--
-- Name: services services_category_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.services
    ADD CONSTRAINT services_category_fk FOREIGN KEY (category) REFERENCES public.service_categories(slug) ON UPDATE CASCADE;


--
-- Name: CONSTRAINT services_category_fk ON services; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON CONSTRAINT services_category_fk ON public.services IS 'Task #07 — prevents services.category drift from canonical service_categories.slug list. ON UPDATE CASCADE syncs rows on rename. ON DELETE NO ACTION dormant (soft-delete only).';


--
-- Name: services services_salon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.services
    ADD CONSTRAINT services_salon_id_fkey FOREIGN KEY (salon_id) REFERENCES public.salons(id) ON DELETE CASCADE;


--
-- Name: square_integrations square_integrations_salon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.square_integrations
    ADD CONSTRAINT square_integrations_salon_id_fkey FOREIGN KEY (salon_id) REFERENCES public.salons(id) ON DELETE CASCADE;


--
-- Name: square_visit_history square_visit_history_client_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.square_visit_history
    ADD CONSTRAINT square_visit_history_client_profile_id_fkey FOREIGN KEY (client_profile_id) REFERENCES public.client_profiles(id) ON DELETE SET NULL;


--
-- Name: square_visit_history square_visit_history_salon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.square_visit_history
    ADD CONSTRAINT square_visit_history_salon_id_fkey FOREIGN KEY (salon_id) REFERENCES public.salons(id) ON DELETE CASCADE;


--
-- Name: staff staff_salon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff
    ADD CONSTRAINT staff_salon_id_fkey FOREIGN KEY (salon_id) REFERENCES public.salons(id) ON DELETE CASCADE;


--
-- Name: staff_services staff_services_service_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_services
    ADD CONSTRAINT staff_services_service_id_fkey FOREIGN KEY (service_id) REFERENCES public.services(id) ON DELETE CASCADE;


--
-- Name: staff_services staff_services_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_services
    ADD CONSTRAINT staff_services_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.staff(id) ON DELETE CASCADE;


--
-- Name: staff_shifts staff_shifts_salon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_shifts
    ADD CONSTRAINT staff_shifts_salon_id_fkey FOREIGN KEY (salon_id) REFERENCES public.salons(id) ON DELETE CASCADE;


--
-- Name: staff_shifts staff_shifts_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_shifts
    ADD CONSTRAINT staff_shifts_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.staff(id) ON DELETE CASCADE;


--
-- Name: staff_unavailability staff_unavailability_salon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_unavailability
    ADD CONSTRAINT staff_unavailability_salon_id_fkey FOREIGN KEY (salon_id) REFERENCES public.salons(id) ON DELETE CASCADE;


--
-- Name: staff_unavailability staff_unavailability_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_unavailability
    ADD CONSTRAINT staff_unavailability_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.staff(id) ON DELETE CASCADE;


--
-- Name: staff staff_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff
    ADD CONSTRAINT staff_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: superadmin_audit_logs superadmin_audit_logs_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.superadmin_audit_logs
    ADD CONSTRAINT superadmin_audit_logs_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: superadmins superadmins_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.superadmins
    ADD CONSTRAINT superadmins_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: superadmins superadmins_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.superadmins
    ADD CONSTRAINT superadmins_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id);


--
-- Name: user_presence user_presence_salon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_presence
    ADD CONSTRAINT user_presence_salon_id_fkey FOREIGN KEY (salon_id) REFERENCES public.salons(id) ON DELETE CASCADE;


--
-- Name: user_presence user_presence_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_presence
    ADD CONSTRAINT user_presence_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: voice_ai_sessions voice_ai_sessions_booking_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_ai_sessions
    ADD CONSTRAINT voice_ai_sessions_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES public.bookings(id);


--
-- Name: voice_ai_sessions voice_ai_sessions_salon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_ai_sessions
    ADD CONSTRAINT voice_ai_sessions_salon_id_fkey FOREIGN KEY (salon_id) REFERENCES public.salons(id);


--
-- Name: voucher_redemptions voucher_redemptions_booking_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voucher_redemptions
    ADD CONSTRAINT voucher_redemptions_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES public.bookings(id) ON DELETE SET NULL;


--
-- Name: voucher_redemptions voucher_redemptions_salon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voucher_redemptions
    ADD CONSTRAINT voucher_redemptions_salon_id_fkey FOREIGN KEY (salon_id) REFERENCES public.salons(id) ON DELETE CASCADE;


--
-- Name: voucher_redemptions voucher_redemptions_voucher_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voucher_redemptions
    ADD CONSTRAINT voucher_redemptions_voucher_id_fkey FOREIGN KEY (voucher_id) REFERENCES public.vouchers(id) ON DELETE CASCADE;


--
-- Name: vouchers vouchers_client_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vouchers
    ADD CONSTRAINT vouchers_client_profile_id_fkey FOREIGN KEY (client_profile_id) REFERENCES public.client_profiles(id) ON DELETE SET NULL;


--
-- Name: vouchers vouchers_free_service_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vouchers
    ADD CONSTRAINT vouchers_free_service_id_fkey FOREIGN KEY (free_service_id) REFERENCES public.services(id) ON DELETE SET NULL;


--
-- Name: vouchers vouchers_salon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vouchers
    ADD CONSTRAINT vouchers_salon_id_fkey FOREIGN KEY (salon_id) REFERENCES public.salons(id) ON DELETE CASCADE;


--
-- Name: website_import_jobs website_import_jobs_salon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.website_import_jobs
    ADD CONSTRAINT website_import_jobs_salon_id_fkey FOREIGN KEY (salon_id) REFERENCES public.salons(id) ON DELETE CASCADE;


--
-- Name: wix_integrations wix_integrations_salon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wix_integrations
    ADD CONSTRAINT wix_integrations_salon_id_fkey FOREIGN KEY (salon_id) REFERENCES public.salons(id) ON DELETE CASCADE;


--
-- Name: ai_trend_cache Public read trend cache; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public read trend cache" ON public.ai_trend_cache FOR SELECT TO anon, authenticated USING (true);


--
-- Name: customer_photo_consents Salon members insert own consents; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Salon members insert own consents" ON public.customer_photo_consents FOR INSERT TO authenticated WITH CHECK ((salon_id IN ( SELECT salon_members.salon_id
   FROM public.salon_members
  WHERE (salon_members.user_id = ( SELECT auth.uid() AS uid)))));


--
-- Name: booking_photos Salon members insert own photos; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Salon members insert own photos" ON public.booking_photos FOR INSERT TO authenticated WITH CHECK ((salon_id IN ( SELECT salon_members.salon_id
   FROM public.salon_members
  WHERE (salon_members.user_id = ( SELECT auth.uid() AS uid)))));


--
-- Name: vouchers Salon members insert own vouchers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Salon members insert own vouchers" ON public.vouchers FOR INSERT TO authenticated WITH CHECK ((salon_id IN ( SELECT salon_members.salon_id
   FROM public.salon_members
  WHERE (salon_members.user_id = ( SELECT auth.uid() AS uid)))));


--
-- Name: voucher_redemptions Salon members insert redemptions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Salon members insert redemptions" ON public.voucher_redemptions FOR INSERT TO authenticated WITH CHECK ((salon_id IN ( SELECT salon_members.salon_id
   FROM public.salon_members
  WHERE (salon_members.user_id = ( SELECT auth.uid() AS uid)))));


--
-- Name: referrals Salon members insert referrals; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Salon members insert referrals" ON public.referrals FOR INSERT TO authenticated WITH CHECK ((salon_id IN ( SELECT salon_members.salon_id
   FROM public.salon_members
  WHERE (salon_members.user_id = ( SELECT auth.uid() AS uid)))));


--
-- Name: ai_chats Salon members read own chats; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Salon members read own chats" ON public.ai_chats FOR SELECT TO authenticated USING ((salon_id IN ( SELECT salon_members.salon_id
   FROM public.salon_members
  WHERE (salon_members.user_id = ( SELECT auth.uid() AS uid)))));


--
-- Name: customer_photo_consents Salon members read own consents; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Salon members read own consents" ON public.customer_photo_consents FOR SELECT TO authenticated USING ((salon_id IN ( SELECT salon_members.salon_id
   FROM public.salon_members
  WHERE (salon_members.user_id = ( SELECT auth.uid() AS uid)))));


--
-- Name: customer_preferences Salon members read own customer prefs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Salon members read own customer prefs" ON public.customer_preferences FOR SELECT TO authenticated USING ((salon_id IN ( SELECT salon_members.salon_id
   FROM public.salon_members
  WHERE (salon_members.user_id = ( SELECT auth.uid() AS uid)))));


--
-- Name: customer_booking_patterns Salon members read own patterns; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Salon members read own patterns" ON public.customer_booking_patterns FOR SELECT TO authenticated USING ((salon_id IN ( SELECT salon_members.salon_id
   FROM public.salon_members
  WHERE (salon_members.user_id = ( SELECT auth.uid() AS uid)))));


--
-- Name: booking_photos Salon members read own photos; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Salon members read own photos" ON public.booking_photos FOR SELECT TO authenticated USING ((salon_id IN ( SELECT salon_members.salon_id
   FROM public.salon_members
  WHERE (salon_members.user_id = ( SELECT auth.uid() AS uid)))));


--
-- Name: voucher_redemptions Salon members read own redemptions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Salon members read own redemptions" ON public.voucher_redemptions FOR SELECT TO authenticated USING ((salon_id IN ( SELECT salon_members.salon_id
   FROM public.salon_members
  WHERE (salon_members.user_id = ( SELECT auth.uid() AS uid)))));


--
-- Name: referrals Salon members read own referrals; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Salon members read own referrals" ON public.referrals FOR SELECT TO authenticated USING ((salon_id IN ( SELECT salon_members.salon_id
   FROM public.salon_members
  WHERE (salon_members.user_id = ( SELECT auth.uid() AS uid)))));


--
-- Name: vouchers Salon members read own vouchers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Salon members read own vouchers" ON public.vouchers FOR SELECT TO authenticated USING ((salon_id IN ( SELECT salon_members.salon_id
   FROM public.salon_members
  WHERE (salon_members.user_id = ( SELECT auth.uid() AS uid)))));


--
-- Name: ai_upsell_log Salon members read upsell log; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Salon members read upsell log" ON public.ai_upsell_log FOR SELECT TO authenticated USING ((salon_id IN ( SELECT salon_members.salon_id
   FROM public.salon_members
  WHERE (salon_members.user_id = ( SELECT auth.uid() AS uid)))));


--
-- Name: booking_photos Salon members soft-delete own photos; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Salon members soft-delete own photos" ON public.booking_photos FOR DELETE TO authenticated USING ((salon_id IN ( SELECT salon_members.salon_id
   FROM public.salon_members
  WHERE (salon_members.user_id = ( SELECT auth.uid() AS uid)))));


--
-- Name: ai_chats Salon members update own chats; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Salon members update own chats" ON public.ai_chats FOR UPDATE TO authenticated USING ((salon_id IN ( SELECT salon_members.salon_id
   FROM public.salon_members
  WHERE (salon_members.user_id = ( SELECT auth.uid() AS uid)))));


--
-- Name: customer_photo_consents Salon members update own consents; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Salon members update own consents" ON public.customer_photo_consents FOR UPDATE TO authenticated USING ((salon_id IN ( SELECT salon_members.salon_id
   FROM public.salon_members
  WHERE (salon_members.user_id = ( SELECT auth.uid() AS uid)))));


--
-- Name: booking_photos Salon members update own photos; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Salon members update own photos" ON public.booking_photos FOR UPDATE TO authenticated USING ((salon_id IN ( SELECT salon_members.salon_id
   FROM public.salon_members
  WHERE (salon_members.user_id = ( SELECT auth.uid() AS uid)))));


--
-- Name: vouchers Salon members update own vouchers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Salon members update own vouchers" ON public.vouchers FOR UPDATE TO authenticated USING ((salon_id IN ( SELECT salon_members.salon_id
   FROM public.salon_members
  WHERE (salon_members.user_id = ( SELECT auth.uid() AS uid)))));


--
-- Name: referrals Salon members update referrals; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Salon members update referrals" ON public.referrals FOR UPDATE TO authenticated USING ((salon_id IN ( SELECT salon_members.salon_id
   FROM public.salon_members
  WHERE (salon_members.user_id = ( SELECT auth.uid() AS uid)))));


--
-- Name: ai_upsell_log Salon members update upsell log; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Salon members update upsell log" ON public.ai_upsell_log FOR UPDATE TO authenticated USING ((salon_id IN ( SELECT salon_members.salon_id
   FROM public.salon_members
  WHERE (salon_members.user_id = ( SELECT auth.uid() AS uid)))));


--
-- Name: ai_chats Salon members write own chats; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Salon members write own chats" ON public.ai_chats FOR INSERT TO authenticated WITH CHECK ((salon_id IN ( SELECT salon_members.salon_id
   FROM public.salon_members
  WHERE (salon_members.user_id = ( SELECT auth.uid() AS uid)))));


--
-- Name: customer_preferences Salon members write own customer prefs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Salon members write own customer prefs" ON public.customer_preferences TO authenticated USING ((salon_id IN ( SELECT salon_members.salon_id
   FROM public.salon_members
  WHERE (salon_members.user_id = ( SELECT auth.uid() AS uid))))) WITH CHECK ((salon_id IN ( SELECT salon_members.salon_id
   FROM public.salon_members
  WHERE (salon_members.user_id = ( SELECT auth.uid() AS uid)))));


--
-- Name: customer_booking_patterns Salon members write own patterns; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Salon members write own patterns" ON public.customer_booking_patterns TO authenticated USING ((salon_id IN ( SELECT salon_members.salon_id
   FROM public.salon_members
  WHERE (salon_members.user_id = ( SELECT auth.uid() AS uid))))) WITH CHECK ((salon_id IN ( SELECT salon_members.salon_id
   FROM public.salon_members
  WHERE (salon_members.user_id = ( SELECT auth.uid() AS uid)))));


--
-- Name: ai_trend_cache Salon members write own trend cache; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Salon members write own trend cache" ON public.ai_trend_cache TO authenticated USING ((salon_id IN ( SELECT salon_members.salon_id
   FROM public.salon_members
  WHERE (salon_members.user_id = ( SELECT auth.uid() AS uid))))) WITH CHECK ((salon_id IN ( SELECT salon_members.salon_id
   FROM public.salon_members
  WHERE (salon_members.user_id = ( SELECT auth.uid() AS uid)))));


--
-- Name: ai_upsell_log Salon members write upsell log; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Salon members write upsell log" ON public.ai_upsell_log FOR INSERT TO authenticated WITH CHECK ((salon_id IN ( SELECT salon_members.salon_id
   FROM public.salon_members
  WHERE (salon_members.user_id = ( SELECT auth.uid() AS uid)))));


--
-- Name: email_verification_tokens Service role only; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role only" ON public.email_verification_tokens USING ((( SELECT auth.role() AS role) = 'service_role'::text));


--
-- Name: ai_actions_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_actions_log ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_chats; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_chats ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_policy_decisions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_policy_decisions ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_trend_cache; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_trend_cache ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_upsell_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_upsell_log ENABLE ROW LEVEL SECURITY;

--
-- Name: platform_announcements announcements_read_authenticated; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY announcements_read_authenticated ON public.platform_announcements FOR SELECT TO authenticated USING (true);


--
-- Name: staff_services anon read staff_services; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "anon read staff_services" ON public.staff_services FOR SELECT TO anon, authenticated USING (true);


--
-- Name: staff_shifts anon read staff_shifts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "anon read staff_shifts" ON public.staff_shifts FOR SELECT TO anon, authenticated USING (true);


--
-- Name: staff_unavailability anon read staff_unavailability; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "anon read staff_unavailability" ON public.staff_unavailability FOR SELECT TO anon, authenticated USING (true);


--
-- Name: queue_entries anon_read_queue_entries; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY anon_read_queue_entries ON public.queue_entries FOR SELECT TO anon USING ((salon_id IN ( SELECT salons.id
   FROM public.salons
  WHERE (salons.archived_at IS NULL))));


--
-- Name: phone_otp_sessions anon_read_valid_otp_session; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY anon_read_valid_otp_session ON public.phone_otp_sessions FOR SELECT USING (((consumed_at IS NULL) AND (expires_at > now())));


--
-- Name: approval_requests; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.approval_requests ENABLE ROW LEVEL SECURITY;

--
-- Name: superadmin_audit_logs audit_logs_select_for_superadmins; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY audit_logs_select_for_superadmins ON public.superadmin_audit_logs FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.superadmins s
  WHERE ((s.user_id = ( SELECT auth.uid() AS uid)) AND (s.revoked_at IS NULL)))));


--
-- Name: auth_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.auth_events ENABLE ROW LEVEL SECURITY;

--
-- Name: platform_flags authenticated_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY authenticated_read ON public.platform_flags FOR SELECT TO authenticated USING (true);


--
-- Name: booking_addons; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.booking_addons ENABLE ROW LEVEL SECURITY;

--
-- Name: booking_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.booking_events ENABLE ROW LEVEL SECURITY;

--
-- Name: booking_events booking_events_select_owner_senior; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY booking_events_select_owner_senior ON public.booking_events FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.salon_members m
  WHERE ((m.user_id = ( SELECT auth.uid() AS uid)) AND (m.salon_id = booking_events.salon_id) AND (m.role = ANY (ARRAY['owner'::text, 'senior'::text]))))));


--
-- Name: booking_notifications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.booking_notifications ENABLE ROW LEVEL SECURITY;

--
-- Name: booking_photos; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.booking_photos ENABLE ROW LEVEL SECURITY;

--
-- Name: booking_reminder_tokens; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.booking_reminder_tokens ENABLE ROW LEVEL SECURITY;

--
-- Name: booking_waitlist_entries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.booking_waitlist_entries ENABLE ROW LEVEL SECURITY;

--
-- Name: booking_waitlist_entries booking_waitlist_select_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY booking_waitlist_select_owner ON public.booking_waitlist_entries FOR SELECT TO authenticated USING ((salon_id IN ( SELECT salon_members.salon_id
   FROM public.salon_members
  WHERE (salon_members.user_id = ( SELECT auth.uid() AS uid)))));


--
-- Name: bookings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bookings ENABLE ROW LEVEL SECURITY;

--
-- Name: bookings bookings_delete_anon; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bookings_delete_anon ON public.bookings FOR DELETE TO anon USING (false);


--
-- Name: bookings bookings_insert_anon; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bookings_insert_anon ON public.bookings FOR INSERT TO anon WITH CHECK ((EXISTS ( SELECT 1
   FROM public.salons
  WHERE ((salons.id = bookings.salon_id) AND (salons.archived_at IS NULL)))));


--
-- Name: bookings bookings_insert_authenticated; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bookings_insert_authenticated ON public.bookings FOR INSERT TO authenticated WITH CHECK ((salon_id IN ( SELECT salon_members.salon_id
   FROM public.salon_members
  WHERE (salon_members.user_id = ( SELECT auth.uid() AS uid)))));


--
-- Name: bookings bookings_select_anon; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bookings_select_anon ON public.bookings FOR SELECT TO anon USING (false);


--
-- Name: bookings bookings_update_anon; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bookings_update_anon ON public.bookings FOR UPDATE TO anon USING (false) WITH CHECK (false);


--
-- Name: campaign_schedules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.campaign_schedules ENABLE ROW LEVEL SECURITY;

--
-- Name: client_ai_summaries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.client_ai_summaries ENABLE ROW LEVEL SECURITY;

--
-- Name: client_email_optouts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.client_email_optouts ENABLE ROW LEVEL SECURITY;

--
-- Name: client_profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.client_profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: customer_booking_patterns; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.customer_booking_patterns ENABLE ROW LEVEL SECURITY;

--
-- Name: customer_photo_consents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.customer_photo_consents ENABLE ROW LEVEL SECURITY;

--
-- Name: customer_preferences; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.customer_preferences ENABLE ROW LEVEL SECURITY;

--
-- Name: platform_settings deny_all_platform_settings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY deny_all_platform_settings ON public.platform_settings USING (false);


--
-- Name: email_otp_codes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.email_otp_codes ENABLE ROW LEVEL SECURITY;

--
-- Name: email_verification_tokens; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.email_verification_tokens ENABLE ROW LEVEL SECURITY;

--
-- Name: error_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.error_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: error_logs error_logs_superadmin_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY error_logs_superadmin_read ON public.error_logs FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.superadmins s
  WHERE ((s.user_id = ( SELECT auth.uid() AS uid)) AND (s.revoked_at IS NULL)))));


--
-- Name: first_visit_sequences; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.first_visit_sequences ENABLE ROW LEVEL SECURITY;

--
-- Name: loyalty_cards; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.loyalty_cards ENABLE ROW LEVEL SECURITY;

--
-- Name: loyalty_programs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.loyalty_programs ENABLE ROW LEVEL SECURITY;

--
-- Name: loyalty_stamp_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.loyalty_stamp_events ENABLE ROW LEVEL SECURITY;

--
-- Name: staff managers delete staff for own salon; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "managers delete staff for own salon" ON public.staff FOR DELETE TO authenticated USING ((salon_id IN ( SELECT salon_members.salon_id
   FROM public.salon_members
  WHERE ((salon_members.user_id = ( SELECT auth.uid() AS uid)) AND (salon_members.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));


--
-- Name: staff managers insert staff for own salon; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "managers insert staff for own salon" ON public.staff FOR INSERT TO authenticated WITH CHECK ((salon_id IN ( SELECT salon_members.salon_id
   FROM public.salon_members
  WHERE ((salon_members.user_id = ( SELECT auth.uid() AS uid)) AND (salon_members.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));


--
-- Name: staff managers update staff for own salon; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "managers update staff for own salon" ON public.staff FOR UPDATE TO authenticated USING ((salon_id IN ( SELECT salon_members.salon_id
   FROM public.salon_members
  WHERE ((salon_members.user_id = ( SELECT auth.uid() AS uid)) AND (salon_members.role = ANY (ARRAY['owner'::text, 'admin'::text])))))) WITH CHECK ((salon_id IN ( SELECT salon_members.salon_id
   FROM public.salon_members
  WHERE ((salon_members.user_id = ( SELECT auth.uid() AS uid)) AND (salon_members.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));


--
-- Name: salon_resources members write salon_resources; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "members write salon_resources" ON public.salon_resources TO authenticated USING ((salon_id IN ( SELECT sm.salon_id
   FROM public.salon_members sm
  WHERE (sm.user_id = auth.uid())))) WITH CHECK ((salon_id IN ( SELECT sm.salon_id
   FROM public.salon_members sm
  WHERE (sm.user_id = auth.uid()))));


--
-- Name: staff_services members write staff_services; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "members write staff_services" ON public.staff_services TO authenticated USING ((staff_id IN ( SELECT s.id
   FROM (public.staff s
     JOIN public.salon_members m ON ((m.salon_id = s.salon_id)))
  WHERE (m.user_id = ( SELECT auth.uid() AS uid))))) WITH CHECK (((staff_id IN ( SELECT s.id
   FROM (public.staff s
     JOIN public.salon_members m ON ((m.salon_id = s.salon_id)))
  WHERE (m.user_id = ( SELECT auth.uid() AS uid)))) AND (service_id IN ( SELECT sv.id
   FROM (public.services sv
     JOIN public.salon_members m ON ((m.salon_id = sv.salon_id)))
  WHERE (m.user_id = ( SELECT auth.uid() AS uid))))));


--
-- Name: staff_shifts members write staff_shifts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "members write staff_shifts" ON public.staff_shifts TO authenticated USING ((salon_id IN ( SELECT sm.salon_id
   FROM public.salon_members sm
  WHERE (sm.user_id = auth.uid())))) WITH CHECK ((salon_id IN ( SELECT sm.salon_id
   FROM public.salon_members sm
  WHERE (sm.user_id = auth.uid()))));


--
-- Name: staff_unavailability members write staff_unavailability; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "members write staff_unavailability" ON public.staff_unavailability TO authenticated USING ((salon_id IN ( SELECT sm.salon_id
   FROM public.salon_members sm
  WHERE (sm.user_id = auth.uid())))) WITH CHECK ((salon_id IN ( SELECT sm.salon_id
   FROM public.salon_members sm
  WHERE (sm.user_id = auth.uid()))));


--
-- Name: minh_lessons; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.minh_lessons ENABLE ROW LEVEL SECURITY;

--
-- Name: notification_templates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notification_templates ENABLE ROW LEVEL SECURITY;

--
-- Name: otp_send_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.otp_send_log ENABLE ROW LEVEL SECURITY;

--
-- Name: otps; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.otps ENABLE ROW LEVEL SECURITY;

--
-- Name: otps otps_service_role_only; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY otps_service_role_only ON public.otps USING (false) WITH CHECK (false);


--
-- Name: salon_members owner can read own memberships; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "owner can read own memberships" ON public.salon_members FOR SELECT TO authenticated USING ((( SELECT auth.uid() AS uid) = user_id));


--
-- Name: services owner delete services for own salon; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "owner delete services for own salon" ON public.services FOR DELETE TO authenticated USING ((salon_id IN ( SELECT salon_members.salon_id
   FROM public.salon_members
  WHERE (salon_members.user_id = ( SELECT auth.uid() AS uid)))));


--
-- Name: services owner insert services for own salon; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "owner insert services for own salon" ON public.services FOR INSERT TO authenticated WITH CHECK ((salon_id IN ( SELECT salon_members.salon_id
   FROM public.salon_members
  WHERE (salon_members.user_id = ( SELECT auth.uid() AS uid)))));


--
-- Name: loyalty_cards owner manage loyalty_cards; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "owner manage loyalty_cards" ON public.loyalty_cards USING ((salon_id IN ( SELECT salon_members.salon_id
   FROM public.salon_members
  WHERE (salon_members.user_id = ( SELECT auth.uid() AS uid)))));


--
-- Name: loyalty_programs owner manage loyalty_programs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "owner manage loyalty_programs" ON public.loyalty_programs USING ((salon_id IN ( SELECT salon_members.salon_id
   FROM public.salon_members
  WHERE (salon_members.user_id = ( SELECT auth.uid() AS uid)))));


--
-- Name: loyalty_stamp_events owner manage loyalty_stamp_events; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "owner manage loyalty_stamp_events" ON public.loyalty_stamp_events USING ((salon_id IN ( SELECT salon_members.salon_id
   FROM public.salon_members
  WHERE (salon_members.user_id = ( SELECT auth.uid() AS uid)))));


--
-- Name: salons owner read own salon; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "owner read own salon" ON public.salons FOR SELECT TO authenticated USING ((id IN ( SELECT salon_members.salon_id
   FROM public.salon_members
  WHERE (salon_members.user_id = ( SELECT auth.uid() AS uid)))));


--
-- Name: bookings owner read own salon bookings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "owner read own salon bookings" ON public.bookings FOR SELECT TO authenticated USING ((salon_id IN ( SELECT salon_members.salon_id
   FROM public.salon_members
  WHERE (salon_members.user_id = ( SELECT auth.uid() AS uid)))));


--
-- Name: voice_ai_sessions owner read voice sessions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "owner read voice sessions" ON public.voice_ai_sessions FOR SELECT USING ((salon_id IN ( SELECT salon_members.salon_id
   FROM public.salon_members
  WHERE (salon_members.user_id = ( SELECT auth.uid() AS uid)))));


--
-- Name: salons owner update own salon; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "owner update own salon" ON public.salons FOR UPDATE TO authenticated USING ((id IN ( SELECT salon_members.salon_id
   FROM public.salon_members
  WHERE (salon_members.user_id = ( SELECT auth.uid() AS uid))))) WITH CHECK ((id IN ( SELECT salon_members.salon_id
   FROM public.salon_members
  WHERE (salon_members.user_id = ( SELECT auth.uid() AS uid)))));


--
-- Name: bookings owner update own salon bookings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "owner update own salon bookings" ON public.bookings FOR UPDATE TO authenticated USING ((salon_id IN ( SELECT salon_members.salon_id
   FROM public.salon_members
  WHERE (salon_members.user_id = ( SELECT auth.uid() AS uid))))) WITH CHECK ((salon_id IN ( SELECT salon_members.salon_id
   FROM public.salon_members
  WHERE (salon_members.user_id = ( SELECT auth.uid() AS uid)))));


--
-- Name: services owner update services for own salon; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "owner update services for own salon" ON public.services FOR UPDATE TO authenticated USING ((salon_id IN ( SELECT salon_members.salon_id
   FROM public.salon_members
  WHERE (salon_members.user_id = ( SELECT auth.uid() AS uid))))) WITH CHECK ((salon_id IN ( SELECT salon_members.salon_id
   FROM public.salon_members
  WHERE (salon_members.user_id = ( SELECT auth.uid() AS uid)))));


--
-- Name: ai_actions_log owner_read_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_read_own ON public.ai_actions_log FOR SELECT USING ((salon_id IN ( SELECT salon_members.salon_id
   FROM public.salon_members
  WHERE ((salon_members.user_id = auth.uid()) AND (salon_members.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));


--
-- Name: approval_requests owners read own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "owners read own" ON public.approval_requests FOR SELECT USING ((salon_id IN ( SELECT salon_members.salon_id
   FROM public.salon_members
  WHERE ((salon_members.user_id = auth.uid()) AND (salon_members.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));


--
-- Name: minh_lessons owners read own salon + global; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "owners read own salon + global" ON public.minh_lessons FOR SELECT USING (((salon_id IS NULL) OR (salon_id IN ( SELECT salon_members.salon_id
   FROM public.salon_members
  WHERE ((salon_members.user_id = auth.uid()) AND (salon_members.role = ANY (ARRAY['owner'::text, 'admin'::text])))))));


--
-- Name: party_link_change_requests; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.party_link_change_requests ENABLE ROW LEVEL SECURITY;

--
-- Name: party_link_claims; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.party_link_claims ENABLE ROW LEVEL SECURITY;

--
-- Name: party_links; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.party_links ENABLE ROW LEVEL SECURITY;

--
-- Name: payment_disputes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payment_disputes ENABLE ROW LEVEL SECURITY;

--
-- Name: phone_otp_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.phone_otp_sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: platform_announcements; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.platform_announcements ENABLE ROW LEVEL SECURITY;

--
-- Name: platform_feature_flags; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.platform_feature_flags ENABLE ROW LEVEL SECURITY;

--
-- Name: platform_flags; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.platform_flags ENABLE ROW LEVEL SECURITY;

--
-- Name: platform_feature_flags platform_flags_read_authenticated; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY platform_flags_read_authenticated ON public.platform_feature_flags FOR SELECT TO authenticated USING (true);


--
-- Name: platform_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.platform_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: user_presence presence_owner_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY presence_owner_read ON public.user_presence FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.salon_members
  WHERE ((salon_members.salon_id = user_presence.salon_id) AND (salon_members.user_id = auth.uid()) AND (salon_members.role = ANY (ARRAY['owner'::text, 'admin'::text, 'manager'::text]))))));


--
-- Name: user_presence presence_self_upsert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY presence_self_upsert ON public.user_presence USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: promotion_services; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.promotion_services ENABLE ROW LEVEL SECURITY;

--
-- Name: promotions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.promotions ENABLE ROW LEVEL SECURITY;

--
-- Name: loyalty_cards public read own card by phone; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "public read own card by phone" ON public.loyalty_cards FOR SELECT USING (true);


--
-- Name: salons public read salons; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "public read salons" ON public.salons FOR SELECT USING (true);


--
-- Name: services public read services; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "public read services" ON public.services FOR SELECT USING (true);


--
-- Name: staff public read staff; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "public read staff" ON public.staff FOR SELECT USING (true);


--
-- Name: service_combos public_read_active_combos; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY public_read_active_combos ON public.service_combos FOR SELECT USING ((is_active = true));


--
-- Name: promotions public_read_active_promotions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY public_read_active_promotions ON public.promotions FOR SELECT USING (((active = true) AND ((now() >= starts_at) AND (now() <= ends_at))));


--
-- Name: promotion_services public_read_promotion_services; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY public_read_promotion_services ON public.promotion_services FOR SELECT USING (true);


--
-- Name: queue_entries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.queue_entries ENABLE ROW LEVEL SECURITY;

--
-- Name: rate_limits; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;

--
-- Name: service_categories readable_by_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY readable_by_all ON public.service_categories FOR SELECT TO authenticated USING (true);


--
-- Name: referrals; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.referrals ENABLE ROW LEVEL SECURITY;

--
-- Name: register_completion_tokens; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.register_completion_tokens ENABLE ROW LEVEL SECURITY;

--
-- Name: reoptin_sends; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.reoptin_sends ENABLE ROW LEVEL SECURITY;

--
-- Name: reviews; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.reviews ENABLE ROW LEVEL SECURITY;

--
-- Name: reviews reviews_select_by_token; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY reviews_select_by_token ON public.reviews FOR SELECT TO anon, authenticated USING (true);


--
-- Name: salon_client_names; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.salon_client_names ENABLE ROW LEVEL SECURITY;

--
-- Name: salon_client_spend; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.salon_client_spend ENABLE ROW LEVEL SECURITY;

--
-- Name: salon_clients; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.salon_clients ENABLE ROW LEVEL SECURITY;

--
-- Name: salon_custom_domains; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.salon_custom_domains ENABLE ROW LEVEL SECURITY;

--
-- Name: salon_custom_domains salon_custom_domains_member_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY salon_custom_domains_member_all ON public.salon_custom_domains USING ((salon_id IN ( SELECT salon_members.salon_id
   FROM public.salon_members
  WHERE (salon_members.user_id = ( SELECT auth.uid() AS uid))))) WITH CHECK ((salon_id IN ( SELECT salon_members.salon_id
   FROM public.salon_members
  WHERE (salon_members.user_id = ( SELECT auth.uid() AS uid)))));


--
-- Name: salon_invite_tokens; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.salon_invite_tokens ENABLE ROW LEVEL SECURITY;

--
-- Name: website_import_jobs salon_member_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY salon_member_all ON public.website_import_jobs USING ((salon_id IN ( SELECT salon_members.salon_id
   FROM public.salon_members
  WHERE (salon_members.user_id = ( SELECT auth.uid() AS uid)))));


--
-- Name: promotion_services salon_member_manage_promotion_services; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY salon_member_manage_promotion_services ON public.promotion_services USING ((EXISTS ( SELECT 1
   FROM (public.promotions p
     JOIN public.salon_members sm ON ((sm.salon_id = p.salon_id)))
  WHERE ((p.id = promotion_services.promotion_id) AND (sm.user_id = auth.uid()) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'manager'::text]))))));


--
-- Name: promotions salon_member_manage_promotions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY salon_member_manage_promotions ON public.promotions USING ((EXISTS ( SELECT 1
   FROM public.salon_members sm
  WHERE ((sm.salon_id = promotions.salon_id) AND (sm.user_id = auth.uid()) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'manager'::text]))))));


--
-- Name: queue_entries salon_member_manage_queue_entries; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY salon_member_manage_queue_entries ON public.queue_entries USING ((salon_id IN ( SELECT salon_members.salon_id
   FROM public.salon_members
  WHERE (salon_members.user_id = ( SELECT auth.uid() AS uid)))));


--
-- Name: booking_reminder_tokens salon_member_manage_reminder_tokens; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY salon_member_manage_reminder_tokens ON public.booking_reminder_tokens USING ((salon_id IN ( SELECT salon_members.salon_id
   FROM public.salon_members
  WHERE (salon_members.user_id = ( SELECT auth.uid() AS uid)))));


--
-- Name: booking_notifications salon_member_read_notifications; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY salon_member_read_notifications ON public.booking_notifications FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.salon_members sm
  WHERE ((sm.salon_id = booking_notifications.salon_id) AND (sm.user_id = ( SELECT auth.uid() AS uid))))));


--
-- Name: salon_page_sections salon_member_rw; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY salon_member_rw ON public.salon_page_sections USING ((salon_id IN ( SELECT salon_members.salon_id
   FROM public.salon_members
  WHERE (salon_members.user_id = ( SELECT auth.uid() AS uid)))));


--
-- Name: salon_members; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.salon_members ENABLE ROW LEVEL SECURITY;

--
-- Name: service_combos salon_owner_manage_combos; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY salon_owner_manage_combos ON public.service_combos TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.salon_members m
  WHERE ((m.user_id = ( SELECT auth.uid() AS uid)) AND (m.salon_id = service_combos.salon_id) AND (m.role = ANY (ARRAY['owner'::text, 'senior'::text]))))));


--
-- Name: salon_page_sections; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.salon_page_sections ENABLE ROW LEVEL SECURITY;

--
-- Name: salon_page_sections salon_page_sections_public_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY salon_page_sections_public_read ON public.salon_page_sections FOR SELECT TO anon, authenticated USING ((is_visible = true));


--
-- Name: salon_resources; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.salon_resources ENABLE ROW LEVEL SECURITY;

--
-- Name: salons; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.salons ENABLE ROW LEVEL SECURITY;

--
-- Name: scheduled_notifications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.scheduled_notifications ENABLE ROW LEVEL SECURITY;

--
-- Name: first_visit_sequences service role full access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "service role full access" ON public.first_visit_sequences USING ((auth.role() = 'service_role'::text)) WITH CHECK ((auth.role() = 'service_role'::text));


--
-- Name: otps service role only; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "service role only" ON public.otps USING (false);


--
-- Name: register_completion_tokens service role only; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "service role only" ON public.register_completion_tokens USING (false) WITH CHECK (false);


--
-- Name: voice_ai_sessions service role voice sessions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "service role voice sessions" ON public.voice_ai_sessions TO service_role USING (true) WITH CHECK (true);


--
-- Name: minh_lessons service-role only write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "service-role only write" ON public.minh_lessons USING ((auth.role() = 'service_role'::text));


--
-- Name: approval_requests service-role write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "service-role write" ON public.approval_requests USING ((auth.role() = 'service_role'::text));


--
-- Name: service_categories; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.service_categories ENABLE ROW LEVEL SECURITY;

--
-- Name: service_combos; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.service_combos ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_actions_log service_role_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY service_role_all ON public.ai_actions_log USING ((auth.role() = 'service_role'::text));


--
-- Name: square_visit_history service_role_only; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY service_role_only ON public.square_visit_history USING ((auth.role() = 'service_role'::text));


--
-- Name: services; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.services ENABLE ROW LEVEL SECURITY;

--
-- Name: square_integrations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.square_integrations ENABLE ROW LEVEL SECURITY;

--
-- Name: square_visit_history; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.square_visit_history ENABLE ROW LEVEL SECURITY;

--
-- Name: staff; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.staff ENABLE ROW LEVEL SECURITY;

--
-- Name: staff_services; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.staff_services ENABLE ROW LEVEL SECURITY;

--
-- Name: staff_shifts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.staff_shifts ENABLE ROW LEVEL SECURITY;

--
-- Name: staff_unavailability; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.staff_unavailability ENABLE ROW LEVEL SECURITY;

--
-- Name: superadmin_audit_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.superadmin_audit_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: service_categories superadmin_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY superadmin_write ON public.service_categories TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.superadmins
  WHERE (superadmins.user_id = ( SELECT auth.uid() AS uid))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.superadmins
  WHERE (superadmins.user_id = ( SELECT auth.uid() AS uid)))));


--
-- Name: superadmins; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.superadmins ENABLE ROW LEVEL SECURITY;

--
-- Name: platform_flags superadmins_full_access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY superadmins_full_access ON public.platform_flags TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.superadmins
  WHERE (superadmins.user_id = ( SELECT auth.uid() AS uid))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.superadmins
  WHERE (superadmins.user_id = ( SELECT auth.uid() AS uid)))));


--
-- Name: superadmins superadmins_self_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY superadmins_self_read ON public.superadmins FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: system_audit; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.system_audit ENABLE ROW LEVEL SECURITY;

--
-- Name: user_presence; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_presence ENABLE ROW LEVEL SECURITY;

--
-- Name: voice_ai_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.voice_ai_sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: voucher_redemptions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.voucher_redemptions ENABLE ROW LEVEL SECURITY;

--
-- Name: vouchers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.vouchers ENABLE ROW LEVEL SECURITY;

--
-- Name: watchdog_alerts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.watchdog_alerts ENABLE ROW LEVEL SECURITY;

--
-- Name: watchdog_state; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.watchdog_state ENABLE ROW LEVEL SECURITY;

--
-- Name: website_import_jobs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.website_import_jobs ENABLE ROW LEVEL SECURITY;

--
-- Name: winback_suggestions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.winback_suggestions ENABLE ROW LEVEL SECURITY;

--
-- Name: wix_integrations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.wix_integrations ENABLE ROW LEVEL SECURITY;

--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: -
--

REVOKE USAGE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO service_role;


--
-- Name: FUNCTION add_booking_addons(p_booking_id uuid, p_service_ids uuid[]); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.add_booking_addons(p_booking_id uuid, p_service_ids uuid[]) TO anon;
GRANT ALL ON FUNCTION public.add_booking_addons(p_booking_id uuid, p_service_ids uuid[]) TO authenticated;
GRANT ALL ON FUNCTION public.add_booking_addons(p_booking_id uuid, p_service_ids uuid[]) TO service_role;


--
-- Name: FUNCTION add_queue_entry(p_salon_id uuid, p_client_name text, p_client_phone text, p_service_id uuid, p_requested_staff_id uuid, p_client_notes text, p_price_cents integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.add_queue_entry(p_salon_id uuid, p_client_name text, p_client_phone text, p_service_id uuid, p_requested_staff_id uuid, p_client_notes text, p_price_cents integer) TO anon;
GRANT ALL ON FUNCTION public.add_queue_entry(p_salon_id uuid, p_client_name text, p_client_phone text, p_service_id uuid, p_requested_staff_id uuid, p_client_notes text, p_price_cents integer) TO authenticated;
GRANT ALL ON FUNCTION public.add_queue_entry(p_salon_id uuid, p_client_name text, p_client_phone text, p_service_id uuid, p_requested_staff_id uuid, p_client_notes text, p_price_cents integer) TO service_role;


--
-- Name: FUNCTION advance_waitlist_notifications(p_window_minutes integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.advance_waitlist_notifications(p_window_minutes integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.advance_waitlist_notifications(p_window_minutes integer) TO service_role;


--
-- Name: FUNCTION auto_mark_no_shows(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.auto_mark_no_shows() FROM PUBLIC;
GRANT ALL ON FUNCTION public.auto_mark_no_shows() TO service_role;


--
-- Name: FUNCTION auto_stamp_on_booking_complete(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.auto_stamp_on_booking_complete() FROM PUBLIC;
GRANT ALL ON FUNCTION public.auto_stamp_on_booking_complete() TO service_role;


--
-- Name: FUNCTION bump_client_no_show(p_phone text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.bump_client_no_show(p_phone text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.bump_client_no_show(p_phone text) TO service_role;


--
-- Name: FUNCTION cancel_booking_as_customer(p_token_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.cancel_booking_as_customer(p_token_id uuid) TO anon;
GRANT ALL ON FUNCTION public.cancel_booking_as_customer(p_token_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.cancel_booking_as_customer(p_token_id uuid) TO service_role;


--
-- Name: FUNCTION cancel_booking_by_id(p_booking_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.cancel_booking_by_id(p_booking_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.cancel_booking_by_id(p_booking_id uuid) TO service_role;


--
-- Name: FUNCTION canonical_phone(p text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.canonical_phone(p text) TO anon;
GRANT ALL ON FUNCTION public.canonical_phone(p text) TO authenticated;
GRANT ALL ON FUNCTION public.canonical_phone(p text) TO service_role;


--
-- Name: FUNCTION check_group_slots_available(p_slots jsonb); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.check_group_slots_available(p_slots jsonb) TO anon;
GRANT ALL ON FUNCTION public.check_group_slots_available(p_slots jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.check_group_slots_available(p_slots jsonb) TO service_role;


--
-- Name: FUNCTION claim_party_slot(p_token text, p_claim_id uuid, p_member_name text, p_member_phone text, p_reminder_opted_in boolean); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.claim_party_slot(p_token text, p_claim_id uuid, p_member_name text, p_member_phone text, p_reminder_opted_in boolean) TO anon;
GRANT ALL ON FUNCTION public.claim_party_slot(p_token text, p_claim_id uuid, p_member_name text, p_member_phone text, p_reminder_opted_in boolean) TO authenticated;
GRANT ALL ON FUNCTION public.claim_party_slot(p_token text, p_claim_id uuid, p_member_name text, p_member_phone text, p_reminder_opted_in boolean) TO service_role;


--
-- Name: FUNCTION claim_salon_memberships_by_email(p_user_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.claim_salon_memberships_by_email(p_user_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.claim_salon_memberships_by_email(p_user_id uuid) TO service_role;


--
-- Name: FUNCTION claim_waitlist_slot(p_claim_token uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.claim_waitlist_slot(p_claim_token uuid) TO anon;
GRANT ALL ON FUNCTION public.claim_waitlist_slot(p_claim_token uuid) TO authenticated;
GRANT ALL ON FUNCTION public.claim_waitlist_slot(p_claim_token uuid) TO service_role;


--
-- Name: FUNCTION cleanup_test_salons(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.cleanup_test_salons() FROM PUBLIC;
GRANT ALL ON FUNCTION public.cleanup_test_salons() TO service_role;


--
-- Name: FUNCTION compute_no_show_risk(p_no_show_count integer, p_visit_count integer, p_subtotal_cents integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.compute_no_show_risk(p_no_show_count integer, p_visit_count integer, p_subtotal_cents integer) TO anon;
GRANT ALL ON FUNCTION public.compute_no_show_risk(p_no_show_count integer, p_visit_count integer, p_subtotal_cents integer) TO authenticated;
GRANT ALL ON FUNCTION public.compute_no_show_risk(p_no_show_count integer, p_visit_count integer, p_subtotal_cents integer) TO service_role;


--
-- Name: FUNCTION confirm_booking_as_customer(p_token_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.confirm_booking_as_customer(p_token_id uuid) TO anon;
GRANT ALL ON FUNCTION public.confirm_booking_as_customer(p_token_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.confirm_booking_as_customer(p_token_id uuid) TO service_role;


--
-- Name: FUNCTION confirm_booking_with_otp(p_booking_id uuid, p_otp_session_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.confirm_booking_with_otp(p_booking_id uuid, p_otp_session_id uuid) TO anon;
GRANT ALL ON FUNCTION public.confirm_booking_with_otp(p_booking_id uuid, p_otp_session_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.confirm_booking_with_otp(p_booking_id uuid, p_otp_session_id uuid) TO service_role;


--
-- Name: FUNCTION confirm_party_member(p_booking_id uuid, p_token text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.confirm_party_member(p_booking_id uuid, p_token text) TO anon;
GRANT ALL ON FUNCTION public.confirm_party_member(p_booking_id uuid, p_token text) TO authenticated;
GRANT ALL ON FUNCTION public.confirm_party_member(p_booking_id uuid, p_token text) TO service_role;


--
-- Name: FUNCTION create_public_booking(p_salon_id uuid, p_service_id uuid, p_staff_id uuid, p_client_name text, p_client_phone text, p_start_time_utc timestamp with time zone, p_end_time_utc timestamp with time zone, p_status text, p_price_cents integer, p_client_notes text, p_addon_service_id uuid, p_addon_price_cents integer, p_client_email text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.create_public_booking(p_salon_id uuid, p_service_id uuid, p_staff_id uuid, p_client_name text, p_client_phone text, p_start_time_utc timestamp with time zone, p_end_time_utc timestamp with time zone, p_status text, p_price_cents integer, p_client_notes text, p_addon_service_id uuid, p_addon_price_cents integer, p_client_email text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.create_public_booking(p_salon_id uuid, p_service_id uuid, p_staff_id uuid, p_client_name text, p_client_phone text, p_start_time_utc timestamp with time zone, p_end_time_utc timestamp with time zone, p_status text, p_price_cents integer, p_client_notes text, p_addon_service_id uuid, p_addon_price_cents integer, p_client_email text) TO anon;
GRANT ALL ON FUNCTION public.create_public_booking(p_salon_id uuid, p_service_id uuid, p_staff_id uuid, p_client_name text, p_client_phone text, p_start_time_utc timestamp with time zone, p_end_time_utc timestamp with time zone, p_status text, p_price_cents integer, p_client_notes text, p_addon_service_id uuid, p_addon_price_cents integer, p_client_email text) TO authenticated;
GRANT ALL ON FUNCTION public.create_public_booking(p_salon_id uuid, p_service_id uuid, p_staff_id uuid, p_client_name text, p_client_phone text, p_start_time_utc timestamp with time zone, p_end_time_utc timestamp with time zone, p_status text, p_price_cents integer, p_client_notes text, p_addon_service_id uuid, p_addon_price_cents integer, p_client_email text) TO service_role;


--
-- Name: FUNCTION create_public_waitlist_entry(p_salon_id uuid, p_service_id uuid, p_staff_id uuid, p_booking_date date, p_preferred_slot_label text, p_client_name text, p_client_phone text, p_source text, p_client_email text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.create_public_waitlist_entry(p_salon_id uuid, p_service_id uuid, p_staff_id uuid, p_booking_date date, p_preferred_slot_label text, p_client_name text, p_client_phone text, p_source text, p_client_email text) TO anon;
GRANT ALL ON FUNCTION public.create_public_waitlist_entry(p_salon_id uuid, p_service_id uuid, p_staff_id uuid, p_booking_date date, p_preferred_slot_label text, p_client_name text, p_client_phone text, p_source text, p_client_email text) TO authenticated;
GRANT ALL ON FUNCTION public.create_public_waitlist_entry(p_salon_id uuid, p_service_id uuid, p_staff_id uuid, p_booking_date date, p_preferred_slot_label text, p_client_name text, p_client_phone text, p_source text, p_client_email text) TO service_role;


--
-- Name: FUNCTION create_referral_code(p_salon_id uuid, p_referrer_phone text, p_referrer_reward integer, p_referee_reward integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.create_referral_code(p_salon_id uuid, p_referrer_phone text, p_referrer_reward integer, p_referee_reward integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.create_referral_code(p_salon_id uuid, p_referrer_phone text, p_referrer_reward integer, p_referee_reward integer) TO service_role;


--
-- Name: FUNCTION decline_party_member(p_booking_id uuid, p_token text, p_suggested_name text, p_suggested_phone text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.decline_party_member(p_booking_id uuid, p_token text, p_suggested_name text, p_suggested_phone text) TO anon;
GRANT ALL ON FUNCTION public.decline_party_member(p_booking_id uuid, p_token text, p_suggested_name text, p_suggested_phone text) TO authenticated;
GRANT ALL ON FUNCTION public.decline_party_member(p_booking_id uuid, p_token text, p_suggested_name text, p_suggested_phone text) TO service_role;


--
-- Name: FUNCTION determine_booking_verification(p_salon_id uuid, p_client_phone text, p_service_ids uuid[], p_subtotal_cents integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.determine_booking_verification(p_salon_id uuid, p_client_phone text, p_service_ids uuid[], p_subtotal_cents integer) TO anon;
GRANT ALL ON FUNCTION public.determine_booking_verification(p_salon_id uuid, p_client_phone text, p_service_ids uuid[], p_subtotal_cents integer) TO authenticated;
GRANT ALL ON FUNCTION public.determine_booking_verification(p_salon_id uuid, p_client_phone text, p_service_ids uuid[], p_subtotal_cents integer) TO service_role;


--
-- Name: FUNCTION determine_booking_verification(p_salon_id uuid, p_client_phone text, p_service_ids uuid[], p_subtotal_cents integer, p_has_email boolean); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.determine_booking_verification(p_salon_id uuid, p_client_phone text, p_service_ids uuid[], p_subtotal_cents integer, p_has_email boolean) TO anon;
GRANT ALL ON FUNCTION public.determine_booking_verification(p_salon_id uuid, p_client_phone text, p_service_ids uuid[], p_subtotal_cents integer, p_has_email boolean) TO authenticated;
GRANT ALL ON FUNCTION public.determine_booking_verification(p_salon_id uuid, p_client_phone text, p_service_ids uuid[], p_subtotal_cents integer, p_has_email boolean) TO service_role;


--
-- Name: FUNCTION get_booking_client_snapshot(p_salon_id uuid, p_phone text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_booking_client_snapshot(p_salon_id uuid, p_phone text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_booking_client_snapshot(p_salon_id uuid, p_phone text) TO anon;
GRANT ALL ON FUNCTION public.get_booking_client_snapshot(p_salon_id uuid, p_phone text) TO authenticated;
GRANT ALL ON FUNCTION public.get_booking_client_snapshot(p_salon_id uuid, p_phone text) TO service_role;


--
-- Name: FUNCTION get_host_groups(p_salon_id uuid, p_phone text, p_limit integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_host_groups(p_salon_id uuid, p_phone text, p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_host_groups(p_salon_id uuid, p_phone text, p_limit integer) TO service_role;


--
-- Name: FUNCTION get_host_stats(p_salon_id uuid, p_phone text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_host_stats(p_salon_id uuid, p_phone text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_host_stats(p_salon_id uuid, p_phone text) TO service_role;


--
-- Name: FUNCTION get_salon_queue(p_salon_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_salon_queue(p_salon_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_salon_queue(p_salon_id uuid) TO service_role;


--
-- Name: FUNCTION increment_voice_session_if_under_limit(p_salon_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.increment_voice_session_if_under_limit(p_salon_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.increment_voice_session_if_under_limit(p_salon_id uuid) TO service_role;


--
-- Name: FUNCTION increment_voucher_used_count(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.increment_voucher_used_count() TO anon;
GRANT ALL ON FUNCTION public.increment_voucher_used_count() TO authenticated;
GRANT ALL ON FUNCTION public.increment_voucher_used_count() TO service_role;


--
-- Name: FUNCTION insert_group_bookings(p_bookings jsonb); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.insert_group_bookings(p_bookings jsonb) TO anon;
GRANT ALL ON FUNCTION public.insert_group_bookings(p_bookings jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.insert_group_bookings(p_bookings jsonb) TO service_role;


--
-- Name: FUNCTION list_salon_client_identities(p_salon_id uuid, p_limit integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.list_salon_client_identities(p_salon_id uuid, p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.list_salon_client_identities(p_salon_id uuid, p_limit integer) TO service_role;


--
-- Name: FUNCTION log_error(p_fingerprint text, p_level text, p_message text, p_surface text, p_route text, p_salon_id uuid, p_user_id uuid, p_stack text, p_context jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.log_error(p_fingerprint text, p_level text, p_message text, p_surface text, p_route text, p_salon_id uuid, p_user_id uuid, p_stack text, p_context jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.log_error(p_fingerprint text, p_level text, p_message text, p_surface text, p_route text, p_salon_id uuid, p_user_id uuid, p_stack text, p_context jsonb) TO service_role;


--
-- Name: FUNCTION log_system_audit(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.log_system_audit() TO anon;
GRANT ALL ON FUNCTION public.log_system_audit() TO authenticated;
GRANT ALL ON FUNCTION public.log_system_audit() TO service_role;


--
-- Name: FUNCTION merge_client_profiles(p_keep_id uuid, p_drop_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.merge_client_profiles(p_keep_id uuid, p_drop_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.merge_client_profiles(p_keep_id uuid, p_drop_id uuid) TO service_role;


--
-- Name: FUNCTION notify_waitlist_for_no_show(p_booking_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.notify_waitlist_for_no_show(p_booking_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.notify_waitlist_for_no_show(p_booking_id uuid) TO service_role;


--
-- Name: FUNCTION public_booking_occupancy_for_range(p_salon_id uuid, p_start timestamp with time zone, p_end timestamp with time zone); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.public_booking_occupancy_for_range(p_salon_id uuid, p_start timestamp with time zone, p_end timestamp with time zone) TO anon;
GRANT ALL ON FUNCTION public.public_booking_occupancy_for_range(p_salon_id uuid, p_start timestamp with time zone, p_end timestamp with time zone) TO authenticated;
GRANT ALL ON FUNCTION public.public_booking_occupancy_for_range(p_salon_id uuid, p_start timestamp with time zone, p_end timestamp with time zone) TO service_role;


--
-- Name: FUNCTION public_resolve_domain(p_host text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.public_resolve_domain(p_host text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.public_resolve_domain(p_host text) TO anon;
GRANT ALL ON FUNCTION public.public_resolve_domain(p_host text) TO authenticated;
GRANT ALL ON FUNCTION public.public_resolve_domain(p_host text) TO service_role;


--
-- Name: FUNCTION rate_limit_hit(p_key text, p_limit integer, p_window_seconds integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rate_limit_hit(p_key text, p_limit integer, p_window_seconds integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rate_limit_hit(p_key text, p_limit integer, p_window_seconds integer) TO service_role;


--
-- Name: FUNCTION rebook_due_candidates(p_salon_id uuid, p_min_visits integer, p_lookahead_days integer, p_overdue_days integer, p_limit integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.rebook_due_candidates(p_salon_id uuid, p_min_visits integer, p_lookahead_days integer, p_overdue_days integer, p_limit integer) TO anon;
GRANT ALL ON FUNCTION public.rebook_due_candidates(p_salon_id uuid, p_min_visits integer, p_lookahead_days integer, p_overdue_days integer, p_limit integer) TO authenticated;
GRANT ALL ON FUNCTION public.rebook_due_candidates(p_salon_id uuid, p_min_visits integer, p_lookahead_days integer, p_overdue_days integer, p_limit integer) TO service_role;


--
-- Name: FUNCTION reschedule_booking_as_customer(p_token_id uuid, p_new_start_utc timestamp with time zone, p_new_end_utc timestamp with time zone); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.reschedule_booking_as_customer(p_token_id uuid, p_new_start_utc timestamp with time zone, p_new_end_utc timestamp with time zone) TO anon;
GRANT ALL ON FUNCTION public.reschedule_booking_as_customer(p_token_id uuid, p_new_start_utc timestamp with time zone, p_new_end_utc timestamp with time zone) TO authenticated;
GRANT ALL ON FUNCTION public.reschedule_booking_as_customer(p_token_id uuid, p_new_start_utc timestamp with time zone, p_new_end_utc timestamp with time zone) TO service_role;


--
-- Name: FUNCTION resolve_client_profile(p_phone text, p_name text, p_email text, p_preferred_staff_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.resolve_client_profile(p_phone text, p_name text, p_email text, p_preferred_staff_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.resolve_client_profile(p_phone text, p_name text, p_email text, p_preferred_staff_id uuid) TO service_role;


--
-- Name: FUNCTION salon_has_staff_services(p_salon_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.salon_has_staff_services(p_salon_id uuid) TO anon;
GRANT ALL ON FUNCTION public.salon_has_staff_services(p_salon_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.salon_has_staff_services(p_salon_id uuid) TO service_role;


--
-- Name: FUNCTION salon_multi_name_phones(p_salon_id uuid, p_limit integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.salon_multi_name_phones(p_salon_id uuid, p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.salon_multi_name_phones(p_salon_id uuid, p_limit integer) TO service_role;


--
-- Name: FUNCTION search_salon_client_typeahead(p_salon_id uuid, p_query text, p_limit integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.search_salon_client_typeahead(p_salon_id uuid, p_query text, p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.search_salon_client_typeahead(p_salon_id uuid, p_query text, p_limit integer) TO service_role;


--
-- Name: FUNCTION search_salon_clients(p_salon_id uuid, p_search text, p_limit integer, p_offset integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.search_salon_clients(p_salon_id uuid, p_search text, p_limit integer, p_offset integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.search_salon_clients(p_salon_id uuid, p_search text, p_limit integer, p_offset integer) TO service_role;


--
-- Name: FUNCTION seed_default_page_sections(p_salon_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.seed_default_page_sections(p_salon_id uuid) TO anon;
GRANT ALL ON FUNCTION public.seed_default_page_sections(p_salon_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.seed_default_page_sections(p_salon_id uuid) TO service_role;


--
-- Name: FUNCTION set_updated_at(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.set_updated_at() TO anon;
GRANT ALL ON FUNCTION public.set_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.set_updated_at() TO service_role;


--
-- Name: FUNCTION staff_services_same_salon_trg(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.staff_services_same_salon_trg() TO anon;
GRANT ALL ON FUNCTION public.staff_services_same_salon_trg() TO authenticated;
GRANT ALL ON FUNCTION public.staff_services_same_salon_trg() TO service_role;


--
-- Name: FUNCTION tg_canon_client_phone(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.tg_canon_client_phone() TO anon;
GRANT ALL ON FUNCTION public.tg_canon_client_phone() TO authenticated;
GRANT ALL ON FUNCTION public.tg_canon_client_phone() TO service_role;


--
-- Name: FUNCTION tg_canon_member_phone(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.tg_canon_member_phone() TO anon;
GRANT ALL ON FUNCTION public.tg_canon_member_phone() TO authenticated;
GRANT ALL ON FUNCTION public.tg_canon_member_phone() TO service_role;


--
-- Name: FUNCTION tg_canon_phone(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.tg_canon_phone() TO anon;
GRANT ALL ON FUNCTION public.tg_canon_phone() TO authenticated;
GRANT ALL ON FUNCTION public.tg_canon_phone() TO service_role;


--
-- Name: FUNCTION tg_canon_voucher_phones(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.tg_canon_voucher_phones() TO anon;
GRANT ALL ON FUNCTION public.tg_canon_voucher_phones() TO authenticated;
GRANT ALL ON FUNCTION public.tg_canon_voucher_phones() TO service_role;


--
-- Name: FUNCTION top_salon_hosts(p_salon_id uuid, p_limit integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.top_salon_hosts(p_salon_id uuid, p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.top_salon_hosts(p_salon_id uuid, p_limit integer) TO service_role;


--
-- Name: FUNCTION touch_booking_patterns_updated_at(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.touch_booking_patterns_updated_at() TO anon;
GRANT ALL ON FUNCTION public.touch_booking_patterns_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.touch_booking_patterns_updated_at() TO service_role;


--
-- Name: FUNCTION touch_customer_photo_consents_updated_at(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.touch_customer_photo_consents_updated_at() TO anon;
GRANT ALL ON FUNCTION public.touch_customer_photo_consents_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.touch_customer_photo_consents_updated_at() TO service_role;


--
-- Name: FUNCTION touch_customer_preferences_updated_at(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.touch_customer_preferences_updated_at() TO anon;
GRANT ALL ON FUNCTION public.touch_customer_preferences_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.touch_customer_preferences_updated_at() TO service_role;


--
-- Name: FUNCTION touch_referrals_updated_at(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.touch_referrals_updated_at() TO anon;
GRANT ALL ON FUNCTION public.touch_referrals_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.touch_referrals_updated_at() TO service_role;


--
-- Name: FUNCTION touch_vouchers_updated_at(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.touch_vouchers_updated_at() TO anon;
GRANT ALL ON FUNCTION public.touch_vouchers_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.touch_vouchers_updated_at() TO service_role;


--
-- Name: FUNCTION unbump_client_no_show(p_phone text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.unbump_client_no_show(p_phone text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.unbump_client_no_show(p_phone text) TO service_role;


--
-- Name: FUNCTION update_party_claim_details(p_token text, p_claim_id uuid, p_member_name text, p_member_phone text, p_reminder_opted_in boolean); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.update_party_claim_details(p_token text, p_claim_id uuid, p_member_name text, p_member_phone text, p_reminder_opted_in boolean) TO anon;
GRANT ALL ON FUNCTION public.update_party_claim_details(p_token text, p_claim_id uuid, p_member_name text, p_member_phone text, p_reminder_opted_in boolean) TO authenticated;
GRANT ALL ON FUNCTION public.update_party_claim_details(p_token text, p_claim_id uuid, p_member_name text, p_member_phone text, p_reminder_opted_in boolean) TO service_role;


--
-- Name: FUNCTION update_queue_entry_status(p_id uuid, p_status text, p_assigned_staff_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.update_queue_entry_status(p_id uuid, p_status text, p_assigned_staff_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.update_queue_entry_status(p_id uuid, p_status text, p_assigned_staff_id uuid) TO service_role;


--
-- Name: FUNCTION update_salon_page_sections_updated_at(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.update_salon_page_sections_updated_at() TO anon;
GRANT ALL ON FUNCTION public.update_salon_page_sections_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.update_salon_page_sections_updated_at() TO service_role;


--
-- Name: FUNCTION update_website_import_jobs_updated_at(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.update_website_import_jobs_updated_at() TO anon;
GRANT ALL ON FUNCTION public.update_website_import_jobs_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.update_website_import_jobs_updated_at() TO service_role;


--
-- Name: FUNCTION winback_candidates(p_salon_id uuid, p_min_visits integer, p_lapse_days integer, p_max_days integer, p_limit integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.winback_candidates(p_salon_id uuid, p_min_visits integer, p_lapse_days integer, p_max_days integer, p_limit integer) TO anon;
GRANT ALL ON FUNCTION public.winback_candidates(p_salon_id uuid, p_min_visits integer, p_lapse_days integer, p_max_days integer, p_limit integer) TO authenticated;
GRANT ALL ON FUNCTION public.winback_candidates(p_salon_id uuid, p_min_visits integer, p_lapse_days integer, p_max_days integer, p_limit integer) TO service_role;


--
-- Name: TABLE ai_actions_log; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.ai_actions_log TO anon;
GRANT ALL ON TABLE public.ai_actions_log TO authenticated;
GRANT ALL ON TABLE public.ai_actions_log TO service_role;


--
-- Name: TABLE ai_chats; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.ai_chats TO anon;
GRANT ALL ON TABLE public.ai_chats TO authenticated;
GRANT ALL ON TABLE public.ai_chats TO service_role;


--
-- Name: TABLE ai_policy_decisions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.ai_policy_decisions TO anon;
GRANT ALL ON TABLE public.ai_policy_decisions TO authenticated;
GRANT ALL ON TABLE public.ai_policy_decisions TO service_role;


--
-- Name: TABLE ai_trend_cache; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.ai_trend_cache TO anon;
GRANT ALL ON TABLE public.ai_trend_cache TO authenticated;
GRANT ALL ON TABLE public.ai_trend_cache TO service_role;


--
-- Name: TABLE ai_upsell_log; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.ai_upsell_log TO anon;
GRANT ALL ON TABLE public.ai_upsell_log TO authenticated;
GRANT ALL ON TABLE public.ai_upsell_log TO service_role;


--
-- Name: TABLE approval_requests; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.approval_requests TO anon;
GRANT ALL ON TABLE public.approval_requests TO authenticated;
GRANT ALL ON TABLE public.approval_requests TO service_role;


--
-- Name: TABLE auth_events; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.auth_events TO anon;
GRANT ALL ON TABLE public.auth_events TO authenticated;
GRANT ALL ON TABLE public.auth_events TO service_role;


--
-- Name: TABLE booking_addons; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.booking_addons TO anon;
GRANT ALL ON TABLE public.booking_addons TO authenticated;
GRANT ALL ON TABLE public.booking_addons TO service_role;


--
-- Name: TABLE booking_events; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.booking_events TO anon;
GRANT ALL ON TABLE public.booking_events TO authenticated;
GRANT ALL ON TABLE public.booking_events TO service_role;


--
-- Name: TABLE booking_notifications; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.booking_notifications TO anon;
GRANT ALL ON TABLE public.booking_notifications TO authenticated;
GRANT ALL ON TABLE public.booking_notifications TO service_role;


--
-- Name: TABLE booking_photos; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.booking_photos TO anon;
GRANT ALL ON TABLE public.booking_photos TO authenticated;
GRANT ALL ON TABLE public.booking_photos TO service_role;


--
-- Name: TABLE booking_reminder_tokens; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.booking_reminder_tokens TO anon;
GRANT ALL ON TABLE public.booking_reminder_tokens TO authenticated;
GRANT ALL ON TABLE public.booking_reminder_tokens TO service_role;


--
-- Name: TABLE booking_waitlist_entries; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.booking_waitlist_entries TO anon;
GRANT ALL ON TABLE public.booking_waitlist_entries TO authenticated;
GRANT ALL ON TABLE public.booking_waitlist_entries TO service_role;


--
-- Name: TABLE bookings; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.bookings TO anon;
GRANT ALL ON TABLE public.bookings TO authenticated;
GRANT ALL ON TABLE public.bookings TO service_role;


--
-- Name: TABLE campaign_schedules; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.campaign_schedules TO anon;
GRANT ALL ON TABLE public.campaign_schedules TO authenticated;
GRANT ALL ON TABLE public.campaign_schedules TO service_role;


--
-- Name: TABLE client_ai_summaries; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.client_ai_summaries TO service_role;


--
-- Name: TABLE client_email_optouts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.client_email_optouts TO anon;
GRANT ALL ON TABLE public.client_email_optouts TO authenticated;
GRANT ALL ON TABLE public.client_email_optouts TO service_role;


--
-- Name: TABLE client_profiles; Type: ACL; Schema: public; Owner: -
--

GRANT REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.client_profiles TO anon;
GRANT REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.client_profiles TO authenticated;
GRANT ALL ON TABLE public.client_profiles TO service_role;


--
-- Name: COLUMN client_profiles.phone; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(phone) ON TABLE public.client_profiles TO anon;
GRANT INSERT(phone) ON TABLE public.client_profiles TO authenticated;


--
-- Name: COLUMN client_profiles.name; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(name),UPDATE(name) ON TABLE public.client_profiles TO anon;
GRANT INSERT(name),UPDATE(name) ON TABLE public.client_profiles TO authenticated;


--
-- Name: COLUMN client_profiles.preferred_staff_id; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(preferred_staff_id),UPDATE(preferred_staff_id) ON TABLE public.client_profiles TO anon;
GRANT INSERT(preferred_staff_id),UPDATE(preferred_staff_id) ON TABLE public.client_profiles TO authenticated;


--
-- Name: COLUMN client_profiles.last_service_date; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(last_service_date),UPDATE(last_service_date) ON TABLE public.client_profiles TO anon;
GRANT INSERT(last_service_date),UPDATE(last_service_date) ON TABLE public.client_profiles TO authenticated;


--
-- Name: COLUMN client_profiles.visit_count; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(visit_count),UPDATE(visit_count) ON TABLE public.client_profiles TO anon;
GRANT INSERT(visit_count),UPDATE(visit_count) ON TABLE public.client_profiles TO authenticated;


--
-- Name: TABLE customer_booking_patterns; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.customer_booking_patterns TO anon;
GRANT ALL ON TABLE public.customer_booking_patterns TO authenticated;
GRANT ALL ON TABLE public.customer_booking_patterns TO service_role;


--
-- Name: TABLE customer_photo_consents; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.customer_photo_consents TO anon;
GRANT ALL ON TABLE public.customer_photo_consents TO authenticated;
GRANT ALL ON TABLE public.customer_photo_consents TO service_role;


--
-- Name: TABLE customer_preferences; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.customer_preferences TO anon;
GRANT ALL ON TABLE public.customer_preferences TO authenticated;
GRANT ALL ON TABLE public.customer_preferences TO service_role;


--
-- Name: TABLE email_otp_codes; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.email_otp_codes TO anon;
GRANT ALL ON TABLE public.email_otp_codes TO authenticated;
GRANT ALL ON TABLE public.email_otp_codes TO service_role;


--
-- Name: TABLE email_verification_tokens; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.email_verification_tokens TO anon;
GRANT ALL ON TABLE public.email_verification_tokens TO authenticated;
GRANT ALL ON TABLE public.email_verification_tokens TO service_role;


--
-- Name: TABLE error_logs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.error_logs TO anon;
GRANT ALL ON TABLE public.error_logs TO authenticated;
GRANT ALL ON TABLE public.error_logs TO service_role;


--
-- Name: TABLE first_visit_sequences; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.first_visit_sequences TO anon;
GRANT ALL ON TABLE public.first_visit_sequences TO authenticated;
GRANT ALL ON TABLE public.first_visit_sequences TO service_role;


--
-- Name: TABLE loyalty_cards; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.loyalty_cards TO anon;
GRANT ALL ON TABLE public.loyalty_cards TO authenticated;
GRANT ALL ON TABLE public.loyalty_cards TO service_role;


--
-- Name: TABLE loyalty_programs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.loyalty_programs TO anon;
GRANT ALL ON TABLE public.loyalty_programs TO authenticated;
GRANT ALL ON TABLE public.loyalty_programs TO service_role;


--
-- Name: TABLE loyalty_stamp_events; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.loyalty_stamp_events TO anon;
GRANT ALL ON TABLE public.loyalty_stamp_events TO authenticated;
GRANT ALL ON TABLE public.loyalty_stamp_events TO service_role;


--
-- Name: TABLE minh_lessons; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.minh_lessons TO anon;
GRANT ALL ON TABLE public.minh_lessons TO authenticated;
GRANT ALL ON TABLE public.minh_lessons TO service_role;


--
-- Name: TABLE notification_templates; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.notification_templates TO anon;
GRANT ALL ON TABLE public.notification_templates TO authenticated;
GRANT ALL ON TABLE public.notification_templates TO service_role;


--
-- Name: TABLE otp_send_log; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.otp_send_log TO service_role;


--
-- Name: TABLE otps; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.otps TO anon;
GRANT ALL ON TABLE public.otps TO authenticated;
GRANT ALL ON TABLE public.otps TO service_role;


--
-- Name: TABLE party_link_change_requests; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.party_link_change_requests TO anon;
GRANT ALL ON TABLE public.party_link_change_requests TO authenticated;
GRANT ALL ON TABLE public.party_link_change_requests TO service_role;


--
-- Name: TABLE party_link_claims; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.party_link_claims TO anon;
GRANT ALL ON TABLE public.party_link_claims TO authenticated;
GRANT ALL ON TABLE public.party_link_claims TO service_role;


--
-- Name: TABLE party_links; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.party_links TO anon;
GRANT ALL ON TABLE public.party_links TO authenticated;
GRANT ALL ON TABLE public.party_links TO service_role;


--
-- Name: TABLE payment_disputes; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.payment_disputes TO service_role;


--
-- Name: TABLE phone_otp_sessions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.phone_otp_sessions TO anon;
GRANT ALL ON TABLE public.phone_otp_sessions TO authenticated;
GRANT ALL ON TABLE public.phone_otp_sessions TO service_role;


--
-- Name: TABLE platform_announcements; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.platform_announcements TO anon;
GRANT ALL ON TABLE public.platform_announcements TO authenticated;
GRANT ALL ON TABLE public.platform_announcements TO service_role;


--
-- Name: TABLE platform_feature_flags; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.platform_feature_flags TO anon;
GRANT ALL ON TABLE public.platform_feature_flags TO authenticated;
GRANT ALL ON TABLE public.platform_feature_flags TO service_role;


--
-- Name: TABLE platform_flags; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.platform_flags TO anon;
GRANT ALL ON TABLE public.platform_flags TO authenticated;
GRANT ALL ON TABLE public.platform_flags TO service_role;


--
-- Name: TABLE platform_settings; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.platform_settings TO anon;
GRANT ALL ON TABLE public.platform_settings TO authenticated;
GRANT ALL ON TABLE public.platform_settings TO service_role;


--
-- Name: TABLE promotion_services; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.promotion_services TO anon;
GRANT ALL ON TABLE public.promotion_services TO authenticated;
GRANT ALL ON TABLE public.promotion_services TO service_role;


--
-- Name: TABLE promotions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.promotions TO anon;
GRANT ALL ON TABLE public.promotions TO authenticated;
GRANT ALL ON TABLE public.promotions TO service_role;


--
-- Name: TABLE queue_entries; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.queue_entries TO anon;
GRANT ALL ON TABLE public.queue_entries TO authenticated;
GRANT ALL ON TABLE public.queue_entries TO service_role;


--
-- Name: TABLE rate_limits; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.rate_limits TO service_role;


--
-- Name: TABLE referrals; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.referrals TO anon;
GRANT ALL ON TABLE public.referrals TO authenticated;
GRANT ALL ON TABLE public.referrals TO service_role;


--
-- Name: TABLE register_completion_tokens; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.register_completion_tokens TO anon;
GRANT ALL ON TABLE public.register_completion_tokens TO authenticated;
GRANT ALL ON TABLE public.register_completion_tokens TO service_role;


--
-- Name: TABLE reoptin_sends; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.reoptin_sends TO anon;
GRANT ALL ON TABLE public.reoptin_sends TO authenticated;
GRANT ALL ON TABLE public.reoptin_sends TO service_role;


--
-- Name: TABLE reviews; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.reviews TO anon;
GRANT ALL ON TABLE public.reviews TO authenticated;
GRANT ALL ON TABLE public.reviews TO service_role;


--
-- Name: TABLE salon_client_names; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.salon_client_names TO anon;
GRANT ALL ON TABLE public.salon_client_names TO authenticated;
GRANT ALL ON TABLE public.salon_client_names TO service_role;


--
-- Name: TABLE salon_client_spend; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.salon_client_spend TO anon;
GRANT ALL ON TABLE public.salon_client_spend TO authenticated;
GRANT ALL ON TABLE public.salon_client_spend TO service_role;


--
-- Name: TABLE salon_clients; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.salon_clients TO service_role;


--
-- Name: TABLE salon_custom_domains; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.salon_custom_domains TO anon;
GRANT ALL ON TABLE public.salon_custom_domains TO authenticated;
GRANT ALL ON TABLE public.salon_custom_domains TO service_role;


--
-- Name: TABLE salon_invite_tokens; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.salon_invite_tokens TO anon;
GRANT ALL ON TABLE public.salon_invite_tokens TO authenticated;
GRANT ALL ON TABLE public.salon_invite_tokens TO service_role;


--
-- Name: TABLE salon_members; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.salon_members TO anon;
GRANT ALL ON TABLE public.salon_members TO authenticated;
GRANT ALL ON TABLE public.salon_members TO service_role;


--
-- Name: TABLE salon_page_sections; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.salon_page_sections TO anon;
GRANT ALL ON TABLE public.salon_page_sections TO authenticated;
GRANT ALL ON TABLE public.salon_page_sections TO service_role;


--
-- Name: TABLE salon_resources; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.salon_resources TO anon;
GRANT ALL ON TABLE public.salon_resources TO authenticated;
GRANT ALL ON TABLE public.salon_resources TO service_role;


--
-- Name: TABLE salons; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.salons TO anon;
GRANT ALL ON TABLE public.salons TO authenticated;
GRANT ALL ON TABLE public.salons TO service_role;


--
-- Name: TABLE scheduled_notifications; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.scheduled_notifications TO service_role;


--
-- Name: TABLE service_categories; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.service_categories TO anon;
GRANT ALL ON TABLE public.service_categories TO authenticated;
GRANT ALL ON TABLE public.service_categories TO service_role;


--
-- Name: TABLE service_combos; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.service_combos TO anon;
GRANT ALL ON TABLE public.service_combos TO authenticated;
GRANT ALL ON TABLE public.service_combos TO service_role;


--
-- Name: TABLE services; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.services TO anon;
GRANT ALL ON TABLE public.services TO authenticated;
GRANT ALL ON TABLE public.services TO service_role;


--
-- Name: TABLE square_integrations; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.square_integrations TO anon;
GRANT ALL ON TABLE public.square_integrations TO authenticated;
GRANT ALL ON TABLE public.square_integrations TO service_role;


--
-- Name: TABLE square_visit_history; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.square_visit_history TO anon;
GRANT ALL ON TABLE public.square_visit_history TO authenticated;
GRANT ALL ON TABLE public.square_visit_history TO service_role;


--
-- Name: TABLE staff; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.staff TO anon;
GRANT ALL ON TABLE public.staff TO authenticated;
GRANT ALL ON TABLE public.staff TO service_role;


--
-- Name: TABLE staff_services; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.staff_services TO anon;
GRANT ALL ON TABLE public.staff_services TO authenticated;
GRANT ALL ON TABLE public.staff_services TO service_role;


--
-- Name: TABLE staff_shifts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.staff_shifts TO anon;
GRANT ALL ON TABLE public.staff_shifts TO authenticated;
GRANT ALL ON TABLE public.staff_shifts TO service_role;


--
-- Name: TABLE staff_unavailability; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.staff_unavailability TO anon;
GRANT ALL ON TABLE public.staff_unavailability TO authenticated;
GRANT ALL ON TABLE public.staff_unavailability TO service_role;


--
-- Name: TABLE superadmin_audit_logs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.superadmin_audit_logs TO anon;
GRANT ALL ON TABLE public.superadmin_audit_logs TO authenticated;
GRANT ALL ON TABLE public.superadmin_audit_logs TO service_role;


--
-- Name: TABLE superadmins; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.superadmins TO anon;
GRANT ALL ON TABLE public.superadmins TO authenticated;
GRANT ALL ON TABLE public.superadmins TO service_role;


--
-- Name: TABLE system_audit; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.system_audit TO anon;
GRANT ALL ON TABLE public.system_audit TO authenticated;
GRANT ALL ON TABLE public.system_audit TO service_role;


--
-- Name: TABLE tax_presets; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.tax_presets TO anon;
GRANT ALL ON TABLE public.tax_presets TO authenticated;
GRANT ALL ON TABLE public.tax_presets TO service_role;


--
-- Name: TABLE user_presence; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.user_presence TO anon;
GRANT ALL ON TABLE public.user_presence TO authenticated;
GRANT ALL ON TABLE public.user_presence TO service_role;


--
-- Name: TABLE voice_ai_sessions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.voice_ai_sessions TO anon;
GRANT ALL ON TABLE public.voice_ai_sessions TO authenticated;
GRANT ALL ON TABLE public.voice_ai_sessions TO service_role;


--
-- Name: TABLE voucher_redemptions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.voucher_redemptions TO anon;
GRANT ALL ON TABLE public.voucher_redemptions TO authenticated;
GRANT ALL ON TABLE public.voucher_redemptions TO service_role;


--
-- Name: TABLE vouchers; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.vouchers TO anon;
GRANT ALL ON TABLE public.vouchers TO authenticated;
GRANT ALL ON TABLE public.vouchers TO service_role;


--
-- Name: TABLE watchdog_alerts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.watchdog_alerts TO anon;
GRANT ALL ON TABLE public.watchdog_alerts TO authenticated;
GRANT ALL ON TABLE public.watchdog_alerts TO service_role;


--
-- Name: TABLE watchdog_state; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.watchdog_state TO anon;
GRANT ALL ON TABLE public.watchdog_state TO authenticated;
GRANT ALL ON TABLE public.watchdog_state TO service_role;


--
-- Name: TABLE website_import_jobs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.website_import_jobs TO anon;
GRANT ALL ON TABLE public.website_import_jobs TO authenticated;
GRANT ALL ON TABLE public.website_import_jobs TO service_role;


--
-- Name: TABLE winback_suggestions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.winback_suggestions TO anon;
GRANT ALL ON TABLE public.winback_suggestions TO authenticated;
GRANT ALL ON TABLE public.winback_suggestions TO service_role;


--
-- Name: TABLE wix_integrations; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.wix_integrations TO anon;
GRANT ALL ON TABLE public.wix_integrations TO authenticated;
GRANT ALL ON TABLE public.wix_integrations TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--



--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--



--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--



--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--



--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--



--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--



--
-- PostgreSQL database dump complete
--
-- END verified schema-only production snapshot

-- BEGIN post-snapshot schema delta: 20260716010000_sms_agent_sessions.sql
-- AI Receptionist Module 4 — SMS transport.
--
-- SMS is stateless per webhook (each inbound text is a fresh HTTP request), but
-- a booking conversation is multi-turn ("cancel my appointment" → "which one?"
-- → "the Friday one"). This table holds the rolling Anthropic message history
-- per (salon, customer phone) so the SAME agent brain can carry context across
-- texts. One row per customer-per-salon; the newest turns overwrite the oldest
-- (the app trims before persisting).
--
-- Access is service-role only (the /api/twilio/sms webhook uses the service-role
-- client). RLS is enabled with NO policies and grants are revoked from anon /
-- authenticated so a leaked anon key cannot read customers' conversation logs.

CREATE TABLE IF NOT EXISTS public.sms_agent_sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id       uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  phone          text NOT NULL,                       -- customer phone, canonical E.164
  messages       jsonb NOT NULL DEFAULT '[]'::jsonb,  -- Anthropic message history (trimmed)
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sms_agent_sessions_salon_phone_uniq UNIQUE (salon_id, phone)
);

-- Fast lookup for the periodic staleness purge (old conversations expire).
CREATE INDEX IF NOT EXISTS sms_agent_sessions_updated_idx
  ON public.sms_agent_sessions (updated_at);

ALTER TABLE public.sms_agent_sessions ENABLE ROW LEVEL SECURITY;

-- No policies: only the service-role client (which bypasses RLS) may touch this.
REVOKE ALL ON public.sms_agent_sessions FROM anon, authenticated;
-- END post-snapshot schema delta: 20260716010000_sms_agent_sessions.sql

-- BEGIN post-snapshot schema delta: 20260719010000_tax_presets_rls.sql
-- Security fix: tax_presets had RLS disabled — anyone with the anon key could
-- read AND write every row (Supabase advisor: rls_disabled, critical).
--
-- tax_presets is platform reference data (tax rates per region label):
--   • readable by everyone (booking page + dashboard need it)
--   • writable ONLY via service-role (bypasses RLS), same as platform_settings.
alter table public.tax_presets enable row level security;

drop policy if exists "tax_presets_read_all" on public.tax_presets;
create policy "tax_presets_read_all"
  on public.tax_presets
  for select
  to anon, authenticated
  using (true);

-- No insert/update/delete policies on purpose: client-side writes are blocked;
-- backend code uses the service-role key which bypasses RLS.
-- END post-snapshot schema delta: 20260719010000_tax_presets_rls.sql

-- BEGIN post-snapshot schema delta: 20260720010000_owner_notification_log.sql
-- Audit trail for owner/manager email alerts.
--
-- Until now sendOwnerBookingNotification wrote nothing anywhere: every failure
-- path was a silent `return`, and the send itself was a fire-and-forget promise
-- that Vercel killed when the response flushed. From the outside there was no
-- way to tell "no booking happened" from "the email never left". This table
-- makes every attempt visible, per recipient.

create table if not exists public.owner_notification_log (
  id uuid primary key default gen_random_uuid(),
  salon_id uuid not null references public.salons (id) on delete cascade,
  booking_id uuid,
  event text not null,
  recipient text not null default '',
  status text not null,
  resend_id text,
  error text,
  created_at timestamptz not null default now(),
  constraint owner_notification_log_status_check
    check (status in ('sent', 'failed', 'skipped'))
);

create index if not exists owner_notification_log_salon_created_idx
  on public.owner_notification_log (salon_id, created_at desc);

create index if not exists owner_notification_log_booking_idx
  on public.owner_notification_log (booking_id)
  where booking_id is not null;

-- Service-role only: written by the notification sender, read by the dashboard
-- through server code. RLS on with no policy blocks anon/authenticated outright.
alter table public.owner_notification_log enable row level security;

revoke all on public.owner_notification_log from anon, authenticated;
-- END post-snapshot schema delta: 20260720010000_owner_notification_log.sql

-- BEGIN post-snapshot schema delta: 20260720120000_voice_session_tool_log.sql
-- voice_ai_sessions.tool_log
--
-- `transcript` had two writers fighting over it: logVoiceToolCall appended one
-- entry per tool call while the session ran, and /api/voice/session/end wrote
-- the conversation the widget captured. Last write won, so a call that produced
-- a real conversation lost its tool log entirely — the record of what the agent
-- actually DID, which is the half you need when a booking goes wrong.
--
-- Splitting them: `transcript` keeps the human-readable conversation (role +
-- text per turn), `tool_log` keeps the machine record (tool name, ok, at).
alter table public.voice_ai_sessions
  add column if not exists tool_log jsonb not null default '[]'::jsonb;

comment on column public.voice_ai_sessions.transcript is
  'Conversation turns captured by the client: [{role: "ai"|"user", text}]. Written once at session end.';
comment on column public.voice_ai_sessions.tool_log is
  'Server-side record of tool invocations: [{at, type, tool, ok}]. Appended during the session.';
-- END post-snapshot schema delta: 20260720120000_voice_session_tool_log.sql

-- BEGIN post-snapshot schema delta: 20260721010000_voice_session_lang_es.sql
-- Allow Spanish voice sessions. The CHECK on voice_ai_sessions.language listed
-- vi/en/fr/zh; a Spanish phone call's session insert would fail the constraint
-- and — because that insert is best-effort/try-caught — silently leave the call
-- unrecorded. Widen it to match SUPPORTED_LANGUAGES (adds 'es').
alter table public.voice_ai_sessions
  drop constraint if exists voice_ai_sessions_language_check;

alter table public.voice_ai_sessions
  add constraint voice_ai_sessions_language_check
  check (language = any (array['vi', 'en', 'es', 'fr', 'zh']));
-- END post-snapshot schema delta: 20260721010000_voice_session_lang_es.sql

-- BEGIN post-snapshot schema delta: 20260721032930_nail_tryon_foundation.sql
-- Nail Try-On MVP foundation.
-- Customer images remain private and are only accessed by trusted server code.

create table public.nail_designs (
  id uuid primary key default gen_random_uuid(),
  salon_id uuid not null references public.salons(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  description text,
  preview_path text not null check (preview_path !~ '(^|/)\.\.(/|$)'),
  prompt_hint text,
  is_active boolean not null default true,
  sort_order integer not null default 0 check (sort_order >= 0),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, salon_id)
);

create table public.nail_tryon_sessions (
  id uuid primary key default gen_random_uuid(),
  salon_id uuid not null references public.salons(id) on delete cascade,
  design_id uuid,
  anonymous_token_hash text not null unique check (char_length(anonymous_token_hash) >= 43),
  source_image_path text not null check (source_image_path !~ '(^|/)\.\.(/|$)'),
  result_image_path text check (result_image_path !~ '(^|/)\.\.(/|$)'),
  status text not null default 'uploaded'
    check (status in ('uploaded', 'quality_rejected', 'queued', 'processing', 'completed', 'failed', 'expired')),
  quality_code text check (quality_code in ('hand_not_found', 'multiple_hands', 'blurred', 'too_dark', 'too_bright', 'nails_occluded', 'unsupported_format')),
  provider text,
  provider_request_id text,
  error_code text,
  consent_version text not null,
  attached_at timestamptz,
  expires_at timestamptz not null default (now() + interval '24 hours'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint nail_tryon_sessions_design_fk foreign key (design_id, salon_id)
    references public.nail_designs(id, salon_id) on delete restrict,
  unique (id, salon_id)
);

create table public.booking_nail_looks (
  id uuid primary key default gen_random_uuid(),
  salon_id uuid not null references public.salons(id) on delete cascade,
  booking_id uuid not null references public.bookings(id) on delete cascade,
  tryon_session_id uuid not null,
  design_id uuid,
  created_at timestamptz not null default now(),
  constraint booking_nail_looks_session_fk foreign key (tryon_session_id, salon_id)
    references public.nail_tryon_sessions(id, salon_id) on delete restrict,
  constraint booking_nail_looks_design_fk foreign key (design_id, salon_id)
    references public.nail_designs(id, salon_id) on delete restrict,
  unique (booking_id),
  unique (tryon_session_id)
);

-- Storage deletion is performed by a service worker. Database cron must never
-- delete storage metadata directly because that can orphan the object itself.
create table public.nail_tryon_cleanup_queue (
  id bigint generated always as identity primary key,
  tryon_session_id uuid not null references public.nail_tryon_sessions(id) on delete cascade,
  object_path text not null,
  attempts integer not null default 0 check (attempts between 0 and 20),
  available_at timestamptz not null default now(),
  processed_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  unique (tryon_session_id, object_path)
);

create index nail_designs_salon_active_sort_idx
  on public.nail_designs(salon_id, is_active, sort_order);
create index nail_tryon_sessions_expiry_idx
  on public.nail_tryon_sessions(expires_at) where status <> 'expired';
create index nail_tryon_sessions_token_idx
  on public.nail_tryon_sessions(anonymous_token_hash);
create index booking_nail_looks_salon_idx
  on public.booking_nail_looks(salon_id, created_at desc);
create index nail_tryon_cleanup_ready_idx
  on public.nail_tryon_cleanup_queue(available_at) where processed_at is null;

create function public.validate_booking_nail_look_salon()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.bookings b
    where b.id = new.booking_id and b.salon_id = new.salon_id
  ) then
    raise exception 'booking_nail_look_salon_mismatch' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger booking_nail_looks_validate_salon
before insert or update on public.booking_nail_looks
for each row execute function public.validate_booking_nail_look_salon();

create function public.queue_expired_nail_tryon_sessions(p_limit integer default 200)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  queued_count integer;
begin
  if p_limit < 1 or p_limit > 1000 then
    raise exception 'invalid_cleanup_limit' using errcode = '22023';
  end if;

  with expired as (
    select s.id, s.source_image_path, s.result_image_path
    from public.nail_tryon_sessions s
    where s.status <> 'expired' and s.expires_at <= now()
    order by s.expires_at
    for update skip locked
    limit p_limit
  ), paths as (
    select id, source_image_path as object_path from expired
    union all
    select id, result_image_path from expired where result_image_path is not null
  ), queued as (
    insert into public.nail_tryon_cleanup_queue(tryon_session_id, object_path)
    select id, object_path from paths
    on conflict do nothing
    returning 1
  )
  update public.nail_tryon_sessions s
  set status = 'expired', updated_at = now()
  where s.id in (select id from expired);

  get diagnostics queued_count = row_count;
  return queued_count;
end;
$$;

revoke all on function public.validate_booking_nail_look_salon() from public, anon, authenticated;
revoke all on function public.queue_expired_nail_tryon_sessions(integer) from public, anon, authenticated;
grant execute on function public.queue_expired_nail_tryon_sessions(integer) to service_role;

alter table public.nail_designs enable row level security;
alter table public.nail_tryon_sessions enable row level security;
alter table public.booking_nail_looks enable row level security;
alter table public.nail_tryon_cleanup_queue enable row level security;

create policy "salon members read nail designs"
on public.nail_designs for select to authenticated
using (exists (
  select 1 from public.salon_members sm
  where sm.salon_id = nail_designs.salon_id and sm.user_id = (select auth.uid())
));

create policy "salon managers insert nail designs"
on public.nail_designs for insert to authenticated
with check (exists (
  select 1 from public.salon_members sm
  where sm.salon_id = nail_designs.salon_id
    and sm.user_id = (select auth.uid()) and sm.role in ('owner', 'admin')
));

create policy "salon managers update nail designs"
on public.nail_designs for update to authenticated
using (exists (
  select 1 from public.salon_members sm
  where sm.salon_id = nail_designs.salon_id
    and sm.user_id = (select auth.uid()) and sm.role in ('owner', 'admin')
))
with check (exists (
  select 1 from public.salon_members sm
  where sm.salon_id = nail_designs.salon_id
    and sm.user_id = (select auth.uid()) and sm.role in ('owner', 'admin')
));

create policy "salon managers delete nail designs"
on public.nail_designs for delete to authenticated
using (exists (
  select 1 from public.salon_members sm
  where sm.salon_id = nail_designs.salon_id
    and sm.user_id = (select auth.uid()) and sm.role in ('owner', 'admin')
));

create policy "salon members read attached nail looks"
on public.booking_nail_looks for select to authenticated
using (exists (
  select 1 from public.salon_members sm
  where sm.salon_id = booking_nail_looks.salon_id and sm.user_id = (select auth.uid())
));

revoke all on public.nail_designs, public.nail_tryon_sessions,
  public.booking_nail_looks, public.nail_tryon_cleanup_queue from anon, authenticated;
grant select, insert, update, delete on public.nail_designs to authenticated;
grant select on public.booking_nail_looks to authenticated;
grant all on public.nail_designs, public.nail_tryon_sessions,
  public.booking_nail_looks, public.nail_tryon_cleanup_queue to service_role;
grant usage, select on sequence public.nail_tryon_cleanup_queue_id_seq to service_role;


-- Intentionally no storage.objects policy for this bucket. Upload, signed-read,
-- and deletion are server-mediated with a non-public service credential.
-- END post-snapshot schema delta: 20260721032930_nail_tryon_foundation.sql

-- BEGIN post-snapshot schema delta: 20260721034942_nail_tryon_generation_fields.sql
alter table public.nail_designs
  add column service_id uuid references public.services(id) on delete set null,
  add column addon_service_id uuid references public.services(id) on delete set null,
  add column style_tags text[] not null default '{}',
  add column palette jsonb not null default '[]'::jsonb,
  add column version integer not null default 1 check (version > 0),
  add column deleted_at timestamptz;

alter table public.nail_tryon_sessions
  drop constraint nail_tryon_sessions_status_check,
  drop constraint nail_tryon_sessions_quality_code_check,
  add column consent_at timestamptz not null default now(),
  add column provider_model text,
  add column design_version integer,
  add column deleted_at timestamptz,
  add constraint nail_tryon_sessions_status_check check (
    status in ('uploaded', 'quality_rejected', 'quality_passed', 'generating', 'ready', 'failed', 'attached', 'deleted', 'expired')
  ),
  add constraint nail_tryon_sessions_quality_code_check check (
    quality_code in ('hand_not_found', 'multiple_hands', 'blurred', 'too_dark', 'too_bright', 'nails_occluded', 'unsupported_format', 'wrong_pose')
  );

alter table public.booking_nail_looks
  add column design_version integer,
  add column design_snapshot jsonb not null default '{}'::jsonb,
  add column disclaimer_version text not null default 'nail-tryon-v1';

create index nail_designs_public_catalog_idx
  on public.nail_designs(salon_id, sort_order, created_at)
  where is_active and deleted_at is null;
-- END post-snapshot schema delta: 20260721034942_nail_tryon_generation_fields.sql

-- BEGIN post-snapshot schema delta: 20260721072707_nail_tryon_telemetry_retention.sql
create table public.nail_tryon_events (
  id bigint generated always as identity primary key,
  salon_id uuid not null references public.salons(id) on delete cascade,
  tryon_session_id uuid references public.nail_tryon_sessions(id) on delete set null,
  event_name text not null check (event_name in (
    'upload_received', 'quality_passed', 'quality_rejected',
    'catalog_viewed', 'generation_started', 'generation_ready',
    'generation_failed', 'booking_attached', 'expired_deleted'
  )),
  properties jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (jsonb_typeof(properties) = 'object')
);

create index nail_tryon_events_salon_created_idx
  on public.nail_tryon_events(salon_id, created_at desc);
create index nail_tryon_events_funnel_idx
  on public.nail_tryon_events(event_name, created_at desc);

alter table public.nail_tryon_events enable row level security;
revoke all on public.nail_tryon_events from public, anon, authenticated;
grant all on public.nail_tryon_events to service_role;
grant usage, select on sequence public.nail_tryon_events_id_seq to service_role;

comment on table public.nail_tryon_events is
  'PII-free Nail Try-On funnel telemetry. Never store image bytes, URLs, tokens, phone, email, or names.';
-- END post-snapshot schema delta: 20260721072707_nail_tryon_telemetry_retention.sql

-- BEGIN post-snapshot schema delta: 20260721090000_voice_ai_upsell.sql
-- Voice AI upsell: after a caller picks a service, the receptionist may offer ONE
-- tasteful upgrade/combo from the salon's own menu. Off is a per-salon choice, so
-- it is a toggle (default ON — owners who added the AI receptionist want revenue).
alter table public.salons
  add column if not exists voice_ai_upsell_enabled boolean not null default true;

comment on column public.salons.voice_ai_upsell_enabled is
  'When true, the voice/web receptionist offers one tasteful upsell after a service is chosen.';
-- END post-snapshot schema delta: 20260721090000_voice_ai_upsell.sql

-- BEGIN post-snapshot schema delta: 20260722011000_nail_design_multi_service_mapping.sql
-- A nail design can be performed through several salon services and may
-- recommend several add-ons.  The legacy scalar columns remain as the default
-- pair so older app releases continue to work during a rolling deployment.

create table if not exists public.nail_design_service_mappings (
  design_id uuid not null references public.nail_designs(id) on delete cascade,
  salon_id uuid not null references public.salons(id) on delete cascade,
  service_id uuid not null references public.services(id) on delete cascade,
  mapping_type text not null check (mapping_type in ('service', 'addon')),
  is_default boolean not null default false,
  sort_order integer not null default 0 check (sort_order >= 0),
  created_at timestamptz not null default now(),
  primary key (design_id, service_id),
  constraint nail_design_service_mappings_design_salon_fk
    foreign key (design_id, salon_id)
    references public.nail_designs(id, salon_id) on delete cascade
);

create unique index if not exists nail_design_one_default_service_idx
  on public.nail_design_service_mappings(design_id)
  where mapping_type = 'service' and is_default;

create index if not exists nail_design_service_mappings_catalog_idx
  on public.nail_design_service_mappings(salon_id, design_id, mapping_type, sort_order);

alter table public.nail_design_service_mappings enable row level security;

drop policy if exists "salon members read nail design mappings"
  on public.nail_design_service_mappings;

create policy "salon members read nail design mappings"
on public.nail_design_service_mappings for select to authenticated
using (exists (
  select 1 from public.salon_members sm
  where sm.salon_id = nail_design_service_mappings.salon_id
    and sm.user_id = (select auth.uid())
));

revoke all on public.nail_design_service_mappings from anon, authenticated;
grant select on public.nail_design_service_mappings to authenticated;
grant all on public.nail_design_service_mappings to service_role;

create or replace function public.replace_nail_design_service_mappings(
  p_design_id uuid,
  p_salon_id uuid,
  p_service_ids uuid[],
  p_addon_service_ids uuid[],
  p_default_service_id uuid default null
) returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_service_ids uuid[] := coalesce(p_service_ids, '{}'::uuid[]);
  v_addon_ids uuid[] := coalesce(p_addon_service_ids, '{}'::uuid[]);
begin
  if not exists (
    select 1 from public.nail_designs d
    where d.id = p_design_id and d.salon_id = p_salon_id and d.deleted_at is null
  ) then
    raise exception 'nail_design_not_found' using errcode = 'P0002';
  end if;

  if p_default_service_id is not null and not (p_default_service_id = any(v_service_ids)) then
    raise exception 'default_service_not_selected' using errcode = '22023';
  end if;

  if exists (
    select 1 from unnest(v_service_ids) requested(id)
    left join public.services s on s.id = requested.id
      and s.salon_id = p_salon_id and s.deleted_at is null and not s.is_addon
    where s.id is null
  ) or exists (
    select 1 from unnest(v_addon_ids) requested(id)
    left join public.services s on s.id = requested.id
      and s.salon_id = p_salon_id and s.deleted_at is null and s.is_addon
    where s.id is null
  ) then
    raise exception 'invalid_nail_design_service_mapping' using errcode = '23514';
  end if;

  delete from public.nail_design_service_mappings
  where design_id = p_design_id and salon_id = p_salon_id;

  insert into public.nail_design_service_mappings
    (design_id, salon_id, service_id, mapping_type, is_default, sort_order)
  select p_design_id, p_salon_id, requested.id, 'service',
    requested.id = coalesce(p_default_service_id, v_service_ids[1]), requested.ord - 1
  from unnest(v_service_ids) with ordinality requested(id, ord)
  on conflict (design_id, service_id) do nothing;

  insert into public.nail_design_service_mappings
    (design_id, salon_id, service_id, mapping_type, is_default, sort_order)
  select p_design_id, p_salon_id, requested.id, 'addon', false, requested.ord - 1
  from unnest(v_addon_ids) with ordinality requested(id, ord)
  on conflict (design_id, service_id) do nothing;

  update public.nail_designs
  set service_id = coalesce(p_default_service_id, v_service_ids[1]),
      addon_service_id = v_addon_ids[1],
      updated_at = now()
  where id = p_design_id and salon_id = p_salon_id;
end;
$$;

revoke all on function public.replace_nail_design_service_mappings(uuid, uuid, uuid[], uuid[], uuid)
  from public, anon, authenticated;
grant execute on function public.replace_nail_design_service_mappings(uuid, uuid, uuid[], uuid[], uuid)
  to service_role;

-- Backfill every existing Smart Quote mapping without changing its meaning.
-- END post-snapshot schema delta: 20260722011000_nail_design_multi_service_mapping.sql

-- BEGIN post-snapshot schema delta: 20260722063820_add_self_service_trial.sql
-- Self-service 14-day trial lifecycle.
-- Existing salons are intentionally left unchanged. New self-service salons
-- receive these values from completeSalonRegistrationAction on the server.

alter table public.salons
  add column if not exists trial_started_at timestamptz,
  add column if not exists trial_ends_at timestamptz;

alter table public.salons
  drop constraint if exists salons_trial_window_check;

alter table public.salons
  add constraint salons_trial_window_check
  check (
    (trial_started_at is null and trial_ends_at is null)
    or (
      trial_started_at is not null
      and trial_ends_at is not null
      and trial_ends_at > trial_started_at
    )
  );

create index if not exists salons_trial_ends_at_idx
  on public.salons (trial_ends_at)
  where subscription_status = 'trialing';

comment on column public.salons.trial_started_at is
  'Server-authored start of the self-service trial. Null for legacy/pilot salons.';
comment on column public.salons.trial_ends_at is
  'Server-authored end of the self-service trial. Access checks must use server time.';

-- Twilio delivery analysis already reads this field. Production had code/schema
-- drift, causing the daily learning cron to fail on every salon.
alter table public.booking_notifications
  add column if not exists error_code text;

comment on column public.booking_notifications.error_code is
  'Provider delivery error code (for example a Twilio 30007/30034 code).';
-- END post-snapshot schema delta: 20260722063820_add_self_service_trial.sql

-- OMITTED production-state-only delta: 20260722175728_move_cron_auth_to_vault.sql
-- Its cron/Vault credential transition is not part of a blank schema baseline.

-- BEGIN post-snapshot schema delta: 20260722180738_lock_internal_rpc_execution.sql
-- These RPCs are server-only. Keeping EXECUTE on PUBLIC exposes customer PII
-- through PostgREST even though NailIQ only calls them with the service role.
alter function public.winback_candidates(uuid, integer, integer, integer, integer)
  set search_path = public, pg_catalog;

alter function public.rebook_due_candidates(uuid, integer, integer, integer, integer)
  set search_path = public, pg_catalog;

revoke execute on function public.winback_candidates(uuid, integer, integer, integer, integer)
  from public, anon, authenticated;
revoke execute on function public.rebook_due_candidates(uuid, integer, integer, integer, integer)
  from public, anon, authenticated;

grant execute on function public.winback_candidates(uuid, integer, integer, integer, integer)
  to service_role;
grant execute on function public.rebook_due_candidates(uuid, integer, integer, integer, integer)
  to service_role;

-- Trigger functions run through their triggers; they must not also be callable
-- as public RPC endpoints.
revoke execute on function public.log_system_audit()
  from public, anon, authenticated;
grant execute on function public.log_system_audit()
  to service_role;
-- END post-snapshot schema delta: 20260722180738_lock_internal_rpc_execution.sql

-- BEGIN post-snapshot schema delta: 20260722182513_harden_public_booking_addons.sql
-- Legacy queue insertion is no longer used by NailIQ. Keep it available to the
-- backend for rollback compatibility, but remove the public PostgREST surface.
revoke execute on function public.add_queue_entry(uuid, text, text, uuid, uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.add_queue_entry(uuid, text, text, uuid, uuid, text, integer)
  to service_role;

-- The public booking flow attaches add-ons immediately after creating a
-- cryptographically-random booking UUID. Keep that capability while preventing
-- replay, late modification, duplicate rows, and oversized payloads.
create or replace function public.add_booking_addons(
  p_booking_id uuid,
  p_service_ids uuid[]
) returns integer
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_salon_id uuid;
  v_created_at timestamptz;
  v_status text;
  v_count integer := 0;
begin
  if p_service_ids is null or cardinality(p_service_ids) = 0 then
    return 0;
  end if;

  if cardinality(p_service_ids) > 8 then
    raise exception 'Too many booking add-ons' using errcode = '22023';
  end if;

  -- The row lock serializes repeated calls for the same booking so the
  -- NOT EXISTS guard below cannot race and create duplicates.
  select b.salon_id, b.created_at, b.status
    into v_salon_id, v_created_at, v_status
  from public.bookings b
  where b.id = p_booking_id
  for update;

  if v_salon_id is null
     or v_created_at < now() - interval '15 minutes'
     or v_status in ('cancelled', 'completed', 'no_show') then
    return 0;
  end if;

  insert into public.booking_addons (
    booking_id,
    service_id,
    name,
    price_cents,
    duration_minutes
  )
  select
    p_booking_id,
    s.id,
    s.name,
    s.price_cents,
    coalesce(s.duration_minutes, 0) + coalesce(s.buffer_minutes, 0)
  from public.services s
  join (
    select requested.service_id, min(requested.ord) as ord
    from unnest(p_service_ids) with ordinality as requested(service_id, ord)
    group by requested.service_id
  ) requested on requested.service_id = s.id
  where s.salon_id = v_salon_id
    and s.is_addon = true
    and s.deleted_at is null
    and not exists (
      select 1
      from public.booking_addons existing
      where existing.booking_id = p_booking_id
        and existing.service_id = s.id
    )
  order by requested.ord;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.add_booking_addons(uuid, uuid[]) from public;
grant execute on function public.add_booking_addons(uuid, uuid[])
  to anon, authenticated, service_role;
-- END post-snapshot schema delta: 20260722182513_harden_public_booking_addons.sql

-- BEGIN post-snapshot schema delta: 20260722184158_lock_verification_rpcs.sql
-- Verification decisions expose customer risk signals and are called only by
-- NailIQ's server-side API. The legacy OTP confirmer is also server-only.
alter function public.determine_booking_verification(uuid, text, uuid[], integer)
  set search_path = public, pg_catalog;
alter function public.determine_booking_verification(uuid, text, uuid[], integer, boolean)
  set search_path = public, pg_catalog;
alter function public.confirm_booking_with_otp(uuid, uuid)
  set search_path = public, pg_catalog;

revoke execute on function public.determine_booking_verification(uuid, text, uuid[], integer)
  from public, anon, authenticated;
revoke execute on function public.determine_booking_verification(uuid, text, uuid[], integer, boolean)
  from public, anon, authenticated;
revoke execute on function public.confirm_booking_with_otp(uuid, uuid)
  from public, anon, authenticated;

grant execute on function public.determine_booking_verification(uuid, text, uuid[], integer)
  to service_role;
grant execute on function public.determine_booking_verification(uuid, text, uuid[], integer, boolean)
  to service_role;
grant execute on function public.confirm_booking_with_otp(uuid, uuid)
  to service_role;
-- END post-snapshot schema delta: 20260722184158_lock_verification_rpcs.sql

-- BEGIN post-snapshot schema delta: 20260722184711_secure_function_default_privileges.sql
-- New functions must be explicitly exposed. This prevents an internal helper
-- from silently becoming a PostgREST RPC for every visitor or signed-in user.
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;

-- Supabase owns and manages the separate supabase_admin defaults. Project
-- migrations run as postgres, so changing that platform role is intentionally
-- outside this migration's authority.
-- END post-snapshot schema delta: 20260722184711_secure_function_default_privileges.sql

-- BEGIN post-snapshot schema delta: 20260722184850_secure_global_function_defaults.sql
-- PostgreSQL's built-in PUBLIC EXECUTE grant is global. A schema-scoped
-- REVOKE cannot override it, so remove it at the owner level. Explicit grants
-- in individual migrations remain the source of truth for public RPCs.
alter default privileges for role postgres
  revoke execute on functions from public;
-- END post-snapshot schema delta: 20260722184850_secure_global_function_defaults.sql

-- BEGIN post-snapshot schema delta: 20260722193542_rate_limit_public_booking.sql
-- Put abuse controls at the actual public write boundary. The browser calls
-- this RPC directly, so a Vercel proxy/WAF rule cannot see booking submits.
--
-- Drift compatibility: production currently has the 14-argument resource-aware
-- v2.9 implementation, while a clean replay of the repository ends at the
-- 13-argument implementation. Preserve whichever canonical implementation is
-- present behind a private name, then expose exactly one 14-argument wrapper.

DO $migration$
BEGIN
  IF to_regprocedure(
    'public.create_public_booking(uuid,uuid,uuid,text,text,timestamptz,timestamptz,text,integer,text,uuid,integer,text,uuid)'
  ) IS NOT NULL THEN
    EXECUTE 'ALTER FUNCTION public.create_public_booking(uuid,uuid,uuid,text,text,timestamptz,timestamptz,text,integer,text,uuid,integer,text,uuid) RENAME TO create_public_booking_unlimited_14';
  ELSIF to_regprocedure(
    'public.create_public_booking(uuid,uuid,uuid,text,text,timestamptz,timestamptz,text,integer,text,uuid,integer,text)'
  ) IS NOT NULL THEN
    EXECUTE 'ALTER FUNCTION public.create_public_booking(uuid,uuid,uuid,text,text,timestamptz,timestamptz,text,integer,text,uuid,integer,text) RENAME TO create_public_booking_unlimited_13';
  ELSE
    RAISE EXCEPTION 'No canonical create_public_booking implementation found';
  END IF;
END;
$migration$;

DO $migration$
BEGIN
  IF to_regprocedure(
    'public.create_public_booking_unlimited_14(uuid,uuid,uuid,text,text,timestamptz,timestamptz,text,integer,text,uuid,integer,text,uuid)'
  ) IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.create_public_booking_unlimited_14(uuid,uuid,uuid,text,text,timestamptz,timestamptz,text,integer,text,uuid,integer,text,uuid) FROM PUBLIC, anon, authenticated';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.create_public_booking_unlimited_14(uuid,uuid,uuid,text,text,timestamptz,timestamptz,text,integer,text,uuid,integer,text,uuid) TO service_role';
  ELSE
    EXECUTE 'REVOKE ALL ON FUNCTION public.create_public_booking_unlimited_13(uuid,uuid,uuid,text,text,timestamptz,timestamptz,text,integer,text,uuid,integer,text) FROM PUBLIC, anon, authenticated';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.create_public_booking_unlimited_13(uuid,uuid,uuid,text,text,timestamptz,timestamptz,text,integer,text,uuid,integer,text) TO service_role';
  END IF;
END;
$migration$;

CREATE FUNCTION public.create_public_booking(
  p_salon_id uuid,
  p_service_id uuid,
  p_staff_id uuid,
  p_client_name text,
  p_client_phone text,
  p_start_time_utc timestamptz,
  p_end_time_utc timestamptz,
  p_status text DEFAULT 'pending',
  p_price_cents integer DEFAULT NULL,
  p_client_notes text DEFAULT NULL,
  p_addon_service_id uuid DEFAULT NULL,
  p_addon_price_cents integer DEFAULT NULL,
  p_client_email text DEFAULT NULL,
  p_resource_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_digits text := regexp_replace(coalesce(p_client_phone, ''), '\D', '', 'g');
  v_phone_bucket text;
  v_result jsonb;
BEGIN
  -- Anonymous public traffic is limited here. Authenticated salon staff and
  -- service-role server flows must remain available for front-desk operations.
  IF v_role = 'anon' THEN
    -- 30 per ten minutes still permits 180 legitimate public bookings/hour.
    IF NOT public.rate_limit_hit(
      'public-booking:salon:' || coalesce(p_salon_id::text, 'missing'),
      30,
      600
    ) THEN
      RETURN jsonb_build_object('success', false, 'code', 'rate_limited');
    END IF;

    -- Store only a one-way phone-derived bucket, never the customer phone.
    v_phone_bucket := md5(coalesce(p_salon_id::text, 'missing') || ':' || v_digits);
    IF NOT public.rate_limit_hit(
      'public-booking:phone:' || v_phone_bucket,
      3,
      900
    ) THEN
      RETURN jsonb_build_object('success', false, 'code', 'rate_limited');
    END IF;
  END IF;

  IF to_regprocedure(
    'public.create_public_booking_unlimited_14(uuid,uuid,uuid,text,text,timestamptz,timestamptz,text,integer,text,uuid,integer,text,uuid)'
  ) IS NOT NULL THEN
    EXECUTE 'SELECT public.create_public_booking_unlimited_14($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)'
      INTO v_result
      USING p_salon_id, p_service_id, p_staff_id, p_client_name, p_client_phone,
        p_start_time_utc, p_end_time_utc, p_status, p_price_cents,
        p_client_notes, p_addon_service_id, p_addon_price_cents,
        p_client_email, p_resource_id;
  ELSE
    EXECUTE 'SELECT public.create_public_booking_unlimited_13($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)'
      INTO v_result
      USING p_salon_id, p_service_id, p_staff_id, p_client_name, p_client_phone,
        p_start_time_utc, p_end_time_utc, p_status, p_price_cents,
        p_client_notes, p_addon_service_id, p_addon_price_cents, p_client_email;
  END IF;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.create_public_booking(
  uuid, uuid, uuid, text, text, timestamptz, timestamptz,
  text, integer, text, uuid, integer, text, uuid
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_public_booking(
  uuid, uuid, uuid, text, text, timestamptz, timestamptz,
  text, integer, text, uuid, integer, text, uuid
) TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.create_public_booking(
  uuid, uuid, uuid, text, text, timestamptz, timestamptz,
  text, integer, text, uuid, integer, text, uuid
) IS 'Public booking boundary with anonymous per-salon and per-phone abuse limits.';
-- END post-snapshot schema delta: 20260722193542_rate_limit_public_booking.sql

-- BEGIN post-snapshot schema delta: 20260722195941_block_anon_direct_booking_insert.sql
-- Public bookings must pass through create_public_booking, which enforces
-- tenant correlation, opening hours, conflicts and abuse limits. Production
-- drift left a permissive anon INSERT policy that bypassed all of those checks.

REVOKE INSERT ON TABLE public.bookings FROM anon;

DROP POLICY IF EXISTS bookings_insert_anon ON public.bookings;
CREATE POLICY bookings_insert_anon
ON public.bookings
FOR INSERT
TO anon
WITH CHECK (false);

COMMENT ON POLICY bookings_insert_anon ON public.bookings IS
  'Fail-closed: anonymous clients must use create_public_booking; direct table inserts are forbidden.';
-- END post-snapshot schema delta: 20260722195941_block_anon_direct_booking_insert.sql

-- BEGIN post-snapshot schema delta: 20260722201500_harden_public_group_booking.sql
-- The anonymous group-booking RPC was a SECURITY DEFINER write boundary but
-- trusted caller-supplied salon/staff/service relationships and price values,
-- and it did not share the abuse controls used by single bookings.

ALTER FUNCTION public.insert_group_bookings(jsonb)
  RENAME TO insert_group_bookings_unlimited;

REVOKE ALL ON FUNCTION public.insert_group_bookings_unlimited(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.insert_group_bookings_unlimited(jsonb)
  TO service_role;

CREATE FUNCTION public.insert_group_bookings(p_bookings jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_group_size integer;
  v_booking jsonb;
  v_salon_id uuid;
  v_row_salon_id uuid;
  v_service_id uuid;
  v_staff_id uuid;
  v_start timestamptz;
  v_end timestamptz;
  v_price integer;
  v_digits text;
  v_phone_bucket text;
  v_sanitized jsonb := '[]'::jsonb;
BEGIN
  IF jsonb_typeof(p_bookings) <> 'array' THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_group_size');
  END IF;

  v_group_size := jsonb_array_length(p_bookings);
  IF v_group_size < 2 OR v_group_size > 20 THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_group_size');
  END IF;

  FOR v_booking IN SELECT value FROM jsonb_array_elements(p_bookings)
  LOOP
    BEGIN
      v_row_salon_id := (v_booking->>'salon_id')::uuid;
      v_service_id := (v_booking->>'service_id')::uuid;
      v_staff_id := (v_booking->>'staff_id')::uuid;
      v_start := (v_booking->>'start_time_utc')::timestamptz;
      v_end := (v_booking->>'end_time_utc')::timestamptz;
    EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_booking_data');
    END;

    IF v_salon_id IS NULL THEN v_salon_id := v_row_salon_id; END IF;
    IF v_row_salon_id IS NULL OR v_row_salon_id <> v_salon_id THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_salon');
    END IF;

    SELECT s.price_cents INTO v_price
    FROM public.services s
    WHERE s.id = v_service_id AND s.salon_id = v_salon_id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_service');
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.staff st
      WHERE st.id = v_staff_id AND st.salon_id = v_salon_id
    ) THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_staff');
    END IF;

    IF v_start IS NULL OR v_end IS NULL OR v_end <= v_start
       OR v_end - v_start > interval '12 hours'
       OR v_start < now() - interval '15 minutes'
       OR v_start > now() + interval '1 year' THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_booking_time');
    END IF;

    IF length(trim(coalesce(v_booking->>'client_name', ''))) NOT BETWEEN 1 AND 120 THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_client_name');
    END IF;

    -- Price is always derived from the salon's service catalog. A modified
    -- browser payload cannot create a fake discounted booking snapshot.
    v_sanitized := v_sanitized || jsonb_build_array(
      v_booking || jsonb_build_object('price_cents', v_price)
    );
  END LOOP;

  IF v_role = 'anon' THEN
    IF NOT public.rate_limit_hit(
      'public-group-booking:salon:' || v_salon_id::text, 10, 600
    ) THEN
      RETURN jsonb_build_object('success', false, 'code', 'rate_limited');
    END IF;

    v_digits := regexp_replace(coalesce(p_bookings->0->>'client_phone', ''), '\\D', '', 'g');
    v_phone_bucket := md5(v_salon_id::text || ':' || v_digits);
    IF NOT public.rate_limit_hit(
      'public-group-booking:phone:' || v_phone_bucket, 3, 900
    ) THEN
      RETURN jsonb_build_object('success', false, 'code', 'rate_limited');
    END IF;
  END IF;

  RETURN public.insert_group_bookings_unlimited(v_sanitized);
END;
$function$;

REVOKE ALL ON FUNCTION public.insert_group_bookings(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.insert_group_bookings(jsonb)
  TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.insert_group_bookings(jsonb) IS
  'Validated group-booking write boundary with authoritative prices and anonymous abuse limits.';
-- END post-snapshot schema delta: 20260722201500_harden_public_group_booking.sql

-- BEGIN post-snapshot schema delta: 20260722203000_bind_client_snapshot_to_booking.sql
-- A salon UUID plus a phone number is enumerable public data. Requiring the
-- newly-created, random booking UUID turns this post-booking lookup into a
-- capability-bound read instead of a phone-to-customer-profile oracle.

CREATE FUNCTION public.get_booking_client_snapshot(
  p_salon_id uuid,
  p_phone text,
  p_booking_id uuid
)
RETURNS TABLE(
  visit_count integer,
  name text,
  no_show_count integer,
  is_vip boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT cp.visit_count, cp.name, cp.no_show_count, cp.is_vip
  FROM public.bookings b
  JOIN public.client_profiles cp
    ON cp.deleted_at IS NULL
   AND (b.client_profile_id = cp.id OR b.client_phone = cp.phone)
  WHERE b.id = p_booking_id
    AND b.salon_id = p_salon_id
    AND b.created_at >= now() - interval '10 minutes'
    AND public.canonical_phone(b.client_phone)
        = public.canonical_phone(p_phone)
  LIMIT 1;
$function$;

REVOKE ALL ON FUNCTION public.get_booking_client_snapshot(uuid, text, uuid)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_booking_client_snapshot(uuid, text, uuid)
  TO anon, authenticated, service_role;

-- Keep the legacy overload only for trusted server operations. Public clients
-- must present the unguessable booking capability to read a snapshot.
REVOKE ALL ON FUNCTION public.get_booking_client_snapshot(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_booking_client_snapshot(uuid, text)
  TO service_role;

COMMENT ON FUNCTION public.get_booking_client_snapshot(uuid, text, uuid) IS
  'Capability-bound recent-booking customer snapshot; prevents public phone enumeration.';
-- END post-snapshot schema delta: 20260722203000_bind_client_snapshot_to_booking.sql

-- BEGIN post-snapshot schema delta: 20260722205000_close_public_pii_reads.sql
-- Public table reads exposed customer PII:
--   * queue_entries: every active salon's names, phones and notes
--   * reviews: all phones, emails and bearer request tokens
--
-- Both product flows already use trusted server actions / tenant-scoped staff
-- access. No public client needs direct SELECT on either base table.

DROP POLICY IF EXISTS anon_read_queue_entries ON public.queue_entries;
REVOKE SELECT ON TABLE public.queue_entries FROM anon;

DROP POLICY IF EXISTS reviews_select_by_token ON public.reviews;
REVOKE SELECT ON TABLE public.reviews FROM anon, authenticated;

COMMENT ON TABLE public.queue_entries IS
  'Contains customer PII. Public base-table reads are forbidden; salon members are tenant-scoped.';
COMMENT ON TABLE public.reviews IS
  'Contains customer PII and bearer tokens. Public review flows use trusted token-scoped server actions.';
-- END post-snapshot schema delta: 20260722205000_close_public_pii_reads.sql

-- BEGIN post-snapshot schema delta: 20260722210600_close_loyalty_otp_reads.sql
-- Loyalty phone numbers and OTP sessions are capabilities, not public catalog
-- data. Filtering a public table query by phone/session in the browser does not
-- prevent enumeration or reuse by another caller.

DROP POLICY IF EXISTS "public read own card by phone" ON public.loyalty_cards;
REVOKE SELECT ON TABLE public.loyalty_cards FROM anon;

CREATE FUNCTION public.validate_phone_otp_session(
  p_session_id uuid,
  p_salon_id uuid,
  p_phone text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.phone_otp_sessions s
    WHERE s.id = p_session_id
      AND s.salon_id = p_salon_id
      AND s.phone = regexp_replace(coalesce(p_phone, ''), '\D', '', 'g')
      AND s.consumed_at IS NULL
      AND s.expires_at > now()
  );
$function$;

REVOKE ALL ON FUNCTION public.validate_phone_otp_session(uuid, uuid, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.validate_phone_otp_session(uuid, uuid, text)
  TO anon, authenticated, service_role;

DROP POLICY IF EXISTS anon_read_valid_otp_session ON public.phone_otp_sessions;
REVOKE SELECT ON TABLE public.phone_otp_sessions FROM anon;

COMMENT ON FUNCTION public.validate_phone_otp_session(uuid, uuid, text) IS
  'Boolean capability check for an exact OTP session, salon and phone; never exposes session rows.';
-- END post-snapshot schema delta: 20260722210600_close_loyalty_otp_reads.sql

-- BEGIN post-snapshot schema delta: 20260722214100_harden_public_salon_reads.sql
-- Anonymous visitors only need the public booking profile. The salons table
-- also contains owner PII, Stripe identifiers, subscription state, admin notes
-- and internal AI/notification configuration, so a table-wide SELECT grant is
-- an unsafe data boundary even with row-level security enabled.

REVOKE ALL PRIVILEGES ON TABLE public.salons FROM anon;

GRANT SELECT (
  id,
  slug,
  name,
  address,
  salon_phone,
  opening_hours,
  profile_complete,
  booking_closed_dates,
  timezone,
  subscription_plan,
  plan_override,
  feature_flags,
  brand_color,
  theme_mode,
  currency_code,
  description,
  phone_otp_enabled,
  voice_ai_enabled,
  vertical,
  public_sections_enabled,
  booking_images,
  staff_selection_enabled,
  booking_lead_minutes,
  group_together_threshold_minutes,
  reference_image_enabled,
  health_ack_required,
  email_links_enabled,
  resources_enabled,
  tax_lines,
  privacy_url,
  terms_url,
  default_language,
  logo_url
) ON TABLE public.salons TO anon;
-- END post-snapshot schema delta: 20260722214100_harden_public_salon_reads.sql

-- BEGIN post-snapshot schema delta: 20260722221300_isolate_authenticated_salon_reads.sql
-- Separate the public booking profile from the tenant-owned salons table.
-- The view intentionally exposes only booking-safe columns and is the only
-- cross-tenant salon surface available to anon/authenticated sessions.

CREATE OR REPLACE VIEW public.public_salon_profiles
WITH (security_barrier = true)
AS
SELECT
  id,
  slug,
  name,
  created_at,
  address,
  salon_phone,
  opening_hours,
  profile_complete,
  booking_closed_dates,
  timezone,
  subscription_plan,
  plan_override,
  feature_flags,
  brand_color,
  theme_mode,
  currency_code,
  description,
  phone_otp_enabled,
  voice_ai_enabled,
  vertical,
  public_sections_enabled,
  booking_images,
  staff_selection_enabled,
  booking_lead_minutes,
  group_together_threshold_minutes,
  reference_image_enabled,
  health_ack_required,
  email_links_enabled,
  resources_enabled,
  primary_grid_axis,
  tax_lines,
  privacy_url,
  terms_url,
  default_language,
  logo_url
FROM public.salons
WHERE archived_at IS NULL;

REVOKE ALL ON TABLE public.public_salon_profiles FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.public_salon_profiles TO anon, authenticated, service_role;

DROP POLICY IF EXISTS "public read salons" ON public.salons;
REVOKE ALL PRIVILEGES ON TABLE public.salons FROM anon;
-- END post-snapshot schema delta: 20260722221300_isolate_authenticated_salon_reads.sql

-- BEGIN post-snapshot schema delta: 20260722223100_harden_public_staff_catalog.sql
-- Public booking needs a small staff/service catalog and availability facts,
-- not tenant user IDs, external provider IDs, deleted rows, or time-off reasons.

CREATE OR REPLACE VIEW public.public_service_catalog
WITH (security_barrier = true) AS
SELECT
  id, salon_id, name, price_cents, duration_minutes, buffer_minutes,
  category, description, is_popular, is_featured, price_type,
  price_max_cents, is_addon, addon_timing
FROM public.services
WHERE deleted_at IS NULL;

CREATE OR REPLACE VIEW public.public_staff_profiles
WITH (security_barrier = true) AS
SELECT id, salon_id, name, job_role, status
FROM public.staff
WHERE deleted_at IS NULL AND status = 'active';

CREATE OR REPLACE VIEW public.public_staff_shifts
WITH (security_barrier = true) AS
SELECT id, staff_id, salon_id, day_of_week, start_time, end_time, is_active
FROM public.staff_shifts
WHERE is_active = true;

CREATE OR REPLACE VIEW public.public_staff_unavailability
WITH (security_barrier = true) AS
SELECT id, staff_id, salon_id, date
FROM public.staff_unavailability;

REVOKE ALL ON TABLE
  public.public_service_catalog,
  public.public_staff_profiles,
  public.public_staff_shifts,
  public.public_staff_unavailability
FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE
  public.public_service_catalog,
  public.public_staff_profiles,
  public.public_staff_shifts,
  public.public_staff_unavailability
TO anon, authenticated, service_role;

DROP POLICY IF EXISTS "public read services" ON public.services;
DROP POLICY IF EXISTS "public read staff" ON public.staff;
DROP POLICY IF EXISTS "anon read staff_shifts" ON public.staff_shifts;
DROP POLICY IF EXISTS "anon read staff_unavailability" ON public.staff_unavailability;

REVOKE ALL PRIVILEGES ON TABLE public.services FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.staff FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.staff_shifts FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.staff_unavailability FROM anon;

CREATE POLICY "members read services for own salon"
ON public.services FOR SELECT TO authenticated
USING (
  salon_id IN (
    SELECT salon_id FROM public.salon_members WHERE user_id = (SELECT auth.uid())
  )
);

CREATE POLICY "members read staff for own salon"
ON public.staff FOR SELECT TO authenticated
USING (
  salon_id IN (
    SELECT salon_id FROM public.salon_members WHERE user_id = (SELECT auth.uid())
  )
);
-- END post-snapshot schema delta: 20260722223100_harden_public_staff_catalog.sql

-- BEGIN folded-baseline grant reconciliation
-- These post-snapshot tables inherited production's service_role default
-- privileges. The schema snapshot strips ALTER DEFAULT PRIVILEGES, so the
-- equivalent table grants must be explicit in a blank database.
GRANT ALL ON TABLE public.owner_notification_log, public.sms_agent_sessions TO service_role;
-- END folded-baseline grant reconciliation
