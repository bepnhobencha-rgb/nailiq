\set ON_ERROR_STOP on

-- Emergency rollback rehearsal: restore the exact legacy member-wide write
-- policies, prove their shape, then roll back so the throwaway database stays
-- hardened. Public read policies are intentionally untouched.
begin;

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
    salon_id in (
      select public.salon_members.salon_id
      from public.salon_members
      where public.salon_members.user_id = (select auth.uid())
    )
  );

create policy "owner insert services for own salon"
  on public.services
  for insert
  to authenticated
  with check (
    salon_id in (
      select public.salon_members.salon_id
      from public.salon_members
      where public.salon_members.user_id = (select auth.uid())
    )
  );

create policy "owner update services for own salon"
  on public.services
  for update
  to authenticated
  using (
    salon_id in (
      select public.salon_members.salon_id
      from public.salon_members
      where public.salon_members.user_id = (select auth.uid())
    )
  )
  with check (
    salon_id in (
      select public.salon_members.salon_id
      from public.salon_members
      where public.salon_members.user_id = (select auth.uid())
    )
  );

drop policy if exists "owner admin write staff_services"
  on public.staff_services;

create policy "members write staff_services"
  on public.staff_services
  for all
  to authenticated
  using (
    staff_id in (
      select s.id
      from public.staff as s
      join public.salon_members as m on m.salon_id = s.salon_id
      where m.user_id = (select auth.uid())
    )
  )
  with check (
    staff_id in (
      select s.id
      from public.staff as s
      join public.salon_members as m on m.salon_id = s.salon_id
      where m.user_id = (select auth.uid())
    )
    and service_id in (
      select svc.id
      from public.services as svc
      join public.salon_members as m on m.salon_id = svc.salon_id
      where m.user_id = (select auth.uid())
    )
  );

do $proof$
begin
  if (
    select count(*)
    from pg_policies
    where schemaname = 'public'
      and tablename = 'services'
      and policyname in (
        'owner delete services for own salon',
        'owner insert services for own salon',
        'owner update services for own salon'
      )
      and roles = array['authenticated']::name[]
      and (coalesce(qual, '') || coalesce(with_check, '')) like '%salon_members%'
      and (coalesce(qual, '') || coalesce(with_check, '')) not like '%admin%'
  ) <> 3 or not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'staff_services'
      and policyname = 'members write staff_services'
      and cmd = 'ALL'
      and roles = array['authenticated']::name[]
      and qual like '%salon_members%'
      and qual not like '%admin%'
      and with_check like '%salon_members%'
      and with_check not like '%admin%'
  ) or not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'services'
      and policyname = 'public read active service catalog'
      and cmd = 'SELECT'
  ) or not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'staff_services'
      and policyname = 'anon read staff_services'
      and cmd = 'SELECT'
  ) then
    raise exception 'setup catalog rollback did not restore legacy policies';
  end if;
end;
$proof$;

rollback;
