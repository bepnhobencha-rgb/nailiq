-- User presence tracking for "Active Sessions" owner view.
-- One row per user — upserted by a client-side heartbeat every 30s.

CREATE TABLE IF NOT EXISTS user_presence (
  user_id     uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  salon_id    uuid NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  ip_address  text,
  user_agent  text,
  device_type text,   -- 'mobile' | 'tablet' | 'desktop'
  browser     text,
  current_path text,
  battery_level integer CHECK (battery_level BETWEEN 0 AND 100),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

-- Index for owner query: all active sessions for a salon.
CREATE INDEX IF NOT EXISTS user_presence_salon_idx
  ON user_presence (salon_id, last_seen_at DESC);

-- RLS: users can upsert their own row; owners/admins can read their salon's rows.
ALTER TABLE user_presence ENABLE ROW LEVEL SECURITY;

-- Each authenticated user can insert/update only their own row.
CREATE POLICY "presence_self_upsert"
  ON user_presence
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Salon owners and admins can read all presence rows for their salon.
CREATE POLICY "presence_owner_read"
  ON user_presence
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM salon_members
      WHERE salon_members.salon_id = user_presence.salon_id
        AND salon_members.user_id  = auth.uid()
        AND salon_members.role IN ('owner', 'admin', 'manager')
    )
  );
