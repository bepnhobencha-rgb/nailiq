-- De-hardcode deposit percentages (were 50/30/20 baked in evaluateDeposit.ts).
-- Per-salon, admin-configurable; defaults preserve current behavior.
ALTER TABLE public.salons
  ADD COLUMN IF NOT EXISTS deposit_pct_no_show smallint NOT NULL DEFAULT 50
    CHECK (deposit_pct_no_show BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS deposit_pct_high_value smallint NOT NULL DEFAULT 30
    CHECK (deposit_pct_high_value BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS deposit_pct_new_customer smallint NOT NULL DEFAULT 20
    CHECK (deposit_pct_new_customer BETWEEN 0 AND 100);
