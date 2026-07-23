-- Fair Cancel, part 2: a SEPARATE late-cancel fee percent (optional).
--
-- A late cancellation with notice is less harmful than a silent no-show, so a
-- salon may want a gentler % for it. NULL = fall back to noshow_fee_percent
-- (unchanged behaviour). When set, the cancel-action route scales the frozen
-- no-show fee snapshot to this percent.
--
-- Auto-refund uses the existing free-text noshow_charge_status with a new
-- 'refunded' value (no CHECK constraint on that column, so no change needed).

ALTER TABLE public.salons
  ADD COLUMN IF NOT EXISTS self_cancel_fee_percent integer;

COMMENT ON COLUMN public.salons.self_cancel_fee_percent IS
  'Late self-cancel fee percent. NULL = use noshow_fee_percent. When set, scales the no-show fee snapshot for late cancellations only.';
