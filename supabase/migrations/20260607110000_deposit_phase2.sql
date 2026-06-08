-- Phase 2: link a booking to its Stripe deposit PaymentIntent (charged on the
-- salon's connected account). deposit_status='paid' + verification_method='deposit'
-- are already valid in their CHECK constraints.
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS stripe_payment_intent_id text,
  ADD COLUMN IF NOT EXISTS deposit_paid_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_bookings_deposit_pi
  ON public.bookings (stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;
