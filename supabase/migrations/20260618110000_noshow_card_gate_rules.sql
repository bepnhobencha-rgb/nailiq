-- Admin-configurable rules for WHO is asked to leave a card on file.
--
-- The card-on-file gate hardcoded "new customer OR any 1 prior no-show OR high
-- risk". These columns let the owner turn each trigger on/off and choose how
-- many prior no-shows it takes. Defaults reproduce the old behavior exactly
-- (all on, after the 1st no-show) so existing salons are unaffected.

alter table public.salons
  add column if not exists noshow_require_new_customer boolean not null default true,
  add column if not exists noshow_require_prior_noshow boolean not null default true,
  add column if not exists noshow_min_noshow_count integer not null default 1,
  add column if not exists noshow_require_high_risk boolean not null default true;

comment on column public.salons.noshow_require_new_customer is
  'Ask first-time customers to leave a card (default true).';
comment on column public.salons.noshow_require_prior_noshow is
  'Ask customers with prior no-shows to leave a card (default true).';
comment on column public.salons.noshow_min_noshow_count is
  'How many prior no-shows trigger the card requirement (default 1).';
comment on column public.salons.noshow_require_high_risk is
  'Ask high AI-risk bookings to leave a card (default true).';
