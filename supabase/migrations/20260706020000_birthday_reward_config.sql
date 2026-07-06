-- Admin-configurable birthday reward for AI VIP Care.
--
-- Replaces the hardcoded "10% off" birthday voucher: the owner sets what the
-- birthday gift is. When set, VIP Care's birthday email attaches a real voucher
-- code. Default 'none' → no reward attached (message unchanged), so this is a
-- no-op until an owner configures it.
alter table public.salons
  add column if not exists birthday_reward_type text not null default 'none',
  add column if not exists birthday_reward_percent integer,
  add column if not exists birthday_reward_amount_cents integer,
  add column if not exists birthday_reward_valid_days integer not null default 30;

alter table public.salons
  drop constraint if exists salons_birthday_reward_type_check;
alter table public.salons
  add constraint salons_birthday_reward_type_check
  check (birthday_reward_type in ('none', 'percent', 'amount'));

comment on column public.salons.birthday_reward_type is
  'AI VIP Care birthday gift: none | percent | amount. When not none, the birthday email attaches a voucher.';
