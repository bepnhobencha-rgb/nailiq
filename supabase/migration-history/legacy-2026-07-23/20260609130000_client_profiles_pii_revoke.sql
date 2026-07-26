-- P0 SECURITY FIX (part 2 of 2) — close the cross-tenant PII read leak.
--
-- MUST be applied to prod ONLY AFTER part 1 (the snapshot RPC) is live AND the
-- booking code that calls it is deployed — otherwise the old code's direct anon
-- read of client_profiles returns null and resets visit_count to 1.
--
-- The `public read client_profiles` policy (USING true, role `public`) + an
-- anon/authenticated table SELECT grant let anyone with the public anon key dump
-- every customer profile (name, phone, visit_count, no_show_count, is_vip)
-- across ALL tenants via GET /rest/v1/client_profiles. client_profiles is a
-- global, phone-keyed table (no salon_id) so any read is cross-tenant.
--
-- service_role bypasses RLS, so every other reader (dashboard, webhooks, Wix
-- sync, superadmin — all service-role) is unaffected. INSERT/UPDATE column
-- grants are intentionally kept: the booking flow's anon profile upsert is
-- already column-restricted (20260607070000_harden_anon_writes) and, on
-- supabase-js v2 (return=minimal), needs no SELECT.
drop policy if exists "public read client_profiles" on public.client_profiles;
revoke select on public.client_profiles from anon, authenticated;
