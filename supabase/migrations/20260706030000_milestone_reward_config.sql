-- Phase 2: admin-configurable MILESTONE reward for AI VIP Care (mirrors the
-- birthday reward from 20260706020000). Applied when a VIP hits 10 / 25 / 50
-- completed visits. Default 'none' → no reward attached (message unchanged).
alter table public.salons
  add column if not exists milestone_reward_type text not null default 'none',
  add column if not exists milestone_reward_percent integer,
  add column if not exists milestone_reward_amount_cents integer,
  add column if not exists milestone_reward_valid_days integer not null default 30;

alter table public.salons
  drop constraint if exists salons_milestone_reward_type_check;
alter table public.salons
  add constraint salons_milestone_reward_type_check
  check (milestone_reward_type in ('none', 'percent', 'amount'));

comment on column public.salons.milestone_reward_type is
  'AI VIP Care milestone gift (10/25/50 visits): none | percent | amount. When not none, the milestone email attaches a voucher.';

-- Allow a new voucher kind for milestone rewards (was: birthday, welcome_back,
-- referral_reward, promo, gift).
alter table public.vouchers drop constraint if exists vouchers_kind_check;
alter table public.vouchers add constraint vouchers_kind_check
  check (kind = any (array['birthday','welcome_back','referral_reward','promo','gift','milestone']));
