\set ON_ERROR_STOP on

-- Emergency rollback rehearsal. It restores the exact two member-wide
-- policies replaced by the migration, verifies their shape, then rolls the
-- rehearsal back so the throwaway database remains on the hardened policy.
begin;

drop policy if exists salon_owner_admin_manage
  on public.salon_page_sections;

create policy salon_member_rw
  on public.salon_page_sections
  using (
    salon_id in (
      select sm.salon_id
      from public.salon_members as sm
      where sm.user_id = (select auth.uid())
    )
  );

drop policy if exists salon_owner_admin_manage
  on public.website_import_jobs;

create policy salon_member_all
  on public.website_import_jobs
  using (
    salon_id in (
      select sm.salon_id
      from public.salon_members as sm
      where sm.user_id = (select auth.uid())
    )
  );

do $test$
begin
  if (
    select count(*)
    from pg_policies
    where schemaname = 'public'
      and (
        (tablename = 'salon_page_sections' and policyname = 'salon_member_rw')
        or
        (tablename = 'website_import_jobs' and policyname = 'salon_member_all')
      )
  ) <> 2 then
    raise exception 'public-page RLS rollback did not restore both legacy policies';
  end if;

  if exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename in ('salon_page_sections', 'website_import_jobs')
      and policyname = 'salon_owner_admin_manage'
  ) then
    raise exception 'public-page RLS rollback left a hardened policy behind';
  end if;
end
$test$;

rollback;
