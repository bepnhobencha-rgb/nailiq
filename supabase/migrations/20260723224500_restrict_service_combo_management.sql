-- Service bundles change the salon's catalog, price, duration, and public
-- booking choices. Permission Matrix §3.8 reserves that configuration for
-- owner/admin. Keep the public active-combo read policy unchanged.

drop policy if exists salon_owner_manage_combos
  on public.service_combos;

create policy salon_owner_admin_manage_combos
  on public.service_combos
  for all
  to authenticated
  using (
    exists (
      select 1
      from public.salon_members as sm
      where sm.user_id = (select auth.uid())
        and sm.salon_id = service_combos.salon_id
        and sm.role in ('owner', 'admin')
    )
  )
  with check (
    exists (
      select 1
      from public.salon_members as sm
      where sm.user_id = (select auth.uid())
        and sm.salon_id = service_combos.salon_id
        and sm.role in ('owner', 'admin')
    )
  );
