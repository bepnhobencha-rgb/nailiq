-- Salon subscription state, mirrored from Stripe.
-- Webhook handler (`/api/stripe/webhook`) writes via the service-role
-- client; reads happen through `resolveSalonForDashboard` ctx (existing
-- RLS — salon_members membership). RLS on `salons` is unchanged.
--
-- Columns are additive; existing rows default to the free plan with an
-- active status (so dashboard surfaces and limit checks see a sensible
-- default before any Stripe activity).

alter table public.salons
  add column if not exists stripe_customer_id text,
  add column if not exists stripe_subscription_id text,
  add column if not exists subscription_plan text not null default 'free',
  add column if not exists subscription_status text not null default 'active',
  add column if not exists subscription_current_period_end timestamptz;

alter table public.salons
  drop constraint if exists salons_subscription_plan_check;

alter table public.salons
  add constraint salons_subscription_plan_check
  check (subscription_plan in ('free', 'pro', 'premium'));

alter table public.salons
  drop constraint if exists salons_subscription_status_check;

alter table public.salons
  add constraint salons_subscription_status_check
  check (
    subscription_status in (
      'active',
      'trialing',
      'past_due',
      'canceled'
    )
  );

-- Webhook lookups happen by stripe_customer_id (or stripe_subscription_id
-- on subscription.* events). Index both for O(1) dispatch.
create unique index if not exists salons_stripe_customer_id_uq
  on public.salons (stripe_customer_id)
  where stripe_customer_id is not null;

create unique index if not exists salons_stripe_subscription_id_uq
  on public.salons (stripe_subscription_id)
  where stripe_subscription_id is not null;

comment on column public.salons.subscription_plan is
  'Mirrored from Stripe via /api/stripe/webhook. free | pro | premium. Limits live in src/shared/lib/subscriptionPlans.ts.';
comment on column public.salons.subscription_status is
  'Mirrored from Stripe (active | trialing | past_due | canceled). Used for dunning UX; gating decisions consult subscription_plan.';
