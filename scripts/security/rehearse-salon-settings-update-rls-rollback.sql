\set ON_ERROR_STOP on

-- Emergency rollback rehearsal: restore the exact legacy member-wide update
-- policy, verify its shape, then roll the rehearsal back so the throwaway
-- database remains hardened.
begin;

drop policy if exists "owner update own salon"
  on public.salons;

create policy "owner update own salon"
  on public.salons
  for update
  to authenticated
  using (
    id in (
      select public.salon_members.salon_id
      from public.salon_members
      where public.salon_members.user_id = (select auth.uid())
    )
  )
  with check (
    id in (
      select public.salon_members.salon_id
      from public.salon_members
      where public.salon_members.user_id = (select auth.uid())
    )
  );

do $test$
begin
  if (
    select count(*)
    from pg_policies
    where schemaname = 'public'
      and tablename = 'salons'
      and policyname = 'owner update own salon'
      and cmd = 'UPDATE'
      and roles = array['authenticated']::name[]
      and qual like '%salon_members%'
      and qual not like '%admin%'
      and with_check like '%salon_members%'
      and with_check not like '%admin%'
  ) <> 1 then
    raise exception 'salon settings rollback did not restore legacy policy';
  end if;
end
$test$;

rollback;
