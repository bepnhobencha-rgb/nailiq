-- Pha 1 — per-salon "togetherness" threshold (minutes). A group whose members
-- start within this many minutes of each other still counts as arriving
-- together (gentle waves), so the booking flow offers a small offset first and
-- only falls back to an all-together-different-time option beyond it. Default 30
-- preserves the previous hardcoded constant.
ALTER TABLE public.salons
  ADD COLUMN IF NOT EXISTS group_together_threshold_minutes integer NOT NULL DEFAULT 30
    CHECK (group_together_threshold_minutes >= 0 AND group_together_threshold_minutes <= 240);

COMMENT ON COLUMN public.salons.group_together_threshold_minutes IS
  'Group booking "togetherness" threshold (minutes): members within this spread are treated as arriving together. Default 30.';
