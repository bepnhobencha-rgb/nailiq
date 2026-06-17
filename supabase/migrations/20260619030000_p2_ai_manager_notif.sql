-- P2: AI Manager — Báo Cáo Viên + owner notification pipeline
-- Adds owner notification channel selector + phone for SMS alerts.
-- Creates ai_actions_log for ACT+UNDO audit trail (also needed by P3+).

-- ── salons: notification channel + owner phone ───────────────────────────────
ALTER TABLE salons
  ADD COLUMN IF NOT EXISTS owner_notification_channel text
    NOT NULL DEFAULT 'email'
    CHECK (owner_notification_channel IN ('email', 'sms', 'both')),
  ADD COLUMN IF NOT EXISTS owner_phone text;

COMMENT ON COLUMN salons.owner_notification_channel IS
  'How the AI Manager delivers alerts to owner: email | sms | both';
COMMENT ON COLUMN salons.owner_phone IS
  'Owner SMS number in E.164 format (+16045550100); used by daily reports + ACT+UNDO';

-- ── ai_actions_log: audit trail for every AI action ─────────────────────────
CREATE TABLE IF NOT EXISTS ai_actions_log (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id       uuid        NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  agent          text        NOT NULL, -- 'daily_report' | 'winback' | 'vip_care' | ...
  action_type    text        NOT NULL, -- 'sent_email' | 'sent_sms' | 'set_flash_deal' | ...
  target_id      uuid,                 -- booking_id / client_profile_id when applicable
  payload        jsonb,                -- what was sent/done (full detail for undo)
  undo_deadline  timestamptz,          -- NULL = final; set = owner can undo until this time
  undone_at      timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_actions_log_salon_created
  ON ai_actions_log (salon_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ai_actions_log_agent_salon
  ON ai_actions_log (agent, salon_id, created_at DESC);

-- RLS: only service-role writes; owner dashboard reads (P3 ActivityFeed)
ALTER TABLE ai_actions_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all" ON ai_actions_log
  FOR ALL USING (auth.role() = 'service_role');

-- Owners can read their own salon's log (needed for ActivityFeed in P3)
CREATE POLICY "owner_read_own" ON ai_actions_log
  FOR SELECT USING (
    salon_id IN (
      SELECT salon_id FROM salon_members
      WHERE user_id = auth.uid()
        AND role IN ('owner', 'admin')
    )
  );

COMMENT ON TABLE ai_actions_log IS
  'Audit trail for every AI Manager action. ACT+UNDO actions set undo_deadline; expired = final.';
