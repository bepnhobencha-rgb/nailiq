-- P0 SECURITY FIX (part 1 of 2) — additive: per-phone snapshot RPC.
--
-- Applied to prod FIRST (additive, changes no existing behaviour), then the
-- booking code is deployed to call it, then part 2 (the SELECT revoke) runs.
-- This ordering avoids a window where the old code's direct anon read of
-- client_profiles returns null and resets visit_count.
--
-- The RPC returns at most ONE phone's row, so the public booking flow keeps its
-- returning-customer recognition + deposit-risk read without anon being able to
-- bulk-read the table. SECURITY DEFINER so it works after part 2 revokes anon
-- SELECT; search_path pinned (also clears the mutable-search_path lint).
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
