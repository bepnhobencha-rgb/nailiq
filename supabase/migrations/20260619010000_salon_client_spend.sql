-- Per-salon customer lifetime spend, synced from Square Payments.
--
-- Square holds the money truth (NailIQ only had bookings, not amounts paid).
-- This table stores each customer's total spend AT THIS SALON so the owner can
-- run spend-based programs (VIP tiers, spend loyalty). Salon-scoped (tenant
-- isolated): a customer's spend at salon A never mixes with salon B.

create table if not exists public.salon_client_spend (
  salon_id          uuid        not null references public.salons (id) on delete cascade,
  client_profile_id uuid        not null references public.client_profiles (id) on delete cascade,
  total_spend_cents bigint      not null default 0,
  payment_count     int         not null default 0,
  last_payment_at   timestamptz,
  synced_at         timestamptz not null default now(),
  primary key (salon_id, client_profile_id)
);

alter table public.salon_client_spend enable row level security;
-- Service-role only — no public policies.

-- Top-spenders lookup per salon (VIP ranking).
create index if not exists salon_client_spend_top_idx
  on public.salon_client_spend (salon_id, total_spend_cents desc);
