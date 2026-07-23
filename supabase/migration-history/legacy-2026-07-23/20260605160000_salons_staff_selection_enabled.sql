-- When false, the public booking wizard skips the "choose staff" step and
-- auto-assigns any available provider. Default true preserves current behavior.
ALTER TABLE public.salons
  ADD COLUMN IF NOT EXISTS staff_selection_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.salons.staff_selection_enabled IS
  'When false, customers do not pick a provider — the booking wizard hides the staff step and auto-assigns (Any). Default true.';
