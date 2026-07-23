-- Staff shifts: recurring weekly schedule per staff member.
-- Optional — salons without rows fall back to full salon opening hours (backward-compat).
-- staff_unavailability: one-off blocked dates (PTO, sick, training).

create table if not exists public.staff_shifts (
  id            uuid primary key default gen_random_uuid(),
  staff_id      uuid not null references public.staff(id) on delete cascade,
  salon_id      uuid not null references public.salons(id) on delete cascade,
  day_of_week   text not null check (day_of_week in ('mon','tue','wed','thu','fri','sat','sun')),
  start_time    text not null check (start_time ~ '^\d{2}:\d{2}$'),
  end_time      text not null check (end_time ~ '^\d{2}:\d{2}$'),
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (staff_id, day_of_week)
);

create index if not exists idx_staff_shifts_salon
  on public.staff_shifts (salon_id, day_of_week)
  where is_active = true;

alter table public.staff_shifts enable row level security;

drop policy if exists "anon read staff_shifts" on public.staff_shifts;
create policy "anon read staff_shifts"
  on public.staff_shifts for select to anon, authenticated using (true);

drop policy if exists "members write staff_shifts" on public.staff_shifts;
create policy "members write staff_shifts"
  on public.staff_shifts for all to authenticated
  using (
    salon_id in (
      select sm.salon_id from public.salon_members sm where sm.user_id = auth.uid()
    )
  )
  with check (
    salon_id in (
      select sm.salon_id from public.salon_members sm where sm.user_id = auth.uid()
    )
  );

-- One-off unavailability: staff member blocked for an entire date.
create table if not exists public.staff_unavailability (
  id         uuid primary key default gen_random_uuid(),
  staff_id   uuid not null references public.staff(id) on delete cascade,
  salon_id   uuid not null references public.salons(id) on delete cascade,
  date       date not null,
  reason     text,
  created_at timestamptz not null default now(),
  unique (staff_id, date)
);

create index if not exists idx_staff_unavailability_salon_date
  on public.staff_unavailability (salon_id, date);

alter table public.staff_unavailability enable row level security;

drop policy if exists "anon read staff_unavailability" on public.staff_unavailability;
create policy "anon read staff_unavailability"
  on public.staff_unavailability for select to anon, authenticated using (true);

drop policy if exists "members write staff_unavailability" on public.staff_unavailability;
create policy "members write staff_unavailability"
  on public.staff_unavailability for all to authenticated
  using (
    salon_id in (
      select sm.salon_id from public.salon_members sm where sm.user_id = auth.uid()
    )
  )
  with check (
    salon_id in (
      select sm.salon_id from public.salon_members sm where sm.user_id = auth.uid()
    )
  );

comment on table public.staff_shifts is
  'Recurring weekly shift schedule per staff member. Salons with no rows use full salon opening hours (backward-compat).';
comment on table public.staff_unavailability is
  'One-off blocked dates per staff member (PTO, sick day, training).';
