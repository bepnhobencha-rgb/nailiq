-- Per-salon voucher validity for loyalty rewards.
--
-- The redeemed-reward voucher expiry was hardcoded to 90 days in
-- loyaltyActions.ts (twice) with no admin UI — changing it required a code
-- edit, against the no-hardcode rule. Make it a per-salon setting.
--
-- Nullable + no default: NULL means "use the platform default"
-- (DEFAULT_VOUCHER_VALID_DAYS = 90 in code), so every existing program keeps
-- the exact prior behavior. The app clamps writes to 7..365.

ALTER TABLE public.loyalty_programs
  ADD COLUMN IF NOT EXISTS voucher_valid_days integer;

COMMENT ON COLUMN public.loyalty_programs.voucher_valid_days IS
  'Days a redeemed reward voucher stays valid. NULL = platform default (90). App clamps 7..365.';
