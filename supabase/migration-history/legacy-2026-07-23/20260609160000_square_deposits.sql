-- Square deposit collection: risk-gated, percentage-of-service deposits via
-- Square Payment Links. Reuses the existing bookings.deposit_* columns; adds
-- Square linkage + per-salon deposit policy on square_integrations.

alter table public.bookings
  add column if not exists square_payment_link_id text,
  add column if not exists square_deposit_order_id text,
  add column if not exists square_payment_id text,
  add column if not exists deposit_link_url text;

-- Per-salon deposit policy (owner: deposit only high-risk customers, % of price).
alter table public.square_integrations
  add column if not exists deposit_enabled boolean not null default false,
  add column if not exists deposit_percent integer not null default 30,
  add column if not exists deposit_risk_threshold integer not null default 60;

comment on column public.square_integrations.deposit_percent is 'Deposit = round(service price * this%)';
comment on column public.square_integrations.deposit_risk_threshold is 'Require a deposit only when booking.no_show_risk_score >= this (0-100)';
