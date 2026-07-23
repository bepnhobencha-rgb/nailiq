-- Square integration: import customers/catalog/bookings from Square into NailIQ.
--   1. `square_integrations` holds per-salon Square config (merchant + location + access
--      token) and the forward-sync watermark, mirroring `wix_integrations`.
--   2. Per-entity `square_*_id` columns map each NailIQ row back to its Square object so
--      imports upsert idempotently (re-running never duplicates).
-- Storage philosophy matches platform_settings / wix_integrations: plaintext value,
-- service-role-only RLS (no app-level encryption exists in this codebase yet).

-- ----- idempotency mapping columns -----
alter table public.client_profiles
  add column if not exists square_customer_id text;
create unique index if not exists client_profiles_square_customer_id_key
  on public.client_profiles (square_customer_id)
  where square_customer_id is not null;

alter table public.bookings
  add column if not exists square_booking_id text;
create unique index if not exists bookings_square_booking_id_key
  on public.bookings (square_booking_id)
  where square_booking_id is not null;

alter table public.services
  add column if not exists square_catalog_item_id text;

alter table public.staff
  add column if not exists square_team_member_id text;

-- ----- per-salon Square config + sync state -----
create table if not exists public.square_integrations (
  salon_id            uuid primary key references public.salons(id) on delete cascade,
  merchant_id         text not null,
  location_id         text not null,
  -- Plaintext, service-role only (same posture as wix_integrations.wix_api_key).
  -- Populated via the admin "save credentials" action, NOT seeded in this migration.
  access_token        text,
  enabled             boolean not null default true,
  -- forward-sync watermark: only pull Square objects updated at/after this
  cursor_synced_at    timestamptz not null default now(),
  last_run_at         timestamptz,
  last_error          text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- Service-role only (scripts + server actions). No anon/authenticated policies → RLS denies all else.
alter table public.square_integrations enable row level security;

-- Seed the first tenant (Hi-Lite Anaheim). Non-secret config only; access_token stays NULL
-- here and is set out-of-band so it never lands in version control.
insert into public.square_integrations (salon_id, merchant_id, location_id)
select id, 'MLS550QW7H88Y', 'LKNG1X7QRRQ4M'
from public.salons
where slug = 'hilite-anaheim'
on conflict (salon_id) do nothing;
