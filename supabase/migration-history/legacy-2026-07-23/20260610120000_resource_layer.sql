-- Resource layer (Phase 1): an OPTIONAL, generic, second scheduling dimension
-- (stations / chairs / beds) independent of staff. Salons with resources_enabled
-- = false behave exactly as before — every resource path is additive and gated.
-- See docs/SPEC-resource-layer.md.

-- ---- generic per-salon resource (NOT hardcoded to "bed") ----
create table if not exists public.salon_resources (
  id            uuid primary key default gen_random_uuid(),
  salon_id      uuid not null references public.salons(id) on delete cascade,
  name          text not null,
  kind          text not null default 'station'
                 check (kind in ('station','chair','bed','backwash','room','other')),
  display_order integer not null default 0,
  status        text not null default 'active' check (status in ('active','inactive')),
  square_team_member_id text,
  deleted_at    timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists idx_salon_resources_salon on public.salon_resources (salon_id) where deleted_at is null;

alter table public.salon_resources enable row level security;

-- Public read (needed for public-booking availability; resource names aren't secret) — mirrors staff_services.
drop policy if exists "anon read salon_resources" on public.salon_resources;
create policy "anon read salon_resources"
  on public.salon_resources for select to anon, authenticated using (true);

-- Salon members may manage resources for salons they belong to.
drop policy if exists "members write salon_resources" on public.salon_resources;
create policy "members write salon_resources"
  on public.salon_resources for all to authenticated
  using (salon_id in (select sm.salon_id from public.salon_members sm where sm.user_id = auth.uid()))
  with check (salon_id in (select sm.salon_id from public.salon_members sm where sm.user_id = auth.uid()));

-- ---- bookings gain an OPTIONAL second dimension ----
alter table public.bookings add column if not exists resource_id uuid references public.salon_resources(id);
create index if not exists idx_bookings_resource_id on public.bookings (resource_id) where resource_id is not null;

-- 1 resource cannot hold 2 overlapping live bookings. Partial → the millions of
-- non-resource bookings stay unconstrained (zero impact on resource-off salons).
alter table public.bookings drop constraint if exists bookings_resource_no_overlap;
alter table public.bookings add constraint bookings_resource_no_overlap
  exclude using gist (
    salon_id    with =,
    resource_id with =,
    tstzrange(start_time_utc, end_time_utc, '[)') with &&
  ) where (resource_id is not null and status not in ('cancelled','no_show'));
-- (staff no-overlap constraint bookings_no_overlap is unchanged)

-- ---- per-salon config (defaults OFF → backward compatible) ----
alter table public.salons
  add column if not exists resources_enabled boolean not null default false,
  add column if not exists primary_grid_axis text not null default 'staff'
    check (primary_grid_axis in ('staff','resource'));

comment on table public.salon_resources is 'Optional physical scheduling resources (beds/chairs/stations), independent of staff. Phase 1 of the resource layer.';
comment on column public.salons.primary_grid_axis is 'Receptionist timeline columns: by staff (default) or by resource (head spa / bed mode).';
