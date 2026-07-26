\set ON_ERROR_STOP on

-- Emergency rollback rehearsal: restore the exact legacy owner/senior policy,
-- verify its shape, then roll back so the throwaway database remains hardened.
begin;

drop policy if exists salon_owner_admin_manage_combos
  on public.service_combos;

create policy salon_owner_manage_combos
  on public.service_combos
  to authenticated
  using (
    exists (
      select 1
      from public.salon_members as m
      where m.user_id = (select auth.uid())
        and m.salon_id = service_combos.salon_id
        and m.role = any (array['owner'::text, 'senior'::text])
    )
  );

do $test$
begin
  if (
    select count(*)
    from pg_policies
    where schemaname = 'public'
      and tablename = 'service_combos'
      and policyname = 'salon_owner_manage_combos'
      and cmd = 'ALL'
      and roles = array['authenticated']::name[]
      and qual like '%owner%'
      and qual like '%senior%'
      and with_check is null
  ) <> 1 then
    raise exception 'combo RLS rollback did not restore the legacy policy';
  end if;

  if exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'service_combos'
      and policyname = 'salon_owner_admin_manage_combos'
  ) then
    raise exception 'combo RLS rollback left the hardened policy behind';
  end if;
end
$test$;

rollback;
