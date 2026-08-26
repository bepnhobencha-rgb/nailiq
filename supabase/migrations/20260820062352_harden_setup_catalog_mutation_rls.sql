-- Services, their prices/durations, and staff capability mappings drive the
-- Guided Setup readiness state and public booking availability. Permission
-- Matrix sections 3.5 and 3.8 reserve these mutations for owner/admin. The
-- legacy policy names said "owner" or "members" but authorized every salon
-- member, including senior, receptionist, and nail_tech, through Data API.

drop policy if exists "owner delete services for own salon"
  on public.services;
drop policy if exists "owner insert services for own salon"
  on public.services;
drop policy if exists "owner update services for own salon"
  on public.services;

create policy "owner delete services for own salon"
  on public.services
  for delete
  to authenticated
  using (
    exists (
      select 1
      from public.salon_members as sm
      where sm.user_id = (select auth.uid())
        and sm.salon_id = services.salon_id
        and sm.role in ('owner', 'admin')
    )
  );

create policy "owner insert services for own salon"
  on public.services
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.salon_members as sm
      where sm.user_id = (select auth.uid())
        and sm.salon_id = services.salon_id
        and sm.role in ('owner', 'admin')
    )
  );

create policy "owner update services for own salon"
  on public.services
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.salon_members as sm
      where sm.user_id = (select auth.uid())
        and sm.salon_id = services.salon_id
        and sm.role in ('owner', 'admin')
    )
  )
  with check (
    exists (
      select 1
      from public.salon_members as sm
      where sm.user_id = (select auth.uid())
        and sm.salon_id = services.salon_id
        and sm.role in ('owner', 'admin')
    )
  );

drop policy if exists "members write staff_services"
  on public.staff_services;

create policy "owner admin write staff_services"
  on public.staff_services
  for all
  to authenticated
  using (
    exists (
      select 1
      from public.staff as s
      join public.salon_members as sm on sm.salon_id = s.salon_id
      where s.id = staff_services.staff_id
        and sm.user_id = (select auth.uid())
        and sm.role in ('owner', 'admin')
    )
  )
  with check (
    exists (
      select 1
      from public.staff as s
      join public.services as svc on svc.salon_id = s.salon_id
      join public.salon_members as sm on sm.salon_id = s.salon_id
      where s.id = staff_services.staff_id
        and svc.id = staff_services.service_id
        and sm.user_id = (select auth.uid())
        and sm.role in ('owner', 'admin')
    )
  );

-- Preserve the established read contract: public booking reads active service
-- fields through public_service_catalog, while staff capability rows remain
-- directly readable by anon/authenticated. This migration changes writes only.
do $proof$
declare
  v_services_write_count integer;
begin
  select count(*)
    into v_services_write_count
    from pg_policies
   where schemaname = 'public'
     and tablename = 'services'
     and policyname in (
       'owner delete services for own salon',
       'owner insert services for own salon',
       'owner update services for own salon'
     )
     and roles = array['authenticated']::name[]
     and (coalesce(qual, '') || coalesce(with_check, '')) like '%owner%'
     and (coalesce(qual, '') || coalesce(with_check, '')) like '%admin%';

  if v_services_write_count <> 3
     or not exists (
       select 1
       from pg_policies
       where schemaname = 'public'
         and tablename = 'services'
         and policyname = 'public read active service catalog'
         and cmd = 'SELECT'
         and roles = array['anon']::name[]
     )
     or not exists (
       select 1
       from pg_policies
       where schemaname = 'public'
         and tablename = 'staff_services'
         and policyname = 'anon read staff_services'
         and cmd = 'SELECT'
         and roles = array['anon', 'authenticated']::name[]
     )
     or not exists (
       select 1
       from pg_policies
       where schemaname = 'public'
         and tablename = 'staff_services'
         and policyname = 'owner admin write staff_services'
         and cmd = 'ALL'
         and roles = array['authenticated']::name[]
         and qual like '%owner%'
         and qual like '%admin%'
         and with_check like '%owner%'
         and with_check like '%admin%'
     )
     or exists (
       select 1
       from pg_policies
       where schemaname = 'public'
         and tablename = 'staff_services'
         and policyname = 'members write staff_services'
     ) then
    raise exception 'setup catalog mutation RLS boundary mismatch';
  end if;
end;
$proof$;
