-- Phase 2: salon onboarding (address, hours, completion) + staff job roles + owner CRUD on catalog.

alter table public.salons
  add column if not exists address text,
  add column if not exists salon_phone text,
  add column if not exists opening_hours jsonb default '{
    "mon": {"open": "09:00", "close": "18:00", "closed": false},
    "tue": {"open": "09:00", "close": "18:00", "closed": false},
    "wed": {"open": "09:00", "close": "18:00", "closed": false},
    "thu": {"open": "09:00", "close": "18:00", "closed": false},
    "fri": {"open": "09:00", "close": "18:00", "closed": false},
    "sat": {"open": "09:00", "close": "18:00", "closed": false},
    "sun": {"open": "09:00", "close": "18:00", "closed": true}
  }'::jsonb,
  add column if not exists profile_complete boolean default false;

alter table public.staff
  add column if not exists job_role text not null default 'nail_tech'
    constraint staff_job_role_check check (job_role in ('owner', 'senior', 'nail_tech'));

comment on column public.staff.job_role is 'Display/station role for booking UX: owner, senior, nail_tech (not auth membership role).';

drop policy if exists "owner insert services for own salon" on public.services;
create policy "owner insert services for own salon"
  on public.services
  for insert
  to authenticated
  with check (
    salon_id in (
      select salon_id from public.salon_members
      where user_id = auth.uid()
    )
  );

drop policy if exists "owner update services for own salon" on public.services;
create policy "owner update services for own salon"
  on public.services
  for update
  to authenticated
  using (
    salon_id in (
      select salon_id from public.salon_members
      where user_id = auth.uid()
    )
  )
  with check (
    salon_id in (
      select salon_id from public.salon_members
      where user_id = auth.uid()
    )
  );

drop policy if exists "owner delete services for own salon" on public.services;
create policy "owner delete services for own salon"
  on public.services
  for delete
  to authenticated
  using (
    salon_id in (
      select salon_id from public.salon_members
      where user_id = auth.uid()
    )
  );

drop policy if exists "owner insert staff for own salon" on public.staff;
create policy "owner insert staff for own salon"
  on public.staff
  for insert
  to authenticated
  with check (
    salon_id in (
      select salon_id from public.salon_members
      where user_id = auth.uid()
    )
  );

drop policy if exists "owner update staff for own salon" on public.staff;
create policy "owner update staff for own salon"
  on public.staff
  for update
  to authenticated
  using (
    salon_id in (
      select salon_id from public.salon_members
      where user_id = auth.uid()
    )
  )
  with check (
    salon_id in (
      select salon_id from public.salon_members
      where user_id = auth.uid()
    )
  );

drop policy if exists "owner delete staff for own salon" on public.staff;
create policy "owner delete staff for own salon"
  on public.staff
  for delete
  to authenticated
  using (
    salon_id in (
      select salon_id from public.salon_members
      where user_id = auth.uid()
    )
  );
