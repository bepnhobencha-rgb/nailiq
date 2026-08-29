-- Cover foreign-key lookup paths reported by the Supabase performance advisor.
-- These indexes do not change authorization or no-show payment behavior.

CREATE INDEX booking_no_show_fee_reviews_booking_fk_idx
  ON public.booking_no_show_fee_reviews (booking_id);

CREATE INDEX booking_no_show_fee_approval_receipts_booking_fk_idx
  ON public.booking_no_show_fee_approval_receipts (booking_id);

CREATE INDEX square_payment_webhook_inbox_salon_fk_idx
  ON public.square_payment_webhook_inbox (salon_id);
