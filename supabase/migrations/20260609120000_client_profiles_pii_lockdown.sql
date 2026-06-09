-- P0 SECURITY FIX — client_profiles cross-tenant PII read leak.
--
-- The `public read client_profiles` policy (USING true, role `public`) plus an
-- anon/authenticated table-level SELECT grant let ANYONE holding the public
-- anon key (it ships in the browser bundle) dump every customer profile —
-- name, phone, visit_count, no_show_count, is_vip — across ALL tenants via
-- GET /rest/v1/client_profiles?select=*. `authenticated` users could read every
-- other salon's customers the same way. (client_profiles is a global, phone-keyed
-- table with no salon_id, so this is a full cross-tenant PII dump.)
--
-- Fix: revoke direct SELECT from anon/authenticated and drop the open policy.
-- The only legitimate anon reads are the booking flow's returning-customer
-- recognition + deposit risk lookup, which need a SINGLE phone's snapshot — moved
-- to a SECURITY DEFINER RPC that returns at most one row, so no bulk dump is
-- possible. Every other reader (dashboard, webhooks, Wix sync, superadmin)
-- already uses the service-role client, which bypasses RLS and is unaffected.

-- 1. Per-phone snapshot RPC for the public booking flow. SECURITY DEFINER so it
--    keeps working after the anon SELECT revoke; returns at most one row for the
--    given phone. search_path pinned (also avoids the mutable-search_path lint).
create or replace function public.get_booking_client_snapshot(p_phone text)
returns table (
  visit_count   integer,
  name          text,
  no_show_count integer,
  is_vip        boolean
)
language sql
security definer
set search_path = public
stable
as $$
  select cp.visit_count, cp.name, cp.no_show_count, cp.is_vip
  from public.client_profiles cp
  where cp.phone = p_phone
    and cp.deleted_at is null
  limit 1;
$$;

revoke all on function public.get_booking_client_snapshot(text) from public;
grant execute on function public.get_booking_client_snapshot(text)
  to anon, authenticated, service_role;

-- 2. Close the leak. service_role bypasses RLS so all service-role readers keep
--    working. INSERT/UPDATE column grants are intentionally KEPT — the booking
--    flow's anon profile upsert is already column-restricted (migration
--    20260607070000_harden_anon_writes) and does not need SELECT.
drop policy if exists "public read client_profiles" on public.client_profiles;
revoke select on public.client_profiles from anon, authenticated;
