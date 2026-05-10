-- 2026-05-10 — SuperAdmin panel (internal tool, Huy only)
--
-- Adds per-salon override knobs that the SuperAdmin panel writes:
--   * `plan_override`        — short-circuits `subscription_plan` for billing-bypass
--                              accounts (beta partners, manual upgrades pending Stripe sync).
--                              `getEffectivePlan(salon)` returns plan_override > subscription_plan > 'free'.
--   * `feature_flags`        — JSONB bag of boolean toggles. Recognised keys (consumed today):
--                                loyalty, reports, audit_log, beta_features,
--                                unlimited_staff, unlimited_services
--                              Unknown keys are tolerated (forward-compat).
--   * `is_beta`              — flips the salon into early-access cohorts (UI flagging,
--                              targeted release toggles).
--   * `admin_notes`          — free text Huy keeps on each salon for context.
--   * `superadmin_locked_at` — sentinel for "this salon is in a frozen / hand-managed state";
--                              not yet enforced — column reserved for a future read-only gate
--                              over salon_owner mutations.
--
-- Plus a dedicated `superadmins` table — membership grants access to the
-- /superadmin route. RLS allows authenticated users to read ONLY their own
-- row (so the page can confirm membership without leaking the full list).
-- Writes happen out-of-band via service role (psql or one-off SQL).

alter table public.salons
  add column if not exists plan_override text
    check (plan_override in ('free', 'pro', 'premium')),
  add column if not exists feature_flags jsonb not null default '{}'::jsonb,
  add column if not exists is_beta boolean not null default false,
  add column if not exists admin_notes text,
  add column if not exists superadmin_locked_at timestamptz;

comment on column public.salons.plan_override is
  'Optional per-salon plan override set by SuperAdmin. When non-NULL it '
  'wins over subscription_plan in getEffectivePlan().';
comment on column public.salons.feature_flags is
  'JSONB bag of boolean feature toggles managed by SuperAdmin. '
  'Recognised keys: loyalty, reports, audit_log, beta_features, '
  'unlimited_staff, unlimited_services. Unknown keys ignored.';
comment on column public.salons.is_beta is
  'True for beta-access salons; flips on/off via SuperAdmin panel.';
comment on column public.salons.superadmin_locked_at is
  'Reserved for a future read-only gate that prevents salon_owner '
  'mutations once SuperAdmin freezes the salon. Not enforced yet.';

create table if not exists public.superadmins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.superadmins enable row level security;

drop policy if exists "superadmins_self_read" on public.superadmins;
create policy "superadmins_self_read" on public.superadmins
  for select to authenticated
  using (user_id = auth.uid());
