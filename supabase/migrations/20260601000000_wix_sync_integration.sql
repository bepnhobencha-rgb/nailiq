-- Wix Bookings two-way sync integration.
--   1. `bookings.wix_booking_id` maps each synced NailIQ booking back to its Wix booking,
--      so the forward cron upserts idempotently and write-back knows what to confirm/cancel.
--   2. `wix_integrations` holds per-salon Wix config + the forward-sync cursor (replaces the
--      standalone script's local state file so the Vercel cron is stateless/serverless-safe).

alter table public.bookings
  add column if not exists wix_booking_id text;

-- One NailIQ booking per Wix booking. Partial so the millions of non-Wix bookings stay unconstrained.
create unique index if not exists bookings_wix_booking_id_key
  on public.bookings (wix_booking_id)
  where wix_booking_id is not null;

create table if not exists public.wix_integrations (
  salon_id            uuid primary key references public.salons(id) on delete cascade,
  site_id             text not null,
  enabled             boolean not null default true,
  -- forward-sync watermark: only pull Wix bookings with updatedDate >= this
  cursor_updated_date timestamptz not null default now(),
  last_run_at         timestamptz,
  last_error          text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- Service-role only (cron + server actions). No anon/authenticated policies → RLS denies all else.
alter table public.wix_integrations enable row level security;

-- Seed the first tenant (Tech Nails). Cursor = now() → forward-only from go-live (history already backfilled).
insert into public.wix_integrations (salon_id, site_id)
select id, 'bca289a2-f279-4a9a-a484-c036e5f78a34'
from public.salons
where slug = 'tech-nails'
on conflict (salon_id) do nothing;
