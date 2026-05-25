-- Add gift card columns to vouchers
ALTER TABLE public.vouchers
  ADD COLUMN IF NOT EXISTS gift_card_value_cents integer,
  ADD COLUMN IF NOT EXISTS gift_card_from_name text,
  ADD COLUMN IF NOT EXISTS gift_card_message text,
  ADD COLUMN IF NOT EXISTS gift_card_purchaser_phone text,
  ADD COLUMN IF NOT EXISTS gift_card_stripe_payment_intent_id text;

COMMENT ON COLUMN public.vouchers.gift_card_value_cents IS 'Original loaded value of the gift card (kind=gift). amount_off_cents tracks remaining balance.';
COMMENT ON COLUMN public.vouchers.gift_card_from_name IS 'Sender name on the gift card';
COMMENT ON COLUMN public.vouchers.gift_card_message IS 'Personal message on the gift card';
COMMENT ON COLUMN public.vouchers.gift_card_purchaser_phone IS 'Phone of person who purchased the gift card';
COMMENT ON COLUMN public.vouchers.gift_card_stripe_payment_intent_id IS 'Stripe PaymentIntent for the gift card purchase';
