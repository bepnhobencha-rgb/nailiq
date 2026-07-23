-- Public-page content and website imports are salon settings. The application
-- already treats them as owner/admin-only; enforce the same boundary for
-- direct Data API access so a lower-privilege salon member cannot bypass the UI.

drop policy if exists salon_member_rw
  on public.salon_page_sections;

create policy salon_owner_admin_manage
  on public.salon_page_sections
  for all
  to authenticated
  using (
    exists (
      select 1
      from public.salon_members as sm
      where sm.salon_id = salon_page_sections.salon_id
        and sm.user_id = (select auth.uid())
        and sm.role in ('owner', 'admin')
    )
  )
  with check (
    exists (
      select 1
      from public.salon_members as sm
      where sm.salon_id = salon_page_sections.salon_id
        and sm.user_id = (select auth.uid())
        and sm.role in ('owner', 'admin')
    )
  );

-- Keep salon_page_sections_public_read unchanged: visible sections remain
-- readable by the public booking page, while hidden rows and every write stay
-- owner/admin-only.

drop policy if exists salon_member_all
  on public.website_import_jobs;

create policy salon_owner_admin_manage
  on public.website_import_jobs
  for all
  to authenticated
  using (
    exists (
      select 1
      from public.salon_members as sm
      where sm.salon_id = website_import_jobs.salon_id
        and sm.user_id = (select auth.uid())
        and sm.role in ('owner', 'admin')
    )
  )
  with check (
    exists (
      select 1
      from public.salon_members as sm
      where sm.salon_id = website_import_jobs.salon_id
        and sm.user_id = (select auth.uid())
        and sm.role in ('owner', 'admin')
    )
  );
