-- A salon row contains business-wide configuration: outbound messaging gates,
-- booking rules, tax settings, branding, feature flags, and AI behavior.
-- Permission Matrix §3 reserves those settings for owner/admin. The legacy
-- policy name said "owner" but authorized every salon member.

drop policy if exists "owner update own salon"
  on public.salons;

create policy "owner update own salon"
  on public.salons
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.salon_members as sm
      where sm.user_id = (select auth.uid())
        and sm.salon_id = salons.id
        and sm.role in ('owner', 'admin')
    )
  )
  with check (
    exists (
      select 1
      from public.salon_members as sm
      where sm.user_id = (select auth.uid())
        and sm.salon_id = salons.id
        and sm.role in ('owner', 'admin')
    )
  );
