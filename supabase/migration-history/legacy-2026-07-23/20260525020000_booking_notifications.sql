-- Central audit log for all outbound booking notifications (SMS + email).
-- Enables Twilio delivery-receipt webhooks and real-time owner visibility.

CREATE TABLE booking_notifications (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id          uuid REFERENCES bookings(id) ON DELETE CASCADE,
  salon_id            uuid NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  notification_type   text NOT NULL,  -- 'booking_confirmation' | 'reminder_24h' | 'reminder_3h' | 'review_request'
  channel             text NOT NULL DEFAULT 'sms',  -- 'sms' | 'email'
  status              text NOT NULL DEFAULT 'sent',  -- 'sent' | 'delivered' | 'undelivered' | 'failed'
  client_phone        text,
  twilio_message_sid  text UNIQUE,    -- Twilio MessageSid for webhook correlation
  body_preview        text,           -- first 120 chars of message body
  sent_at             timestamptz NOT NULL DEFAULT now(),
  delivered_at        timestamptz,
  failed_at           timestamptz,
  error_message       text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_booking_notif_booking   ON booking_notifications(booking_id);
CREATE INDEX idx_booking_notif_salon     ON booking_notifications(salon_id, created_at DESC);
CREATE INDEX idx_booking_notif_sid       ON booking_notifications(twilio_message_sid) WHERE twilio_message_sid IS NOT NULL;

ALTER TABLE booking_notifications ENABLE ROW LEVEL SECURITY;

-- Salon members can read their own salon's notifications
CREATE POLICY "salon_member_read_notifications"
  ON booking_notifications FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM salon_members sm
      WHERE sm.salon_id = booking_notifications.salon_id
        AND sm.user_id  = auth.uid()
    )
  );

-- Only service role inserts/updates (webhook + server actions)
-- No RLS INSERT/UPDATE policies — service role bypasses RLS.

-- Enable Realtime so owner dashboard gets live delivery updates
ALTER PUBLICATION supabase_realtime ADD TABLE booking_notifications;
