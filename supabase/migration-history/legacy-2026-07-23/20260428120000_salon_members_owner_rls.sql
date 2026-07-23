-- Owner memberships + authenticated booking access for dashboard.
-- Run via supabase db push or SQL editor.

create table if not exists public.salon_members (
  id uuid primary key default gen_random_uuid(),
  salon_id uuid not null references public.salons (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'owner'
    check (role in ('owner', 'staff')),
  created_at timestamptz default now(),
  unique (salon_id, user_id)
);

create index if not exists salon_members_user_id_idx on public.salon_members (user_id);
create index if not exists salon_members_salon_id_idx on public.salon_members (salon_id);

alter table public.salon_members enable row level security;

drop policy if exists "owner can read own memberships" on public.salon_members;
create policy "owner can read own memberships"
  on public.salon_members
  for select
  to authenticated
  using (auth.uid() = user_id);

-- Bookings: salon owners/staff with membership may read/update rows for their salon.
drop policy if exists "owner read own salon bookings" on public.bookings;
create policy "owner read own salon bookings"
  on public.bookings
  for select
  to authenticated
  using (
    salon_id in (
      select salon_id from public.salon_members
      where user_id = auth.uid()
    )
  );

drop policy if exists "owner update own salon bookings" on public.bookings;
create policy "owner update own salon bookings"
  on public.bookings
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

-- Salons: optional stricter read for authenticated owners (public catalog policy remains).
drop policy if exists "owner read own salon" on public.salons;
create policy "owner read own salon"
  on public.salons
  for select
  to authenticated
  using (
    id in (
      select salon_id from public.salon_members
      where user_id = auth.uid()
    )
  );
