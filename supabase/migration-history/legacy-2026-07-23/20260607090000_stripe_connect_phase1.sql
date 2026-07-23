-- Stripe Connect (Express) per salon — Phase 1 (onboarding only, no charges yet).
-- Deposits (Phase 2) will be charged on the salon's own connected account so the
-- money goes to the salon, not the platform.
ALTER TABLE public.salons
  ADD COLUMN IF NOT EXISTS stripe_connect_account_id text,
  ADD COLUMN IF NOT EXISTS stripe_connect_charges_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS stripe_connect_details_submitted boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.salons.stripe_connect_account_id IS
  'Stripe Connect (Express) account id (acct_…) for this salon; deposits are charged on it.';
COMMENT ON COLUMN public.salons.stripe_connect_charges_enabled IS
  'Mirror of Stripe account.charges_enabled — true once the salon can accept charges.';
