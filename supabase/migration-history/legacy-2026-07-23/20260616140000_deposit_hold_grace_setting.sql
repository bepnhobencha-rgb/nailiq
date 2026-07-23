-- Admin-configurable grace window for the pay-deposit-to-confirm hold (replaces
-- the hardcoded 30-min constant in the release-pending cron). Per-salon, owner-
-- settable. Default 30 to preserve current behaviour.
alter table public.salons
  add column if not exists deposit_hold_grace_minutes int not null default 30;

-- Sanity bounds: at least 5 min (give the customer time to open the link + pay),
-- at most 24h.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'salons_deposit_hold_grace_minutes_range'
  ) then
    alter table public.salons
      add constraint salons_deposit_hold_grace_minutes_range
      check (deposit_hold_grace_minutes between 5 and 1440);
  end if;
end $$;

comment on column public.salons.deposit_hold_grace_minutes is 'Minutes a deposit-held slot waits for payment before the release-pending cron cancels it. Admin-set, default 30.';
