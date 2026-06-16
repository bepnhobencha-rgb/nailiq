-- Per-salon VIP spend tiers (gold/silver/bronze thresholds in cents).
-- NULL = use the code defaults. Admin-configurable so a salon can tune the bar
-- for "Vàng / Bạc / Đồng" to its own price level (no hardcoded $ amounts).

alter table public.salons
  add column if not exists vip_spend_tiers jsonb;

comment on column public.salons.vip_spend_tiers is
  'VIP spend tier thresholds in cents: {"gold":N,"silver":N,"bronze":N}. '
  'A customer''s lifetime Square spend ≥ a threshold earns that tier. '
  'NULL → code defaults (gold $1000 / silver $500 / bronze $200).';
