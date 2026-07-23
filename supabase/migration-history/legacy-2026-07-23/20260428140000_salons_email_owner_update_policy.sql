-- Progressive email recovery (dashboard banner). Columns + authenticated owner salon update.

alter table public.salons add column if not exists email text;
alter table public.salons add column if not exists email_verified boolean default false;

drop policy if exists "owner update own salon" on public.salons;
create policy "owner update own salon"
  on public.salons
  for update
  to authenticated
  using (
    id in (
      select salon_id from public.salon_members
      where user_id = auth.uid()
    )
  )
  with check (
    id in (
      select salon_id from public.salon_members
      where user_id = auth.uid()
    )
  );
