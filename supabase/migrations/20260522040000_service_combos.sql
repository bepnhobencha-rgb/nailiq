-- Service combo bundles: predefined multi-service packages with custom pricing.
create table if not exists public.service_combos (
  id               uuid         default gen_random_uuid() primary key,
  salon_id         uuid         not null references public.salons(id) on delete cascade,
  name             text         not null,
  description      text,
  service_ids      uuid[]       not null default '{}',
  price_cents      integer      not null default 0,
  discount_cents   integer      not null default 0,
  duration_minutes integer      not null default 60,
  is_active        boolean      not null default true,
  position         integer      not null default 0,
  created_at       timestamptz  not null default now(),
  updated_at       timestamptz  not null default now()
);

create index if not exists service_combos_salon_id_idx
  on public.service_combos(salon_id);

-- RLS: salon owner can manage their own combos; public can read active ones.
alter table public.service_combos enable row level security;

create policy "salon_owner_manage_combos" on public.service_combos
  for all
  to authenticated
  using (
    exists (
      select 1 from public.salon_members m
      where m.user_id = auth.uid()
        and m.salon_id = service_combos.salon_id
        and m.role in ('owner', 'senior')
    )
  );

create policy "public_read_active_combos" on public.service_combos
  for select using (is_active = true);

-- Track which combo (if any) a booking was made against.
alter table public.bookings
  add column if not exists service_combo_id uuid
    references public.service_combos(id)
    on delete set null;

comment on column public.bookings.service_combo_id is
  'When booked as a combo bundle, references the service_combos row.';
