-- Re-opt-in campaign: let Square-imported customers confirm marketing consent
-- (stamps client_profiles.marketing_consent_at) in exchange for a welcome
-- voucher they claim by booking on NailIQ. Adds a 'reoptin' voucher kind and a
-- send-ledger table for idempotency + tracking.

-- 1. Allow the new voucher kind (re-list all existing kinds so they stay valid).
alter table public.vouchers drop constraint if exists vouchers_kind_check;
alter table public.vouchers add constraint vouchers_kind_check
  check (kind = any (array[
    'birthday','welcome_back','referral_reward','promo','gift','milestone','reoptin'
  ]));

-- 2. Send ledger — at most one row per (salon, client). The token is a
--    capability that drives the confirm/claim link in the email.
create table if not exists public.reoptin_sends (
  id                uuid primary key default gen_random_uuid(),
  salon_id          uuid not null references public.salons(id) on delete cascade,
  client_profile_id uuid not null references public.client_profiles(id) on delete cascade,
  email             text not null,
  token             text not null unique,
  voucher_id        uuid references public.vouchers(id) on delete set null,
  code              text,
  status            text not null default 'pending'
                    check (status in ('pending','sent','confirmed','booked','failed','suppressed')),
  sent_at           timestamptz,
  confirmed_at      timestamptz,
  booked_at         timestamptz,
  created_at        timestamptz not null default now(),
  unique (salon_id, client_profile_id)
);

create index if not exists reoptin_sends_salon_idx on public.reoptin_sends (salon_id);
create index if not exists reoptin_sends_token_idx on public.reoptin_sends (token);

-- 3. RLS: the token is a bearer capability, so no anon/auth read path. Only the
--    service role (which bypasses RLS) touches this table.
alter table public.reoptin_sends enable row level security;
