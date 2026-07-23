-- Decouple no-show POLICY (on/off, fee %, risk threshold) from the Square
-- integration so it's provider-agnostic. Connection ("is a provider hooked up")
-- stays provider-specific (square_integrations / Stripe); only the policy moves
-- here. Lets a Stripe salon enable no-show protection without a fake Square row.
alter table public.salons
  add column if not exists noshow_protection_enabled boolean not null default false;
alter table public.salons
  add column if not exists noshow_fee_percent integer not null default 20;
alter table public.salons
  add column if not exists noshow_risk_threshold integer not null default 60;

-- Preserve current behaviour: backfill from each salon's Square deposit policy.
update public.salons s set
  noshow_protection_enabled = coalesce(si.deposit_enabled, false),
  noshow_fee_percent       = coalesce(si.deposit_percent, 20),
  noshow_risk_threshold    = coalesce(si.deposit_risk_threshold, 60)
from public.square_integrations si
where si.salon_id = s.id;

comment on column public.salons.noshow_protection_enabled is
  'No-show protection on/off (provider-agnostic). Connection is checked separately via the resolved payment provider.';
