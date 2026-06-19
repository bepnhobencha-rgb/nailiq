-- Outcome tracking: did Minh's action actually bring the client back?
ALTER TABLE ai_actions_log
  ADD COLUMN IF NOT EXISTS outcome text CHECK (outcome IN ('converted', 'no_conversion')),
  ADD COLUMN IF NOT EXISTS outcome_at timestamptz,
  ADD COLUMN IF NOT EXISTS outcome_booking_id uuid REFERENCES bookings(id) ON DELETE SET NULL;

-- Efficient lookup: pending outcomes for client-facing agents
CREATE INDEX IF NOT EXISTS ai_actions_log_outcome_pending_idx
  ON ai_actions_log (salon_id, agent, action_type, created_at)
  WHERE outcome IS NULL;

-- Owner can give Minh standing instructions (goals, priorities, constraints)
ALTER TABLE salons ADD COLUMN IF NOT EXISTS ai_manager_instructions text;
