-- Reminder action tokens: one row per reminder email sent.
-- The token UUID is embedded in confirm/reschedule/cancel links.

CREATE TABLE IF NOT EXISTS booking_reminder_tokens (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  uuid        NOT NULL REFERENCES bookings(id)  ON DELETE CASCADE,
  salon_id    uuid        NOT NULL REFERENCES salons(id)    ON DELETE CASCADE,
  used_action text,       -- 'confirm' | 'reschedule' | 'cancel'
  used_at     timestamptz,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE booking_reminder_tokens ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS brt_booking_idx ON booking_reminder_tokens (booking_id);
CREATE INDEX IF NOT EXISTS brt_expires_idx ON booking_reminder_tokens (expires_at);

COMMENT ON TABLE booking_reminder_tokens IS
  'One row per reminder send. UUID is the capability: embed in confirm/reschedule/cancel URLs.';
