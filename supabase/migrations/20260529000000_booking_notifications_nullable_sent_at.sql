-- Allow booking_notifications.sent_at to be NULL.
--
-- logNotification() records BOTH successful and failed sends. A FAILED send has
-- no sent_at (it was never sent) and instead carries failed_at + error_message.
-- The original schema declared `sent_at timestamptz NOT NULL DEFAULT now()`, so
-- inserting an explicit NULL for a failed send was rejected with Postgres 23502
-- ("null value in column \"sent_at\" of relation \"booking_notifications\"
-- violates not-null constraint"). The net effect: FAILED notifications were
-- silently never recorded in the central audit table (successful sends logged
-- fine because sent_at was set). Observed at runtime when Twilio rejected SMS
-- sends (error 21609) during the voice-booking e2e specs.
--
-- Drop the NOT NULL so failed-send rows persist (status='failed', sent_at=NULL,
-- failed_at=now(), error_message set).
--
-- The DEFAULT now() is intentionally KEPT: callers that omit sent_at still get a
-- timestamp; only explicit NULLs (failed sends) are now allowed through. This is
-- a constraint relaxation only — no data is modified and no column is dropped.

ALTER TABLE booking_notifications
  ALTER COLUMN sent_at DROP NOT NULL;
