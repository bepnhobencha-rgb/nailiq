-- Queue display mode: 'full' (default) shows all fields on each queue card;
-- 'simple' hides priority badge, party size, staff dispatch line, heart-line,
-- and request tags so small salons get a cleaner, less cluttered view.
ALTER TABLE salons
  ADD COLUMN IF NOT EXISTS queue_display_mode text NOT NULL DEFAULT 'full';

-- Constrain to known values so rogue server-action calls can't corrupt the column.
ALTER TABLE salons
  ADD CONSTRAINT salons_queue_display_mode_check
  CHECK (queue_display_mode IN ('full', 'simple'));
