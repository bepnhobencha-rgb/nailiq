-- Self-serve late-cancellation fee.
--
-- Until now customer self-cancel (via the emailed /booking/cancel link) was
-- unconditional and free, letting a card-on-file customer dodge the no-show fee
-- by cancelling last-minute. This adds a configurable cancellation window: a
-- self-cancel INSIDE the window (close to the appointment) on a booking with a
-- saved card + recorded consent charges the same fee % as a no-show, reusing the
-- existing chargeNoShowFee machinery. Outside the window stays free.
--
-- Two per-salon settings, both no-hardcode (admin-editable in the No-Show
-- Protection hub). Enforcement lives in the cancel-action route, not here.

ALTER TABLE public.salons
  ADD COLUMN IF NOT EXISTS self_cancel_window_hours integer NOT NULL DEFAULT 24,
  ADD COLUMN IF NOT EXISTS self_cancel_fee_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.salons.self_cancel_window_hours IS
  'Hours before appointment start within which a customer self-cancel counts as a late cancel (fee-eligible). Default 24.';
COMMENT ON COLUMN public.salons.self_cancel_fee_enabled IS
  'When true, a late self-cancel on a booking with a saved card + consent is charged the no-show fee %. Default off (opt-in).';

-- Turn it on for salons that already run card-on-file no-show protection (the
-- only salons that have saved cards + consent to charge against) — i.e. Hi-Lite.
-- Others stay off until they enable it themselves.
UPDATE public.salons
SET    self_cancel_fee_enabled = true
WHERE  noshow_protection_enabled = true;
